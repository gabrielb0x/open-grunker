/**
 * Open Grunker — procedural audio.
 *
 * Every sound in the game is synthesised at runtime. No audio files ship with
 * the project, nothing is preloaded, and the whole sound design is about
 * thirty kilobytes of source.
 *
 * ── What makes it sound like a game rather than like a synthesiser ──────────
 *
 * Four things, and they matter more than any individual recipe below:
 *
 *  1. **Nothing is ever played twice the same way.** Every voice takes a small
 *     random walk through pitch, level, filter and timing. A rifle emptying a
 *     magazine is thirty *different* gunshots, which is the single largest
 *     difference between this and a loop of one sample.
 *
 *  2. **Distance is a chain, not a volume knob.** A far shot arrives late (at
 *     the speed of sound), dark (air eats the top end), wide (the direct sound
 *     and its reflections separate) and mostly tail. A near one is all crack
 *     and mechanism. That relationship is most of what makes a firefight
 *     legible by ear — you can hear roughly where a fight is without looking.
 *
 *  3. **The room answers back.** Two convolution sends run in parallel: a short
 *     one for early reflections, which is what tells you a space is enclosed,
 *     and a long diffuse one whose top end dies faster than its bottom, the way
 *     a real tail does.
 *
 *  4. **The bus is mixed, not summed.** A limiter, a soft clipper and a gentle
 *     bus compressor sit under everything, and a hard voice cap keeps a
 *     ten-player firefight from turning into square-wave mush. Loud things duck
 *     the reverb briefly so the next transient stays sharp.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 *
 * `initAudio` builds the graph once. `voice()` is the one place a sound is
 * routed and scheduled. `noise` and `tone` are the two generators everything is
 * built out of, and `sfx` is the catalogue of recipes.
 */
import { settings } from './settings.js';
import { SURFACE_FX } from '/shared/constants.js';

let ctx = null;
let master = null;            // everything meets here
let bus = null;               // post-compressor, pre-destination
let sends = null;             // { early, tail } convolution sends
let buffers = null;           // { white, pink, brown }
let started = false;
/** The anthem chain — see `initAnthemBus`. Its own path to the output. */
let anthem = null;

/**
 * Live voices, so a firefight cannot outrun the CPU.
 *
 * Web Audio will happily accept two thousand oscillators and then drop the
 * whole graph to a crackle. The cap is generous — a busy second is maybe forty
 * voices — and past it a sound is simply not started. That is a blunt rule, but
 * the only time it is ever reached is under a wall of simultaneous gunfire, and
 * the thirty-third layer of that is not something anybody was going to hear.
 */
const MAX_VOICES = 72;
let voices = 0;

/** Metres per unit, so distance delay and air absorption are in real terms. */
const SPEED_OF_SOUND = 343;
const UNITS_PER_METRE = 1.6;

const now = () => ctx.currentTime;
const rnd = (a, b) => a + Math.random() * (b - a);
/** A multiplier that wanders around 1 by ±`amount`. The anti-machine-gun. */
const vary = (amount) => 1 + (Math.random() * 2 - 1) * amount;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ── Graph ────────────────────────────────────────────────────────────────
 *
 *   voices ─┬─────────────────────────────────────► master ─► bus chain ─► out
 *           ├─► earlySend ─► convolver(small room) ─┤
 *           └─► tailSend  ─► convolver(big room)  ──┘
 *
 * The two sends are separate buses rather than one, because "this space is
 * enclosed" and "this space is large" are different perceptions and every
 * sound wants a different amount of each. A pistol indoors is mostly early
 * reflections; a rocket outdoors is almost entirely tail.
 * ────────────────────────────────────────────────────────────────────────── */

/** Creates the context on the first user gesture (browsers require this). */
export function initAudio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: 'interactive' });

  master = ctx.createGain();
  master.gain.value = settings.masterVolume;

  /* ── The bus ────────────────────────────────────────────────────────────
   * Three stages, in the order a mixing desk would have them:
   *
   *   glue      a slow, gentle compressor that makes a burst of gunfire read
   *             as one event rather than as ten unrelated bangs
   *   clip      a soft saturator: the last few decibels bend instead of
   *             squaring off, so a nuke going off next to a firefight
   *             distorts the way loud things do rather than the way clipping does
   *   ceiling   a fast brickwall so nothing ever leaves above 0 dBFS
   * ─────────────────────────────────────────────────────────────────────── */
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -18;
  glue.knee.value = 26;
  glue.ratio.value = 3.2;
  glue.attack.value = 0.008;
  glue.release.value = 0.24;

  const clipper = ctx.createWaveShaper();
  clipper.curve = softClipCurve();
  clipper.oversample = '2x';

  const ceiling = ctx.createDynamicsCompressor();
  ceiling.threshold.value = -1.6;
  ceiling.knee.value = 0;
  ceiling.ratio.value = 20;
  ceiling.attack.value = 0.001;
  ceiling.release.value = 0.06;

  // A touch of air on the whole mix. Procedural noise is naturally dull up
  // top, and two decibels here is the difference between "synthesised" and
  // "recorded" more often than any single recipe below.
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 7200;
  air.gain.value = 2.4;

  bus = ctx.createGain();
  master.connect(glue);
  glue.connect(clipper);
  clipper.connect(air);
  air.connect(ceiling);
  ceiling.connect(bus);
  bus.connect(ctx.destination);

  buffers = {
    white: makeNoise(2, 'white'),
    pink: makeNoise(2, 'pink'),
    brown: makeNoise(2, 'brown'),
  };

  sends = {
    early: makeSend(impulse({ seconds: 0.24, decay: 5.2, taps: 26, spread: 0.09, damp: 0.45 }), 0.5),
    tail: makeSend(impulse({ seconds: 2.1, decay: 3.1, taps: 9, spread: 0.4, damp: 0.86 }), 0.42),
  };

  initAnthemBus();

  started = true;
  return ctx;
}

/* ── The anthem bus ─────────────────────────────────────────────────────────
 *
 * The one place in this file that plays something it did not synthesise, and
 * therefore the one place that has to assume the worst about what it is given.
 *
 * A player anthem is a stranger's audio file, chosen by whoever just killed
 * you, arriving on a screen you did not ask to be looking at. The server
 * levels every one of them before it stores it — see server/util/audio.js —
 * but that is a rule enforced somewhere else, on a machine somebody else runs,
 * and "somebody else already checked" is not a thing to put between a stranger
 * and a listener's ears. So this chain assumes nothing:
 *
 *   source ─► gain (the player's own volume) ─► limiter ─► shelf ─► master
 *
 * The limiter is a hard, fast brickwall well below the one on the main bus, so
 * an anthem cannot be the loudest thing in the mix however it was encoded. The
 * shelf takes two decibels off the top: a track that has been levelled *up*
 * has had its hiss levelled up with it, and this is what stops that reading as
 * a fault in the game.
 *
 * It joins the mix at `master`, so a player who turns the master volume down
 * turns anthems down with it — and it has its own gain besides, so a player
 * who wants the game and not other people's music can have exactly that.
 * ────────────────────────────────────────────────────────────────────────── */

