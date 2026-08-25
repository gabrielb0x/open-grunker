/**
 * Open Grunker — class & weapon definitions (shared client/server).
 *
 * Each entry is a full Krunker-style "class": a signature primary, plus the
 * pistol and knife every class carries.  `model` is a procedural recipe — the
 * client builds both the first-person viewmodel and the third-person world
 * model from it, so no binary art assets are needed anywhere in the project.
 *
 * A part is `{ p:[x,y,z], s:[w,h,d], c:<hex>, m:<material>, r:[rx,ry,rz] }`.
 * `m` picks how it is shaded — polished metal, matte polymer, wood, rubber or
 * an emissive lens — which is what makes these read as guns rather than boxes.
 *
 * `model.sight` is the point on the weapon that must sit dead centre when the
 * player aims: the viewmodel derives its whole aim-down-sights pose from it, so
 * every gun lines up on the crosshair without a hand-tuned offset.
 *
 * Units: damage in HP, fireRate in rounds/minute, distances in world units,
 * spread in radians, recoil in radians per shot.
 */
import { rng32 } from './shot.js';

/** Ammo type ids — only cosmetic, used for the HUD icon. */
export const AMMO = { RIFLE: 'rifle', HEAVY: 'heavy', LIGHT: 'light', SHELL: 'shell', ROCKET: 'rocket' };

/** How a model part is shaded. */
export const MAT = {
  METAL: 'metal',       // blued steel — tight specular
  ALLOY: 'alloy',       // brushed aluminium — broad specular
  POLY: 'poly',         // matte polymer
  WOOD: 'wood',         // satin varnish
  RUBBER: 'rubber',     // dead matte
  GLASS: 'glass',       // lens
  EMIT: 'emit',         // self-lit (reticles, tritium)
};

const COL = {
  steel: 0x2e343d, gunmetal: 0x3b424c, dark: 0x1b1e23, black: 0x101215,
  wood: 0x7d4f2b, darkwood: 0x5c3a1f, tan: 0xb99a67, sand: 0xc9ac78,
  poly: 0x24282e, olive: 0x40492f, alloy: 0x767e88, silver: 0x9aa3ad,
  glass: 0x66c8ff, brass: 0xc9a227, red: 0xff3b30,
};

/* ── Damage / spread maths ───────────────────────────────────────────────── */

/**
 * Damage falloff: full damage up to `near`, scaling down to `farMult` at `far`.
 * @returns {number} multiplier in [farMult, 1]
 */
export function falloff(w, dist) {
  if (dist <= w.near) return 1;
  if (dist >= w.far) return w.farMult;
  const t = (dist - w.near) / (w.far - w.near);
  return 1 + t * (w.farMult - 1);
}

/** Seconds between shots. */
export const shotInterval = (w) => 60 / w.fireRate;

/**
 * Effective spread for a player state (radians, cone half-angle).
 *
 * `burst` is how many rounds have gone down range without letting the cone
 * settle. It grows the cone (bloom) up to a per-weapon ceiling, which is what
 * makes tapping strictly better than holding at range — and the first round out
 * of a settled weapon is the most accurate one it will ever fire.
 */
export function spreadFor(w, { moving = false, airborne = false, ads = false, crouching = false, burst = 0 } = {}) {
  let s = ads ? w.spreadAds : w.spread;
  if (moving) s += w.spreadMove;
  if (airborne) s += w.spreadAir;
  if (crouching) s *= 0.6;
  const bloom = w.bloom ?? 0;
  if (bloom > 0 && burst > 0) {
    const n = Math.min(burst, w.bloomCap ?? 10);
    s += bloom * n * (ads ? 0.68 : 1);
  }
  // A weapon that has been resting fires its first round dead straight.
  if (burst <= 0 && w.firstShotAccuracy) s *= w.firstShotAccuracy;
  return s;
}

/**
 * Recoil for shot `n` of a burst (1-based).
 *
 * The pattern is deterministic: the same weapon fired in the same order always
 * kicks the same way, so a spray can be learned and pulled down — exactly the
 * contract a Counter-Strike player expects. Vertical climb ramps in over
 * `climbShots`, horizontal drifts along a fixed two-harmonic curve, and only a
 * small jitter term is random (seeded, so it stays reproducible per shot index).
 */
export function recoilKick(w, n) {
  const r = w.recoil ?? { up: w.recoilV ?? 0.02, side: w.recoilH ?? 0.006 };
  const idx = Math.max(1, n | 0);
  const climb = Math.max(1, r.climbShots ?? 4);
  const t = Math.min(1, (idx - 1) / climb);
  const ramp = (r.firstShot ?? 0.6) + (1 - (r.firstShot ?? 0.6)) * t;
  const pitch = (r.up ?? 0.02) * ramp;

  const phase = (idx - 1) * (r.swing ?? 0.85);
  const shape = Math.sin(phase) * 0.78 + Math.sin(phase * 0.47 + 1.7) * 0.42;
  const jitter = (rng32((idx * 2654435761) ^ (r.seed ?? 0x9e37))() * 2 - 1) * (r.jitter ?? 0.35);
  const yaw = (r.side ?? 0.006) * (shape + jitter) * (0.3 + t * 1.05);

  return { pitch, yaw };
}

/** How fast the view walks back down after the trigger is released (rad/s). */
export const recoilRecovery = (w) => w.recoil?.recover ?? w.recoilRecover ?? 7;

/* ── Shared shot-sound recipes ───────────────────────────────────────────── */

/**
 * A gunshot is four layers: a body thump, a supersonic crack, a decaying tail
 * and the mechanical action. Tuning them per weapon is what stops nine guns
 * sounding like one synth.
 */
const snd = (o) => ({
  body: 180, bodyGain: 0.55, bodyDecay: 0.16,
  crack: 2400, crackGain: 0.5, crackDecay: 0.06,
  tail: 0.35, tailGain: 0.22, tailFreq: 900,
  mech: 3200, mechGain: 0.12,
  gain: 0.7, ...o,
});

/* ── Sidearms carried by every class ─────────────────────────────────────── */

/**
 * The sidearm every class carries.
 *
 * Deliberately kept a hair under lethal at four rounds: 25 × 4 is exactly a
 * full health bar, so a point-blank four-tap kills and *any* distance at all
 * makes it five. That is the line this weapon should sit on — free, on every
 * class, and never the reason a fight was won at range. It used to do 26 at 380
 * rpm, which is a 0.47 s time-to-kill and comfortably better than half the
 * primaries it is meant to be the fallback for.
 */
