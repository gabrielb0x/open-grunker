/**
 * Open Grunker — anthem sniffing, measuring and levelling.
 *
 * There is no audio library on this server and no intention of adding one, so
 * this module is the whole of what stands between the disk and whatever a
 * client felt like sending. It is the same bargain util/image.js makes for
 * pictures, and it is struck for the same reason: a server that cannot read
 * what it stores cannot enforce anything about it.
 *
 * ── Why the format is this dull ─────────────────────────────────────────────
 *
 * An anthem arrives as mono 16-bit PCM in a plain RIFF/WAVE wrapper, and
 * nothing else is accepted. Not because that is a nice format — it is not, it
 * is enormous — but because it is the only one this file can *measure*. An MP3
 * would need a decoder to answer "how loud is this", and a loudness rule that
 * cannot be checked is a loudness rule that does not exist. The browser has a
 * complete decoder built into it and every uploader is running one, so the
 * decoding happens there and the arithmetic happens here.
 *
 * ── What actually protects a listener ───────────────────────────────────────
 *
 * Three things, in this order:
 *
 *  1. **The samples are rewritten.** This module does not check a loudness and
 *     refuse; it measures one and *changes* it. What lands on disk is levelled
 *     whatever was uploaded, so there is no threshold to sit just underneath.
 *
 *  2. **The measurement is short-term.** A whole-file average calls "nine
 *     seconds of silence and one air horn" a quiet track and turns it up. The
 *     loudest 400 ms in the file calls it an air horn. See `measure`.
 *
 *  3. **The file is re-emitted, not patched.** The bytes written back are a
 *     canonical 44-byte header and the samples, so every other chunk a
 *     container could be carrying — metadata, cue points, whatever a tool
 *     decided to append — is gone rather than stored and later served.
 *
 * The client then plays the result through a limited bus at the listener's own
 * volume, which is the fourth thing, and the only one that would still work if
 * every line here were wrong.
 */
import {
  ANTHEM_BITS, ANTHEM_CHANNELS, ANTHEM_FADE_MS, ANTHEM_HOP_MS, ANTHEM_MAX_BYTES,
  ANTHEM_MAX_SECONDS, ANTHEM_MIN_SECONDS, ANTHEM_PEAK_CEILING_DB, ANTHEM_SAMPLE_RATE,
  ANTHEM_SILENCE_DB, ANTHEM_TARGET_RMS_DB, ANTHEM_WINDOW_MS,
} from '../../shared/constants.js';

const WAV_HEADER_BYTES = 44;
/** Signed 16-bit PCM. The only `wFormatTag` this file will look at. */
const WAVE_FORMAT_PCM = 1;

const db = (amp) => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);
const amp = (decibels) => 10 ** (decibels / 20);

/* ── Reading ─────────────────────────────────────────────────────────────── */

/**
 * Walks a RIFF/WAVE container and reports what is really in it.
 *
 * Chunk-by-chunk rather than "assume the 44-byte canonical layout", because a
 * perfectly ordinary encoder writes a LIST or a fact chunk before the data and
 * an anthem that fails to upload because iTunes touched it is a bug. Every
 * offset is bounds-checked against the buffer before it is used: a length field
 * inside a file is a claim by the sender, and this is the one place that claim
 * is allowed to be wrong without consequences.
 *
 * @param {Buffer} buf
 * @returns {{format:number, channels:number, sampleRate:number, bits:number,
 *            dataAt:number, dataBytes:number, frames:number, seconds:number}|null}
 *   null when the buffer is not a WAVE file, or is too damaged to measure.
 */
export function identifyWav(buf) {
  if (!buf || buf.length < WAV_HEADER_BYTES) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (buf.toString('latin1', 8, 12) !== 'WAVE') return null;

  let fmt = null;
  let dataAt = -1;
  let dataBytes = 0;

  // 12 is the first byte after "RIFF<size>WAVE"; every chunk is an 8-byte
  // header and a body, and an odd body is followed by one pad byte.
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    // A chunk that claims to run past the end of the file is where reading
    // stops. What has been found so far still counts — a truncated tail after
    // a complete `data` chunk is a download that was cut short, not an attack.
    if (size > buf.length - body) {
      if (id === 'data' && dataAt < 0) { dataAt = body; dataBytes = buf.length - body; }
      break;
    }
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data' && dataAt < 0) {
      dataAt = body;
      dataBytes = size;
    }
    at = body + size + (size & 1);
  }

  if (!fmt || dataAt < 0) return null;
  if (!fmt.channels || !fmt.sampleRate || !fmt.bits) return null;

  const frameBytes = (fmt.bits >> 3) * fmt.channels;
  if (!frameBytes) return null;
  const frames = Math.floor(dataBytes / frameBytes);
  return {
    ...fmt,
    dataAt,
    dataBytes: frames * frameBytes,
    frames,
    seconds: frames / fmt.sampleRate,
  };
}