function initAnthemBus() {
  const gain = ctx.createGain();
  gain.gain.value = 0;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  const shelf = ctx.createBiquadFilter();
  shelf.type = 'highshelf';
  shelf.frequency.value = 9000;
  shelf.gain.value = -2;

  gain.connect(limiter);
  limiter.connect(shelf);
  shelf.connect(master);

  anthem = { gain, source: null, token: 0 };
}

/**
 * Decodes an anthem, once, and remembers it.
 *
 * Keyed by URL, and the URL carries a content hash — so a track that changes is
 * a different key and a track that has not cannot be decoded twice. The browser
 * cache does the same job one layer down for the *bytes*; this is about the
 * decode, which is the expensive half and would otherwise happen on the frame
 * somebody died.
 *
 * A failure is cached too, as null. An anthem that 404s is going to 404 every
 * time this player is killed by that player, and re-fetching it each death is
 * a request per death for a file that is not there.
 *
 * @param {string} url
 * @returns {Promise<AudioBuffer|null>}
 */
const anthemCache = new Map();

export function loadAnthem(url) {
  if (!url || !ctx) return Promise.resolve(null);
  if (anthemCache.has(url)) return anthemCache.get(url);
  const job = fetch(url, { credentials: 'omit', cache: 'force-cache' })
    .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
    .then((bytes) => ctx.decodeAudioData(bytes))
    .catch(() => null);
  anthemCache.set(url, job);
  return job;
}

/**
 * Plays one decoded anthem, replacing whatever was playing.
 *
 * `token` is what makes a second death during a first one safe: every start
 * claims a number, and the stop handler only clears the chain if the number it
 * was given is still the current one. Without it, a fast respawn-and-die would
 * have the *first* anthem's `onended` tear down the *second* one's source.
 *
 * @param {AudioBuffer} buffer
 * @param {{volume?:number, fadeIn?:number}} opts
 * @returns {number} how many seconds it will play for
 */
export function playAnthem(buffer, { volume = 1, fadeIn = 0.12 } = {}) {
  if (!ctx || !anthem || !buffer) return 0;
  stopAnthem(0.04);
  const token = ++anthem.token;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(anthem.gain);
  src.onended = () => { if (anthem.token === token) anthem.source = null; };
  anthem.source = src;

  const t = now();
  anthem.gain.gain.cancelScheduledValues(t);
  anthem.gain.gain.setValueAtTime(0, t);
  anthem.gain.gain.linearRampToValueAtTime(clamp(volume, 0, 1), t + fadeIn);
  src.start(t);
  return buffer.duration;
}

/** Fades the anthem out and lets go of it. Safe to call when none is playing. */
export function stopAnthem(fade = 0.25) {
  if (!ctx || !anthem?.source) return;
  const src = anthem.source;
  const t = now();
  anthem.gain.gain.cancelScheduledValues(t);
  // From wherever it actually is rather than from the target: cancelling
  // scheduled values leaves the parameter at its current value, and ramping
  // from a value it was never at is a step, which is a click.
  anthem.gain.gain.setValueAtTime(anthem.gain.gain.value, t);
  anthem.gain.gain.linearRampToValueAtTime(0, t + fade);
  anthem.source = null;
  try { src.stop(t + fade + 0.02); } catch { /* already stopped */ }
}

/** Is an anthem playing right now? The kill cam asks, to caption itself. */
export const anthemPlaying = () => !!anthem?.source;

export function resumeAudio() {
  if (ctx?.state === 'suspended') ctx.resume();
}

export function setMasterVolume(v) {
  if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

/**
 * How many voices are alive right now, and the ceiling they are counted
 * against. Exported so the mixer can be measured rather than assumed: "a
 * distant shot costs fewer voices than a near one" is a claim about the
 * distance model, and it is only true for as long as something checks.
 */
export const voiceCount = () => voices;
export { MAX_VOICES };

/**
 * A saturation curve that is straight in the middle and bends at the ends.
 *
 * `tanh` shaped rather than a hard knee: the first 70% of the range is
 * effectively linear, so ordinary play is untouched, and only the peaks — a
 * rocket, a nuke, six rifles at once — get rounded.
 */
function softClipCurve(n = 2048) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.35) / Math.tanh(1.35);
  }
  return curve;
}

/**
 * Noise, in three colours.
 *
 * White is flat and reads as hiss — right for a supersonic crack and wrong for
 * almost everything else. Pink falls 3 dB per octave and is what most natural
 * broadband sound actually looks like, so it is the default body of an impact
 * or a footstep. Brown falls 6 dB and carries the weight under an explosion.
 * Using the right one is worth more than any amount of filtering the wrong one.
 */
function makeNoise(seconds, colour) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);

  if (colour === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  if (colour === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }
  // Pink, by the Paul Kellet filter — six one-poles summed. Cheap, and close
  // enough to -3 dB/octave that no ear in a firefight is going to argue.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

/**
 * One impulse response, built rather than loaded.
 *
 * Two parts, because a real one has two. `taps` discrete early reflections give
 * the space a size — the ear reads the gap before the first one as the distance
 * to the nearest wall — and a diffuse exponential tail underneath gives it a
 * volume. `damp` is what makes it sound like a room rather than a spring: the
 * top end of the tail is rolled off progressively, so the reverb gets darker as
 * it dies exactly the way air and soft surfaces make it.
 *
 * The two channels are decorrelated, which is what makes the tail *wide*
 * instead of a mono blob sitting in the middle of the head.
 */
function impulse({ seconds, decay, taps, spread, damp }) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    // A one-pole low-pass whose cutoff falls as the tail decays.
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = (1 - t) ** decay;
      const raw = (Math.random() * 2 - 1) * env;
      // Coefficient walks from "open" to "very dark" across the tail.
      const a = 1 - (0.06 + damp * 0.9 * t);
      lp += a * (raw - lp);
      d[i] = lp;
    }
    // Early reflections, scattered slightly differently per channel.
    for (let k = 0; k < taps; k++) {
      const at = Math.floor((0.004 + Math.random() * spread) * ctx.sampleRate);
      if (at >= len) continue;
      d[at] += (Math.random() * 2 - 1) * (1 - at / len) ** 2 * 1.5;
    }
  }
  return ir;
}

/** One reverb bus: a convolver behind a gain, wired into the master. */
function makeSend(ir, level) {
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  const gain = ctx.createGain();
  gain.gain.value = level;
  conv.connect(gain);
  gain.connect(master);
  const input = ctx.createGain();
  input.connect(conv);
  // The *parameter* rather than the node, because the ducker automates it —
  // and `level` alongside, because the ducker has to know what to come back up
  // to, and reading that off a parameter that is mid-ramp is how a duck slowly
  // turns into a fade.
  return { input, gain: gain.gain, level };
}

/**
 * Ducks the reverb for a moment.
 *
 * Something very loud fills the tail with itself, and the next transient lands
 * inside that wash and reads as mush. Pulling the sends down for a fifth of a
 * second and letting them back up keeps the room without letting it swallow
 * the next shot — the trick every game mix uses and none of them mention.
 */
