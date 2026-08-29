/**
 * Open Grunker — class & weapon definitions (shared client/server).
 *
 * Each entry is a full Krunker-style "class": a signature primary, plus the
 * pistol and knife every class carries.  `model` is a procedural recipe — the
 * client builds both the first-person viewmodel and the third-person world
 * model from it, so no binary art assets are needed anywhere in the project.
 *
 * A part is `{ p:[x,y,z], s:[w,h,d], c:<hex>, m:<material>, z:<zone>,
 * r:[rx,ry,rz], tag:<animated group>, fine:1 }`.
 *
 *   `m`     how it is shaded — polished metal, matte polymer, wood, rubber or
 *           an emissive lens. This is what makes these read as guns rather
 *           than boxes.
 *   `z`     which part of the gun it is (see ZONE). A skin paints zones, not
 *           whole weapons, so the barrel can stay blued under a gold receiver.
 *   `tag`   ties it to an animation: `mag`, `bolt`, `slide`, `pump`, `cyl`.
 *   `fine`  detail work. The first-person viewmodel draws every part; the
 *           third-person body skips these, because nobody reads slide
 *           serrations at forty metres and eight players' worth of them is a
 *           few hundred draw calls that buy nothing.
 *
 * `model.sight` is the point on the weapon that must sit dead centre when the
 * player aims: the viewmodel derives its whole aim-down-sights pose from it, so
 * every gun lines up on the crosshair without a hand-tuned offset.
 *
 * `model.grip` / `model.fore` are where the two hands go. The viewmodel builds
 * an articulated hand at each one rather than parking a mitt near the gun, so
 * fingers land on the actual grip of the actual weapon — `gripTilt` rakes the
 * firing hand with the grip, and `foreKind` picks how the support hand holds
 * on: `fore` clamps a horizontal handguard, `vert` wraps a vertical foregrip,
 * `pump` rides a pump, `cup` cradles a pistol butt, `none` hides it.
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

/**
 * Which piece of a gun a part belongs to — the unit a finish is painted on.
 *
 * This is the whole difference between a skin and a tint. Dipping every part of
 * a rifle in one colour makes the wood, the steel and the polymer the same
 * shade of nothing; painting *zones* leaves the barrel blued while the receiver
 * goes gold, keeps the rubber butt pad black under a camouflage, and never
 * touches a lens or a tritium dot. Every part below declares one.
 */
export const ZONE = {
  BODY: 'body',       // receiver, frame, chassis — the biggest painted panel
  METAL: 'metal',     // barrel, bolt, slide, brake — the working steel
  WOOD: 'wood',       // grip, stock, handguard — whatever the hands hold
  ACCENT: 'accent',   // rails, optics, magazines, hardware
  DETAIL: 'detail',   // never painted: lenses, reticles, brass, bores
};
const Z = ZONE;