export const PISTOL = {
  id: 'pistol', name: 'P9 Sidearm', slot: 1, ammoType: AMMO.LIGHT, kind: 'pistol',
  damage: 25, fireRate: 330, auto: false, pellets: 1,
  magSize: 15, reserve: 60, reloadTime: 1.3,
  spread: 0.0068, spreadMove: 0.018, spreadAir: 0.055, spreadAds: 0.0016,
  bloom: 0.0034, bloomCap: 7, firstShotAccuracy: 0.5,
  recoil: { up: 0.024, side: 0.0065, climbShots: 3, firstShot: 0.7, swing: 1.15, jitter: 0.4, recover: 11, seed: 0x51 },
  recoilV: 0.024, recoilH: 0.0065, recoilRecover: 11,
  near: 18, far: 70, farMult: 0.48, moveMult: 1.06, adsMoveMult: 0.78,
  adsFov: 52, adsTime: 0.14, headMult: 2.0,
  shell: { size: 0.7, color: 0xc9a227 },
  sound: snd({ body: 300, bodyGain: 0.42, bodyDecay: 0.1, crack: 2900, crackGain: 0.4, crackDecay: 0.045, tail: 0.2, tailGain: 0.13, gain: 0.5 }),
  model: {
    scale: 1,
    parts: [
      { p: [0, 0.005, -0.02], s: [0.062, 0.115, 0.44], c: COL.steel, m: MAT.METAL, tag: 'slide' }, // slide
      { p: [0, 0.062, -0.02], s: [0.05, 0.02, 0.42], c: COL.gunmetal, m: MAT.ALLOY },    // slide rib
      { p: [0, -0.075, 0.005], s: [0.058, 0.06, 0.4], c: COL.poly, m: MAT.POLY },        // frame
      { p: [0, -0.2, 0.085], s: [0.062, 0.23, 0.115], c: COL.poly, m: MAT.POLY, r: [0.22, 0, 0], tag: 'mag' }, // grip / magazine well
      { p: [0, -0.185, 0.085], s: [0.048, 0.2, 0.02], c: COL.dark, m: MAT.RUBBER, r: [0.22, 0, 0] },
      { p: [0, -0.02, -0.26], s: [0.03, 0.028, 0.14], c: COL.black, m: MAT.METAL },      // barrel
      { p: [0, -0.115, 0.02], s: [0.03, 0.05, 0.045], c: COL.black, m: MAT.METAL },      // trigger guard
      { p: [0, 0.078, 0.16], s: [0.026, 0.026, 0.03], c: COL.dark, m: MAT.METAL },       // rear sight
      { p: [0.028, 0.078, 0.16], s: [0.014, 0.02, 0.02], c: 0x1affa0, m: MAT.EMIT },
      { p: [-0.028, 0.078, 0.16], s: [0.014, 0.02, 0.02], c: 0x1affa0, m: MAT.EMIT },
      { p: [0, 0.08, -0.2], s: [0.016, 0.03, 0.02], c: COL.dark, m: MAT.METAL },         // front post
      { p: [0, 0.086, -0.2], s: [0.012, 0.014, 0.014], c: 0x1affa0, m: MAT.EMIT },
    ],
    muzzle: [0, -0.02, -0.34],
    eject: [0.05, 0.03, -0.02],
    grip: [0, -0.2, 0.09],
    sight: [0, 0.082, -0.02],
  },
};

export const KNIFE = {
  id: 'knife', name: 'Combat Knife', slot: 2, melee: true, kind: 'knife',
  damage: 62, backstab: 145, fireRate: 118, range: 3.1,
  moveMult: 1.24,
  sound: snd({ body: 900, bodyGain: 0.18, bodyDecay: 0.09, crack: 4200, crackGain: 0.2, crackDecay: 0.05, tail: 0.1, tailGain: 0.05, gain: 0.35 }),
  model: {
    scale: 1,
    parts: [
      { p: [0, 0.005, -0.24], s: [0.018, 0.085, 0.42], c: 0xc6ccd6, m: MAT.ALLOY },      // blade
      { p: [0, 0.04, -0.24], s: [0.02, 0.012, 0.4], c: 0xeef3fa, m: MAT.ALLOY },         // edge highlight
      { p: [0, -0.005, -0.47], s: [0.016, 0.05, 0.09], c: 0xc6ccd6, m: MAT.ALLOY, r: [0, 0, 0.5] },
      { p: [0, 0, 0.0], s: [0.05, 0.05, 0.045], c: COL.dark, m: MAT.METAL },             // guard
      { p: [0, -0.005, 0.13], s: [0.036, 0.052, 0.22], c: COL.black, m: MAT.RUBBER },    // handle
      { p: [0, -0.005, 0.25], s: [0.042, 0.045, 0.03], c: COL.gunmetal, m: MAT.METAL },  // pommel
    ],
    muzzle: [0, 0, -0.42],
    grip: [0, -0.02, 0.14],
    sight: [0, 0.02, -0.1],
  },
};

/* ── Primary classes ─────────────────────────────────────────────────────── */

