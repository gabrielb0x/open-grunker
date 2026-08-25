/**
 * Open Grunker — procedural audio.
 *
 * Every sound is synthesised at runtime: no audio files ship with the project,
 * so the whole client stays small and there is nothing to preload.
 *
 * A gunshot is built the way a real one is recorded — a mechanical transient,
 * a low body, a supersonic crack and a tail that decays into the map's
 * reverb — and how much of each you hear depends on how far away it is. Close
 * shots are all crack; distant ones are all body and tail, low-passed by the
 * air between you. That single relationship is most of what makes a firefight
 * legible by ear.
 */
import { settings } from './settings.js';
import { SURFACE_FX } from '/shared/constants.js';

let ctx = null;
let master = null;
let comp = null;
let reverb = null;
let reverbGain = null;
let noiseBuffer = null;
let started = false;

/** Creates the context on the first user gesture (browsers require this). */
export function initAudio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = settings.masterVolume;

  // A gentle limiter so a full-auto exchange never clips the output.
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 22;
  comp.ratio.value = 7;
  comp.attack.value = 0.004;
  comp.release.value = 0.16;
  master.connect(comp);
  comp.connect(ctx.destination);

  // 2 s of white noise, reused by every percussive sound.
  const len = Math.floor(ctx.sampleRate * 2);
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  // A short procedural impulse response — the room every gunshot tail lands in.
  const irLen = Math.floor(ctx.sampleRate * 1.05);
  const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < irLen; i++) {
      const t = i / irLen;
      // Early reflections in the first 60 ms, then a smooth exponential tail.
      const early = i < ctx.sampleRate * 0.06 && Math.random() < 0.02 ? 3 : 1;
      d[i] = (Math.random() * 2 - 1) * (1 - t) ** 3.1 * early;
    }
  }
  reverb = ctx.createConvolver();
  reverb.buffer = ir;
  reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.36;
  reverb.connect(reverbGain);
  reverbGain.connect(master);

  started = true;
  return ctx;
}

export function resumeAudio() {
  if (ctx?.state === 'suspended') ctx.resume();
}

export function setMasterVolume(v) {
  if (master) master.gain.value = v;
}

const now = () => ctx.currentTime;
const rnd = (a, b) => a + Math.random() * (b - a);

/** Positional gain/pan/occlusion for a world-space sound. */
function spatial(pos, listener) {
  if (!pos || !listener) return { gain: 1, pan: 0, dist: 0 };
  const dx = pos.x - listener.pos.x, dy = pos.y - listener.pos.y, dz = pos.z - listener.pos.z;
  const dist = Math.hypot(dx, dy, dz);
  const gain = 1 / (1 + (dist / 15) ** 1.32);
  const len = dist || 1;
  const pan = Math.max(-1, Math.min(1, (dx * listener.right.x + dz * listener.right.z) / len));
  return { gain, pan, dist };
}

/**
 * Output chain for one voice: gain → optional pan → master, with a parallel
 * reverb send. `cut` low-passes the whole voice, which is how distance is sold.
 */
function chain(pan = 0, send = 0, cut = 0) {
  const g = ctx.createGain();
  let node = g;
  if (cut > 0 && cut < 20000) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cut;
    f.Q.value = 0.5;
    g.connect(f);
    node = f;
  }
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    node.connect(p);
    p.connect(master);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      p.connect(s);
      s.connect(reverb);
    }
  } else {
    node.connect(master);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      node.connect(s);
      s.connect(reverb);
    }
  }
  return g;
}

function noise(dur, {
  type = 'bandpass', freq = 900, q = 0.7, gain = 0.4, pan = 0,
  decay = null, sweep = null, send = 0, cut = 0, delay = 0, rate = null,
} = {}) {
  if (!started || gain < 0.0015) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.playbackRate.value = rate ?? (0.8 + Math.random() * 0.45);
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  filt.Q.value = q;
  const out = chain(pan, send, cut);

  const t = now() + delay;
  const d = decay ?? dur;
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(gain, t + 0.003);
  out.gain.exponentialRampToValueAtTime(0.0001, t + d);
  if (sweep) filt.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), t + d);

  src.connect(filt);
  filt.connect(out);
  src.start(t, Math.random() * 1.5);
  src.stop(t + d + 0.02);
}