function duck(amount = 0.45, hold = 0.18) {
  if (!sends) return;
  const t = now();
  for (const send of [sends.early, sends.tail]) {
    const base = send.level;
    send.gain.cancelScheduledValues(t);
    send.gain.setValueAtTime(send.gain.value, t);
    send.gain.linearRampToValueAtTime(base * (1 - amount), t + 0.02);
    send.gain.setTargetAtTime(base, t + hold, 0.22);
  }
}

/* ── Placement ────────────────────────────────────────────────────────────── */

/**
 * Where a world-space sound is, relative to the ears.
 *
 * `gain` falls off on an inverse curve rather than inverse-square: real
 * inverse-square makes anything past twenty units inaudible, which is
 * technically correct and useless in a game where the thing you most need to
 * hear is a fight on the far side of the map.
 *
 * `behind` is what lets a sound behind you be filtered differently from one in
 * front. It is not HRTF, but a shot at your back being duller than the same
 * shot in front is most of the cue people actually use.
 */
function spatial(pos, listener) {
  if (!pos || !listener) return { gain: 1, pan: 0, dist: 0, behind: 0 };
  const dx = pos.x - listener.pos.x;
  const dy = pos.y - listener.pos.y;
  const dz = pos.z - listener.pos.z;
  const dist = Math.hypot(dx, dy, dz);
  const len = dist || 1;
  const gain = 1 / (1 + (dist / 15) ** 1.32);
  const pan = clamp((dx * listener.right.x + dz * listener.right.z) / len, -1, 1);
  // The forward axis is the right vector turned ninety degrees, which is the
  // one the listener already gives us.
  const forward = (dx * -listener.right.z + dz * listener.right.x) / len;
  return { gain, pan, dist, behind: clamp(-forward, 0, 1) };
}

/**
 * Air absorption for a distance, as a low-pass corner in hertz.
 *
 * A real figure would be per-frequency and humidity-dependent. This is the part
 * of it an ear notices: the top end goes first, and it goes fast.
 */
const airCut = (dist) => Math.max(620, 19000 / (1 + dist / 8.5));

/* ── Voices ───────────────────────────────────────────────────────────────
 *
 *   source ─► [filter] ─► gain ─► [panner] ─┬─► master
 *                                           ├─► early send
 *                                           └─► tail send
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Builds the output half of one voice and returns its gain node.
 *
 * `width` is a Haas trick: delaying one ear by a handful of milliseconds makes
 * a mono source read as wide without touching its level or its position. It is
 * applied only at distance, where the direct sound and its first reflections
 * really have separated by the time they arrive.
 */
function voice(pan = 0, { early = 0, tail = 0, cut = 0, hp = 0, width = 0 } = {}) {
  const g = ctx.createGain();
  let node = g;

  if (hp > 20) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    f.Q.value = 0.6;
    node.connect(f);
    node = f;
  }
  if (cut > 0 && cut < 20000) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cut;
    f.Q.value = 0.6;
    node.connect(f);
    node = f;
  }

  const pannerFor = (at) => {
    if (!ctx.createStereoPanner) return null;
    const sp = ctx.createStereoPanner();
    sp.pan.value = clamp(at, -1, 1);
    return sp;
  };

  // The direct path.
  const direct = pannerFor(pan);
  if (direct) { node.connect(direct); direct.connect(master); }
  else node.connect(master);

  // The wide path: the same signal a few milliseconds later, pulled towards
  // the other ear and dropped in level. Two paths in parallel rather than one
  // channel-split, because splitting a stereo panner's output into a merger
  // collapses it back to mono and throws away the placement we just made.
  if (width > 0.01) {
    const delay = ctx.createDelay(0.06);
    delay.delayTime.value = 0.005 + width * 0.018;
    const trim = ctx.createGain();
    trim.gain.value = 0.5 * width;
    node.connect(delay);
    delay.connect(trim);
    const wide = pannerFor(-pan * 0.75);
    if (wide) { trim.connect(wide); wide.connect(master); }
    else trim.connect(master);
  }

  // Sends tap the pre-pan signal: reverb has no business being panned, and
  // a tail that sits where the source was is a tail with no room around it.
  if (early > 0 && sends) {
    const e = ctx.createGain();
    e.gain.value = early;
    node.connect(e);
    e.connect(sends.early.input);
  }
  if (tail > 0 && sends) {
    const t = ctx.createGain();
    t.gain.value = tail;
    node.connect(t);
    t.connect(sends.tail.input);
  }
  return g;
}

/**
 * Counts a voice in, and back out exactly once when it has finished.
 *
 * Both an `onended` handler and a timer, because neither alone is reliable: a
 * few browsers never fire `onended` for a source that was stopped rather than
 * run out, and a tab that is throttled in the background runs the timer late.
 * The latch is what stops the two of them from releasing the same voice twice
 * and slowly convincing the mixer it has room it does not have.
 */
function claim(src, at, until) {
  if (voices >= MAX_VOICES) return false;
  voices++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    voices--;
  };
  src.onended = release;
  setTimeout(release, Math.max(40, (until - at) * 1000 + 150));
  return true;
}

/**
 * One burst of filtered noise — the workhorse behind every percussive sound.
 *
 * `colour` picks which noise buffer it comes out of, `attack` shapes how sharp
 * the front of it is, and `sweep`/`q` animate the filter so the burst *moves*
 * rather than just fading. A static filter over a noise envelope is the sound
 * of a cheap synthesiser; a filter that falls through the decay is the sound of
 * something physical losing energy.
 */
function noise(dur, {
  type = 'bandpass', freq = 900, q = 0.7, gain = 0.4, pan = 0,
  decay = null, sweep = null, qSweep = null, early = 0, tail = 0, cut = 0, hp = 0,
  delay = 0, rate = null, attack = 0.002, colour = 'pink', width = 0, curve = 2.2,
} = {}) {
  if (!started || gain < 0.0012 || voices >= MAX_VOICES) return;

  const src = ctx.createBufferSource();
  src.buffer = buffers[colour] ?? buffers.pink;
  src.playbackRate.value = rate ?? rnd(0.82, 1.24);

  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  filt.Q.value = q;

  const out = voice(pan, { early, tail, cut, hp, width });
  const t = now() + delay;
  const d = decay ?? dur;
  if (!claim(src, t, t + d)) return;

  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
  // setValueCurve would be exact; a two-segment exponential is close, far
  // cheaper, and the second segment is what gives a percussive tail its shape.
  out.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * 0.34), t + attack + d * 0.22);
  out.gain.exponentialRampToValueAtTime(0.00008, t + d * curve * 0.5);

  if (sweep) filt.frequency.exponentialRampToValueAtTime(Math.max(30, sweep), t + d);
  if (qSweep) filt.Q.linearRampToValueAtTime(qSweep, t + d);

  src.connect(filt);
  filt.connect(out);
  // A random offset into a two-second buffer: the same noise never plays twice.
  src.start(t, Math.random() * 1.6);
  src.stop(t + d * curve * 0.5 + 0.03);
}

/**
 * One pitched voice.
 *
 * `harm` stacks a quiet octave-and-a-fifth above the fundamental, which is what
 * separates "a note" from "a thing that rang". Costs one extra oscillator and
 * is the difference between a metal impact that pings and one that beeps.
 */