/** @type {Record<string, any>} */
export const CLASSES = {
  triggerman: {
    id: 'triggerman', name: 'Triggerman', tagline: 'Balanced assault rifle. The all-rounder.',
    unlockLevel: 0, color: 0x4caf50, role: 'Assault',
    primary: {
      id: 'ar', name: 'AK-74 Pattern Rifle', slot: 0, ammoType: AMMO.RIFLE, kind: 'rifle',
      damage: 29, fireRate: 600, auto: true, pellets: 1,
      magSize: 30, reserve: 120, reloadTime: 2.05, reloadEmptyTime: 2.55,
      spread: 0.009, spreadMove: 0.017, spreadAir: 0.055, spreadAds: 0.0018,
      bloom: 0.0016, bloomCap: 12, firstShotAccuracy: 0.35,
      recoil: { up: 0.0165, side: 0.0072, climbShots: 5, firstShot: 0.5, swing: 0.82, jitter: 0.3, recover: 7.2, seed: 0xa1 },
      recoilV: 0.0165, recoilH: 0.0072, recoilRecover: 7.2,
      near: 40, far: 130, farMult: 0.6, moveMult: 1.0, adsMoveMult: 0.55,
      adsFov: 48, adsTime: 0.19, headMult: 2.35,
      shell: { size: 0.9, color: 0xc9a227 },
      sound: snd({ body: 165, bodyGain: 0.6, bodyDecay: 0.17, crack: 2300, crackGain: 0.55, crackDecay: 0.06, tail: 0.42, tailGain: 0.26, gain: 0.74 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0, 0.02], s: [0.072, 0.115, 0.5], c: COL.steel, m: MAT.METAL },            // receiver
          { p: [0, 0.068, 0.02], s: [0.062, 0.028, 0.48], c: COL.gunmetal, m: MAT.ALLOY },    // dust cover
          { p: [0, 0.02, -0.36], s: [0.052, 0.055, 0.28], c: COL.darkwood, m: MAT.WOOD },     // handguard
          { p: [0, 0.055, -0.36], s: [0.042, 0.03, 0.26], c: COL.gunmetal, m: MAT.METAL },    // gas tube
          { p: [0, 0.005, -0.62], s: [0.026, 0.026, 0.34], c: COL.black, m: MAT.METAL },      // barrel
          { p: [0, 0.005, -0.82], s: [0.042, 0.042, 0.09], c: COL.dark, m: MAT.METAL },       // brake
          { p: [0, 0.005, -0.84], s: [0.05, 0.014, 0.05], c: COL.dark, m: MAT.METAL },
          { p: [0, -0.16, 0.06], s: [0.06, 0.24, 0.11], c: COL.darkwood, m: MAT.WOOD, r: [0.28, 0, 0] },  // grip
          { p: [0, -0.145, -0.15], s: [0.052, 0.19, 0.14], c: COL.steel, m: MAT.METAL, r: [-0.18, 0, 0], tag: 'mag' }, // magazine
          { p: [0, -0.235, -0.19], s: [0.05, 0.06, 0.12], c: COL.dark, m: MAT.POLY, r: [-0.18, 0, 0], tag: 'mag' },
          { p: [0, -0.03, 0.34], s: [0.055, 0.1, 0.3], c: COL.darkwood, m: MAT.WOOD },        // stock
          { p: [0, 0.015, 0.48], s: [0.06, 0.12, 0.045], c: COL.dark, m: MAT.RUBBER },        // butt pad
          { p: [0, -0.078, -0.02], s: [0.03, 0.045, 0.05], c: COL.black, m: MAT.METAL },      // trigger guard
          { p: [0.05, 0.03, 0.02], s: [0.03, 0.02, 0.07], c: COL.gunmetal, m: MAT.ALLOY, tag: 'bolt' }, // charging handle
          { p: [0, 0.092, 0.2], s: [0.036, 0.03, 0.035], c: COL.dark, m: MAT.METAL },         // rear sight
          { p: [0.017, 0.096, 0.2], s: [0.012, 0.024, 0.02], c: COL.black, m: MAT.METAL },
          { p: [-0.017, 0.096, 0.2], s: [0.012, 0.024, 0.02], c: COL.black, m: MAT.METAL },
          { p: [0, 0.098, -0.66], s: [0.03, 0.05, 0.03], c: COL.dark, m: MAT.METAL },         // front post hood
          { p: [0, 0.098, -0.665], s: [0.01, 0.036, 0.012], c: COL.black, m: MAT.METAL },
        ],
        muzzle: [0, 0.005, -0.9],
        eject: [0.06, 0.05, 0.0],
        grip: [0, -0.18, 0.06],
        sight: [0, 0.1, 0.0],
      },
    },
  },

  hunter: {
    id: 'hunter', name: 'Hunter', tagline: 'Bolt-action sniper. One shot, one kill.',
    unlockLevel: 0, color: 0x9c27b0, role: 'Sniper',
    primary: {
      id: 'sniper', name: 'AWM Bolt-Action', slot: 0, ammoType: AMMO.HEAVY, kind: 'sniper',
      damage: 105, fireRate: 55, auto: false, pellets: 1,
      magSize: 5, reserve: 25, reloadTime: 2.5, reloadEmptyTime: 2.9,
      /*
       * Scoped this rifle is perfect and unscoped it is a shotgun without the
       * pellets — which is the whole bargain of carrying a one-shot kill. At
       * 0.05 the hip cone was under three degrees, so a rifle that deletes
       * anybody it touches was also a point-and-click weapon at every range
       * nobody could dodge in. The scope is the aim now; the hip is a prayer.
       */
      spread: 0.135, spreadMove: 0.075, spreadAir: 0.12, spreadAds: 0.0,
      bloom: 0, bloomCap: 0,
      recoil: { up: 0.075, side: 0.011, climbShots: 2, firstShot: 1, swing: 1.6, jitter: 0.5, recover: 4.2, seed: 0xb2 },
      recoilV: 0.075, recoilH: 0.011, recoilRecover: 4.2,
      near: 200, far: 400, farMult: 1.0, moveMult: 0.86, adsMoveMult: 0.3,
      adsFov: 14, adsTime: 0.26, headMult: 2.0, scope: true,
      boltTime: 0.9, quickscope: true, scopeSteady: true,
      shell: { size: 1.15, color: 0xb08a2a },
      sound: snd({ body: 120, bodyGain: 0.85, bodyDecay: 0.3, crack: 1800, crackGain: 0.7, crackDecay: 0.1, tail: 0.95, tailGain: 0.45, tailFreq: 550, mech: 1400, mechGain: 0.2, gain: 0.95 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, -0.01, 0.06], s: [0.07, 0.1, 0.72], c: COL.olive, m: MAT.POLY },           // chassis
          { p: [0, 0.045, 0.02], s: [0.05, 0.05, 0.56], c: COL.steel, m: MAT.METAL },         // receiver
          { p: [0, 0.02, -0.62], s: [0.032, 0.032, 0.72], c: COL.black, m: MAT.METAL },       // barrel
          { p: [0, 0.02, -1.02], s: [0.05, 0.05, 0.13], c: COL.dark, m: MAT.METAL },          // suppressor cap
          { p: [0, -0.13, 0.12], s: [0.058, 0.2, 0.11], c: COL.olive, m: MAT.POLY, r: [0.3, 0, 0] }, // grip
          { p: [0, -0.12, -0.16], s: [0.05, 0.16, 0.1], c: COL.steel, m: MAT.METAL, tag: 'mag' }, // magazine
          { p: [0, 0.0, 0.5], s: [0.06, 0.13, 0.34], c: COL.olive, m: MAT.POLY },             // stock
          { p: [0, 0.03, 0.68], s: [0.065, 0.14, 0.05], c: COL.dark, m: MAT.RUBBER },
          { p: [0, -0.08, 0.56], s: [0.05, 0.08, 0.14], c: COL.olive, m: MAT.POLY },          // cheek riser
          { p: [0, 0.14, -0.1], s: [0.062, 0.062, 0.5], c: COL.black, m: MAT.METAL },         // scope tube
          { p: [0, 0.14, -0.32], s: [0.086, 0.086, 0.06], c: COL.dark, m: MAT.METAL },        // objective bell
          { p: [0, 0.14, -0.355], s: [0.072, 0.072, 0.012], c: COL.glass, m: MAT.GLASS },
          { p: [0, 0.14, 0.14], s: [0.07, 0.07, 0.05], c: COL.dark, m: MAT.METAL },           // eyepiece
          { p: [0, 0.14, 0.165], s: [0.056, 0.056, 0.01], c: 0x0d1b26, m: MAT.GLASS },
          { p: [0, 0.2, -0.06], s: [0.03, 0.03, 0.06], c: COL.gunmetal, m: MAT.ALLOY },       // turret
          { p: [0.075, 0.06, 0.06], s: [0.075, 0.024, 0.024], c: COL.gunmetal, m: MAT.ALLOY, tag: 'bolt' }, // bolt handle
          { p: [0.105, 0.05, 0.06], s: [0.03, 0.05, 0.05], c: COL.silver, m: MAT.ALLOY, tag: 'bolt' },
          { p: [0, -0.075, -0.5], s: [0.03, 0.06, 0.14], c: COL.dark, m: MAT.POLY },          // bipod stub
        ],
        muzzle: [0, 0.02, -1.12],
        eject: [0.06, 0.07, 0.06],
        grip: [0, -0.16, 0.12],
        sight: [0, 0.14, 0.0],
      },
    },
  },

  runngun: {
    id: 'runngun', name: 'Run N Gun', tagline: 'Blistering SMG and the fastest legs on the map.',
    unlockLevel: 0, color: 0x00bcd4, role: 'Skirmisher',
    primary: {
      id: 'smg', name: 'MP-9 Submachine Gun', slot: 0, ammoType: AMMO.LIGHT, kind: 'smg',
      damage: 17, fireRate: 950, auto: true, pellets: 1,
      magSize: 30, reserve: 140, reloadTime: 1.5, reloadEmptyTime: 1.9,
      spread: 0.013, spreadMove: 0.011, spreadAir: 0.046, spreadAds: 0.005,
      bloom: 0.0014, bloomCap: 14, firstShotAccuracy: 0.5,
      recoil: { up: 0.0108, side: 0.0078, climbShots: 7, firstShot: 0.55, swing: 1.05, jitter: 0.45, recover: 9.5, seed: 0xc3 },
      recoilV: 0.0108, recoilH: 0.0078, recoilRecover: 9.5,
      near: 22, far: 70, farMult: 0.45, moveMult: 1.18, adsMoveMult: 0.82,
      adsFov: 56, adsTime: 0.12, headMult: 2.2,
      shell: { size: 0.62, color: 0xc9a227 },
      sound: snd({ body: 260, bodyGain: 0.4, bodyDecay: 0.1, crack: 3100, crackGain: 0.42, crackDecay: 0.04, tail: 0.2, tailGain: 0.13, gain: 0.52 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0, 0.0], s: [0.066, 0.105, 0.36], c: COL.poly, m: MAT.POLY },
          { p: [0, 0.058, 0.0], s: [0.05, 0.024, 0.34], c: COL.gunmetal, m: MAT.ALLOY },
          { p: [0, 0.01, -0.26], s: [0.05, 0.06, 0.2], c: COL.poly, m: MAT.POLY },
          { p: [0, 0.005, -0.42], s: [0.024, 0.024, 0.16], c: COL.black, m: MAT.METAL },
          { p: [0, 0.005, -0.52], s: [0.036, 0.036, 0.07], c: COL.dark, m: MAT.METAL },
          { p: [0, -0.15, 0.03], s: [0.055, 0.2, 0.1], c: COL.poly, m: MAT.POLY, r: [0.24, 0, 0] },
          { p: [0, -0.14, -0.1], s: [0.048, 0.2, 0.09], c: COL.dark, m: MAT.POLY, r: [-0.1, 0, 0], tag: 'mag' },
          { p: [0, -0.06, 0.02], s: [0.028, 0.04, 0.045], c: COL.black, m: MAT.METAL },
          { p: [0, 0.005, 0.22], s: [0.05, 0.075, 0.16], c: COL.dark, m: MAT.POLY },
          { p: [0, 0.005, 0.31], s: [0.056, 0.095, 0.03], c: COL.black, m: MAT.RUBBER },
          { p: [0, 0.084, 0.13], s: [0.05, 0.02, 0.14], c: COL.dark, m: MAT.METAL },          // rail
          { p: [0, 0.108, 0.1], s: [0.05, 0.055, 0.05], c: COL.dark, m: MAT.METAL },          // red dot
          { p: [0, 0.108, 0.076], s: [0.04, 0.04, 0.008], c: 0x1a3548, m: MAT.GLASS },
          { p: [0, 0.108, 0.074], s: [0.008, 0.008, 0.006], c: COL.red, m: MAT.EMIT },
        ],
        muzzle: [0, 0.005, -0.58],
        eject: [0.055, 0.045, -0.02],
        grip: [0, -0.17, 0.03],
        sight: [0, 0.108, 0.1],
      },
    },
  },

  spraynpray: {
    id: 'spraynpray', name: 'Spray N Pray', tagline: 'A drum-fed LMG that never stops talking.',
    unlockLevel: 0, color: 0xff9800, role: 'Support',
    primary: {
      id: 'lmg', name: 'M249 Light Machine Gun', slot: 0, ammoType: AMMO.RIFLE, kind: 'lmg',
      damage: 23, fireRate: 780, auto: true, pellets: 1,
      magSize: 60, reserve: 180, reloadTime: 3.2, reloadEmptyTime: 3.7,
      spread: 0.017, spreadMove: 0.028, spreadAir: 0.075, spreadAds: 0.005,
      bloom: 0.0011, bloomCap: 22, firstShotAccuracy: 0.6,
      recoil: { up: 0.0125, side: 0.0112, climbShots: 9, firstShot: 0.6, swing: 0.66, jitter: 0.55, recover: 5.8, seed: 0xd4 },
      recoilV: 0.0125, recoilH: 0.0112, recoilRecover: 5.8,
      near: 35, far: 120, farMult: 0.55, moveMult: 0.85, adsMoveMult: 0.45,
      adsFov: 50, adsTime: 0.29, headMult: 2.2,
      shell: { size: 0.95, color: 0xc9a227, rate: 1 },
      sound: snd({ body: 150, bodyGain: 0.62, bodyDecay: 0.19, crack: 2100, crackGain: 0.5, crackDecay: 0.065, tail: 0.5, tailGain: 0.3, gain: 0.78 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0, 0.02], s: [0.086, 0.13, 0.56], c: COL.olive, m: MAT.POLY },
          { p: [0, 0.075, 0.02], s: [0.07, 0.03, 0.54], c: COL.gunmetal, m: MAT.METAL },
          { p: [0, 0.02, -0.44], s: [0.05, 0.05, 0.42], c: COL.black, m: MAT.METAL },
          { p: [0, 0.02, -0.76], s: [0.032, 0.032, 0.3], c: COL.black, m: MAT.METAL },
          { p: [0, 0.02, -0.94], s: [0.05, 0.05, 0.1], c: COL.dark, m: MAT.METAL },
          { p: [0, 0.09, -0.4], s: [0.05, 0.03, 0.2], c: COL.gunmetal, m: MAT.METAL },        // carry handle
          { p: [0, -0.2, 0.0], s: [0.17, 0.2, 0.26], c: COL.olive, m: MAT.POLY, tag: 'mag' },  // drum
          { p: [0.088, -0.2, 0.0], s: [0.01, 0.16, 0.22], c: COL.dark, m: MAT.METAL, tag: 'mag' },
          { p: [0, -0.16, 0.3], s: [0.06, 0.2, 0.11], c: COL.dark, m: MAT.POLY, r: [0.3, 0, 0] },
          { p: [0, 0.0, 0.42], s: [0.06, 0.12, 0.28], c: COL.olive, m: MAT.POLY },
          { p: [0, 0.02, 0.57], s: [0.065, 0.14, 0.04], c: COL.dark, m: MAT.RUBBER },
          { p: [0, -0.09, -0.36], s: [0.05, 0.08, 0.24], c: COL.olive, m: MAT.POLY },         // foregrip
          { p: [0, 0.104, 0.26], s: [0.04, 0.032, 0.04], c: COL.dark, m: MAT.METAL },
          { p: [0, 0.11, -0.55], s: [0.026, 0.05, 0.024], c: COL.dark, m: MAT.METAL },
        ],
        muzzle: [0, 0.02, -1.02],
        eject: [0.07, 0.03, 0.02],
        grip: [0, -0.2, 0.3],
        sight: [0, 0.112, 0.0],
      },
    },
  },

  vince: {
    id: 'vince', name: 'Vince', tagline: 'Hand cannon. Two taps and a swagger.',
    unlockLevel: 0, color: 0xf44336, role: 'Duelist',
    primary: {
      id: 'revolver', name: '.357 Revolver', slot: 0, ammoType: AMMO.HEAVY, kind: 'revolver',
      damage: 58, fireRate: 210, auto: false, pellets: 1,
      magSize: 6, reserve: 36, reloadTime: 2.15, reloadEmptyTime: 2.35,
      spread: 0.008, spreadMove: 0.026, spreadAir: 0.065, spreadAds: 0.0016,
      bloom: 0.006, bloomCap: 4, firstShotAccuracy: 0.35,
      recoil: { up: 0.052, side: 0.0135, climbShots: 3, firstShot: 0.85, swing: 1.4, jitter: 0.5, recover: 6.2, seed: 0xe5 },
      recoilV: 0.052, recoilH: 0.0135, recoilRecover: 6.2,
      near: 45, far: 140, farMult: 0.72, moveMult: 1.08, adsMoveMult: 0.72,
      adsFov: 44, adsTime: 0.17, headMult: 2.4,
      shell: null,
      sound: snd({ body: 135, bodyGain: 0.8, bodyDecay: 0.24, crack: 2000, crackGain: 0.62, crackDecay: 0.08, tail: 0.65, tailGain: 0.36, tailFreq: 700, gain: 0.88 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0.02, -0.14], s: [0.05, 0.075, 0.4], c: COL.silver, m: MAT.ALLOY },        // frame/barrel shroud
          { p: [0, 0.055, -0.16], s: [0.04, 0.022, 0.36], c: 0xb9c2cc, m: MAT.ALLOY },        // rib
          { p: [0, 0.005, -0.02], s: [0.098, 0.098, 0.12], c: 0x8f99a4, m: MAT.ALLOY, tag: 'cyl' }, // cylinder
          { p: [0, 0.005, -0.02], s: [0.11, 0.05, 0.115], c: 0x8f99a4, m: MAT.ALLOY, r: [0, 0, 1.047], tag: 'cyl' },
          { p: [0, 0.005, -0.02], s: [0.11, 0.05, 0.115], c: 0x8f99a4, m: MAT.ALLOY, r: [0, 0, -1.047], tag: 'cyl' },
          { p: [0, -0.16, 0.13], s: [0.056, 0.22, 0.115], c: COL.darkwood, m: MAT.WOOD, r: [0.34, 0, 0] },
          { p: [0, -0.075, 0.02], s: [0.028, 0.05, 0.045], c: 0x8f99a4, m: MAT.ALLOY },
          { p: [0, 0.02, -0.32], s: [0.028, 0.03, 0.06], c: COL.black, m: MAT.METAL },
          { p: [0, 0.078, 0.11], s: [0.03, 0.026, 0.03], c: COL.black, m: MAT.METAL },
          { p: [0, 0.082, -0.3], s: [0.012, 0.03, 0.014], c: COL.black, m: MAT.METAL },
          { p: [0, 0.088, -0.3], s: [0.014, 0.012, 0.012], c: COL.red, m: MAT.EMIT },
        ],
        muzzle: [0, 0.02, -0.36],
        eject: [0.06, 0.0, -0.02],
        grip: [0, -0.18, 0.14],
        sight: [0, 0.084, 0.0],
      },
    },
  },

  detective: {
    id: 'detective', name: 'Detective', tagline: 'Akimbo machine pistols. Style over accuracy.',
    unlockLevel: 0, color: 0x3f51b5, role: 'Skirmisher',
    primary: {
      id: 'akimbo', name: 'Akimbo Machine Pistols', slot: 0, ammoType: AMMO.LIGHT, kind: 'akimbo',
      damage: 14, fireRate: 1250, auto: true, pellets: 1, akimbo: true,
      magSize: 44, reserve: 176, reloadTime: 2.0, reloadEmptyTime: 2.35,
      spread: 0.022, spreadMove: 0.015, spreadAir: 0.046, spreadAds: 0.012,
      bloom: 0.0012, bloomCap: 16, firstShotAccuracy: 0.7,
      recoil: { up: 0.0086, side: 0.0125, climbShots: 8, firstShot: 0.6, swing: 1.35, jitter: 0.7, recover: 10.5, seed: 0xf6 },
      recoilV: 0.0086, recoilH: 0.0125, recoilRecover: 10.5,
      near: 18, far: 60, farMult: 0.4, moveMult: 1.12, adsMoveMult: 0.95,
      adsFov: 60, adsTime: 0.1, headMult: 2.0,
      shell: { size: 0.6, color: 0xc9a227 },
      sound: snd({ body: 320, bodyGain: 0.34, bodyDecay: 0.08, crack: 3400, crackGain: 0.36, crackDecay: 0.035, tail: 0.16, tailGain: 0.1, gain: 0.46 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0.005, -0.02], s: [0.058, 0.105, 0.36], c: COL.silver, m: MAT.ALLOY },
          { p: [0, 0.058, -0.02], s: [0.046, 0.02, 0.34], c: 0xb9c2cc, m: MAT.ALLOY },
          { p: [0, -0.07, 0.0], s: [0.054, 0.06, 0.32], c: COL.dark, m: MAT.POLY },
          { p: [0, -0.19, 0.075], s: [0.056, 0.22, 0.1], c: COL.dark, m: MAT.POLY, r: [0.2, 0, 0], tag: 'mag' },
          { p: [0, -0.02, -0.24], s: [0.026, 0.026, 0.12], c: COL.black, m: MAT.METAL },
          { p: [0, -0.1, 0.02], s: [0.028, 0.045, 0.045], c: COL.black, m: MAT.METAL },
          { p: [0, 0.074, 0.14], s: [0.024, 0.024, 0.026], c: COL.black, m: MAT.METAL },
          { p: [0, 0.078, -0.18], s: [0.012, 0.026, 0.014], c: COL.black, m: MAT.METAL },
        ],
        muzzle: [0, -0.02, -0.32],
        eject: [0.05, 0.03, -0.02],
        grip: [0, -0.19, 0.08],
        sight: [0, 0.078, 0.0],
      },
    },
  },

  marksman: {
    id: 'marksman', name: 'Marksman', tagline: 'Semi-auto DMR. Rewards a steady trigger finger.',
    unlockLevel: 0, color: 0x8bc34a, role: 'Sniper',
    primary: {
      id: 'dmr', name: 'SR-25 Marksman Rifle', slot: 0, ammoType: AMMO.HEAVY, kind: 'dmr',
      damage: 47, fireRate: 320, auto: false, pellets: 1,
      magSize: 12, reserve: 72, reloadTime: 2.15, reloadEmptyTime: 2.6,
      spread: 0.006, spreadMove: 0.028, spreadAir: 0.075, spreadAds: 0.0008,
      bloom: 0.0055, bloomCap: 5, firstShotAccuracy: 0.3,
      recoil: { up: 0.041, side: 0.0078, climbShots: 4, firstShot: 0.8, swing: 1.25, jitter: 0.35, recover: 6.6, seed: 0x17 },
      recoilV: 0.041, recoilH: 0.0078, recoilRecover: 6.6,
      near: 90, far: 240, farMult: 0.8, moveMult: 0.94, adsMoveMult: 0.45,
      adsFov: 28, adsTime: 0.23, headMult: 2.3, scope: true, scopeSteady: true,
      shell: { size: 1.0, color: 0xb08a2a },
      sound: snd({ body: 140, bodyGain: 0.7, bodyDecay: 0.22, crack: 2000, crackGain: 0.6, crackDecay: 0.08, tail: 0.6, tailGain: 0.32, tailFreq: 650, gain: 0.82 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0, 0.04], s: [0.07, 0.115, 0.46], c: COL.tan, m: MAT.POLY },
          { p: [0, 0.068, 0.02], s: [0.058, 0.026, 0.5], c: COL.dark, m: MAT.METAL },
          { p: [0, 0.02, -0.38], s: [0.06, 0.075, 0.36], c: COL.tan, m: MAT.POLY },           // handguard
          { p: [0.032, 0.02, -0.38], s: [0.004, 0.05, 0.32], c: COL.dark, m: MAT.METAL },
          { p: [-0.032, 0.02, -0.38], s: [0.004, 0.05, 0.32], c: COL.dark, m: MAT.METAL },
          { p: [0, 0.005, -0.68], s: [0.028, 0.028, 0.28], c: COL.black, m: MAT.METAL },
          { p: [0, 0.005, -0.86], s: [0.044, 0.044, 0.1], c: COL.dark, m: MAT.METAL },
          { p: [0, -0.16, 0.08], s: [0.058, 0.22, 0.11], c: COL.dark, m: MAT.POLY, r: [0.28, 0, 0] },
          { p: [0, -0.15, -0.1], s: [0.05, 0.2, 0.11], c: COL.tan, m: MAT.POLY, tag: 'mag' },
          { p: [0, -0.076, 0.0], s: [0.03, 0.045, 0.05], c: COL.black, m: MAT.METAL },
          { p: [0, -0.005, 0.34], s: [0.058, 0.11, 0.26], c: COL.tan, m: MAT.POLY },
          { p: [0, 0.01, 0.47], s: [0.062, 0.13, 0.04], c: COL.dark, m: MAT.RUBBER },
          { p: [0, 0.128, -0.06], s: [0.055, 0.055, 0.4], c: COL.dark, m: MAT.METAL },        // optic
          { p: [0, 0.128, -0.25], s: [0.072, 0.072, 0.05], c: COL.black, m: MAT.METAL },
          { p: [0, 0.128, -0.278], s: [0.058, 0.058, 0.01], c: COL.glass, m: MAT.GLASS },
          { p: [0, 0.128, 0.14], s: [0.06, 0.06, 0.045], c: COL.black, m: MAT.METAL },
          { p: [0, 0.128, 0.162], s: [0.046, 0.046, 0.008], c: 0x0d1b26, m: MAT.GLASS },
        ],
        muzzle: [0, 0.005, -0.94],
        eject: [0.06, 0.045, 0.02],
        grip: [0, -0.18, 0.08],
        sight: [0, 0.128, 0.0],
      },
    },
  },

  bulldog: {
    id: 'bulldog', name: 'Bulldog', tagline: 'Pump shotgun. Own every corner you turn.',
    unlockLevel: 0, color: 0x795548, role: 'Breacher',
    primary: {
      id: 'shotgun', name: 'M870 Pump Shotgun', slot: 0, ammoType: AMMO.SHELL, kind: 'shotgun',
      damage: 13, fireRate: 82, auto: false, pellets: 9,
      magSize: 6, reserve: 30, reloadTime: 2.9, shellReload: 0.42,
      spread: 0.062, spreadMove: 0.018, spreadAir: 0.035, spreadAds: 0.042,
      bloom: 0, bloomCap: 0,
      recoil: { up: 0.062, side: 0.0105, climbShots: 3, firstShot: 0.9, swing: 1.5, jitter: 0.45, recover: 5.2, seed: 0x28 },
      recoilV: 0.062, recoilH: 0.0105, recoilRecover: 5.2,
      near: 12, far: 34, farMult: 0.28, moveMult: 1.02, adsMoveMult: 0.7,
      adsFov: 58, adsTime: 0.18, headMult: 1.7,
      boltTime: 0.62,
      shell: { size: 1.4, color: 0xc0392b, delay: 0.45 },
      sound: snd({ body: 110, bodyGain: 0.9, bodyDecay: 0.28, crack: 1500, crackGain: 0.55, crackDecay: 0.1, tail: 0.7, tailGain: 0.38, tailFreq: 600, mech: 900, mechGain: 0.22, gain: 0.92 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0, 0.06], s: [0.072, 0.1, 0.4], c: COL.steel, m: MAT.METAL },              // receiver
          { p: [0, 0.03, -0.42], s: [0.046, 0.046, 0.66], c: COL.black, m: MAT.METAL },       // barrel
          { p: [0, -0.032, -0.4], s: [0.044, 0.044, 0.62], c: COL.gunmetal, m: MAT.METAL },   // mag tube
          { p: [0, -0.032, -0.28], s: [0.062, 0.062, 0.22], c: COL.wood, m: MAT.WOOD, tag: 'pump' }, // pump
          { p: [0, -0.032, -0.28], s: [0.068, 0.03, 0.2], c: COL.darkwood, m: MAT.WOOD, tag: 'pump' },
          { p: [0, -0.15, 0.14], s: [0.056, 0.2, 0.11], c: COL.wood, m: MAT.WOOD, r: [0.36, 0, 0] },
          { p: [0, -0.07, 0.04], s: [0.03, 0.045, 0.05], c: COL.black, m: MAT.METAL },
          { p: [0, -0.005, 0.4], s: [0.058, 0.115, 0.32], c: COL.wood, m: MAT.WOOD },
          { p: [0, 0.01, 0.55], s: [0.062, 0.135, 0.04], c: COL.dark, m: MAT.RUBBER },
          { p: [0, 0.062, 0.18], s: [0.03, 0.026, 0.04], c: COL.dark, m: MAT.METAL },
          { p: [0, 0.07, -0.68], s: [0.014, 0.032, 0.016], c: COL.dark, m: MAT.METAL },
          { p: [0, 0.078, -0.68], s: [0.016, 0.014, 0.014], c: 0xffe066, m: MAT.EMIT },
        ],
        muzzle: [0, 0.03, -0.78],
        eject: [0.06, 0.03, 0.06],
        grip: [0, -0.17, 0.14],
        sight: [0, 0.072, 0.0],
      },
    },
  },

  rocketeer: {
    id: 'rocketeer', name: 'Rocketeer', tagline: 'Splash damage, rocket jumps, zero subtlety.',
    unlockLevel: 0, color: 0xffc107, role: 'Breacher',
    primary: {
      id: 'rpg', name: 'RPG-7 Launcher', slot: 0, ammoType: AMMO.ROCKET, kind: 'rpg',
      damage: 130, fireRate: 46, auto: false, pellets: 1,
      // One tube, and the reload was two and a third seconds of standing still
      // holding an empty pipe — long enough that a missed rocket was the whole
      // engagement. Halved: the class lives or dies on the shot after the miss.
      magSize: 1, reserve: 8, reloadTime: 1.15,
      spread: 0.003, spreadMove: 0.005, spreadAir: 0.009, spreadAds: 0.0015,
      bloom: 0, bloomCap: 0,
      recoil: { up: 0.058, side: 0.006, climbShots: 2, firstShot: 1, swing: 1, jitter: 0.3, recover: 5, seed: 0x39 },
      recoilV: 0.058, recoilH: 0.006, recoilRecover: 5,
      near: 400, far: 400, farMult: 1, moveMult: 0.82, adsMoveMult: 0.6,
      adsFov: 54, adsTime: 0.25, headMult: 1.0,
      projectile: { speed: 74, gravity: 2.5, radius: 0.22 },
      /*
       * A bigger, harder blast.
       *
       * The old one had to land almost on top of somebody: outside about three
       * metres it was doing chip damage, which for a weapon that fires once
       * every two seconds meant a near miss was worth nothing at all. The
       * radius now covers a room, the edge of it still hurts, and a direct hit
       * takes a full-health player off the board.
       *
       * `selfMult` comes down as the damage goes up on purpose: the impulse is
       * why anyone plays this class, and a rocket jump has to stay a move
       * rather than a wager. 130 × 0.30 is 39 at the epicentre — expensive,
       * survivable, and still worth the height.
       */
      splash: { radius: 7.6, maxDamage: 130, minDamage: 34, selfMult: 0.30, impulse: 18.5 },
      shell: null,
      sound: snd({ body: 95, bodyGain: 0.95, bodyDecay: 0.4, crack: 1200, crackGain: 0.4, crackDecay: 0.16, tail: 1.0, tailGain: 0.4, tailFreq: 420, gain: 0.95 }),
      model: {
        scale: 1,
        parts: [
          { p: [0, 0, 0.0], s: [0.1, 0.1, 1.0], c: 0x3f4a30, m: MAT.POLY },                   // tube
          { p: [0, 0, -0.3], s: [0.128, 0.128, 0.22], c: 0x33402a, m: MAT.POLY },
          { p: [0, 0, 0.46], s: [0.145, 0.145, 0.16], c: COL.dark, m: MAT.METAL },            // venturi
          { p: [0, 0, -0.62], s: [0.13, 0.13, 0.2], c: 0x6b3f22, m: MAT.POLY, tag: 'mag' },   // warhead body
          { p: [0, 0, -0.78], s: [0.075, 0.075, 0.16], c: 0x53301a, m: MAT.POLY, tag: 'mag' },
          { p: [0, 0, -0.9], s: [0.03, 0.03, 0.1], c: COL.dark, m: MAT.METAL, tag: 'mag' },
          { p: [0, -0.14, 0.12], s: [0.055, 0.2, 0.1], c: COL.dark, m: MAT.POLY, r: [0.2, 0, 0] },
          { p: [0, -0.1, -0.28], s: [0.05, 0.14, 0.1], c: 0x33402a, m: MAT.POLY },
          { p: [0, 0.09, 0.16], s: [0.05, 0.09, 0.4], c: COL.dark, m: MAT.POLY },             // heat shield
          { p: [0, 0.155, -0.1], s: [0.024, 0.06, 0.16], c: COL.gunmetal, m: MAT.METAL },     // optic mount
          { p: [0, 0.2, -0.1], s: [0.055, 0.055, 0.18], c: COL.black, m: MAT.METAL },
          { p: [0, 0.2, -0.192], s: [0.044, 0.044, 0.008], c: COL.glass, m: MAT.GLASS },
        ],
        muzzle: [0, 0, -0.95],
        eject: null,
        grip: [0, -0.16, 0.14],
        sight: [0, 0.2, -0.1],
      },
    },
  },
};