function tone(freq, dur, {
  type = 'sine', gain = 0.2, pan = 0, sweepTo = null, send = 0, cut = 0, delay = 0,
} = {}) {
  if (!started || gain < 0.0015) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  const out = chain(pan, send, cut);
  const t = now() + delay;
  osc.frequency.setValueAtTime(freq, t);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur);
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(gain, t + 0.005);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const vol = () => settings.sfxVolume;

/** Impact recipes per surface family. */
const IMPACT = {
  stone: { type: 'bandpass', freq: 2400, q: 1.5, dur: 0.085, gain: 0.3, sweep: 700 },
  metal: { type: 'bandpass', freq: 3600, q: 4.5, dur: 0.16, gain: 0.34, sweep: 1800, ring: true },
  wood: { type: 'bandpass', freq: 1200, q: 1.1, dur: 0.1, gain: 0.28, sweep: 380 },
  sand: { type: 'lowpass', freq: 900, q: 0.6, dur: 0.11, gain: 0.2, sweep: 260 },
  dirt: { type: 'lowpass', freq: 700, q: 0.6, dur: 0.12, gain: 0.22, sweep: 200 },
  snow: { type: 'highpass', freq: 2600, q: 0.5, dur: 0.09, gain: 0.16, sweep: 1400 },
  glass: { type: 'highpass', freq: 4200, q: 2, dur: 0.2, gain: 0.3, sweep: 2600, ring: true },
  foliage: { type: 'bandpass', freq: 5200, q: 0.9, dur: 0.1, gain: 0.16, sweep: 2200 },
};