const COL = {
  steel: 0x2e343d, gunmetal: 0x3b424c, dark: 0x1b1e23, black: 0x101215,
  wood: 0x7d4f2b, darkwood: 0x5c3a1f, tan: 0xb99a67, sand: 0xc9ac78,
  poly: 0x24282e, olive: 0x40492f, alloy: 0x767e88, silver: 0x9aa3ad,
  glass: 0x66c8ff, brass: 0xc9a227, red: 0xff3b30,
  raw: 0x8d959f,        // bare, unblued steel — a crown, a trigger, a bolt face
  bore: 0x08090b,       // the hole itself
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
 * The `lastShot` stamp a weapon carries out of a swap.
 *
 * Bringing a weapon up has always been recorded as a shot a moment ago, which
 * means what stands between the swap and the first round is the weapon's own
 * fire interval. On a rifle that is nothing; on a launcher at 46 rounds a
 * minute it was a second and a third of holding a live tube unable to pull the
 * trigger. A weapon that sets `drawTime` caps the wait there instead, for the
 * ones slow enough that it is a delay rather than a formality.
 *
 * `grace` is the slice of the wait each side forgives — a tenth of a second on
 * the client, 0.15 on the room, exactly as before this was a knob.
 */
export const drawStamp = (w, now, grace) =>
  now - Math.max(grace, shotInterval(w) - (w.drawTime ?? Infinity));

/**
 * Effective spread for a player state (radians, cone half-angle).
 *
 * `burst` is how many rounds have gone down range without letting the cone
 * settle. It grows the cone (bloom) up to a per-weapon ceiling, which is what
 * makes tapping strictly better than holding at range — and the first round out
 * of a settled weapon is the most accurate one it will ever fire.
 *
 * `mult` is the last term applied and it belongs to the player rather than to
 * the weapon — a Perks-mode Marksman shoots a tighter cone out of the same
 * rifle. It multiplies the finished number rather than any of the parts, so a
 * perk narrows movement, bloom and stance in the same proportion instead of
 * quietly rewriting which of them dominates.
 */
export function spreadFor(w, {
  moving = false, airborne = false, ads = false, crouching = false, burst = 0, mult = 1,
} = {}) {
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
  return s * mult;
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
      /* Slide — one mass, then the cuts that make it read as steel. */
      { p: [0, 0.014, -0.05], s: [0.068, 0.094, 0.46], c: COL.steel, m: MAT.METAL, z: Z.BODY, tag: 'slide' },
      { p: [0, 0.062, -0.05], s: [0.052, 0.016, 0.44], c: COL.gunmetal, m: MAT.ALLOY, z: Z.BODY, tag: 'slide' },
      { p: [0, 0.014, -0.285], s: [0.062, 0.086, 0.035], c: COL.dark, m: MAT.METAL, z: Z.METAL, tag: 'slide' },
      { p: [0, 0.014, 0.1], s: [0.072, 0.07, 0.009], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
      { p: [0, 0.014, 0.128], s: [0.072, 0.07, 0.009], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
      { p: [0, 0.014, 0.156], s: [0.072, 0.07, 0.009], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
      { p: [0, 0.014, -0.2], s: [0.072, 0.062, 0.009], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
      { p: [0, 0.014, -0.228], s: [0.072, 0.062, 0.009], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
      { p: [0.033, 0.034, 0.02], s: [0.009, 0.042, 0.13], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, tag: 'slide' },
      { p: [0.032, 0.014, 0.088], s: [0.009, 0.022, 0.05], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, tag: 'slide', fine: 1 },

      /* Barrel: bare steel at the crown, which is where a real one shows. */
      { p: [0, 0, -0.3], s: [0.03, 0.03, 0.1], c: COL.raw, m: MAT.ALLOY, z: Z.METAL },
      { p: [0, 0, -0.336], s: [0.036, 0.036, 0.022], c: COL.dark, m: MAT.METAL, z: Z.METAL },
      { p: [0, 0, -0.348], s: [0.018, 0.018, 0.012], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

      /* Frame, dust cover and a two-slot accessory rail. */
      { p: [0, -0.052, -0.06], s: [0.062, 0.05, 0.36], c: COL.poly, m: MAT.POLY, z: Z.BODY },
      { p: [0, -0.086, -0.15], s: [0.046, 0.018, 0.18], c: COL.poly, m: MAT.POLY, z: Z.ACCENT, fine: 1 },
      { p: [0, -0.094, -0.1], s: [0.048, 0.008, 0.014], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
      { p: [0, -0.094, -0.18], s: [0.048, 0.008, 0.014], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },

      /* Trigger guard drawn as a bow rather than a single block. */
      { p: [0, -0.1, -0.085], s: [0.03, 0.062, 0.02], c: COL.poly, m: MAT.POLY, z: Z.BODY },
      { p: [0, -0.126, -0.03], s: [0.03, 0.02, 0.13], c: COL.poly, m: MAT.POLY, z: Z.BODY },
      { p: [0, -0.086, -0.03], s: [0.014, 0.052, 0.015], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },

      /* Grip: raked, stippled panels, a rubber backstrap. */
      { p: [0, -0.2, 0.115], s: [0.06, 0.24, 0.1], c: COL.poly, m: MAT.POLY, z: Z.WOOD, r: [0.26, 0, 0] },
      { p: [0.031, -0.2, 0.113], s: [0.006, 0.19, 0.086], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.26, 0, 0], fine: 1 },
      { p: [-0.031, -0.2, 0.113], s: [0.006, 0.19, 0.086], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.26, 0, 0], fine: 1 },
      { p: [0, -0.192, 0.158], s: [0.05, 0.21, 0.018], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.26, 0, 0] },
      { p: [0, -0.032, 0.152], s: [0.052, 0.036, 0.06], c: COL.poly, m: MAT.POLY, z: Z.BODY, r: [-0.3, 0, 0], fine: 1 },

      /* The magazine is the magazine — the grip stays on the gun when it drops. */
      { p: [0, -0.205, 0.111], s: [0.046, 0.25, 0.07], c: COL.steel, m: MAT.METAL, z: Z.ACCENT, r: [0.26, 0, 0], tag: 'mag' },
      { p: [0, -0.328, 0.144], s: [0.066, 0.022, 0.098], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, r: [0.26, 0, 0], tag: 'mag' },

      /* Controls. */
      { p: [-0.034, -0.042, 0.02], s: [0.009, 0.017, 0.075], c: COL.gunmetal, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
      { p: [0.034, -0.048, -0.005], s: [0.009, 0.02, 0.026], c: COL.gunmetal, m: MAT.ALLOY, z: Z.METAL, fine: 1 },

      /* Three-dot night sights. */
      { p: [0, 0.08, 0.14], s: [0.05, 0.028, 0.026], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, tag: 'slide' },
      { p: [0.017, 0.083, 0.14], s: [0.009, 0.011, 0.014], c: 0x1affa0, m: MAT.EMIT, z: Z.DETAIL, tag: 'slide', fine: 1 },
      { p: [-0.017, 0.083, 0.14], s: [0.009, 0.011, 0.014], c: 0x1affa0, m: MAT.EMIT, z: Z.DETAIL, tag: 'slide', fine: 1 },
      { p: [0, 0.08, -0.24], s: [0.016, 0.028, 0.02], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, tag: 'slide' },
      { p: [0, 0.085, -0.246], s: [0.011, 0.013, 0.011], c: 0x1affa0, m: MAT.EMIT, z: Z.DETAIL, tag: 'slide', fine: 1 },
    ],
    muzzle: [0, 0, -0.36],
    eject: [0.05, 0.04, 0.02],
    sight: [0, 0.092, 0],
    grip: [0, -0.185, 0.128], gripTilt: 0.26,
    fore: [-0.068, -0.15, 0.112], foreKind: 'cup',
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
      /* Blade: a spine, a hollow grind and a bevelled edge, not one plate. */
      { p: [0, 0.012, -0.24], s: [0.02, 0.052, 0.42], c: 0xb9c1cc, m: MAT.ALLOY, z: Z.METAL },
      { p: [0, 0.045, -0.25], s: [0.024, 0.026, 0.4], c: 0x8d95a1, m: MAT.ALLOY, z: Z.METAL },
      { p: [0, -0.019, -0.25], s: [0.011, 0.02, 0.4], c: 0xeef3fa, m: MAT.ALLOY, z: Z.METAL },
      { p: [0, 0.052, -0.13], s: [0.026, 0.014, 0.1], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
      { p: [0, 0.052, -0.1], s: [0.026, 0.014, 0.1], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
      { p: [0, 0.026, -0.46], s: [0.018, 0.062, 0.1], c: 0xb9c1cc, m: MAT.ALLOY, z: Z.METAL, r: [0, 0, 0] },
      { p: [0, -0.004, -0.5], s: [0.014, 0.05, 0.08], c: 0xd8dee7, m: MAT.ALLOY, z: Z.METAL, r: [0.42, 0, 0] },
      { p: [0.012, 0.02, -0.3], s: [0.002, 0.03, 0.16], c: 0x2b3038, m: MAT.METAL, z: Z.ACCENT, fine: 1 },

      /* Guard and ricasso. */
      { p: [0, 0.005, -0.02], s: [0.05, 0.058, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
      { p: [0, 0.052, -0.02], s: [0.03, 0.03, 0.04], c: COL.gunmetal, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
      { p: [0, -0.03, -0.02], s: [0.03, 0.03, 0.04], c: COL.gunmetal, m: MAT.METAL, z: Z.ACCENT, fine: 1 },

      /* Handle: scales over a tang, with finger grooves. */
      { p: [0, 0, 0.11], s: [0.038, 0.056, 0.24], c: COL.black, m: MAT.RUBBER, z: Z.WOOD },
      { p: [0.02, 0, 0.11], s: [0.004, 0.044, 0.22], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, fine: 1 },
      { p: [-0.02, 0, 0.11], s: [0.004, 0.044, 0.22], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, fine: 1 },
      { p: [0, -0.03, 0.05], s: [0.04, 0.016, 0.03], c: COL.dark, m: MAT.RUBBER, z: Z.DETAIL, fine: 1 },
      { p: [0, -0.03, 0.11], s: [0.04, 0.016, 0.03], c: COL.dark, m: MAT.RUBBER, z: Z.DETAIL, fine: 1 },
      { p: [0, -0.03, 0.17], s: [0.04, 0.016, 0.03], c: COL.dark, m: MAT.RUBBER, z: Z.DETAIL, fine: 1 },
      { p: [0, 0, 0.245], s: [0.044, 0.05, 0.036], c: COL.gunmetal, m: MAT.METAL, z: Z.ACCENT },
      { p: [0, 0, 0.268], s: [0.016, 0.016, 0.012], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
    ],
    muzzle: [0, 0, -0.52],
    sight: [0, 0.02, -0.1],
    grip: [0, 0, 0.115], gripTilt: 0, gripAxis: 'z',
    fore: [-0.03, -0.075, 0.19], foreKind: 'idle',
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
          /* Stamped receiver, dust cover, selector. */
          { p: [0, 0, 0.02], s: [0.076, 0.11, 0.5], c: COL.steel, m: MAT.METAL, z: Z.BODY },
          { p: [0, 0.066, 0.02], s: [0.066, 0.026, 0.48], c: COL.gunmetal, m: MAT.ALLOY, z: Z.BODY },
          { p: [0, 0.081, 0.02], s: [0.032, 0.012, 0.46], c: COL.steel, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0.04, 0.01, 0.08], s: [0.008, 0.06, 0.22], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0.047, 0.05, 0.11], s: [0.016, 0.08, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, r: [0, 0, 0.22] },
          { p: [0, -0.052, -0.06], s: [0.07, 0.05, 0.14], c: COL.steel, m: MAT.METAL, z: Z.BODY },

          /* Handguard, vented, with the gas tube riding over it. */
          { p: [0, 0.004, -0.34], s: [0.06, 0.064, 0.3], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD },
          { p: [0, 0.054, -0.34], s: [0.05, 0.032, 0.28], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD },
          { p: [0.031, 0.054, -0.3], s: [0.007, 0.022, 0.05], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [-0.031, 0.054, -0.3], s: [0.007, 0.022, 0.05], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0.031, 0.054, -0.38], s: [0.007, 0.022, 0.05], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [-0.031, 0.054, -0.38], s: [0.007, 0.022, 0.05], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.052, -0.51], s: [0.042, 0.056, 0.08], c: COL.gunmetal, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.05, -0.46], s: [0.03, 0.03, 0.06], c: COL.gunmetal, m: MAT.METAL, z: Z.METAL, fine: 1 },

          /* Barrel and a two-port brake. */
          { p: [0, 0.005, -0.64], s: [0.026, 0.026, 0.32], c: COL.black, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.005, -0.78], s: [0.034, 0.034, 0.05], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.005, -0.86], s: [0.048, 0.048, 0.1], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.005, -0.86], s: [0.056, 0.014, 0.055], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.005, -0.912], s: [0.02, 0.02, 0.014], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Furniture: grip, stock, butt pad, sling loop. */
          { p: [0, -0.165, 0.07], s: [0.062, 0.24, 0.11], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD, r: [0.3, 0, 0] },
          { p: [0, -0.255, 0.098], s: [0.066, 0.032, 0.116], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.3, 0, 0], fine: 1 },
          { p: [0, -0.02, 0.26], s: [0.058, 0.1, 0.26], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD, r: [0.06, 0, 0] },
          { p: [0, 0.032, 0.24], s: [0.05, 0.05, 0.22], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD, fine: 1 },
          { p: [0, 0.006, 0.4], s: [0.062, 0.115, 0.038], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD },
          { p: [0.033, -0.05, 0.22], s: [0.011, 0.024, 0.032], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },

          /* The banana magazine, raked in three segments so it actually curves. */
          { p: [0, -0.12, -0.135], s: [0.056, 0.15, 0.132], c: COL.steel, m: MAT.METAL, z: Z.ACCENT, r: [-0.14, 0, 0], tag: 'mag' },
          { p: [0, -0.222, -0.178], s: [0.052, 0.13, 0.118], c: COL.steel, m: MAT.METAL, z: Z.ACCENT, r: [-0.44, 0, 0], tag: 'mag' },
          { p: [0, -0.3, -0.246], s: [0.05, 0.08, 0.1], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, r: [-0.74, 0, 0], tag: 'mag', fine: 1 },
          { p: [0, -0.12, -0.135], s: [0.06, 0.022, 0.138], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, r: [-0.14, 0, 0], tag: 'mag', fine: 1 },

          /* Trigger group and charging handle. */
          { p: [0, -0.076, -0.005], s: [0.034, 0.018, 0.12], c: COL.steel, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.058, -0.058], s: [0.032, 0.045, 0.018], c: COL.steel, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.04, -0.012], s: [0.013, 0.045, 0.013], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
          { p: [0.05, 0.036, 0.03], s: [0.032, 0.024, 0.075], c: COL.gunmetal, m: MAT.ALLOY, z: Z.METAL, tag: 'bolt' },
          { p: [0.03, 0.036, 0.03], s: [0.022, 0.022, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.METAL, tag: 'bolt', fine: 1 },

          /* Irons: a rear leaf between ears, a hooded front post. */
          { p: [0, 0.088, 0.19], s: [0.042, 0.03, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0.017, 0.1, 0.19], s: [0.011, 0.028, 0.032], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [-0.017, 0.1, 0.19], s: [0.011, 0.028, 0.032], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.098, -0.78], s: [0.032, 0.052, 0.032], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.098, -0.782], s: [0.009, 0.04, 0.012], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
        ],
        muzzle: [0, 0.005, -0.92],
        eject: [0.06, 0.05, 0],
        sight: [0, 0.1, 0],
        grip: [0, -0.15, 0.085], gripTilt: 0.3,
        fore: [0, -0.055, -0.35], foreKind: 'fore',
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
          /* Chassis: a bedded action in a polymer stock. */
          { p: [0, -0.012, 0.06], s: [0.072, 0.1, 0.72], c: COL.olive, m: MAT.POLY, z: Z.BODY },
          { p: [0, 0.046, 0.02], s: [0.052, 0.052, 0.56], c: COL.steel, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.046, 0.28], s: [0.056, 0.056, 0.06], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0.033, 0.05, 0.02], s: [0.008, 0.03, 0.5], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Free-floated heavy barrel with a fluted section and a can on the end. */
          { p: [0, 0.02, -0.56], s: [0.036, 0.036, 0.62], c: COL.black, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.038, -0.56], s: [0.026, 0.008, 0.56], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.002, -0.56], s: [0.026, 0.008, 0.56], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.02, -0.98], s: [0.054, 0.054, 0.24], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.02, -0.87], s: [0.06, 0.06, 0.022], c: COL.gunmetal, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
          { p: [0, 0.02, -1.09], s: [0.06, 0.06, 0.022], c: COL.gunmetal, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
          { p: [0, 0.02, -1.105], s: [0.024, 0.024, 0.014], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Grip, thumb shelf, adjustable comb and butt. */
          { p: [0, -0.14, 0.13], s: [0.06, 0.22, 0.11], c: COL.olive, m: MAT.POLY, z: Z.WOOD, r: [0.32, 0, 0] },
          { p: [0.032, -0.14, 0.128], s: [0.006, 0.17, 0.086], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.32, 0, 0], fine: 1 },
          { p: [-0.032, -0.14, 0.128], s: [0.006, 0.17, 0.086], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.32, 0, 0], fine: 1 },
          { p: [0, -0.24, 0.166], s: [0.064, 0.03, 0.11], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.32, 0, 0], fine: 1 },
          { p: [0, 0.005, 0.36], s: [0.062, 0.14, 0.3], c: COL.olive, m: MAT.POLY, z: Z.WOOD },
          { p: [0, 0.086, 0.34], s: [0.05, 0.05, 0.2], c: COL.dark, m: MAT.POLY, z: Z.WOOD },
          { p: [0, 0.038, 0.5], s: [0.066, 0.125, 0.045], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD },
          { p: [0, -0.078, 0.44], s: [0.05, 0.1, 0.14], c: COL.olive, m: MAT.POLY, z: Z.WOOD, fine: 1 },
          { p: [0, -0.05, 0.5], s: [0.036, 0.05, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },

          /* Detachable box magazine. */
          { p: [0, -0.115, -0.16], s: [0.052, 0.17, 0.11], c: COL.steel, m: MAT.METAL, z: Z.ACCENT, tag: 'mag' },
          { p: [0, -0.208, -0.16], s: [0.06, 0.024, 0.12], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, tag: 'mag', fine: 1 },
          { p: [0, -0.055, -0.16], s: [0.056, 0.05, 0.116], c: COL.olive, m: MAT.POLY, z: Z.BODY, fine: 1 },

          /* Trigger group. */
          { p: [0, -0.08, -0.03], s: [0.032, 0.02, 0.11], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.058, -0.078], s: [0.03, 0.05, 0.018], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.04, -0.032], s: [0.013, 0.048, 0.013], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },

          /* Bolt: body, handle and knob, all pulled together on the cycle. */
          { p: [0.052, 0.06, 0.07], s: [0.07, 0.024, 0.024], c: COL.gunmetal, m: MAT.ALLOY, z: Z.METAL, tag: 'bolt' },
          { p: [0.096, 0.048, 0.07], s: [0.034, 0.055, 0.055], c: COL.silver, m: MAT.ALLOY, z: Z.METAL, tag: 'bolt' },
          { p: [0.096, 0.048, 0.07], s: [0.038, 0.02, 0.02], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'bolt', fine: 1 },

          /* Glass: 30 mm tube, bell, turrets, ocular. Cantilever mount, two rings. */
          { p: [0, 0.142, -0.1], s: [0.064, 0.064, 0.5], c: COL.black, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.142, -0.33], s: [0.09, 0.09, 0.07], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.142, -0.368], s: [0.076, 0.076, 0.014], c: COL.glass, m: MAT.GLASS, z: Z.DETAIL },
          { p: [0, 0.142, 0.14], s: [0.074, 0.074, 0.06], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.142, 0.172], s: [0.058, 0.058, 0.012], c: 0x0d1b26, m: MAT.GLASS, z: Z.DETAIL },
          { p: [0, 0.205, -0.06], s: [0.034, 0.04, 0.062], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },
          { p: [0.05, 0.142, -0.06], s: [0.04, 0.034, 0.062], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.1, -0.24], s: [0.03, 0.05, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.1, 0.04], s: [0.03, 0.05, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },

          /* Folded bipod under the fore-end. */
          { p: [0, -0.07, -0.48], s: [0.032, 0.06, 0.14], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, fine: 1 },
          { p: [0.028, -0.12, -0.5], s: [0.014, 0.14, 0.014], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, r: [0.2, 0, 0.24], fine: 1 },
          { p: [-0.028, -0.12, -0.5], s: [0.014, 0.14, 0.014], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, r: [0.2, 0, -0.24], fine: 1 },
        ],
        muzzle: [0, 0.02, -1.12],
        eject: [0.06, 0.07, 0.06],
        sight: [0, 0.142, 0],
        grip: [0, -0.125, 0.145], gripTilt: 0.32,
        fore: [0, -0.06, -0.4], foreKind: 'fore',
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
          /* Polymer lower, steel upper, ambidextrous controls. */
          { p: [0, 0, 0], s: [0.07, 0.1, 0.38], c: COL.poly, m: MAT.POLY, z: Z.BODY },
          { p: [0, 0.056, 0], s: [0.056, 0.026, 0.36], c: COL.gunmetal, m: MAT.ALLOY, z: Z.BODY },
          { p: [0, 0.012, -0.26], s: [0.056, 0.07, 0.2], c: COL.poly, m: MAT.POLY, z: Z.BODY },
          { p: [0.03, 0.012, -0.26], s: [0.008, 0.05, 0.16], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [-0.03, 0.012, -0.26], s: [0.008, 0.05, 0.16], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [0.038, -0.005, 0.06], s: [0.012, 0.03, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },
          { p: [-0.038, -0.005, 0.06], s: [0.012, 0.03, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },

          /* Barrel, shroud and a birdcage. */
          { p: [0, 0.005, -0.42], s: [0.026, 0.026, 0.16], c: COL.black, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.005, -0.52], s: [0.04, 0.04, 0.08], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.005, -0.545], s: [0.046, 0.014, 0.03], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.005, -0.565], s: [0.018, 0.018, 0.012], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Grip and vertical fore-grip — the two places the hands actually land. */
          { p: [0, -0.15, 0.035], s: [0.058, 0.21, 0.1], c: COL.poly, m: MAT.POLY, z: Z.WOOD, r: [0.26, 0, 0] },
          { p: [0, -0.235, 0.058], s: [0.062, 0.028, 0.108], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, r: [0.26, 0, 0], fine: 1 },
          { p: [0, -0.1, -0.3], s: [0.05, 0.16, 0.06], c: COL.dark, m: MAT.POLY, z: Z.WOOD, r: [-0.12, 0, 0] },
          { p: [0, -0.175, -0.31], s: [0.056, 0.026, 0.07], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [-0.12, 0, 0], fine: 1 },

          /* Translucent magazine, raked forward out of the well. */
          { p: [0, -0.14, -0.1], s: [0.05, 0.22, 0.092], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, r: [-0.1, 0, 0], tag: 'mag' },
          { p: [0, -0.252, -0.112], s: [0.056, 0.024, 0.1], c: COL.black, m: MAT.POLY, z: Z.ACCENT, r: [-0.1, 0, 0], tag: 'mag', fine: 1 },
          { p: [0.026, -0.14, -0.1], s: [0.004, 0.18, 0.06], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, r: [-0.1, 0, 0], tag: 'mag', fine: 1 },
          { p: [0, -0.05, -0.1], s: [0.056, 0.05, 0.1], c: COL.poly, m: MAT.POLY, z: Z.BODY, fine: 1 },

          /* Trigger group. */
          { p: [0, -0.062, 0.005], s: [0.03, 0.016, 0.1], c: COL.black, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.045, -0.042], s: [0.028, 0.04, 0.016], c: COL.black, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.032, 0], s: [0.012, 0.04, 0.012], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },

          /* Folding stock: a wire frame and a cheek pad. */
          { p: [0, 0.008, 0.24], s: [0.052, 0.08, 0.16], c: COL.dark, m: MAT.POLY, z: Z.WOOD },
          { p: [0.024, 0.008, 0.34], s: [0.012, 0.014, 0.14], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT },
          { p: [-0.024, 0.008, 0.34], s: [0.012, 0.014, 0.14], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT },
          { p: [0, 0.008, 0.412], s: [0.06, 0.09, 0.026], c: COL.black, m: MAT.RUBBER, z: Z.WOOD },
          { p: [0, 0.05, 0.28], s: [0.04, 0.022, 0.12], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD, fine: 1 },

          /* Full-length rail with a red dot on it, plus a folded backup post. */
          { p: [0, 0.08, 0.02], s: [0.052, 0.018, 0.34], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.086, 0.1], s: [0.056, 0.008, 0.012], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.086, -0.02], s: [0.056, 0.008, 0.012], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.104, 0.13], s: [0.05, 0.02, 0.07], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.132, 0.12], s: [0.052, 0.05, 0.058], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.132, 0.092], s: [0.042, 0.042, 0.008], c: 0x1a3548, m: MAT.GLASS, z: Z.DETAIL },
          { p: [0, 0.132, 0.09], s: [0.009, 0.009, 0.006], c: COL.red, m: MAT.EMIT, z: Z.DETAIL },
          { p: [0, 0.132, 0.148], s: [0.042, 0.042, 0.008], c: 0x0d1b26, m: MAT.GLASS, z: Z.DETAIL, fine: 1 },
        ],
        muzzle: [0, 0.005, -0.6],
        eject: [0.055, 0.045, -0.02],
        sight: [0, 0.132, 0.12],
        grip: [0, -0.135, 0.055], gripTilt: 0.26,
        fore: [0, -0.11, -0.3], foreKind: 'vert',
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
          /* Big stamped body, feed tray, carry handle. */
          { p: [0, 0, 0.02], s: [0.09, 0.13, 0.56], c: COL.olive, m: MAT.POLY, z: Z.BODY },
          { p: [0, 0.076, 0.02], s: [0.074, 0.03, 0.54], c: COL.gunmetal, m: MAT.METAL, z: Z.BODY },
          { p: [0, 0.094, 0.06], s: [0.08, 0.014, 0.3], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0.046, 0.02, 0.02], s: [0.008, 0.07, 0.5], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.12, -0.36], s: [0.05, 0.034, 0.26], c: COL.gunmetal, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.1, -0.47], s: [0.05, 0.06, 0.03], c: COL.gunmetal, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.1, -0.25], s: [0.05, 0.06, 0.03], c: COL.gunmetal, m: MAT.METAL, z: Z.ACCENT, fine: 1 },

          /* Heavy barrel with a heat shield and a slotted flash hider. */
          { p: [0, 0.02, -0.44], s: [0.052, 0.052, 0.42], c: COL.black, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.05, -0.44], s: [0.03, 0.008, 0.38], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.02, -0.78], s: [0.034, 0.034, 0.3], c: COL.black, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.02, -0.95], s: [0.052, 0.052, 0.12], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.048, -0.95], s: [0.026, 0.014, 0.07], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.02, -1.015], s: [0.024, 0.024, 0.014], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Belt drum, with a strip of visible brass leaving it. */
          { p: [0, -0.2, 0], s: [0.18, 0.21, 0.27], c: COL.olive, m: MAT.POLY, z: Z.ACCENT, tag: 'mag' },
          { p: [0.092, -0.2, 0], s: [0.012, 0.17, 0.23], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, tag: 'mag' },
          { p: [-0.092, -0.2, 0], s: [0.012, 0.17, 0.23], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, tag: 'mag', fine: 1 },
          { p: [0, -0.2, -0.14], s: [0.14, 0.13, 0.014], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, tag: 'mag', fine: 1 },
          { p: [0, -0.086, 0.02], s: [0.056, 0.06, 0.09], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, tag: 'mag' },
          { p: [0, -0.086, 0.02], s: [0.062, 0.014, 0.094], c: 0x8a6a1a, m: MAT.ALLOY, z: Z.DETAIL, tag: 'mag', fine: 1 },

          /* Grip, trigger, and a fat foregrip under the shield. */
          { p: [0, -0.165, 0.31], s: [0.062, 0.23, 0.11], c: COL.dark, m: MAT.POLY, z: Z.WOOD, r: [0.3, 0, 0] },
          { p: [0, -0.255, 0.338], s: [0.066, 0.03, 0.116], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [0.3, 0, 0], fine: 1 },
          { p: [0, -0.075, 0.245], s: [0.036, 0.02, 0.11], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.055, 0.198], s: [0.034, 0.05, 0.018], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.038, 0.242], s: [0.014, 0.045, 0.014], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
          { p: [0, -0.08, -0.36], s: [0.052, 0.09, 0.24], c: COL.olive, m: MAT.POLY, z: Z.WOOD },
          { p: [0, -0.13, -0.36], s: [0.058, 0.024, 0.25], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, fine: 1 },

          /* Stock with a shoulder hook. */
          { p: [0, 0, 0.36], s: [0.064, 0.12, 0.26], c: COL.olive, m: MAT.POLY, z: Z.WOOD },
          { p: [0, 0.058, 0.34], s: [0.05, 0.05, 0.2], c: COL.dark, m: MAT.POLY, z: Z.WOOD, fine: 1 },
          { p: [0, 0.02, 0.48], s: [0.068, 0.13, 0.04], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD },
          { p: [0, -0.06, 0.46], s: [0.05, 0.06, 0.12], c: COL.olive, m: MAT.POLY, z: Z.WOOD, r: [0.4, 0, 0], fine: 1 },

          /* Folding bipod and irons. */
          { p: [0.03, -0.14, -0.6], s: [0.016, 0.16, 0.016], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, r: [0, 0, 0.3], fine: 1 },
          { p: [-0.03, -0.14, -0.6], s: [0.016, 0.16, 0.016], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, r: [0, 0, -0.3], fine: 1 },
          { p: [0, 0.108, 0.24], s: [0.044, 0.034, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0.018, 0.12, 0.24], s: [0.011, 0.03, 0.032], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [-0.018, 0.12, 0.24], s: [0.011, 0.03, 0.032], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.108, -0.55], s: [0.03, 0.056, 0.03], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.108, -0.552], s: [0.009, 0.042, 0.012], c: COL.black, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
        ],
        muzzle: [0, 0.02, -1.02],
        eject: [0.07, 0.03, 0.02],
        sight: [0, 0.126, 0],
        grip: [0, -0.15, 0.325], gripTilt: 0.3,
        fore: [0, -0.135, -0.36], foreKind: 'fore',
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
          /* Frame, top strap and a vented rib down the barrel. */
          { p: [0, 0.018, -0.13], s: [0.052, 0.08, 0.4], c: COL.silver, m: MAT.ALLOY, z: Z.BODY },
          { p: [0, 0.058, -0.16], s: [0.042, 0.024, 0.36], c: 0xb9c2cc, m: MAT.ALLOY, z: Z.BODY },
          { p: [0, 0.07, -0.1], s: [0.03, 0.012, 0.05], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.07, -0.2], s: [0.03, 0.012, 0.05], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, -0.018, -0.19], s: [0.038, 0.036, 0.3], c: 0x8f99a4, m: MAT.ALLOY, z: Z.BODY, fine: 1 },
          { p: [0, 0.018, -0.32], s: [0.05, 0.07, 0.05], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.018, -0.342], s: [0.02, 0.02, 0.012], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Six-shot cylinder: a hex barrel of flats with visible chambers. */
          { p: [0, 0.005, -0.02], s: [0.1, 0.1, 0.125], c: 0x8f99a4, m: MAT.ALLOY, z: Z.METAL, tag: 'cyl' },
          { p: [0, 0.005, -0.02], s: [0.112, 0.05, 0.12], c: 0x8f99a4, m: MAT.ALLOY, z: Z.METAL, r: [0, 0, 1.047], tag: 'cyl' },
          { p: [0, 0.005, -0.02], s: [0.112, 0.05, 0.12], c: 0x8f99a4, m: MAT.ALLOY, z: Z.METAL, r: [0, 0, -1.047], tag: 'cyl' },
          { p: [0, 0.052, 0.044], s: [0.022, 0.022, 0.008], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, tag: 'cyl', fine: 1 },
          { p: [0.042, 0.028, 0.044], s: [0.022, 0.022, 0.008], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, tag: 'cyl', fine: 1 },
          { p: [-0.042, 0.028, 0.044], s: [0.022, 0.022, 0.008], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, tag: 'cyl', fine: 1 },
          { p: [0.042, -0.02, 0.044], s: [0.022, 0.022, 0.008], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, tag: 'cyl', fine: 1 },
          { p: [-0.042, -0.02, 0.044], s: [0.022, 0.022, 0.008], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, tag: 'cyl', fine: 1 },
          { p: [0, -0.042, 0.044], s: [0.022, 0.022, 0.008], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, tag: 'cyl', fine: 1 },
          { p: [0, 0.005, -0.11], s: [0.022, 0.022, 0.14], c: 0x767f8a, m: MAT.ALLOY, z: Z.METAL, tag: 'cyl', fine: 1 },

          /* Hammer, trigger, guard and the cylinder latch. */
          { p: [0, 0.062, 0.12], s: [0.024, 0.06, 0.04], c: COL.dark, m: MAT.METAL, z: Z.METAL, r: [0.3, 0, 0] },
          { p: [0, 0.086, 0.135], s: [0.03, 0.016, 0.03], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, -0.07, 0.045], s: [0.03, 0.02, 0.11], c: 0x8f99a4, m: MAT.ALLOY, z: Z.BODY },
          { p: [0, -0.05, -0.002], s: [0.028, 0.05, 0.018], c: 0x8f99a4, m: MAT.ALLOY, z: Z.BODY, fine: 1 },
          { p: [0, -0.034, 0.042], s: [0.014, 0.048, 0.014], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [-0.03, 0.005, 0.075], s: [0.012, 0.03, 0.06], c: 0x767f8a, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },

          /* Chequered wood grips with a steel backstrap and a lanyard ring. */
          { p: [0, -0.155, 0.135], s: [0.058, 0.23, 0.115], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD, r: [0.34, 0, 0] },
          { p: [0.03, -0.155, 0.133], s: [0.007, 0.19, 0.096], c: COL.wood, m: MAT.WOOD, z: Z.WOOD, r: [0.34, 0, 0], fine: 1 },
          { p: [-0.03, -0.155, 0.133], s: [0.007, 0.19, 0.096], c: COL.wood, m: MAT.WOOD, z: Z.WOOD, r: [0.34, 0, 0], fine: 1 },
          { p: [0, -0.14, 0.192], s: [0.046, 0.2, 0.02], c: 0x8f99a4, m: MAT.ALLOY, z: Z.ACCENT, r: [0.34, 0, 0], fine: 1 },
          { p: [0, -0.262, 0.176], s: [0.05, 0.032, 0.09], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, r: [0.34, 0, 0], fine: 1 },

          /* Ramp front sight with a red insert, adjustable notch at the rear. */
          { p: [0, 0.076, 0.1], s: [0.036, 0.026, 0.03], c: COL.black, m: MAT.METAL, z: Z.ACCENT },
          { p: [0.012, 0.082, 0.1], s: [0.008, 0.02, 0.02], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [-0.012, 0.082, 0.1], s: [0.008, 0.02, 0.02], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.08, -0.3], s: [0.014, 0.03, 0.016], c: COL.black, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.086, -0.303], s: [0.014, 0.014, 0.012], c: COL.red, m: MAT.EMIT, z: Z.DETAIL, fine: 1 },
        ],
        muzzle: [0, 0.018, -0.36],
        eject: [0.06, 0, -0.02],
        sight: [0, 0.086, 0],
        grip: [0, -0.14, 0.15], gripTilt: 0.34,
        fore: [-0.068, -0.115, 0.135], foreKind: 'cup',
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
          /* Machine pistol: long slide, ported, with a stubby compensator. */
          { p: [0, 0.012, -0.04], s: [0.06, 0.098, 0.38], c: COL.silver, m: MAT.ALLOY, z: Z.BODY, tag: 'slide' },
          { p: [0, 0.058, -0.04], s: [0.046, 0.018, 0.36], c: 0xb9c2cc, m: MAT.ALLOY, z: Z.BODY, tag: 'slide' },
          { p: [0, 0.058, -0.14], s: [0.03, 0.014, 0.03], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
          { p: [0, 0.058, -0.08], s: [0.03, 0.014, 0.03], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
          { p: [0, 0.012, 0.1], s: [0.064, 0.076, 0.009], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
          { p: [0, 0.012, 0.126], s: [0.064, 0.076, 0.009], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'slide', fine: 1 },
          { p: [0.03, 0.032, 0.02], s: [0.008, 0.04, 0.12], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, tag: 'slide' },
          { p: [0, 0.006, -0.26], s: [0.048, 0.05, 0.09], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.006, -0.284], s: [0.052, 0.014, 0.04], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.006, -0.306], s: [0.018, 0.018, 0.012], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Frame, rail and trigger group. */
          { p: [0, -0.062, -0.01], s: [0.056, 0.06, 0.32], c: COL.dark, m: MAT.POLY, z: Z.BODY },
          { p: [0, -0.098, -0.11], s: [0.042, 0.016, 0.14], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, fine: 1 },
          { p: [0, -0.104, -0.14], s: [0.044, 0.008, 0.012], c: COL.black, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [0, -0.108, -0.05], s: [0.03, 0.06, 0.018], c: COL.dark, m: MAT.POLY, z: Z.BODY },
          { p: [0, -0.134, 0.005], s: [0.03, 0.018, 0.12], c: COL.dark, m: MAT.POLY, z: Z.BODY },
          { p: [0, -0.094, 0.005], s: [0.013, 0.05, 0.013], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },

          /* Extended magazine — this is the one that leaves the gun. */
          { p: [0, -0.215, 0.078], s: [0.048, 0.3, 0.078], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, r: [0.2, 0, 0], tag: 'mag' },
          { p: [0, -0.36, 0.108], s: [0.058, 0.024, 0.094], c: COL.black, m: MAT.POLY, z: Z.ACCENT, r: [0.2, 0, 0], tag: 'mag', fine: 1 },
          { p: [0.025, -0.215, 0.078], s: [0.004, 0.26, 0.05], c: COL.brass, m: MAT.ALLOY, z: Z.DETAIL, r: [0.2, 0, 0], tag: 'mag', fine: 1 },

          /* Grip. */
          { p: [0, -0.185, 0.08], s: [0.056, 0.23, 0.098], c: COL.dark, m: MAT.POLY, z: Z.WOOD, r: [0.2, 0, 0] },
          { p: [0.029, -0.185, 0.078], s: [0.006, 0.18, 0.082], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [0.2, 0, 0], fine: 1 },
          { p: [-0.029, -0.185, 0.078], s: [0.006, 0.18, 0.082], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [0.2, 0, 0], fine: 1 },
          { p: [0, -0.178, 0.122], s: [0.048, 0.2, 0.018], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [0.2, 0, 0], fine: 1 },

          /* Sights. */
          { p: [0, 0.076, 0.12], s: [0.044, 0.026, 0.026], c: COL.black, m: MAT.METAL, z: Z.ACCENT, tag: 'slide' },
          { p: [0.015, 0.079, 0.12], s: [0.008, 0.011, 0.014], c: 0x1affa0, m: MAT.EMIT, z: Z.DETAIL, tag: 'slide', fine: 1 },
          { p: [-0.015, 0.079, 0.12], s: [0.008, 0.011, 0.014], c: 0x1affa0, m: MAT.EMIT, z: Z.DETAIL, tag: 'slide', fine: 1 },
          { p: [0, 0.076, -0.2], s: [0.014, 0.026, 0.018], c: COL.black, m: MAT.METAL, z: Z.ACCENT, tag: 'slide' },
          { p: [0, 0.081, -0.206], s: [0.011, 0.012, 0.011], c: 0x1affa0, m: MAT.EMIT, z: Z.DETAIL, tag: 'slide', fine: 1 },
        ],
        muzzle: [0, 0.006, -0.32],
        eject: [0.05, 0.04, 0.02],
        sight: [0, 0.086, 0],
        grip: [0, -0.17, 0.09], gripTilt: 0.2,
        fore: null, foreKind: 'none',
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
          /* AR-pattern upper and lower, with a brass deflector and forward assist. */
          { p: [0, 0, 0.04], s: [0.072, 0.11, 0.44], c: COL.tan, m: MAT.POLY, z: Z.BODY },
          { p: [0, 0.062, 0.02], s: [0.06, 0.03, 0.5], c: COL.dark, m: MAT.METAL, z: Z.BODY },
          { p: [0.04, 0.03, 0.14], s: [0.014, 0.04, 0.05], c: COL.tan, m: MAT.POLY, z: Z.BODY, fine: 1 },
          { p: [0.04, -0.005, 0.16], s: [0.014, 0.032, 0.032], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0.038, 0.02, 0.04], s: [0.008, 0.05, 0.16], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [-0.04, -0.01, 0.1], s: [0.014, 0.028, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },

          /* Free-float M-LOK handguard: slotted panels on both sides and the belly. */
          { p: [0, 0.02, -0.38], s: [0.062, 0.078, 0.38], c: COL.tan, m: MAT.POLY, z: Z.BODY },
          { p: [0.033, 0.02, -0.34], s: [0.005, 0.026, 0.07], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [0.033, 0.02, -0.44], s: [0.005, 0.026, 0.07], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [-0.033, 0.02, -0.34], s: [0.005, 0.026, 0.07], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [-0.033, 0.02, -0.44], s: [0.005, 0.026, 0.07], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [0, -0.022, -0.38], s: [0.03, 0.008, 0.3], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.062, -0.38], s: [0.056, 0.022, 0.38], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },

          /* Barrel and a chunky muzzle brake. */
          { p: [0, 0.005, -0.68], s: [0.03, 0.03, 0.28], c: COL.black, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.005, -0.86], s: [0.05, 0.05, 0.12], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.005, -0.83], s: [0.056, 0.016, 0.03], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.005, -0.88], s: [0.056, 0.016, 0.03], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.005, -0.925], s: [0.02, 0.02, 0.014], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },

          /* Grip, trigger, 20-round magazine. */
          { p: [0, -0.165, 0.08], s: [0.06, 0.24, 0.11], c: COL.dark, m: MAT.POLY, z: Z.WOOD, r: [0.28, 0, 0] },
          { p: [0, -0.255, 0.106], s: [0.064, 0.03, 0.114], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [0.28, 0, 0], fine: 1 },
          { p: [0, -0.076, 0], s: [0.034, 0.018, 0.11], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.056, -0.05], s: [0.032, 0.048, 0.018], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.04, -0.006], s: [0.013, 0.045, 0.013], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
          { p: [0, -0.15, -0.1], s: [0.052, 0.21, 0.11], c: COL.tan, m: MAT.POLY, z: Z.ACCENT, r: [-0.06, 0, 0], tag: 'mag' },
          { p: [0, -0.258, -0.106], s: [0.058, 0.024, 0.116], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, r: [-0.06, 0, 0], tag: 'mag', fine: 1 },
          { p: [0, -0.15, -0.1], s: [0.056, 0.02, 0.114], c: COL.dark, m: MAT.POLY, z: Z.DETAIL, r: [-0.06, 0, 0], tag: 'mag', fine: 1 },

          /* Adjustable stock on a buffer tube. */
          { p: [0, 0.005, 0.24], s: [0.042, 0.05, 0.16], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, -0.005, 0.3], s: [0.06, 0.11, 0.22], c: COL.tan, m: MAT.POLY, z: Z.WOOD },
          { p: [0, 0.058, 0.28], s: [0.048, 0.05, 0.18], c: COL.tan, m: MAT.POLY, z: Z.WOOD, fine: 1 },
          { p: [0, -0.058, 0.36], s: [0.05, 0.05, 0.12], c: COL.dark, m: MAT.POLY, z: Z.WOOD, r: [0.35, 0, 0], fine: 1 },
          { p: [0, 0.005, 0.4], s: [0.064, 0.115, 0.036], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD },

          /* LPVO on a cantilever mount, with flip caps and a throw lever. */
          { p: [0, 0.128, -0.06], s: [0.058, 0.058, 0.4], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.128, -0.25], s: [0.076, 0.076, 0.06], c: COL.black, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.128, -0.283], s: [0.06, 0.06, 0.012], c: COL.glass, m: MAT.GLASS, z: Z.DETAIL },
          { p: [0, 0.128, 0.14], s: [0.062, 0.062, 0.05], c: COL.black, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.128, 0.168], s: [0.048, 0.048, 0.01], c: 0x0d1b26, m: MAT.GLASS, z: Z.DETAIL },
          { p: [0, 0.186, -0.04], s: [0.03, 0.036, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },
          { p: [0.044, 0.128, 0.08], s: [0.032, 0.03, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.09, -0.18], s: [0.03, 0.04, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.09, 0.04], s: [0.03, 0.04, 0.05], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
        ],
        muzzle: [0, 0.005, -0.94],
        eject: [0.06, 0.045, 0.06],
        sight: [0, 0.128, 0],
        grip: [0, -0.15, 0.095], gripTilt: 0.28,
        fore: [0, -0.04, -0.4], foreKind: 'fore',
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
          /* Milled receiver with a loading port and a shell lifter. */
          { p: [0, 0, 0.06], s: [0.076, 0.1, 0.4], c: COL.steel, m: MAT.METAL, z: Z.BODY },
          { p: [0, 0.052, 0.06], s: [0.06, 0.02, 0.38], c: COL.gunmetal, m: MAT.ALLOY, z: Z.BODY, fine: 1 },
          { p: [0.04, 0.005, 0.06], s: [0.008, 0.05, 0.16], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, -0.045, 0.06], s: [0.05, 0.03, 0.2], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.005, 0.245], s: [0.06, 0.07, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.BODY, fine: 1 },

          /* Barrel over a magazine tube, joined by a barrel band. */
          { p: [0, 0.036, -0.44], s: [0.05, 0.05, 0.66], c: COL.black, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0.036, -0.78], s: [0.056, 0.056, 0.03], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.036, -0.792], s: [0.03, 0.03, 0.014], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, -0.03, -0.4], s: [0.046, 0.046, 0.6], c: COL.gunmetal, m: MAT.METAL, z: Z.METAL },
          { p: [0, -0.03, -0.71], s: [0.05, 0.05, 0.04], c: COL.dark, m: MAT.METAL, z: Z.METAL, fine: 1 },
          { p: [0, 0.003, -0.6], s: [0.056, 0.09, 0.03], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },

          /* Pump: ribbed wood, and it is the part that travels on the cycle. */
          { p: [0, -0.03, -0.28], s: [0.068, 0.068, 0.24], c: COL.wood, m: MAT.WOOD, z: Z.WOOD, tag: 'pump' },
          { p: [0, -0.068, -0.28], s: [0.074, 0.03, 0.22], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD, tag: 'pump' },
          { p: [0, -0.03, -0.2], s: [0.074, 0.074, 0.014], c: COL.darkwood, m: MAT.WOOD, z: Z.DETAIL, tag: 'pump', fine: 1 },
          { p: [0, -0.03, -0.26], s: [0.074, 0.074, 0.014], c: COL.darkwood, m: MAT.WOOD, z: Z.DETAIL, tag: 'pump', fine: 1 },
          { p: [0, -0.03, -0.32], s: [0.074, 0.074, 0.014], c: COL.darkwood, m: MAT.WOOD, z: Z.DETAIL, tag: 'pump', fine: 1 },
          { p: [0, -0.03, -0.38], s: [0.074, 0.074, 0.014], c: COL.darkwood, m: MAT.WOOD, z: Z.DETAIL, tag: 'pump', fine: 1 },

          /* Trigger group and a shell carrier on the receiver's flank. */
          { p: [0, -0.07, 0.04], s: [0.034, 0.02, 0.12], c: COL.black, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.05, -0.012], s: [0.032, 0.05, 0.018], c: COL.black, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.032, 0.036], s: [0.014, 0.048, 0.014], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
          { p: [-0.044, 0.005, 0.1], s: [0.014, 0.05, 0.19], c: COL.dark, m: MAT.POLY, z: Z.ACCENT, fine: 1 },
          { p: [-0.05, 0.02, 0.06], s: [0.022, 0.022, 0.06], c: 0xc0392b, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [-0.05, -0.008, 0.06], s: [0.022, 0.022, 0.06], c: 0xc0392b, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [-0.05, 0.02, 0.14], s: [0.022, 0.022, 0.06], c: 0xc0392b, m: MAT.POLY, z: Z.DETAIL, fine: 1 },
          { p: [-0.05, -0.008, 0.14], s: [0.022, 0.022, 0.06], c: 0xc0392b, m: MAT.POLY, z: Z.DETAIL, fine: 1 },

          /* Wood stock with a rubber recoil pad. */
          { p: [0, -0.15, 0.15], s: [0.058, 0.2, 0.11], c: COL.wood, m: MAT.WOOD, z: Z.WOOD, r: [0.36, 0, 0] },
          { p: [0, -0.02, 0.33], s: [0.06, 0.12, 0.28], c: COL.wood, m: MAT.WOOD, z: Z.WOOD, r: [0.05, 0, 0] },
          { p: [0, 0.038, 0.31], s: [0.05, 0.05, 0.22], c: COL.wood, m: MAT.WOOD, z: Z.WOOD, fine: 1 },
          { p: [0, 0.005, 0.47], s: [0.064, 0.12, 0.04], c: COL.dark, m: MAT.RUBBER, z: Z.WOOD },
          { p: [0, 0.005, 0.45], s: [0.068, 0.128, 0.012], c: COL.black, m: MAT.RUBBER, z: Z.DETAIL, fine: 1 },

          /* Ghost ring at the back, a beaded post up front. */
          { p: [0, 0.07, 0.2], s: [0.04, 0.03, 0.03], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0.016, 0.082, 0.2], s: [0.01, 0.026, 0.026], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [-0.016, 0.082, 0.2], s: [0.01, 0.026, 0.026], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.075, -0.72], s: [0.014, 0.036, 0.016], c: COL.dark, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.086, -0.722], s: [0.016, 0.016, 0.014], c: 0xffe066, m: MAT.EMIT, z: Z.DETAIL },
        ],
        muzzle: [0, 0.036, -0.8],
        eject: [0.06, 0.03, 0.06],
        sight: [0, 0.086, 0],
        grip: [0, -0.135, 0.165], gripTilt: 0.36,
        fore: [0, -0.11, -0.28], foreKind: 'pump',
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
      // Swapping to the launcher used to cost the whole 1.3-second fire
      // interval before it would fire — a second of pointing a loaded tube at
      // somebody and watching. The tube is up in about a quarter of a second;
      // that is now all it takes. See `drawStamp`.
      drawTime: 0.25,
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
          /* Launch tube, flared at the breech, with a wooden heat wrap. */
          { p: [0, 0, 0], s: [0.1, 0.1, 1], c: 0x3f4a30, m: MAT.POLY, z: Z.BODY },
          { p: [0, 0, -0.3], s: [0.13, 0.13, 0.22], c: 0x33402a, m: MAT.POLY, z: Z.BODY },
          { p: [0, 0, 0.44], s: [0.148, 0.148, 0.15], c: COL.dark, m: MAT.METAL, z: Z.METAL },
          { p: [0, 0, 0.518], s: [0.09, 0.09, 0.014], c: COL.bore, m: MAT.METAL, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.086, 0.14], s: [0.056, 0.09, 0.42], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD },
          { p: [0, 0.086, 0.02], s: [0.06, 0.096, 0.02], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.086, 0.26], s: [0.06, 0.096, 0.02], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, -0.086, -0.02], s: [0.05, 0.08, 0.3], c: COL.darkwood, m: MAT.WOOD, z: Z.WOOD },

          /* The warhead — the piece that is gone once it has been fired. */
          { p: [0, 0, -0.62], s: [0.134, 0.134, 0.2], c: 0x6b3f22, m: MAT.POLY, z: Z.ACCENT, tag: 'mag' },
          { p: [0, 0, -0.53], s: [0.104, 0.104, 0.04], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, tag: 'mag', fine: 1 },
          { p: [0, 0, -0.78], s: [0.078, 0.078, 0.16], c: 0x53301a, m: MAT.POLY, z: Z.ACCENT, tag: 'mag' },
          { p: [0, 0, -0.9], s: [0.034, 0.034, 0.11], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, tag: 'mag' },
          { p: [0, 0, -0.955], s: [0.02, 0.02, 0.03], c: COL.gunmetal, m: MAT.ALLOY, z: Z.DETAIL, tag: 'mag', fine: 1 },
          { p: [0.05, 0, -0.72], s: [0.02, 0.008, 0.1], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'mag', fine: 1 },
          { p: [-0.05, 0, -0.72], s: [0.02, 0.008, 0.1], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'mag', fine: 1 },
          { p: [0, 0.05, -0.72], s: [0.008, 0.02, 0.1], c: COL.dark, m: MAT.METAL, z: Z.DETAIL, tag: 'mag', fine: 1 },

          /* Grips, trigger and the shoulder rest. */
          { p: [0, -0.15, 0.14], s: [0.058, 0.22, 0.1], c: COL.dark, m: MAT.POLY, z: Z.WOOD, r: [0.2, 0, 0] },
          { p: [0, -0.24, 0.158], s: [0.062, 0.028, 0.11], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [0.2, 0, 0], fine: 1 },
          { p: [0, -0.076, 0.09], s: [0.034, 0.02, 0.11], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.055, 0.042], s: [0.032, 0.048, 0.018], c: COL.dark, m: MAT.METAL, z: Z.BODY, fine: 1 },
          { p: [0, -0.038, 0.086], s: [0.014, 0.045, 0.014], c: COL.raw, m: MAT.ALLOY, z: Z.METAL, fine: 1 },
          { p: [0, -0.115, -0.26], s: [0.052, 0.16, 0.1], c: 0x33402a, m: MAT.POLY, z: Z.WOOD, r: [-0.14, 0, 0] },
          { p: [0, -0.19, -0.27], s: [0.058, 0.026, 0.11], c: COL.black, m: MAT.RUBBER, z: Z.WOOD, r: [-0.14, 0, 0], fine: 1 },
          { p: [0, -0.075, 0.42], s: [0.05, 0.07, 0.18], c: COL.dark, m: MAT.POLY, z: Z.WOOD, r: [-0.3, 0, 0], fine: 1 },

          /* Optic on a side mount, plus a folding iron ladder. */
          { p: [0, 0.155, -0.1], s: [0.026, 0.06, 0.16], c: COL.gunmetal, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.205, -0.1], s: [0.058, 0.058, 0.19], c: COL.black, m: MAT.METAL, z: Z.ACCENT },
          { p: [0, 0.205, -0.198], s: [0.046, 0.046, 0.01], c: COL.glass, m: MAT.GLASS, z: Z.DETAIL },
          { p: [0, 0.205, 0.0], s: [0.05, 0.05, 0.014], c: 0x0d1b26, m: MAT.GLASS, z: Z.DETAIL, fine: 1 },
          { p: [0, 0.245, -0.1], s: [0.026, 0.026, 0.05], c: COL.gunmetal, m: MAT.ALLOY, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.09, 0.24], s: [0.03, 0.07, 0.016], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
          { p: [0, 0.09, -0.34], s: [0.024, 0.07, 0.016], c: COL.dark, m: MAT.METAL, z: Z.ACCENT, fine: 1 },
        ],
        muzzle: [0, 0, -0.98],
        eject: null,
        sight: [0, 0.205, -0.1],
        grip: [0, -0.14, 0.155], gripTilt: 0.2,
        fore: [0, -0.15, -0.26], foreKind: 'vert',
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
 * Rarity, and the finish catalogue, moved out.
 *
 * They live in `shared/cosmetics.js` now, because a finish is one of nine
 * things a player wears rather than the only one — and because that file has
 * to be able to import this one for `ZONE`, which rules out the reverse. What
 * stays here is the part that is genuinely about a weapon: how one *model
 * part* is finished, which is a question about the gun rather than about the
 * paint.
 */