/* ── Measuring ───────────────────────────────────────────────────────────── */

/**
 * True peak and short-term loudness of a block of samples, in dBFS.
 *
 * `loud` is the loudest ANTHEM_WINDOW_MS anywhere in the track, found by
 * sliding that window in ANTHEM_HOP_MS steps over a running sum of squares —
 * one pass, whatever the window size. That single number is what the levelling
 * below is aimed at, and it is the reason the obvious trick does not work: a
 * long quiet stretch cannot drag the measurement of a loud one down, because
 * the two are never in the same window.
 *
 * A file shorter than one window is measured whole, which is the same thing
 * with fewer steps.
 *
 * @param {Float64Array|Float32Array} samples normalised to [-1, 1]
 * @param {number} sampleRate
 * @returns {{peak:number, loud:number, rms:number, peakDb:number, loudDb:number, rmsDb:number}}
 */
export function measure(samples, sampleRate) {
  const n = samples.length;
  if (!n) return { peak: 0, loud: 0, rms: 0, peakDb: -Infinity, loudDb: -Infinity, rmsDb: -Infinity };

  let peak = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    const a = x < 0 ? -x : x;
    if (a > peak) peak = a;
    total += x * x;
  }
  const rms = Math.sqrt(total / n);

  const window = Math.max(1, Math.min(n, Math.round((sampleRate * ANTHEM_WINDOW_MS) / 1000)));
  const hop = Math.max(1, Math.round((sampleRate * ANTHEM_HOP_MS) / 1000));

  // Running sum of squares over the window, advanced one hop at a time. Adding
  // the samples entering and subtracting those leaving keeps this O(n) rather
  // than O(n · window), which matters: at 32 kHz a whole-window recompute per
  // hop is a hundred million multiplies for a ten-second file.
  let sum = 0;
  for (let i = 0; i < window; i++) sum += samples[i] * samples[i];
  let loudest = sum;
  for (let start = hop; start + window <= n; start += hop) {
    for (let i = start - hop; i < start; i++) sum -= samples[i] * samples[i];
    for (let i = start + window - hop; i < start + window; i++) sum += samples[i] * samples[i];
    // Floating-point drift over thousands of add/subtract pairs is bounded and
    // far below a decibel, but a negative sum from cancellation would produce a
    // NaN in the sqrt below, so it is floored.
    if (sum < 0) sum = 0;
    if (sum > loudest) loudest = sum;
  }
  const loud = Math.sqrt(loudest / window);

  return { peak, loud, rms, peakDb: db(peak), loudDb: db(loud), rmsDb: db(rms) };
}

/**
 * The gain that takes a measurement to the house level.
 *
 * Whichever of the two rules asks for less wins: the loudness target is what
 * levels a track, the peak ceiling is what stops that levelling from clipping
 * one. A brickwalled upload therefore comes out quieter than it went in, and a
 * quiet one comes out louder but never louder than the ceiling allows.
 *
 * @returns {number} a linear multiplier, 0 when there is nothing there to level
 */