export const sfx = {
  /**
   * Weapon report. `spec` is the `sound` block from shared/weapons.js.
   * Distance decides the mix: near you it is crack and mechanism, far away it
   * is body and tail through a low-pass, exactly the way real gunfire carries.
   */
  shot(spec, pos = null, listener = null) {
    if (!started || !spec) return;
    const { gain: sg, pan, dist } = spatial(pos, listener);
    const near = pos === null;
    const g = (spec.gain ?? 0.7) * sg * vol();
    if (g < 0.004) return;

    // Air absorption: a shot 80 units away has lost most of its top end.
    const cut = near ? 0 : Math.max(700, 18000 / (1 + dist / 9));
    const send = near ? 0.16 : Math.min(0.7, 0.2 + dist / 90);
    const far = Math.min(1, dist / 55);

    // 1 — body: the low thump you feel more than hear.
    noise(spec.bodyDecay, {
      type: 'lowpass', freq: spec.body * 6, gain: g * spec.bodyGain * (1 + far * 0.5),
      pan, sweep: spec.body * 0.8, send, cut,
    });
    tone(spec.body, spec.bodyDecay * 1.1, {
      type: 'triangle', gain: g * spec.bodyGain * 0.5, pan, sweepTo: spec.body * 0.4, send, cut,
    });

    // 2 — crack: the supersonic snap, which is what dies off with distance.
    noise(spec.crackDecay, {
      type: 'highpass', freq: spec.crack, q: 0.8,
      gain: g * spec.crackGain * (1 - far * 0.72), pan, sweep: spec.crack * 0.45, cut,
    });

    // 3 — tail: the map answering back.
    noise(spec.tail, {
      type: 'lowpass', freq: spec.tailFreq ?? 900, q: 0.4,
      gain: g * spec.tailGain * (0.7 + far * 0.8), pan,
      sweep: (spec.tailFreq ?? 900) * 0.25, send: send + 0.25, cut, delay: 0.012 + dist / 340,
    });

    // 4 — mechanism: only audible on your own weapon.
    if (near && spec.mechGain > 0) {
      noise(0.035, { type: 'bandpass', freq: spec.mech, q: 3, gain: g * spec.mechGain, delay: 0.02 });
    }
  },

  /** The snap of a round passing close by. Nothing tells you faster to move. */
  whizz(pan = 0, close = 0.5) {
    if (!started) return;
    const g = (0.1 + close * 0.24) * vol();
    noise(0.055, { type: 'bandpass', freq: 1800 + close * 2600, q: 6, gain: g, pan, sweep: 600, rate: 1.4 });
    tone(2400 + close * 1200, 0.05, { type: 'sine', gain: g * 0.4, pan, sweepTo: 700 });
  },

  hitmarker(head = false, kill = false) {
    if (!started || !settings.hitSound) return;
    const g = 0.3 * vol();
    if (kill) {
      tone(1180, 0.06, { type: 'square', gain: g });
      tone(1760, 0.1, { type: 'triangle', gain: g * 0.8, delay: 0.045 });
    } else if (head) {
      tone(1720, 0.07, { type: 'square', gain: g });
      tone(2450, 0.085, { type: 'sine', gain: g * 0.6, delay: 0.012 });
    } else {
      tone(1180, 0.06, { type: 'square', gain: g * 0.9 });
    }
  },

  kill() {
    if (!started) return;
    const g = 0.26 * vol();
    tone(660, 0.09, { type: 'triangle', gain: g });
    tone(990, 0.14, { type: 'triangle', gain: g, delay: 0.07 });
  },

  hurt(amount = 20) {
    if (!started) return;
    const g = Math.min(0.5, 0.16 + amount / 250) * vol();
    noise(0.2, { type: 'lowpass', freq: 800, gain: g, sweep: 180, send: 0.2 });
    tone(165, 0.18, { type: 'sine', gain: 0.15 * vol(), sweepTo: 85 });
  },

  /** Bullet striking your own body — the wet thump nobody wants to hear. */
  fleshHit() {
    if (!started) return;
    noise(0.1, { type: 'lowpass', freq: 620, gain: 0.24 * vol(), sweep: 200 });
  },

  die() {
    if (!started) return;
    tone(300, 0.75, { type: 'sawtooth', gain: 0.2 * vol(), sweepTo: 55, send: 0.4 });
    noise(0.55, { type: 'lowpass', freq: 460, gain: 0.2 * vol(), sweep: 80, send: 0.4 });
  },

  /**
   * A rocket going off. `pos.r` is the blast's own radius when the caller has
   * it — the explosion frame carries one — and a bigger warhead gets a longer,
   * lower boom rather than the same one played louder.
   */
  explosion(pos = null, listener = null) {
    if (!started) return;
    const { gain: sg, pan, dist } = spatial(pos, listener);
    const g = sg * vol();
    if (g < 0.005) return;
    const k = Math.sqrt(Math.max(0.5, (pos?.r ?? 5.4) / 5.4));
    const cut = Math.max(600, 16000 / (1 + dist / 7));
    noise(0.85 * k, { type: 'lowpass', freq: 900, gain: 0.85 * g, pan, sweep: 60, send: 0.55, cut });
    tone(62 / k, 0.75 * k, { type: 'sine', gain: 0.55 * g, pan, sweepTo: 24, send: 0.35 });
    noise(0.32, { type: 'highpass', freq: 2400, gain: 0.28 * g * (1 - Math.min(1, dist / 50)), pan, cut });
    noise(1.5 * k, { type: 'lowpass', freq: 500, gain: 0.22 * g, pan, sweep: 90, send: 0.9, delay: 0.06 });
  },

  /** Bullet hitting geometry — the recipe comes from the surface it hit. */
  impact(pos = null, listener = null, surface = 'concrete') {
    if (!started) return;
    const { gain: sg, pan, dist } = spatial(pos, listener);
    if (dist > 75) return;
    const family = SURFACE_FX[surface]?.sound ?? 'stone';
    if (SURFACE_FX[surface]?.silent) return;
    const r = IMPACT[family] ?? IMPACT.stone;
    const g = r.gain * sg * vol();
    noise(r.dur, {
      type: r.type, freq: r.freq * rnd(0.85, 1.2), q: r.q, gain: g, pan, sweep: r.sweep,
      send: 0.2, cut: Math.max(900, 18000 / (1 + dist / 8)),
    });
    if (r.ring) {
      tone(r.freq * rnd(0.8, 1.3), 0.14, { type: 'sine', gain: g * 0.3, pan, sweepTo: r.freq * 0.5, send: 0.3 });
    }
  },

  /** A spent case hitting the floor. */
  shell() {
    if (!started) return;
    const g = 0.09 * vol();
    noise(0.05, { type: 'bandpass', freq: rnd(3200, 5200), q: 6, gain: g });
    tone(rnd(2600, 4200), 0.07, { type: 'sine', gain: g * 0.55, sweepTo: 1400 });
  },

  /** Reload stages: magazine out, magazine in, action charged. */
  reload(stage = 'out') {
    if (!started) return;
    const g = 0.24 * vol();
    if (stage === 'out') {
      noise(0.07, { type: 'bandpass', freq: 1500, q: 2.4, gain: g });
      tone(420, 0.05, { type: 'square', gain: g * 0.3, sweepTo: 220 });
    } else if (stage === 'in') {
      noise(0.09, { type: 'bandpass', freq: 1000, q: 3, gain: g * 1.1 });
      tone(210, 0.07, { type: 'square', gain: g * 0.45, sweepTo: 120 });
    } else {                                  // 'charge'
      noise(0.05, { type: 'bandpass', freq: 2600, q: 5, gain: g * 0.9 });
      noise(0.06, { type: 'bandpass', freq: 1700, q: 4, gain: g, delay: 0.07 });
    }
  },

  /** Bolt cycled or pump racked after a shot. */
  cycle() {
    if (!started) return;
    const g = 0.2 * vol();
    noise(0.05, { type: 'bandpass', freq: 2200, q: 5, gain: g });
    noise(0.055, { type: 'bandpass', freq: 1400, q: 4.5, gain: g * 1.1, delay: 0.13 });
  },

  dryFire() {
    if (!started) return;
    noise(0.045, { type: 'highpass', freq: 3600, gain: 0.2 * vol() });
    tone(140, 0.04, { type: 'square', gain: 0.08 * vol() });
  },

  switchWeapon() {
    if (!started) return;
    noise(0.06, { type: 'bandpass', freq: 2000, q: 2.5, gain: 0.16 * vol() });
    noise(0.05, { type: 'bandpass', freq: 1200, q: 3, gain: 0.14 * vol(), delay: 0.09 });
  },

  footstep(hard = false, surface = 'concrete') {
    if (!started) return;
    const family = SURFACE_FX[surface]?.sound ?? 'stone';
    if (SURFACE_FX[surface]?.silent) return;
    const base = { stone: 520, metal: 900, wood: 420, sand: 320, dirt: 300, snow: 700, glass: 900, foliage: 800 }[family] ?? 520;
    noise(hard ? 0.13 : 0.08, {
      type: family === 'snow' || family === 'foliage' ? 'highpass' : 'lowpass',
      freq: base * (hard ? 1.25 : 1) * rnd(0.85, 1.2),
      gain: (hard ? 0.15 : 0.08) * vol(), sweep: base * 0.35, send: 0.14,
    });
  },

  jump() { if (started) noise(0.06, { type: 'lowpass', freq: 480, gain: 0.08 * vol() }); },

  land(hard = false, surface = 'concrete') {
    if (!started) return;
    noise(hard ? 0.22 : 0.11, {
      type: 'lowpass', freq: hard ? 300 : 480, gain: (hard ? 0.3 : 0.13) * vol(), sweep: 85, send: 0.2,
    });
    if (hard) tone(90, 0.16, { type: 'sine', gain: 0.14 * vol(), sweepTo: 50 });
    this.footstep(hard, surface);
  },

  slide() {
    if (!started) return;
    noise(0.5, { type: 'bandpass', freq: 1500, q: 0.6, gain: 0.17 * vol(), sweep: 340, send: 0.22 });
  },

  spawn() {
    if (!started) return;
    tone(440, 0.14, { type: 'sine', gain: 0.14 * vol(), sweepTo: 880 });
    tone(660, 0.18, { type: 'triangle', gain: 0.1 * vol(), delay: 0.06, sweepTo: 990 });
  },

  ui(kind = 'click') {
    if (!started) return;
    const g = 0.14 * vol();
    if (kind === 'click') tone(760, 0.045, { type: 'square', gain: g });
    else if (kind === 'hover') tone(1100, 0.025, { type: 'sine', gain: g * 0.4 });
    else if (kind === 'ok') { tone(660, 0.08, { type: 'triangle', gain: g }); tone(990, 0.11, { type: 'triangle', gain: g, delay: 0.06 }); }
    else if (kind === 'error') tone(200, 0.18, { type: 'sawtooth', gain: g, sweepTo: 130 });
  },

  levelUp() {
    if (!started) return;
    const g = 0.22 * vol();
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, { type: 'triangle', gain: g, delay: i * 0.09, send: 0.3 }));
  },

  /** A challenge completed, a mastery tier reached — small, bright, distinct. */
  unlock() {
    if (!started) return;
    const g = 0.2 * vol();
    [784, 1047, 1319].forEach((f, i) => tone(f, 0.16, { type: 'sine', gain: g, delay: i * 0.07, send: 0.35 }));
  },

  /** Descending fanfare when the match clock runs out. */
  matchEnd() {
    if (!started) return;
    const g = 0.18 * vol();
    [784, 659, 523, 392].forEach((f, i) => tone(f, 0.28, { type: 'triangle', gain: g, delay: i * 0.12, send: 0.4 }));
  },

  /** Short rising blip for a score event. */
  points(big = false) {
    if (!started) return;
    const g = (big ? 0.15 : 0.09) * vol();
    tone(big ? 880 : 740, 0.07, { type: 'triangle', gain: g, sweepTo: big ? 1320 : 1040 });
  },

  /** Killstreak / objective announcement sting. */
  sting(pitch = 1) {
    if (!started) return;
    const g = 0.2 * vol();
    tone(330 * pitch, 0.16, { type: 'sawtooth', gain: g * 0.6, sweepTo: 220 * pitch, send: 0.4 });
    tone(660 * pitch, 0.22, { type: 'triangle', gain: g, delay: 0.05, send: 0.4 });
  },

  /** Match clock ticking down. */
  tick(urgent = false) {
    if (!started) return;
    tone(urgent ? 1400 : 900, 0.04, { type: 'square', gain: (urgent ? 0.12 : 0.07) * vol() });
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
    const g = 0.13 * vol();
    tone(urgent ? 520 : 420, 0.6, { type: 'sawtooth', gain: g, sweepTo: urgent ? 300 : 250, send: 0.5 });
    tone(urgent ? 262 : 210, 0.6, { type: 'square', gain: g * 0.5, sweepTo: urgent ? 150 : 126, send: 0.5 });
  },

  /** …and the thing it was warning about. */
  nuke() {
    if (!started) return;
    const g = vol();
    // A crack, then everything under it, then a very long tail.
    noise(0.5, { type: 'highpass', freq: 3200, gain: 0.5 * g, send: 0.4 });
    noise(2.6, { type: 'lowpass', freq: 700, gain: 1.0 * g, sweep: 45, send: 0.9 });
    tone(48, 2.4, { type: 'sine', gain: 0.7 * g, sweepTo: 20, send: 0.5 });
    tone(96, 1.4, { type: 'triangle', gain: 0.32 * g, sweepTo: 30, send: 0.5, delay: 0.05 });
    noise(3.4, { type: 'lowpass', freq: 400, gain: 0.34 * g, sweep: 70, send: 1, delay: 0.35 });
  },
};

export default sfx;