export const CLASS_IDS = Object.keys(CLASSES);
export const DEFAULT_CLASS = 'triggerman';

/** Resolve a class id to its definition, falling back to the default. */
export const getClass = (id) => CLASSES[id] || CLASSES[DEFAULT_CLASS];

/** The three weapons a class carries, indexed by slot. */
export function loadoutFor(classId) {
  return [getClass(classId).primary, PISTOL, KNIFE];
}

let _byId = null;
/** Every weapon definition in the game, indexed by its wire id. */
export function weaponById(id) {
  if (!_byId) {
    _byId = {};
    for (const cid of CLASS_IDS) for (const w of loadoutFor(cid)) _byId[w.id] = w;
  }
  return _byId[id] ?? null;
}

/** Short display name for the killfeed and HUD. */
export const WEAPON_LABEL = {
  ar: 'RIFLE', sniper: 'SNIPER', smg: 'SMG', lmg: 'LMG', revolver: 'REVOLVER',
  akimbo: 'AKIMBO', dmr: 'MARKSMAN', shotgun: 'SHOTGUN', rpg: 'ROCKET',
  pistol: 'SIDEARM', knife: 'KNIFE', fall: 'GRAVITY', void: 'THE VOID', nuke: 'NUKE',
};

/* ── Cosmetics ───────────────────────────────────────────────────────────── */