function tone(freq, dur, {
  type = 'sine', gain = 0.2, pan = 0, sweepTo = null, early = 0, tail = 0,
  cut = 0, delay = 0, attack = 0.004, harm = 0, detune = 0, width = 0,
} = {}) {
  if (!started || gain < 0.0012 || voices >= MAX_VOICES) return;

  const osc = ctx.createOscillator();
  osc.type = type;
  if (detune) osc.detune.value = detune;
  const out = voice(pan, { early, tail, cut, width });
  const t = now() + delay;
  if (!claim(osc, t, t + dur)) return;

  osc.frequency.setValueAtTime(freq, t);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(18, sweepTo), t + dur);

  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
  out.gain.exponentialRampToValueAtTime(0.00008, t + dur);

  osc.connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);

  if (harm > 0) {
    const h = ctx.createOscillator();
    h.type = 'sine';
    const hOut = voice(pan, { early, tail, cut });
    if (claim(h, t, t + dur * 0.7)) {
      h.frequency.setValueAtTime(freq * 2.76, t);
      if (sweepTo) h.frequency.exponentialRampToValueAtTime(Math.max(18, sweepTo * 2.76), t + dur * 0.7);
      hOut.gain.setValueAtTime(0.0001, t);
      hOut.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * harm), t + attack);
      hOut.gain.exponentialRampToValueAtTime(0.00008, t + dur * 0.7);
      h.connect(hOut);
      h.start(t);
      h.stop(t + dur * 0.7 + 0.02);
    }
  }
}

/**
 * A very short broadband transient — the *click* at the front of a sound.
 *
 * Almost every percussive noise in the real world starts with two or three
 * milliseconds of nearly-flat spectrum before the resonances take over, and
 * leaving it out is the most common reason synthesised percussion sounds soft.
 */
function transient(gain, { pan = 0, freq = 5200, dur = 0.006, delay = 0, cut = 0 } = {}) {
  noise(dur, {
    type: 'highpass', freq, q: 0.4, gain, pan, colour: 'white',
    attack: 0.0006, delay, cut, curve: 1.4,
  });
}

const vol = () => settings.sfxVolume;

/* ── Surface recipes ──────────────────────────────────────────────────────
 *
 * One entry per surface family, and every field of it is used: the family
 * decides the filter shape, the pitch, how long it rings, whether it rings at
 * all, and which noise colour it is made of. A concrete hit and a metal hit
 * differ in six ways here, not in one frequency number.
 * ────────────────────────────────────────────────────────────────────────── */
const IMPACT = {
  stone: { type: 'bandpass', freq: 2200, q: 1.7, dur: 0.09, gain: 0.34, sweep: 620, colour: 'pink', ring: 0, punch: 190 },
  metal: { type: 'bandpass', freq: 3400, q: 3.4, dur: 0.14, gain: 0.36, sweep: 1500, colour: 'white', ring: 0.42, punch: 240 },
  wood: { type: 'bandpass', freq: 1150, q: 1.4, dur: 0.1, gain: 0.32, sweep: 330, colour: 'pink', ring: 0.16, punch: 150 },
  sand: { type: 'lowpass', freq: 1000, q: 0.5, dur: 0.12, gain: 0.24, sweep: 220, colour: 'white', ring: 0, punch: 0 },
  dirt: { type: 'lowpass', freq: 760, q: 0.5, dur: 0.13, gain: 0.26, sweep: 170, colour: 'brown', ring: 0, punch: 110 },
  snow: { type: 'highpass', freq: 2400, q: 0.5, dur: 0.09, gain: 0.19, sweep: 1200, colour: 'white', ring: 0, punch: 0 },
  glass: { type: 'highpass', freq: 3900, q: 1.8, dur: 0.19, gain: 0.32, sweep: 2400, colour: 'white', ring: 0.55, punch: 0 },
  foliage: { type: 'bandpass', freq: 4800, q: 0.9, dur: 0.11, gain: 0.19, sweep: 1900, colour: 'white', ring: 0, punch: 0 },
};

/** Footsteps: the same families, heard from underneath rather than in front. */
const STEP = {
  stone: { freq: 480, hp: 150, colour: 'pink', crisp: 0.5 },
  metal: { freq: 820, hp: 260, colour: 'white', crisp: 1 },
  wood: { freq: 400, hp: 120, colour: 'pink', crisp: 0.45 },
  sand: { freq: 300, hp: 90, colour: 'white', crisp: 0.7 },
  dirt: { freq: 270, hp: 70, colour: 'brown', crisp: 0.2 },
  snow: { freq: 620, hp: 200, colour: 'white', crisp: 0.85 },
  glass: { freq: 880, hp: 300, colour: 'white', crisp: 1 },
  foliage: { freq: 700, hp: 240, colour: 'white', crisp: 0.9 },
};

