/**
 * Open Grunker — player movement (shared client/server).
 *
 * Quake/Source-derived: friction + accelerate on the ground, capped
 * wish-speed acceleration in the air (which is what makes air-strafing and
 * bunny-hopping work), plus Krunker's signature crouch-slide.
 *
 * `step()` is pure with respect to its inputs: same state + same input + same
 * world always yields the same result, on either side of the wire.
 */

import * as K from './constants.js';

/** Bitmask for the input keys we put on the wire. */
export const KEY = {
  FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8,
  JUMP: 16, CROUCH: 32, ADS: 64, FIRE: 128,
};

/** Fresh movement state for a spawning player. */
export function createState(x = 0, y = 0, z = 0, yaw = 0) {
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    yaw, pitch: 0,
    onGround: false,
    crouching: false,
    sliding: false,
    slideTime: 0,
    slideCd: 0,
    jumpCd: 0,
    coyote: 0,
    jumpBuffer: 0,
    slideBuffer: 0,        // s of "I asked to slide" still waiting for the ground
    /**
     * The key mask of the previous step.
     *
     * Jumping and sliding are edge-triggered off it: holding the key does
     * nothing after the first frame, so chaining hops is a rhythm the player
     * plays rather than a key they lean on. Callers that replay inputs out of
     * order (client prediction does, every time a snapshot lands) pass the
     * previous mask on the input itself — see `step`.
     */
    prevKeys: 0,
    hopGrace: 0,           // s of reduced friction after a landing
    hopping: false,        // set for one step when a chained hop leaves the ground
    height: K.PLAYER_HEIGHT,
    fallSpeed: 0,          // impact speed captured on landing, for fall damage
    landed: false,         // set for one step when the player touches down
    steppedUp: 0,          // vertical distance climbed this step (view smoothing)
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Quake accelerate: only add speed along wishdir up to `wishSpeed`. */
function accelerate(s, wx, wz, wishSpeed, accel, dt) {
  const current = s.vx * wx + s.vz * wz;
  const add = wishSpeed - current;
  if (add <= 0) return;
  let accelSpeed = accel * wishSpeed * dt;
  if (accelSpeed > add) accelSpeed = add;
  s.vx += accelSpeed * wx;
  s.vz += accelSpeed * wz;
}

/**
 * Turns momentum toward `(dx, dz)` without changing how much of it there is.
 *
 * This is what makes a slide and a chained hop follow where the player is
 * pointing. It rotates the horizontal velocity by at most `rate * dt` radians
 * toward the target direction and renormalises to the original speed, so every
 * unit of speed a player earned by hopping survives the turn — steering decides
 * where the speed goes, never how much of it there is.
 *
 * Accelerating toward the same direction instead (which is what the Quake
 * air-strafe underneath this does) cannot do the job: `accelerate` refuses to
 * add anything once you are already moving faster than the wish speed, which is
 * precisely the case a player at full bunny-hop speed is always in.
 */
function steerVelocity(s, dx, dz, rate, dt) {
  const speed = Math.hypot(s.vx, s.vz);
  if (speed < K.STEER_MIN_SPEED) return;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return;
  const tx = dx / len, tz = dz / len;
  const cx = s.vx / speed, cz = s.vz / speed;

  // Signed angle from where we are going to where we want to go. The cross
  // product gives the direction of the turn, the dot gives its size.
  const cross = cx * tz - cz * tx;
  const dot = clamp(cx * tx + cz * tz, -1, 1);
  const delta = Math.atan2(cross, dot);
  if (delta === 0) return;

  const maxTurn = rate * dt;
  const turn = clamp(delta, -maxTurn, maxTurn);
  const cs = Math.cos(turn), sn = Math.sin(turn);
  // Rotating a unit vector and rescaling keeps the speed exact rather than
  // letting floating point bleed it away over a long carve.
  s.vx = (cx * cs - cz * sn) * speed;
  s.vz = (cx * sn + cz * cs) * speed;
}

function applyFriction(s, friction, dt) {
  const speed = Math.hypot(s.vx, s.vz);
  if (speed < 0.05) { s.vx = 0; s.vz = 0; return; }
  const control = Math.max(speed, 3.0);
  const drop = control * friction * dt;
  const newSpeed = Math.max(0, speed - drop) / speed;
  s.vx *= newSpeed;
  s.vz *= newSpeed;
}

/* ── Collision resolution ────────────────────────────────────────────────── */

/**
 * Pushes a body that somehow ended up inside geometry back out along its
 * shallowest axis. Only runs when the body is actually overlapping (an
 * explosion shove, a spawn in a bad spot), and never moves it further than the
 * overlap itself — so it can't fling anyone onto a roof.
 */
function resolvePenetration(s, world) {
  const r = K.PLAYER_RADIUS;
  const skin = K.COLLISION_SKIN;
  for (let iter = 0; iter < 3; iter++) {
    const h = s.height;
    const idx = world.query(s.x - r, s.y, s.z - r, s.x + r, s.y + h, s.z + r);
    if (idx.length === 0) return;

    // Deepest overlap first: fixing it usually clears the rest.
    let best = -1, bestDepth = 0;
    for (let k = 0; k < idx.length; k++) {
      const j = idx[k] * 3;
      const dx = Math.min((s.x + r) - world.min[j], world.max[j] - (s.x - r));
      const dy = Math.min((s.y + h) - world.min[j + 1], world.max[j + 1] - s.y);
      const dz = Math.min((s.z + r) - world.min[j + 2], world.max[j + 2] - (s.z - r));
      const depth = Math.min(dx, dy, dz);
      if (depth > bestDepth) { bestDepth = depth; best = idx[k]; }
    }
    if (best < 0) return;

    const j = best * 3;
    const h2 = s.height;
    const pxPos = (s.x + r) - world.min[j];          // push toward -x
    const pxNeg = world.max[j] - (s.x - r);          // push toward +x
    const pyPos = (s.y + h2) - world.min[j + 1];     // push down
    const pyNeg = world.max[j + 1] - s.y;            // push up
    const pzPos = (s.z + r) - world.min[j + 2];
    const pzNeg = world.max[j + 2] - (s.z - r);
    const m = Math.min(pxPos, pxNeg, pyPos, pyNeg, pzPos, pzNeg);

    if (m === pyNeg) { s.y = world.max[j + 1] + skin; if (s.vy < 0) s.vy = 0; }
    else if (m === pyPos) { s.y = world.min[j + 1] - h2 - skin; if (s.vy > 0) s.vy = 0; }
    else if (m === pxPos) { s.x = world.min[j] - r - skin; if (s.vx > 0) s.vx = 0; }
    else if (m === pxNeg) { s.x = world.max[j] + r + skin; if (s.vx < 0) s.vx = 0; }
    else if (m === pzPos) { s.z = world.min[j + 2] - r - skin; if (s.vz > 0) s.vz = 0; }
    else { s.z = world.max[j + 2] + r + skin; if (s.vz < 0) s.vz = 0; }
  }
}

/**
 * Move along one axis and stop against whatever blocks the way.
 *
 * The body always starts a move outside every solid, so a legal resolution can
 * never put it further back than where the move began. Clamping the corrected
 * coordinate to the swept interval enforces exactly that: a body that clips a
 * box by a floating-point hair gets nudged back to the surface instead of being
 * snapped to that box's far face — which is what used to teleport players to
 * the top of trees and walls.
 */
function collideAxis(s, world, axis, delta) {
  if (delta === 0) return false;
  const r = K.PLAYER_RADIUS;
  const skin = K.COLLISION_SKIN;

  const start = axis === 0 ? s.x : axis === 1 ? s.y : s.z;
  const target = start + delta;
  const lo = (delta > 0 ? start : target) - skin;
  const hi = (delta > 0 ? target : start) + skin;
  const inSweep = (v) => (v < lo ? lo : v > hi ? hi : v);

  if (axis === 0) s.x = target;
  else if (axis === 1) s.y = target;
  else s.z = target;

  let hit = false;
  if (axis === 1 && s.y < world.floorY) { s.y = world.floorY; s.vy = 0; hit = true; }

  for (let iter = 0; iter < 4; iter++) {
    const h = s.height;
    const idx = world.query(s.x - r, s.y, s.z - r, s.x + r, s.y + h, s.z + r);
    if (idx.length === 0) break;

    let best = -1, bestPen = 0;
    for (let k = 0; k < idx.length; k++) {
      const j = idx[k] * 3;
      let pen;
      if (axis === 0) pen = delta > 0 ? (s.x + r) - world.min[j] : world.max[j] - (s.x - r);
      else if (axis === 1) pen = delta > 0 ? (s.y + h) - world.min[j + 1] : world.max[j + 1] - s.y;
      else pen = delta > 0 ? (s.z + r) - world.min[j + 2] : world.max[j + 2] - (s.z - r);
      if (pen > bestPen) { bestPen = pen; best = idx[k]; }
    }
    if (best < 0) break;

    const j = best * 3;
    if (axis === 0) {
      s.x = inSweep(delta > 0 ? world.min[j] - r - skin : world.max[j] + r + skin);
      s.vx = 0;
    } else if (axis === 1) {
      s.y = inSweep(delta > 0 ? world.min[j + 1] - s.height - skin : world.max[j + 1] + skin);
      s.vy = 0;
    } else {
      s.z = inSweep(delta > 0 ? world.min[j + 2] - r - skin : world.max[j + 2] + r + skin);
      s.vz = 0;
    }
    hit = true;
  }
  return hit;
}

/** True when the body's box is clear of every solid. */
function isFree(s, world) {
  const r = K.PLAYER_RADIUS;
  return !world.overlapsAny(s.x - r, s.y, s.z - r, s.x + r, s.y + s.height, s.z + r);
}

/** Moves the body, handling the step-up over small ledges and stairs. */
function moveAndCollide(s, world, dx, dy, dz) {
  s.steppedUp = 0;
  resolvePenetration(s, world);

  // Vertical first, so ground state is fresh for the step-up test below.
  const wasOnGround = s.onGround;
  s.onGround = false;
  if (dy !== 0 && collideAxis(s, world, 1, dy) && dy < 0) s.onGround = true;

  const startX = s.x, startY = s.y, startZ = s.z;
  const blockedX = collideAxis(s, world, 0, dx);
  const blockedZ = collideAxis(s, world, 2, dz);

  // Stepping is a ground move: never while rising, so nobody can walk up a wall.
  if ((blockedX || blockedZ) && (s.onGround || (wasOnGround && s.vy <= 0.001))) {
    const flatX = s.x, flatZ = s.z, flatVX = s.vx, flatVZ = s.vz;
    const flatDist = (flatX - startX) ** 2 + (flatZ - startZ) ** 2;

    // Retry the horizontal move one step higher, then settle back down.
    s.x = startX; s.y = startY; s.z = startZ;
    const restore = () => {
      s.x = flatX; s.y = startY; s.z = flatZ; s.vx = flatVX; s.vz = flatVZ;
    };

    if (collideAxis(s, world, 1, K.STEP_HEIGHT)) {
      restore();                                    // ceiling in the way
    } else {
      collideAxis(s, world, 0, dx);
      collideAxis(s, world, 2, dz);
      const stepDist = (s.x - startX) ** 2 + (s.z - startZ) ** 2;
      if (stepDist > flatDist + 1e-6) {
        if (collideAxis(s, world, 1, -K.STEP_HEIGHT)) { s.onGround = true; s.vy = 0; }
        // A step that ends inside geometry is not a step — take the flat move.
        if (s.y > startY + K.STEP_HEIGHT + 1e-3 || !isFree(s, world)) restore();
        else s.steppedUp = Math.max(0, s.y - startY);
      } else {
        restore();
      }
    }
  }

  // Ground probe: keeps `onGround` true across seams between adjacent boxes.
  // Only a surface the feet can actually rest on counts — brushing a wall does not.
  if (!s.onGround && s.vy <= 0.001) {
    const r = K.PLAYER_RADIUS;
    if (s.y <= world.floorY + 0.06) s.onGround = true;
    else {
      const idx = world.query(s.x - r, s.y - 0.06, s.z - r, s.x + r, s.y + 0.02, s.z + r);
      for (let k = 0; k < idx.length; k++) {
        const top = world.max[idx[k] * 3 + 1];
        if (top <= s.y + 0.02 && top >= s.y - 0.08) { s.onGround = true; break; }
      }
    }
  }
}

/* ── Main step ───────────────────────────────────────────────────────────── */

/**
 * Advance one player by one fixed tick.
 * @param {object} s      movement state (mutated)
 * @param {object} input  { keys, yaw, pitch, prev? } — `prev` is the previous
 *        step's key mask, which is what jump and slide are edge-triggered off.
 *        Omit it on a stream that is stepped strictly in order (the server, a
 *        bot) and the state's own record is used instead; pass it when inputs
 *        are replayed out of order, or a rewind would swallow a fresh press.
 * @param {World}  world  collision world
 * @param {number} dt     seconds (normally K.TICK_DT)
 * @param {object} opts   { speedMult, frozen, fly, jumpMult, hopKeep, airMax }
 */
export function step(s, input, world, dt = K.TICK_DT, opts = {}) {
  const keys = input.keys | 0;
  const prevKeys = (input.prev ?? s.prevKeys ?? 0) | 0;
  s.prevKeys = keys;
  const speedMult = opts.speedMult ?? 1;
  /*
   * The four numbers a perk is allowed to reach into the physics with.
   *
   * They are read here, once, and every one of them falls back to the constant
   * it overrides — so a caller that knows nothing about perks (which is every
   * caller outside the Perks mode, plus every test written before it existed)
   * gets exactly the movement it always got. That property is not a nicety: a
   * perk that changed the shared step for everybody would change it on the
   * client and the server at slightly different moments, and prediction would
   * disagree with authority for as long as the mismatch lasted.
   */
  const jumpVel = K.JUMP_VELOCITY * (opts.jumpMult ?? 1);
  const hopKeep = opts.hopKeep ?? K.HOP_SPEED_KEEP;
  const airMax = K.MAX_AIR_SPEED * (opts.airMax ?? 1);

  s.yaw = input.yaw;
  s.pitch = clamp(input.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  s.landed = false;
  s.hopping = false;

  if (opts.frozen) {
    s.vx = 0; s.vz = 0;
    s.vy -= K.GRAVITY * dt;
    moveAndCollide(s, world, 0, s.vy * dt, 0);
    return s;
  }

  // Timers
  s.jumpCd = Math.max(0, s.jumpCd - dt);
  s.slideCd = Math.max(0, s.slideCd - dt);
  s.hopGrace = Math.max(0, (s.hopGrace ?? 0) - dt);
  if (s.onGround) s.coyote = K.COYOTE_TIME; else s.coyote = Math.max(0, s.coyote - dt);

  /*
   * Jump and slide are edge-triggered.
   *
   * Holding the key used to refill the buffer on every single tick, which made
   * a leaning finger a perfect bunny hop and a held crouch an endless slide —
   * the two hardest things in the movement set, free. A press fills the buffer
   * once; the buffer decays; the key has to come back up before it can fill
   * again. The grace window is untouched, so a press a few ticks early still
   * lands: what went away is the *repeat*, not the forgiveness.
   */
  const wantJump = (keys & KEY.JUMP) !== 0;
  const jumpPressed = wantJump && (prevKeys & KEY.JUMP) === 0;
  s.jumpBuffer = jumpPressed ? K.JUMP_BUFFER : Math.max(0, s.jumpBuffer - dt);

  // Wish direction in world space
  const f = ((keys & KEY.FWD) ? 1 : 0) - ((keys & KEY.BACK) ? 1 : 0);
  const r = ((keys & KEY.RIGHT) ? 1 : 0) - ((keys & KEY.LEFT) ? 1 : 0);
  const sinY = Math.sin(s.yaw), cosY = Math.cos(s.yaw);
  let wx = f * -sinY + r * cosY;
  let wz = f * -cosY - r * sinY;
  const wlen = Math.hypot(wx, wz);
  if (wlen > 1e-6) { wx /= wlen; wz /= wlen; } else { wx = 0; wz = 0; }

  /*
   * Where the player is pointing — the crosshair flattened onto the floor.
   *
   * This is what a slide and a hop carve toward, and it is deliberately the
   * *look* direction rather than the wish direction: momentum follows the
   * crosshair, so turning the mouse turns the player, with or without a hand on
   * the movement keys. Steering off the wish direction instead would send an
   * air-strafer sideways every time they held A, which is the opposite of what
   * holding A is for.
   */
  const lookX = -sinY, lookZ = -cosY;

  /*
   * …and whether it applies at all.
   *
   * A strafe key held is a player air-strafing, and air-strafing is the one
   * thing carving cannot be layered on top of. The speed it builds comes
   * entirely from the angle between where you are going and where you are
   * pushing, and steering exists to close exactly that angle: measured, any
   * amount of carve at all — even a tenth of the rate used here — collapses a
   * strafe run from 3.1× base speed to 1.4×. So the two take turns.
   *
   *   nothing, or W/S      your speed follows the crosshair
   *   A or D held          the classic air-strafe, untouched
   *
   * One rule, in the player's hands, and it reads the way it plays: let go of
   * the strafe keys and your momentum comes round to where you are looking.
   */
  const carving = r === 0;

  const wantCrouch = (keys & KEY.CROUCH) !== 0;

  /*
   * God mode: free flight.
   *
   * The whole movement model is replaced rather than bent — no gravity, no
   * friction, no ground state — because every one of those exists to make a
   * body that falls feel good, and this one does not fall. The crosshair is the
   * throttle: forward flies where you look, jump and crouch are pure up and
   * down, and velocity is driven to the target rather than accelerated toward
   * it so the flight stops the moment the keys do.
   *
   * Collision stays on. Somebody who can walk through walls cannot be shown
   * what is behind them, and an admin inspecting a map wants to know where its
   * edges really are.
   */
  if (opts.fly) {
    const cp = Math.cos(s.pitch);
    let dx = f * -sinY * cp + r * cosY;
    let dy = f * Math.sin(s.pitch);
    let dz = f * -cosY * cp - r * sinY;
    if ((keys & KEY.JUMP) !== 0) dy += 1;
    if (wantCrouch) dy -= 1;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) { dx /= len; dy /= len; dz /= len; }
    const target = len > 1e-6 ? K.FLY_SPEED : 0;
    const k = Math.min(1, dt * 14);
    s.vx += (dx * target - s.vx) * k;
    s.vy += (dy * target - s.vy) * k;
    s.vz += (dz * target - s.vz) * k;
    s.sliding = false;
    // Crouch means "descend" up here, so the body stands back up — but never
    // into a ceiling, which is the same rule the walking path follows.
    if (s.height < K.PLAYER_HEIGHT) {
      const rr = K.PLAYER_RADIUS;
      if (!world.overlapsAny(s.x - rr, s.y + s.height, s.z - rr, s.x + rr, s.y + K.PLAYER_HEIGHT, s.z + rr)) {
        s.height = K.PLAYER_HEIGHT;
      }
    }
    s.crouching = s.height < K.PLAYER_HEIGHT;
    moveAndCollide(s, world, s.vx * dt, s.vy * dt, s.vz * dt);
    // Never grounded, so nothing downstream reports a landing: no fall damage,
    // no footsteps, no dust from a body that is hovering.
    s.onGround = false;
    s.landed = false;
    s.fallSpeed = 0;
    s.coyote = 0;
    s.jumpBuffer = 0;
    return s;
  }

  const crouchPressed = wantCrouch && (prevKeys & KEY.CROUCH) === 0;
  s.slideBuffer = crouchPressed ? K.SLIDE_BUFFER : Math.max(0, (s.slideBuffer ?? 0) - dt);
  const horizSpeed = Math.hypot(s.vx, s.vz);

  /* Slide: crouch while moving fast on the ground. */
  if (s.sliding) {
    s.slideTime += dt;
    if (!wantCrouch || s.slideTime > K.SLIDE_MAX_TIME || horizSpeed < K.SLIDE_MIN_SPEED || !s.onGround) {
      s.sliding = false;
      s.slideCd = K.SLIDE_COOLDOWN;
    }
  } else if (wantCrouch && s.slideBuffer > 0 && s.onGround && s.slideCd <= 0
             && horizSpeed > K.BASE_SPEED * 0.72) {
    s.sliding = true;
    s.slideTime = 0;
    s.slideBuffer = 0;
    const boost = K.SLIDE_BOOST;
    if (horizSpeed > 0.01) { s.vx += (s.vx / horizSpeed) * boost; s.vz += (s.vz / horizSpeed) * boost; }
  }

  // Crouch height (never un-crouch into a ceiling)
  const wantHeight = (wantCrouch || s.sliding) ? K.PLAYER_CROUCH_HEIGHT : K.PLAYER_HEIGHT;
  if (wantHeight > s.height) {
    const rr = K.PLAYER_RADIUS;
    if (!world.overlapsAny(s.x - rr, s.y + s.height, s.z - rr, s.x + rr, s.y + wantHeight, s.z + rr)) {
      s.height = wantHeight;
    }
  } else {
    s.height = wantHeight;
  }
  s.crouching = s.height < K.PLAYER_HEIGHT;

  /* A hop is about to fire: the landing must not eat the speed we came in with. */
  const willHop = s.jumpBuffer > 0 && s.jumpCd <= 0 && (s.onGround || s.coyote > 0);

  /* Horizontal acceleration */
  const baseSpeed = K.BASE_SPEED * speedMult;
  if (s.onGround) {
    if (s.sliding) {
      applyFriction(s, K.SLIDE_FRICTION, dt);
      accelerate(s, wx, wz, baseSpeed * 0.35, K.GROUND_ACCEL * 0.22, dt);
      // A slide is a carve: the speed is already paid for, and the mouse says
      // where it goes. Holding a strafe key is how you say otherwise — sliding
      // round a corner while watching a doorway.
      if (carving) steerVelocity(s, lookX, lookZ, K.SLIDE_STEER, dt);
    } else {
      if (willHop) {
        // Bunny hop: skip ground friction entirely and bleed a fraction instead.
        // At a `hopKeep` of exactly 1 it bleeds nothing and hops compound until
        // the air cap stops them, which is the whole of what the Runner perk is.
        s.vx *= hopKeep;
        s.vz *= hopKeep;
      } else {
        // Just landed? Friction stays soft for a moment so a late hop still works.
        applyFriction(s, K.GROUND_FRICTION * (s.hopGrace > 0 ? 0.28 : 1), dt);
      }
      const target = s.crouching ? baseSpeed * K.CROUCH_SPEED_MULT : baseSpeed;
      accelerate(s, wx, wz, target, K.GROUND_ACCEL, dt);
    }
  } else {
    accelerate(s, wx, wz, Math.min(baseSpeed, K.AIR_WISH_CAP), K.AIR_ACCEL, dt);
    // …and so is a hop, gentler, and never while a strafe key is doing the
    // other job.
    if (carving) steerVelocity(s, lookX, lookZ, K.AIR_STEER, dt);
    const sp = Math.hypot(s.vx, s.vz);
    if (sp > airMax) { s.vx *= airMax / sp; s.vz *= airMax / sp; }
  }

  /* Jump — buffered and coyote-timed so bunny-hopping feels forgiving. */
  if (willHop) {
    s.vy = jumpVel;
    s.hopping = s.hopGrace > 0;
    s.onGround = false;
    s.coyote = 0;
    s.jumpBuffer = 0;
    s.hopGrace = 0;
    s.jumpCd = K.JUMP_COOLDOWN;
    if (s.sliding) { s.sliding = false; s.slideCd = K.SLIDE_COOLDOWN * 0.5; }
  }

  /* Gravity + integrate */
  s.vy -= K.GRAVITY * dt;
  if (s.vy < -80) s.vy = -80;

  const wasAir = !s.onGround;
  const fallSpeed = -s.vy;
  moveAndCollide(s, world, s.vx * dt, s.vy * dt, s.vz * dt);

  if (wasAir && s.onGround) {
    s.landed = true;
    s.fallSpeed = fallSpeed;
    s.hopGrace = K.HOP_GRACE;
  } else {
    s.fallSpeed = 0;
  }
  return s;
}

/** Eye position for a movement state. */
export const eyeY = (s) => s.y + s.height - K.EYE_OFFSET;

/** Forward unit vector from yaw/pitch. */
export function lookDir(yaw, pitch, out = { x: 0, y: 0, z: 0 }) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Fall damage for a landing impact speed, 0 when harmless. */
export function fallDamage(speed) {
  if (speed <= K.FALL_DAMAGE_SPEED) return 0;
  return Math.min(K.MAX_HEALTH, Math.round((speed - K.FALL_DAMAGE_SPEED) * K.FALL_DAMAGE_SCALE));
}
