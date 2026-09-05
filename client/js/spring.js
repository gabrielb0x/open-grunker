/**
 * Open Grunker — a damped spring that cannot explode.
 *
 * Every recoil kick, view punch and weapon settle in the game is the same
 * second-order system: a value pulled back to zero by a stiffness and slowed by
 * a damping. Both used to be integrated the obvious way —
 *
 *     v += (-x * stiffness - v * damping) * dt;
 *     x += v * dt;
 *
 * — which is semi-implicit Euler, and semi-implicit Euler is only stable while
 * the step is small. Writing the step as the matrix it is, the two eigenvalues
 * stay inside the unit circle only while
 *
 *     dt < 2 / damping        and        stiffness·dt² + 2·damping·dt < 4
 *
 * The view punch ran at stiffness 190, damping 21, and the frame loop clamps
 * `dt` at 0.1 s. That fails the second test above 0.072 s — so on any machine
 * dropping under about 14 fps the spring did not settle, it *grew*, by a factor
 * of 2.4 every frame. Three seconds of that is a camera rotating by numbers
 * with eleven digits in them: the screen strobes, the aim appears to point
 * everywhere at once, and for a player with photosensitive epilepsy that is not
 * a glitch, it is a hazard. The weapon's own recoil spring (130 / 16) failed
 * the same test just below 11 fps.
 *
 * So the spring is not integrated at all any more. A linear system with
 * constant coefficients has a closed-form solution, and this evaluates it:
 * given `x` and `v` now, it returns exactly where they are `dt` later. That is
 * unconditionally stable — a one-second step is as correct as a one-millisecond
 * step, both decay toward zero, and no frame rate can make either grow. It is
 * also *more* accurate than the old code at every frame rate, not just the bad
 * ones.
 *
 * Nothing here is per-frame expensive: one `exp` and one trig pair per spring
 * per frame, shared across however many axes that spring drives.
 */

/**
 * The 2×2 step matrix for a spring, as four numbers.
 *
 * Advancing one axis is then `x' = a·x + b·v`, `v' = c·x + d·v` — so a punch
 * with a pitch and a yaw on the same spring pays for the transcendentals once.
 *
 * Returns a module-level scratch object, in the same spirit as the collision
 * world's query buffer: read it before calling again.
 *
 * @param {number} stiffness how hard the value is pulled back to zero
 * @param {number} damping   how hard the motion is slowed
 * @param {number} dt        seconds to advance, any size
 */
const STEP = { a: 1, b: 0, c: 0, d: 1 };

export function springStep(stiffness, damping, dt) {
  if (!(dt > 0) || !(stiffness > 0)) {
    // No time, or no spring: the only honest answer is "nothing moved". A
    // stiffness of zero is still damped motion, but nothing in the game asks
    // for one, and returning identity is safer than dividing by it.
    STEP.a = 1; STEP.b = dt > 0 ? dt : 0; STEP.c = 0; STEP.d = 1;
    return STEP;
  }

  const w = Math.sqrt(stiffness);              // undamped angular frequency
  const zeta = damping / (2 * w);              // damping ratio
  const decay = Math.exp(-zeta * w * dt);

  /*
   * `S` and `C` are the same two numbers in all three regimes — the sine and
   * cosine of an oscillation that is real when the spring rings, degenerate
   * when it is critically damped, and hyperbolic when it crawls home. Writing
   * them this way means one set of coefficients below rather than three.
   */
  let S, C;
  if (zeta < 0.999) {
    const wd = w * Math.sqrt(1 - zeta * zeta);
    S = decay * Math.sin(wd * dt) / wd;
    C = decay * Math.cos(wd * dt);
  } else if (zeta <= 1.001) {
    S = decay * dt;
    C = decay;
  } else {
    const mu = w * Math.sqrt(zeta * zeta - 1);
    S = decay * Math.sinh(mu * dt) / mu;
    C = decay * Math.cosh(mu * dt);
  }

  const zw = zeta * w;
  STEP.a = C + zw * S;
  STEP.b = S;
  STEP.c = -stiffness * S;
  STEP.d = C - zw * S;
  return STEP;
}

/**
 * How far a value may be pushed before the game refuses to draw it.
 *
 * The closed form above cannot diverge, so this is not what keeps the camera
 * sane — it is the guard rail behind it. Anything that reaches these springs
 * comes from a weapon table or a hit, both of which are bounded, and a value
 * outside this range means something upstream produced a NaN or an infinity.
 * Clamping is what makes "the screen never strobes" a property of the code
 * rather than a property of the arithmetic being right.
 */
export const PUNCH_LIMIT = 60;

/** Clamps to ±`limit`, and turns any NaN or Infinity into 0. */
export function safe(v, limit = PUNCH_LIMIT) {
  return Number.isFinite(v) ? (v > limit ? limit : v < -limit ? -limit : v) : 0;
}