export const sfx = {
  /**
   * A weapon report. `spec` is the `sound` block out of shared/weapons.js.
   *
   * Five layers, and how much of each you hear is entirely a function of how
   * far away it is:
   *
   *   transient  the two-millisecond click of the primer and the action
   *   punch      a pitched thump that falls fast — the pressure wave
   *   body       broadband low-mid weight, the part that carries
   *   crack      the supersonic snap, which is what dies first with distance
   *   tail       the map answering, delayed by the time sound takes to get back
   *
   * Near you it is transient, crack and mechanism. Eighty units away the crack
   * is gone, the top end has been eaten by the air, the whole thing arrives a
   * quarter of a second late and it is mostly tail — which is exactly how you
   * can tell, without looking, that the fight is on the other side of the map.
   */
  shot(spec, pos = null, listener = null) {
    if (!started || !spec) return;
    const { gain: sg, pan, dist, behind } = spatial(pos, listener);
    const near = pos === null;
    const g = (spec.gain ?? 0.7) * sg * vol() * vary(0.07);
    if (g < 0.0035) return;

    // Every shot is a slightly different gun. Held tight enough that a weapon
    // still has an identity, wide enough that two in a row never match.
    const p = vary(0.045);

    const cut = near ? 0 : airCut(dist) * (1 - behind * 0.28);
    const travel = near ? 0 : (dist / UNITS_PER_METRE) / SPEED_OF_SOUND;
    const far = Math.min(1, dist / 55);
    const early = near ? 0.26 : clamp(0.3 + far * 0.4, 0, 0.8);
    const tail = near ? 0.2 : clamp(0.25 + far * 0.75, 0, 1);
    const width = near ? 0 : far * 0.8;

    // 1 — transient. The one layer that is the same at any distance except in
    //     level: a click is a click, it just gets quieter and darker.
    transient(g * 0.5 * (1 - far * 0.75), { pan, freq: 6200 * p, delay: travel, cut });

    // 2 — punch. A pitched thump with a very fast downward sweep: this is the
    //     layer you feel, and the one that makes a rifle different from a
    //     firework.
    tone(spec.body * 1.9 * p, spec.bodyDecay * 0.55, {
      type: 'triangle', gain: g * spec.bodyGain * 0.62, pan,
      sweepTo: spec.body * 0.55, early, tail: tail * 0.4, cut,
      delay: travel, attack: 0.0012,
    });

    // 3 — body. Broadband, low-passed, and *louder* in relative terms the
    //     further away it is: it is the only part that survives the trip.
    noise(spec.bodyDecay * 1.15, {
      type: 'lowpass', freq: spec.body * 5.5 * p, q: 0.8, colour: 'brown',
      gain: g * spec.bodyGain * (1 + far * 0.55), pan, sweep: spec.body * 0.75,
      early, tail, cut, delay: travel, attack: 0.0018, width,
    });

    // 4 — crack. Sharp, high, and the first thing distance takes away.
    noise(spec.crackDecay, {
      type: 'highpass', freq: spec.crack * p, q: 0.9, colour: 'white',
      gain: g * spec.crackGain * (1 - far * 0.8), pan, sweep: spec.crack * 0.4,
      cut, delay: travel, attack: 0.0008, curve: 1.6,
    });
    // A resonant peak riding on top of the crack. Gives the report a *pitch*
    // you can identify a weapon by rather than a generic bang.
    noise(spec.crackDecay * 1.4, {
      type: 'bandpass', freq: spec.crack * 0.55 * p, q: 2.2, colour: 'white',
      gain: g * spec.crackGain * 0.5 * (1 - far * 0.6), pan,
      sweep: spec.crack * 0.28, qSweep: 0.7, cut, delay: travel + 0.001,
    });

    // 5 — tail. Delayed by the round trip out to the geometry and back, which
    //     is why a shot in the open sounds different from one in a corridor.
    noise(spec.tail * (1 + far * 0.5), {
      type: 'lowpass', freq: (spec.tailFreq ?? 900) * p, q: 0.4, colour: 'pink',
      gain: g * spec.tailGain * (0.65 + far * 0.9), pan,
      sweep: (spec.tailFreq ?? 900) * 0.22,
      early: early * 0.4, tail: tail + 0.25, cut,
      delay: travel + 0.014 + dist / 340, attack: 0.01, width,
    });

    // 6 — mechanism. Only your own weapon: the bolt, the spring, the sear.
    if (near && spec.mechGain > 0) {
      noise(0.03, {
        type: 'bandpass', freq: spec.mech * vary(0.08), q: 3.4, colour: 'white',
        gain: g * spec.mechGain, delay: 0.018, attack: 0.0008,
      });
      tone(spec.mech * 0.45, 0.05, {
        type: 'square', gain: g * spec.mechGain * 0.3, delay: 0.02, sweepTo: spec.mech * 0.25,
      });
    }

    // Anything big enough clears room in the reverb for what comes next.
    if (g > 0.35) duck(0.3, 0.1);
  },

  /** The snap of a round passing close by. Nothing tells you faster to move. */
  whizz(pan = 0, close = 0.5) {
    if (!started) return;
    const g = (0.09 + close * 0.26) * vol();
    // A doppler sweep rather than a static tone: the thing is *going past*.
    noise(0.05, {
      type: 'bandpass', freq: (1700 + close * 2800) * vary(0.12), q: 7, colour: 'white',
      gain: g, pan, sweep: 520, rate: 1.5, attack: 0.0007, curve: 1.5,
    });
    tone(2600 + close * 1400, 0.045, {
      type: 'sine', gain: g * 0.36, pan, sweepTo: 620, attack: 0.001,
    });
    transient(g * 0.4, { pan, freq: 7000 });
  },

  /**
   * The hitmarker.
   *
   * Three distinct sounds because they carry three different pieces of
   * information, and a player has a fraction of a second to tell them apart:
   * a body hit is a short blunt tap, a headshot is bright and metallic, and a
   * kill is the two-note figure everything else in the game reserves for
   * "that worked".
   */
  hitmarker(head = false, kill = false) {
    if (!started || !settings.hitSound) return;
    const g = 0.3 * vol();
    if (kill) {
      transient(g * 0.5, { freq: 6000 });
      tone(1240, 0.05, { type: 'triangle', gain: g, attack: 0.001, harm: 0.25 });
      tone(1860, 0.11, { type: 'triangle', gain: g * 0.85, delay: 0.042, early: 0.2, harm: 0.3 });
    } else if (head) {
      transient(g * 0.6, { freq: 7400 });
      tone(1820, 0.06, { type: 'square', gain: g * 0.75, attack: 0.0008 });
      tone(2620, 0.08, { type: 'sine', gain: g * 0.5, delay: 0.01, sweepTo: 2200 });
    } else {
      transient(g * 0.45, { freq: 5200 });
      tone(1180, 0.05, { type: 'square', gain: g * 0.8, attack: 0.0008, sweepTo: 980 });
    }
  },

  kill() {
    if (!started) return;
    const g = 0.24 * vol();
    tone(660, 0.09, { type: 'triangle', gain: g, harm: 0.2, early: 0.2 });
    tone(990, 0.15, { type: 'triangle', gain: g, delay: 0.068, harm: 0.25, early: 0.25 });
  },

  /**
   * Being hit. Scales with the damage, and not only in volume: a big hit is
   * lower, longer and lands with more of a thump.
   */
  hurt(amount = 20) {
    if (!started) return;
    const heavy = clamp(amount / 60, 0, 1);
    const g = Math.min(0.5, 0.15 + amount / 240) * vol();
    noise(0.18 + heavy * 0.1, {
      type: 'lowpass', freq: 900 - heavy * 300, colour: 'brown',
      gain: g, sweep: 150, early: 0.2, tail: 0.16, attack: 0.0015,
    });
    tone(175 - heavy * 55, 0.2, {
      type: 'sine', gain: 0.16 * vol(), sweepTo: 74, attack: 0.002,
    });
    // A short breath of noise under it: the wind going out of you.
    noise(0.3, {
      type: 'bandpass', freq: 620, q: 0.8, colour: 'white',
      gain: g * 0.22, sweep: 240, delay: 0.05, attack: 0.03,
    });
    duck(0.25, 0.12);
  },

  /** Bullet striking your own body — the wet thump nobody wants to hear. */
  fleshHit() {
    if (!started) return;
    const g = 0.26 * vol();
    transient(g * 0.35, { freq: 3400 });
    noise(0.09, {
      type: 'lowpass', freq: 660 * vary(0.15), colour: 'brown',
      gain: g, sweep: 190, attack: 0.001,
    });
    tone(120, 0.08, { type: 'sine', gain: g * 0.5, sweepTo: 60 });
  },

  die() {
    if (!started) return;
    const g = vol();
    tone(300, 0.8, { type: 'sawtooth', gain: 0.19 * g, sweepTo: 52, early: 0.3, tail: 0.5 });
    tone(151, 0.9, { type: 'sine', gain: 0.16 * g, sweepTo: 32, tail: 0.5, detune: -12 });
    noise(0.6, {
      type: 'lowpass', freq: 480, colour: 'brown', gain: 0.2 * g, sweep: 70,
      early: 0.3, tail: 0.55, attack: 0.004,
    });
    duck(0.5, 0.4);
  },

  /**
   * A rocket going off.
   *
   * `pos.r` is the blast's own radius when the caller has it — the explosion
   * frame carries one — and a bigger warhead gets a longer, lower, slower boom
   * rather than the same one played louder. Four layers: the crack of the
   * detonation, the low body, the debris, and a very long tail.
   */
  explosion(pos = null, listener = null) {
    if (!started) return;
    const { gain: sg, pan, dist } = spatial(pos, listener);
    const g = sg * vol();
    if (g < 0.004) return;
    const k = Math.sqrt(Math.max(0.5, (pos?.r ?? 5.4) / 5.4)) * vary(0.06);
    const cut = airCut(dist) * 0.85;
    const travel = (dist / UNITS_PER_METRE) / SPEED_OF_SOUND;
    const far = Math.min(1, dist / 60);

    // The crack of the detonation itself — gone by forty units.
    transient(0.55 * g * (1 - far), { pan, freq: 8000, delay: travel, cut });
    noise(0.3, {
      type: 'highpass', freq: 2200, colour: 'white',
      gain: 0.32 * g * (1 - far * 0.8), pan, cut, delay: travel, attack: 0.001,
    });

    // The body: brown noise and a sine an octave below anything else in the game.
    noise(0.9 * k, {
      type: 'lowpass', freq: 820, colour: 'brown', gain: 0.9 * g, pan,
      sweep: 52, early: 0.35, tail: 0.7, cut, delay: travel, attack: 0.003, width: far * 0.6,
    });
    tone(58 / k, 0.8 * k, {
      type: 'sine', gain: 0.6 * g, pan, sweepTo: 21, tail: 0.45, delay: travel, attack: 0.004,
    });

    // Debris, then the map answering for a long time afterwards.
    noise(0.55, {
      type: 'bandpass', freq: 2600, q: 0.7, colour: 'white',
      gain: 0.18 * g * (1 - far * 0.5), pan, sweep: 700, cut,
      delay: travel + 0.06, attack: 0.02, tail: 0.4,
    });
    noise(1.8 * k, {
      type: 'lowpass', freq: 460, colour: 'brown', gain: 0.24 * g, pan,
      sweep: 80, tail: 1, early: 0.3, cut, delay: travel + 0.08, attack: 0.05, width: 0.6,
    });
    duck(0.55, 0.32);
  },

  /**
   * A bullet hitting geometry.
   *
   * Three layers per surface: the impact transient, the material's own
   * resonance, and — for anything that rings — a pitched tail. The recipe comes
   * out of the surface family, so a round into a sheet of steel and one into
   * packed dirt are genuinely different sounds rather than the same one at
   * different frequencies.
   */
  impact(pos = null, listener = null, surface = 'concrete') {
    if (!started) return;
    const { gain: sg, pan, dist } = spatial(pos, listener);
    if (dist > 80) return;
    const fx = SURFACE_FX[surface];
    if (fx?.silent) return;
    const r = IMPACT[fx?.sound ?? 'stone'] ?? IMPACT.stone;
    const g = r.gain * sg * vol() * vary(0.12);
    if (g < 0.0025) return;
    const cut = airCut(dist);
    const travel = (dist / UNITS_PER_METRE) / SPEED_OF_SOUND;
    const p = vary(0.16);

    transient(g * 0.55, { pan, freq: 6800 * p, delay: travel, cut });
    noise(r.dur, {
      type: r.type, freq: r.freq * p, q: r.q, colour: r.colour,
      gain: g, pan, sweep: r.sweep, early: 0.28, tail: 0.16, cut,
      delay: travel, attack: 0.0009,
    });
    // The thud under the spray — what the surface does, not what the round does.
    if (r.punch) {
      tone(r.punch * p, 0.06, {
        type: 'sine', gain: g * 0.45, pan, sweepTo: r.punch * 0.5, delay: travel, attack: 0.001,
      });
    }
    // Metal and glass keep ringing. Two partials, deliberately not harmonic:
    // a struck plate is not a musical instrument.
    if (r.ring) {
      tone(r.freq * p * 1.02, 0.22, {
        type: 'sine', gain: g * r.ring, pan, sweepTo: r.freq * 0.72,
        early: 0.3, tail: 0.24, delay: travel, attack: 0.001,
      });
      tone(r.freq * p * 1.61, 0.15, {
        type: 'sine', gain: g * r.ring * 0.45, pan, sweepTo: r.freq * 1.2,
        tail: 0.2, delay: travel + 0.004,
      });
    }
  },

  /** A spent case hitting the floor: two bounces, never the same twice. */
  shell() {
    if (!started) return;
    const g = 0.1 * vol() * vary(0.25);
    const f = rnd(3000, 5400);
    for (const [at, level, pitch] of [[0, 1, 1], [rnd(0.07, 0.13), 0.55, 1.14], [rnd(0.19, 0.28), 0.24, 1.3]]) {
      transient(g * 0.5 * level, { freq: f * 1.4, delay: at });
      tone(f * pitch, 0.055 * level + 0.02, {
        type: 'sine', gain: g * 0.6 * level, sweepTo: f * pitch * 0.55,
        delay: at, attack: 0.0008, early: 0.3, harm: 0.3,
      });
      noise(0.03, {
        type: 'bandpass', freq: f * pitch * 1.3, q: 7, colour: 'white',
        gain: g * level, delay: at, attack: 0.0006,
      });
    }
  },

  /**
   * Reload stages: magazine out, magazine in, action charged.
   *
   * Each one is a mechanism, so each one is a transient plus a resonance plus
   * a small dull thump — the click of the catch, the ring of the housing, the
   * mass of the magazine actually arriving somewhere.
   */
  reload(stage = 'out') {
    if (!started) return;
    const g = 0.26 * vol();
    const p = vary(0.07);
    if (stage === 'out') {
      transient(g * 0.6, { freq: 6000 * p });
      noise(0.06, { type: 'bandpass', freq: 1600 * p, q: 3, colour: 'white', gain: g, attack: 0.0007 });
      tone(430 * p, 0.05, { type: 'square', gain: g * 0.26, sweepTo: 200 });
      // The magazine dropping clear, a moment later.
      tone(260 * p, 0.07, { type: 'sine', gain: g * 0.2, sweepTo: 130, delay: 0.1, early: 0.3 });
    } else if (stage === 'in') {
      transient(g * 0.7, { freq: 5000 * p });
      noise(0.075, { type: 'bandpass', freq: 1000 * p, q: 3.6, colour: 'white', gain: g * 1.1, attack: 0.0007 });
      tone(200 * p, 0.08, { type: 'square', gain: g * 0.42, sweepTo: 105, attack: 0.001 });
      tone(120 * p, 0.09, { type: 'sine', gain: g * 0.3, sweepTo: 62, early: 0.25 });
    } else {                                  // 'charge'
      transient(g * 0.8, { freq: 7200 * p });
      noise(0.045, { type: 'bandpass', freq: 2700 * p, q: 5.5, colour: 'white', gain: g * 0.95, attack: 0.0006 });
      // Spring, then the bolt slamming home.
      noise(0.05, { type: 'bandpass', freq: 1800 * p, q: 4.5, colour: 'white', gain: g, delay: 0.07, attack: 0.0006 });
      tone(310 * p, 0.06, { type: 'square', gain: g * 0.34, sweepTo: 150, delay: 0.072 });
      tone(155 * p, 0.07, { type: 'sine', gain: g * 0.24, sweepTo: 80, delay: 0.075, early: 0.3 });
    }
  },

  /** Bolt cycled or pump racked after a shot: back, then forward. */
  cycle() {
    if (!started) return;
    const g = 0.22 * vol();
    const p = vary(0.06);
    transient(g * 0.6, { freq: 6600 * p });
    noise(0.045, { type: 'bandpass', freq: 2300 * p, q: 5.5, colour: 'white', gain: g, attack: 0.0006 });
    tone(520 * p, 0.05, { type: 'square', gain: g * 0.2, sweepTo: 260 });
    transient(g * 0.7, { freq: 5400 * p, delay: 0.125 });
    noise(0.05, { type: 'bandpass', freq: 1450 * p, q: 4.5, colour: 'white', gain: g * 1.1, delay: 0.125, attack: 0.0006 });
    tone(230 * p, 0.07, { type: 'sine', gain: g * 0.3, sweepTo: 118, delay: 0.128, early: 0.3 });
  },

  dryFire() {
    if (!started) return;
    const g = 0.22 * vol();
    transient(g, { freq: 7600 });
    noise(0.035, { type: 'highpass', freq: 3800, colour: 'white', gain: g * 0.8, attack: 0.0005 });
    // The dead, unsatisfying thud of a hammer with nothing under it.
    tone(148, 0.035, { type: 'square', gain: g * 0.36, sweepTo: 96, attack: 0.0008 });
  },

  switchWeapon() {
    if (!started) return;
    const g = 0.19 * vol();
    // Cloth and strap first, then the weapon settling into the hands.
    noise(0.13, { type: 'bandpass', freq: 2400, q: 0.8, colour: 'white', gain: g * 0.5, sweep: 900, attack: 0.012 });
    transient(g * 0.5, { freq: 5200, delay: 0.075 });
    noise(0.05, { type: 'bandpass', freq: 1350, q: 3, colour: 'white', gain: g, delay: 0.078, attack: 0.0008 });
    tone(240, 0.06, { type: 'sine', gain: g * 0.3, sweepTo: 130, delay: 0.08, early: 0.3 });
  },

  /**
   * A footstep.
   *
   * Two layers per surface: a low thump — the weight arriving — and a scuff of
   * the right colour on top. Snow and foliage are mostly the scuff, dirt is
   * almost entirely the thump, and metal has both plus a ring. Randomised hard
   * enough that a sprint down a corridor never sounds like a metronome.
   */
  footstep(hard = false, surface = 'concrete') {
    if (!started) return;
    const fx = SURFACE_FX[surface];
    if (fx?.silent) return;
    const family = fx?.sound ?? 'stone';
    const s = STEP[family] ?? STEP.stone;
    const g = (hard ? 0.17 : 0.09) * vol() * vary(0.22);
    const p = vary(0.14);

    // Weight.
    noise(hard ? 0.11 : 0.07, {
      type: 'lowpass', freq: s.freq * (hard ? 1.2 : 1) * p, q: 0.7, colour: 'brown',
      gain: g, sweep: s.freq * 0.3, early: 0.22, attack: 0.0018,
    });
    // Scuff.
    noise(hard ? 0.1 : 0.075, {
      type: 'highpass', freq: s.hp * 5 * p, q: 0.5, colour: 'white',
      gain: g * s.crisp * 0.55, sweep: s.hp * 2, early: 0.18, attack: 0.004,
    });
    if (family === 'metal') {
      tone(s.freq * 2.4 * p, 0.09, { type: 'sine', gain: g * 0.22, sweepTo: s.freq * 1.5, early: 0.35 });
    }
  },

  jump() {
    if (!started) return;
    const g = 0.1 * vol();
    noise(0.05, { type: 'lowpass', freq: 460 * vary(0.12), colour: 'brown', gain: g, sweep: 200, attack: 0.002 });
    // Kit and cloth on the way up.
    noise(0.11, { type: 'bandpass', freq: 3000, q: 0.7, colour: 'white', gain: g * 0.3, sweep: 1200, attack: 0.008 });
  },

  land(hard = false, surface = 'concrete') {
    if (!started) return;
    const g = vol();
    noise(hard ? 0.2 : 0.1, {
      type: 'lowpass', freq: hard ? 280 : 460, colour: 'brown',
      gain: (hard ? 0.32 : 0.14) * g, sweep: 74, early: 0.3, tail: hard ? 0.25 : 0.1, attack: 0.0018,
    });
    if (hard) {
      tone(84, 0.18, { type: 'sine', gain: 0.16 * g, sweepTo: 44, attack: 0.002, tail: 0.3 });
      // A grunt of impact — a short, low, formant-ish burst.
      noise(0.13, { type: 'bandpass', freq: 380, q: 2.4, colour: 'brown', gain: 0.1 * g, sweep: 220, delay: 0.02, attack: 0.01 });
    }
    this.footstep(hard, surface);
  },

  slide() {
    if (!started) return;
    const g = 0.18 * vol();
    // Two bands rather than one: a slide is grit under you and cloth around you.
    noise(0.55, {
      type: 'bandpass', freq: 1400, q: 0.6, colour: 'pink',
      gain: g, sweep: 320, early: 0.24, tail: 0.18, attack: 0.03,
    });
    noise(0.5, {
      type: 'highpass', freq: 3600, colour: 'white',
      gain: g * 0.4, sweep: 1400, attack: 0.05,
    });
    tone(140, 0.4, { type: 'sine', gain: g * 0.16, sweepTo: 70, attack: 0.04, tail: 0.2 });
  },

  spawn() {
    if (!started) return;
    const g = 0.16 * vol();
    // Rising, with the room opening up behind it.
    tone(440, 0.16, { type: 'sine', gain: g, sweepTo: 880, attack: 0.006, tail: 0.3, harm: 0.2 });
    tone(660, 0.2, { type: 'triangle', gain: g * 0.7, delay: 0.06, sweepTo: 990, tail: 0.35 });
    noise(0.35, {
      type: 'highpass', freq: 2600, colour: 'white', gain: g * 0.32,
      sweep: 8000, attack: 0.02, tail: 0.5,
    });
  },

  /**
   * Interface sounds.
   *
   * These are the sounds a player hears most and thinks about least, which is
   * exactly why they are worth designing rather than reaching for a beep. Every
   * one is a transient plus a short pitched body with a harmonic — small,
   * wooden, and quiet enough to live under a hundred clicks a session.
   */
  ui(kind = 'click') {
    if (!started) return;
    const g = 0.15 * vol();
    if (kind === 'click') {
      transient(g * 0.5, { freq: 5600 });
      tone(880, 0.035, { type: 'triangle', gain: g, attack: 0.0008, sweepTo: 700, harm: 0.3 });
      tone(1760, 0.02, { type: 'sine', gain: g * 0.3, attack: 0.0006 });
    } else if (kind === 'hover') {
      // Deliberately tiny: it fires on every pointer that crosses a button.
      tone(1500, 0.022, { type: 'sine', gain: g * 0.26, attack: 0.001, sweepTo: 1750 });
    } else if (kind === 'ok') {
      transient(g * 0.4, { freq: 6000 });
      tone(784, 0.07, { type: 'triangle', gain: g, attack: 0.001, harm: 0.3, early: 0.25 });
      tone(1175, 0.12, { type: 'triangle', gain: g * 0.9, delay: 0.055, harm: 0.35, early: 0.3 });
    } else if (kind === 'error') {
      // Two notes a semitone apart, together. There is no way to hear that as
      // anything but "no".
      tone(196, 0.2, { type: 'sawtooth', gain: g * 0.7, sweepTo: 150, attack: 0.002 });
      tone(207, 0.2, { type: 'sawtooth', gain: g * 0.45, sweepTo: 158, attack: 0.002, detune: 8 });
      noise(0.09, { type: 'lowpass', freq: 700, colour: 'brown', gain: g * 0.35, sweep: 200, attack: 0.002 });
    }
  },

  /** Levelling up: a rising arpeggio that actually resolves. */
  levelUp() {
    if (!started) return;
    const g = 0.22 * vol();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(f, 0.24, {
        type: 'triangle', gain: g * (1 - i * 0.08), delay: i * 0.085,
        early: 0.3, tail: 0.35, harm: 0.3, attack: 0.004,
      });
    });
    // A low root under it, so the figure has a floor to sit on.
    tone(130.81, 0.6, { type: 'sine', gain: g * 0.4, tail: 0.4, attack: 0.01 });
    tone(1567.98, 0.5, { type: 'sine', gain: g * 0.2, delay: 0.34, tail: 0.5 });
  },

  /** A challenge completed, a mastery tier reached — small, bright, distinct. */
  unlock() {
    if (!started) return;
    const g = 0.2 * vol();
    [783.99, 1046.5, 1318.5].forEach((f, i) => {
      tone(f, 0.18, { type: 'sine', gain: g * (1 - i * 0.1), delay: i * 0.065, tail: 0.4, harm: 0.25 });
    });
    noise(0.4, {
      type: 'highpass', freq: 5000, colour: 'white',
      gain: g * 0.22, sweep: 11000, delay: 0.05, attack: 0.03, tail: 0.5,
    });
  },

  /** The match clock running out: a descending figure, and the room emptying. */
  matchEnd() {
    if (!started) return;
    const g = 0.19 * vol();
    [783.99, 659.25, 523.25, 392].forEach((f, i) => {
      tone(f, 0.34, {
        type: 'triangle', gain: g * (1 + i * 0.05), delay: i * 0.13,
        early: 0.3, tail: 0.5, harm: 0.25, attack: 0.006,
      });
    });
    tone(98, 1.1, { type: 'sine', gain: g * 0.5, delay: 0.38, sweepTo: 82, tail: 0.6, attack: 0.02 });
    duck(0.3, 0.6);
  },

  /** Short rising blip for a score event. */
  points(big = false) {
    if (!started) return;
    const g = (big ? 0.15 : 0.09) * vol();
    tone(big ? 880 : 740, 0.07, {
      type: 'triangle', gain: g, sweepTo: big ? 1320 : 1040, attack: 0.0015, harm: big ? 0.3 : 0.15,
    });
    if (big) transient(g * 0.4, { freq: 6800 });
  },

  /**
   * A killstreak or objective sting.
   *
   * Three layers that arrive together: a low swell you feel, a mid figure you
   * hear, and a bright top that makes it cut through gunfire. `pitch` is what
   * separates one announcement from another.
   */
  sting(pitch = 1) {
    if (!started) return;
    const g = 0.21 * vol();
    tone(110 * pitch, 0.34, { type: 'sine', gain: g * 0.6, sweepTo: 82 * pitch, tail: 0.5, attack: 0.008 });
    tone(330 * pitch, 0.18, { type: 'sawtooth', gain: g * 0.5, sweepTo: 220 * pitch, early: 0.3, tail: 0.4 });
    tone(660 * pitch, 0.24, { type: 'triangle', gain: g, delay: 0.05, early: 0.35, tail: 0.45, harm: 0.3 });
    noise(0.3, {
      type: 'highpass', freq: 4200, colour: 'white', gain: g * 0.18,
      sweep: 9000, delay: 0.04, attack: 0.02, tail: 0.5,
    });
    duck(0.25, 0.2);
  },

  /** Match clock ticking down. Urgent is higher, harder and drier. */
  tick(urgent = false) {
    if (!started) return;
    const g = (urgent ? 0.13 : 0.075) * vol();
    transient(g * 0.7, { freq: urgent ? 7000 : 5200 });
    tone(urgent ? 1568 : 988, 0.035, { type: 'square', gain: g, attack: 0.0006, sweepTo: urgent ? 1320 : 880 });
  },

  /**
   * The nuke siren — a slow two-tone air-raid wail that runs the countdown.
   *
   * Called once per second while one is in the air, so it is one rising sweep
   * per call rather than a loop somebody has to remember to stop: whatever
   * happens to the match, the sound stops with the countdown that drives it.
   */
  siren(urgent = false) {
    if (!started) return;
    const g = 0.14 * vol();
    const top = urgent ? 560 : 440;
    // Up, then down: a real siren does not just fall.
    tone(top * 0.62, 0.62, { type: 'sawtooth', gain: g, sweepTo: top, early: 0.3, tail: 0.6, attack: 0.09 });
    tone(top * 0.31, 0.62, { type: 'square', gain: g * 0.45, sweepTo: top * 0.5, tail: 0.6, attack: 0.09 });
    tone(top * 1.5, 0.5, { type: 'sine', gain: g * 0.2, sweepTo: top * 0.9, delay: 0.08, tail: 0.55 });
  },

  /** …and the thing it was warning about. */
  nuke() {
    if (!started) return;
    const g = vol();
    // The flash: a hard transient and a wall of top end that immediately goes.
    transient(0.7 * g, { freq: 9000 });
    noise(0.55, { type: 'highpass', freq: 2800, colour: 'white', gain: 0.5 * g, sweep: 900, early: 0.4, tail: 0.5, attack: 0.001 });
    // The body: everything under a kilohertz, for two and a half seconds.
    noise(2.8, { type: 'lowpass', freq: 640, colour: 'brown', gain: g, sweep: 40, tail: 1, early: 0.4, attack: 0.006 });
    tone(44, 2.6, { type: 'sine', gain: 0.72 * g, sweepTo: 18, tail: 0.6, attack: 0.01 });
    tone(88, 1.5, { type: 'triangle', gain: 0.3 * g, sweepTo: 27, tail: 0.6, delay: 0.04 });
    // …and the map, for a very long time afterwards.
    noise(3.6, { type: 'lowpass', freq: 380, colour: 'brown', gain: 0.34 * g, sweep: 60, tail: 1, delay: 0.35, attack: 0.15, width: 0.9 });
    duck(0.75, 1.4);
  },
};

export default sfx;