export function levellingGain({ peak, loud }) {
  if (!(peak > 0) || !(loud > 0)) return 0;
  return Math.min(amp(ANTHEM_TARGET_RMS_DB) / loud, amp(ANTHEM_PEAK_CEILING_DB) / peak);
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

/**
 * A canonical 44-byte mono PCM header for `frames` frames.
 *
 * Written from scratch on every store, which is the point: whatever chunks the
 * uploaded container carried, the file that ends up on disk is exactly a header
 * and samples and nothing else.
 */
function wavHeader(frames, sampleRate = ANTHEM_SAMPLE_RATE) {
  const bytes = frames * (ANTHEM_BITS >> 3) * ANTHEM_CHANNELS;
  const head = Buffer.alloc(WAV_HEADER_BYTES);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + bytes, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);                                   // PCM fmt chunk size
  head.writeUInt16LE(WAVE_FORMAT_PCM, 20);
  head.writeUInt16LE(ANTHEM_CHANNELS, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * ANTHEM_CHANNELS * (ANTHEM_BITS >> 3), 28);   // byte rate
  head.writeUInt16LE(ANTHEM_CHANNELS * (ANTHEM_BITS >> 3), 32);                // block align
  head.writeUInt16LE(ANTHEM_BITS, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(bytes, 40);
  return head;
}

/* ── The route's two questions ───────────────────────────────────────────── */

/**
 * Is this buffer storable as somebody's anthem?
 *
 * Shape only — length, format, duration. How loud it is is not a reason to
 * refuse anything, because loudness is fixed rather than judged: see `level`.
 *
 * @param {Buffer} buf raw upload
 * @returns {{ok:true, info:object}|{ok:false, code:string, message:string}}
 */
export function validateAnthem(buf) {
  if (!buf?.length) {
    return { ok: false, code: 'empty_upload', message: 'no audio was sent' };
  }
  // Deliberately before the size check, even though the size check is cheaper.
  // Every way of being too big is really a way of being too long, and "that is
  // 12.0s" is an answer somebody can act on where "that is 751 KB" is a riddle
  // about sample rates. Reading the header costs a walk over a handful of chunk
  // lengths, not over the file, and the route has already capped what it read.
  const info = identifyWav(buf);
  if (!info) {
    return { ok: false, code: 'unsupported_audio', message: 'that file is not a WAVE recording' };
  }
  if (info.format !== WAVE_FORMAT_PCM || info.bits !== ANTHEM_BITS
      || info.channels !== ANTHEM_CHANNELS || info.sampleRate !== ANTHEM_SAMPLE_RATE) {
    return {
      ok: false,
      code: 'unsupported_audio',
      message: `an anthem is mono ${ANTHEM_BITS}-bit PCM at ${ANTHEM_SAMPLE_RATE} Hz — `
        + 'the uploader in the panel makes one out of whatever you give it',
    };
  }
  if (info.seconds > ANTHEM_MAX_SECONDS + 0.05) {
    return {
      ok: false,
      code: 'anthem_too_long',
      message: `that is ${info.seconds.toFixed(1)}s — an anthem is at most ${ANTHEM_MAX_SECONDS}s`,
    };
  }
  if (info.seconds < ANTHEM_MIN_SECONDS) {
    return {
      ok: false,
      code: 'anthem_too_short',
      message: `that is ${info.seconds.toFixed(1)}s — an anthem is at least ${ANTHEM_MIN_SECONDS}s`,
    };
  }
  // Last, and by now only reachable by a file that is the right length and the
  // right format and still too big — which means it is carrying something other
  // than samples, and that is a reason to refuse it rather than to strip it.
  if (buf.length > ANTHEM_MAX_BYTES) {
    return {
      ok: false,
      code: 'anthem_too_large',
      message: `that is ${Math.ceil(buf.length / 1024)} KB — the limit is ${Math.floor(ANTHEM_MAX_BYTES / 1024)} KB`,
    };
  }
  return { ok: true, info };
}

/**
 * Levels a validated anthem and re-emits it.
 *
 * This is the half that makes the ceiling real. The gain is computed from the
 * measurement, applied to every sample, and the result written into a fresh
 * canonical file — so what a player uploaded is not what any listener is ever
 * served, whatever it was.
 *
 * The ends are ramped over ANTHEM_FADE_MS. A ten-second cut out of the middle
 * of a track starts and stops on whatever sample it happened to land on, and a
 * discontinuity into a listener's speakers is a click at full scale — which is
 * exactly the thing everything above is trying to prevent, arriving through the
 * back door.
 *
 * @param {Buffer} buf a buffer `validateAnthem` has already accepted
 * @param {object} info the descriptor it returned
 * @returns {{ok:true, buffer:Buffer, report:object}
 *          |{ok:false, code:string, message:string}}
 */
export function level(buf, info) {
  const { frames, dataAt, sampleRate } = info;
  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    // Divided by 32768 rather than 32767, so -32768 maps to exactly -1 and the
    // scale stays symmetric. The half-LSB of headroom this costs at the top is
    // not audible and the asymmetry would be.
    samples[i] = buf.readInt16LE(dataAt + i * 2) / 32768;
  }

  const before = measure(samples, sampleRate);
  if (before.rmsDb < ANTHEM_SILENCE_DB) {
    return {
      ok: false,
      code: 'anthem_silent',
      message: 'there is nothing audible in that file',
    };
  }

  const gain = levellingGain(before);
  if (!(gain > 0)) {
    return { ok: false, code: 'anthem_silent', message: 'there is nothing audible in that file' };
  }

  const fade = Math.max(1, Math.min(frames >> 1, Math.round((sampleRate * ANTHEM_FADE_MS) / 1000)));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let v = samples[i] * gain;
    if (i < fade) v *= i / fade;
    else if (i >= frames - fade) v *= (frames - 1 - i) / fade;
    // The ceiling above means this clamp should never bite. It is here because
    // "should never" is not a guarantee, and a wrapped Int16 is the loudest
    // sound a computer can make.
    const s = Math.round(v * 32767);
    out.writeInt16LE(s > 32767 ? 32767 : s < -32768 ? -32768 : s, i * 2);
    samples[i] = v;
  }

  const after = measure(samples, sampleRate);
  return {
    ok: true,
    buffer: Buffer.concat([wavHeader(frames, sampleRate), out]),
    report: {
      seconds: Math.round(info.seconds * 100) / 100,
      gainDb: Math.round(db(gain) * 10) / 10,
      before: { peakDb: round1(before.peakDb), loudDb: round1(before.loudDb) },
      after: { peakDb: round1(after.peakDb), loudDb: round1(after.loudDb) },
    },
  };
}

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export default { identifyWav, measure, levellingGain, validateAnthem, level };