/**
 * Weapon finishes. Purely cosmetic — a skin never changes a number. Some are
 * bought with GR, others are earned: `unlock` is checked against the player's
 * account rather than their wallet.
 */
export const RARITY = {
  common:    { id: 'common',    name: 'Common',    color: 0x8fa0b4 },
  uncommon:  { id: 'uncommon',  name: 'Uncommon',  color: 0x4ddb7a },
  rare:      { id: 'rare',      name: 'Rare',      color: 0x4d9bff },
  epic:      { id: 'epic',      name: 'Epic',      color: 0xb07cff },
  legendary: { id: 'legendary', name: 'Legendary', color: 0xf5a623 },
};

export const SKINS = {
  default:  { id: 'default',  name: 'Factory',      price: 0,    tint: null,     rarity: 'common' },
  urban:    { id: 'urban',    name: 'Urban Grey',   price: 150,  tint: 0x6b7178, rarity: 'common' },
  midnight: { id: 'midnight', name: 'Midnight',     price: 250,  tint: 0x1b2340, rarity: 'uncommon' },
  arctic:   { id: 'arctic',   name: 'Arctic',       price: 500,  tint: 0xd8ecff, rarity: 'uncommon' },
  desert:   { id: 'desert',   name: 'Desert Tan',   price: 500,  tint: 0xc2a06a, rarity: 'uncommon' },
  forest:   { id: 'forest',   name: 'Woodland',     price: 650,  tint: 0x4a5a38, rarity: 'uncommon' },
  toxic:    { id: 'toxic',    name: 'Toxic',        price: 800,  tint: 0x66dd33, rarity: 'rare' },
  crimson:  { id: 'crimson',  name: 'Crimson',      price: 800,  tint: 0xb01f2e, rarity: 'rare' },
  cobalt:   { id: 'cobalt',   name: 'Cobalt',       price: 900,  tint: 0x2b6ed6, rarity: 'rare' },
  carbon:   { id: 'carbon',   name: 'Carbon Fibre', price: 1200, tint: 0x14171c, rarity: 'epic', gloss: 1 },
  vapor:    { id: 'vapor',    name: 'Vaporwave',    price: 2000, tint: 0xff5fd2, rarity: 'epic', gloss: 1 },
  gold:     { id: 'gold',     name: 'Gold Rush',    price: 3000, tint: 0xd4a520, rarity: 'legendary', gloss: 1.6 },
  // Earned, never sold.
  // `account` is the cheapest unlock in the game and deliberately so: it is the
  // one finish a guest can look at and own five seconds later, and the only
  // thing it asks for is the account every other feature here already needs.
  enlisted: { id: 'enlisted', name: 'Enlisted',     price: -1,   tint: 0x2f7d64, rarity: 'uncommon',
              unlock: { type: 'account' }, hint: 'Create a free account' },
  veteran:  { id: 'veteran',  name: 'Veteran',      price: -1,   tint: 0x3f4a55, rarity: 'rare',
              unlock: { type: 'level', value: 15 }, hint: 'Reach level 15' },
  master:   { id: 'master',   name: 'Masterwork',   price: -1,   tint: 0x7a5cff, rarity: 'epic', gloss: 1.2,
              unlock: { type: 'mastery', value: 4 }, hint: 'Reach mastery IV with this weapon' },
  legend:   { id: 'legend',   name: 'Legend',       price: -1,   tint: 0xff7043, rarity: 'legendary', gloss: 1.8,
              unlock: { type: 'mastery', value: 6 }, hint: 'Reach mastery VI with this weapon' },
};

export const SKIN_IDS = Object.keys(SKINS);