/**
 * How one model part is finished under one skin.
 *
 * The zone decides everything: a skin paints the zones it names and leaves the
 * rest factory, and the `detail` zone is never touched at all — which is what
 * keeps a gold rifle's optic glass from turning gold with it.
 *
 * @param {object} part  a `model.parts` entry
 * @param {object} skin  a finish, out of shared/cosmetics.js
 * @returns {{color:number, pattern:object|null, gloss:number, glow:number}}
 */
export function paintFor(part, skin) {
  const zone = part.z ?? ZONE.BODY;
  const untouchable = zone === ZONE.DETAIL || part.m === MAT.EMIT || part.m === MAT.GLASS;
  const painted = !untouchable ? (skin?.paint?.[zone] ?? null) : null;
  const pat = !untouchable && skin?.pattern?.on?.includes(zone) ? skin.pattern : null;
  return {
    color: painted ?? part.c,
    pattern: pat,
    gloss: untouchable ? 0 : (skin?.gloss ?? 0),
    glow: untouchable ? 0 : (skin?.glow ?? 0),
  };
}

/**
 * The colour a finish would put on a pair of gloves.
 *
 * A fallback now rather than the rule: gloves are their own slot since V2, and
 * this is only reached when that slot is empty. See `SLOT.GLOVES`.
 */
export const gloveColor = (skin) => skin?.glove ?? 0x2b3038;
