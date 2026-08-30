/**
 * Movement and map integrity: every spawn point is usable, bodies never fall
 * through geometry, air-strafing accelerates, sliding boosts, stairs climb.
 */
import { World } from '../shared/physics.js';
import { getMap, MAP_IDS } from '../shared/maps.js';
import * as M from '../shared/movement.js';
import * as K from '../shared/constants.js';
import { suite, check, info } from './harness.mjs';

export default function run() {
  suite('Maps — spawn points');
  let badSpawns = 0, totalSpawns = 0;
  for (const id of MAP_IDS) {
    const map = getMap(id);
    const world = new World(map);
    for (const [team, list] of Object.entries(map.spawns)) {
      for (const [x, y, z, yaw] of list) {
        totalSpawns++;
        const r = K.PLAYER_RADIUS;
        const stuck = world.overlapsAny(x - r, y, z - r, x + r, y + K.PLAYER_HEIGHT, z + r);
        const s = M.createState(x, y, z, yaw);
        for (let t = 0; t < 300; t++) M.step(s, { keys: 0, yaw, pitch: 0 }, world, K.TICK_DT);
        if (stuck || !s.onGround || s.y < -0.5) {
          badSpawns++;
          info(`bad spawn ${id}/${team} at (${x}, ${y}, ${z})`);
        }
      }
    }
  }
  check('every spawn point is clear and lands on ground', badSpawns === 0,
    `${totalSpawns - badSpawns}/${totalSpawns} across ${MAP_IDS.length} maps`);

  suite('Maps — no geometry traps');
  let noSettle = 0, dropped = 0;
  for (const id of MAP_IDS) {
    const map = getMap(id);
    const world = new World(map);
    const half = (map.size ?? 96) / 2 - 4;
    for (let x = -half; x <= half; x += 6) {
      for (let z = -half; z <= half; z += 6) {
        const b = M.createState(x, 30, z, 0);
        for (let t = 0; t < 420; t++) M.step(b, { keys: 0, yaw: 0, pitch: 0 }, world, K.TICK_DT);
        dropped++;
        if (!b.onGround || b.y < -0.5) noSettle++;
      }
    }
  }
  check('bodies dropped across every map all settle on solid ground',
    noSettle === 0, `${dropped - noSettle}/${dropped} drop points`);

  suite('Movement mechanics');
  const world = new World(getMap('sandstorm'));
  // Speed measurements need open ground, so use a bare floor with no walls.
  const flat = new World({
    id: 'flat', size: 400, boxes: [], solids: [],
    ground: { size: 400 }, spawns: { ffa: [[0, 0, 0, 0]] },
  });

  const runner = M.createState(0, 0.5, 0, 0);
  for (let i = 0; i < 120; i++) M.step(runner, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
  const groundSpeed = Math.hypot(runner.vx, runner.vz);
  check('ground speed settles at the configured base speed',
    Math.abs(groundSpeed - K.BASE_SPEED) < 0.05, `${groundSpeed.toFixed(2)} u/s`);

  let yaw = 0, peak = 0;
  for (let i = 0; i < 600; i++) {
    yaw += 0.9 * K.TICK_DT;
    M.step(runner, { keys: M.KEY.RIGHT | M.KEY.JUMP, yaw, pitch: 0 }, flat, K.TICK_DT);
    peak = Math.max(peak, Math.hypot(runner.vx, runner.vz));
  }
  check('air-strafing accelerates past base speed', peak > K.BASE_SPEED * 1.3,
    `peak ${peak.toFixed(2)} u/s vs base ${K.BASE_SPEED}`);

  const slider = M.createState(0, 1, 0, 0);
  for (let i = 0; i < 90; i++) M.step(slider, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
  const before = Math.hypot(slider.vx, slider.vz);
  M.step(slider, { keys: M.KEY.FWD | M.KEY.CROUCH, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
  const after = Math.hypot(slider.vx, slider.vz);
  check('crouch-sliding grants a speed burst and lowers the body',
    slider.sliding && after > before + 4 && slider.height < K.PLAYER_HEIGHT,
    `${before.toFixed(2)} -> ${after.toFixed(2)} u/s, height ${slider.height}`);

  // Walk up the mirrored ramp onto Sandstorm's central platform.
  const climber = M.createState(-20, 0.5, 0, 0);
  const startY = climber.y;
  for (let i = 0; i < 200; i++) M.step(climber, { keys: M.KEY.FWD, yaw: -Math.PI / 2, pitch: 0 }, world, K.TICK_DT);
  check('stairs and ramps are climbable', climber.y > startY + 1.5,
    `y ${startY.toFixed(2)} -> ${climber.y.toFixed(2)}`);

  check('fall damage only applies past the threshold',
    M.fallDamage(K.FALL_DAMAGE_SPEED - 1) === 0 && M.fallDamage(K.FALL_DAMAGE_SPEED + 10) > 0,
    `${M.fallDamage(K.FALL_DAMAGE_SPEED + 10)} hp at +10 u/s`);


  suite('Movement — collision safety');
  // A lone pillar: walking into it, jumping at it, or standing flush against it
  // must never put the body on top of it. This is the tree-climb regression.
  const pillarWorld = new World({
    id: 'pillar', size: 120, ground: { size: 200 }, spawns: { ffa: [[0, 0, 0, 0]] },
    boxes: [
      { x: 0, y: 0, z: 0, w: 0.7, h: 4.5, d: 0.7, c: 0x604020 },      // trunk
      { x: 0, y: 3.2, z: 0, w: 3.4, h: 2.4, d: 3.4, c: 0x2e4a3a },    // canopy
      { x: 12, y: 0, z: 0, w: 1.2, h: 6, d: 12, c: 0x808080 },        // tall wall
    ],
  });
  pillarWorld.solids = pillarWorld.map?.solids;

  let climbed = 0, tried = 0, worstY = 0;
  for (let a = 0; a < 96; a++) {
    const ang = (a / 96) * Math.PI * 2;
    const fx = -Math.sin(ang), fz = -Math.cos(ang);
    for (const keys of [M.KEY.FWD, M.KEY.FWD | M.KEY.JUMP, M.KEY.FWD | M.KEY.RIGHT,
      M.KEY.FWD | M.KEY.RIGHT | M.KEY.JUMP, M.KEY.FWD | M.KEY.CROUCH]) {
      for (const speed of [0, 12, 22]) {
        tried++;
        const b = M.createState(-fx * 5, 0.2, -fz * 5, ang);
        b.vx = fx * speed; b.vz = fz * speed;
        for (let i = 0; i < 200; i++) {
          M.step(b, { keys, yaw: ang, pitch: 0 }, pillarWorld, K.TICK_DT);
          if (b.onGround && b.y > worstY) worstY = b.y;
          if (b.onGround && b.y > 1.0) { climbed++; i = 200; }
        }
      }
    }
  }
  check('nobody ever ends up standing on a tree or a wall they walked into',
    climbed === 0, `${tried - climbed}/${tried} approaches, highest ground ${worstY.toFixed(2)}`);

  // Flush contact must not read as an overlap on the next tick. Exact geometry
  // from Subzero's pines, where (min - radius) + radius rounds back over min.
  const R = K.PLAYER_RADIUS;
  let teleports = 0, pressed = 0;
  for (const edge of [-31.7, 31.7, -0.48, 12.35, -7.8, 5.25]) {
    for (const side of [-1, 1]) {
      const wall = side < 0
        ? { x: edge + 1.7, y: 3.2, z: 0, w: 3.4, h: 2.4, d: 3.4, c: 0x2e4a3a }
        : { x: edge - 1.7, y: 3.2, z: 0, w: 3.4, h: 2.4, d: 3.4, c: 0x2e4a3a };
      const w = new World({
        id: 'flush', size: 200, ground: { size: 200 }, spawns: { ffa: [[0, 0, 0, 0]] },
        boxes: [wall, { x: edge + side * 3, y: 0, z: 0, w: 6, h: 3.2, d: 8, c: 0x808080 }],
      });
      const b = M.createState(edge + side * R, 3.2, 0, 0);
      const y0 = b.y;
      pressed++;
      for (let t = 0; t < 60; t++) {
        M.step(b, { keys: side < 0 ? M.KEY.LEFT : M.KEY.RIGHT, yaw: 0, pitch: 0 }, w, K.TICK_DT);
        if (b.y > y0 + 0.05) { teleports++; break; }
      }
    }
  }
  check('pressing flush into a surface never snaps the body to its far face',
    teleports === 0, `${pressed - teleports}/${pressed} contacts held their ground`);

  suite('Movement — bunny hopping');

  /**
   * Jump and slide are edge-triggered, so a test that holds the key is testing
   * a single press. `tap` releases the bit on odd ticks: the key goes back up
   * often enough that every landing finds a fresh press waiting in the buffer,
   * which is exactly the rhythm a hopping player plays.
   */
  const tap = (keys, tick, bit = M.KEY.JUMP) => (tick % 2 === 0 ? keys : keys & ~bit);

  const hopper = M.createState(0, 0.5, 0, 0);
  let hopYaw = 0;
  for (let i = 0; i < 90; i++) M.step(hopper, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
  const flatSpeed = Math.hypot(hopper.vx, hopper.vz);
  let minSpeed = Infinity, landings = 0;
  for (let i = 0; i < 420; i++) {
    hopYaw += 1.05 * K.TICK_DT;
    M.step(hopper, { keys: tap(M.KEY.FWD | M.KEY.RIGHT | M.KEY.JUMP, i), yaw: hopYaw, pitch: 0 }, flat, K.TICK_DT);
    if (hopper.landed) landings++;
    if (i > 30) minSpeed = Math.min(minSpeed, Math.hypot(hopper.vx, hopper.vz));
  }
  const hopSpeed = Math.hypot(hopper.vx, hopper.vz);
  check('tapping jump chains hops without losing speed on landing',
    landings > 3 && minSpeed > flatSpeed * 0.9 && hopSpeed > flatSpeed * 1.4,
    `${landings} landings, floor ${minSpeed.toFixed(2)} u/s, top ${hopSpeed.toFixed(2)} u/s`);

  check('…and holding it does not: one press is one hop', (() => {
    // The whole point of the rule. A finger resting on the key used to be a
    // perfect bunny hop, which made the hardest thing in the movement set the
    // easiest one.
    const held = M.createState(0, 0.5, 0, 0);
    for (let i = 0; i < 90; i++) M.step(held, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
    let hops = 0;
    for (let i = 0; i < 300; i++) {
      const was = held.onGround;
      M.step(held, { keys: M.KEY.FWD | M.KEY.JUMP, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
      if (was && !held.onGround && held.vy > 1) hops++;
    }
    info(`${hops} hop(s) out of five seconds of a held key`);
    return hops === 1;
  })());

  check('…and neither does a held crouch keep a slide going', (() => {
    const s2 = M.createState(0, 0.5, 0, 0);
    for (let i = 0; i < 90; i++) M.step(s2, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
    let slides = 0, was = false;
    for (let i = 0; i < 400; i++) {
      M.step(s2, { keys: M.KEY.FWD | M.KEY.CROUCH, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
      if (s2.sliding && !was) slides++;
      was = s2.sliding;
    }
    info(`${slides} slide(s) out of nearly seven seconds of a held key`);
    return slides === 1;
  })());

  // Missing the hop by a couple of ticks should still keep most of the speed.
  const sloppy = M.createState(0, 0.5, 0, 0);
  for (let i = 0; i < 90; i++) M.step(sloppy, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
  let late = 0;
  for (let i = 0; i < 300; i++) {
    // Release jump for 6 ticks after each landing, then press again.
    if (sloppy.landed) late = 6;
    const keys = M.KEY.FWD | (late > 0 ? 0 : M.KEY.JUMP);
    if (late > 0) late--;
    M.step(sloppy, { keys, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
  }
  check('a late hop still keeps most of the momentum',
    Math.hypot(sloppy.vx, sloppy.vz) > K.BASE_SPEED * 0.85,
    `${Math.hypot(sloppy.vx, sloppy.vz).toFixed(2)} u/s`);

  /* ── Prediction, and the half of the state no packet carries ───────────────
   *
   * A client rewinds to the server's body and replays every input still in
   * flight, several times a second. The packet holds a position, a velocity, a
   * ground flag and a height — and nothing at all about how far into its second
   * and a third a slide is, or how long ago a crouch was pressed. Replaying
   * inputs without putting those back advances them once per replay on top of
   * the once they were meant to be advanced, and the worse the connection the
   * faster they run: the slide players reported as glitchy.
   *
   * This is that failure, reproduced against nothing but `step` — one body
   * simulated straight through, and a second one rewound and replayed the way
   * client prediction does it. With `carry`/`restore` the two agree exactly;
   * without them the second body's slide is over before the first one's is
   * halfway.
   * ────────────────────────────────────────────────────────────────────────*/

  suite('Movement — replaying inputs');

  check('a rewound body that replays its inputs slides for exactly as long', (() => {
    /** Six ticks of lag: what a hundred-millisecond round trip holds in flight. */
    const LAG = 6;
    // Ninety ticks of running to build the speed a slide needs, then crouch
    // and hold it: the press is the edge that starts the slide, and holding it
    // is what lets the slide run to its own limit rather than to a key release.
    const keysAt = (i) => M.KEY.FWD | (i >= 90 ? M.KEY.CROUCH : 0);

    // The authority: one body, one pass, no replays. `truthAt` is what the
    // server would have put in each snapshot — the eight numbers, and nothing
    // else, which is the whole point.
    const truth = M.createState(0, 0.5, 0, 0);
    let prev = 0;
    const truthSlide = [], truthAt = [];
    for (let i = 0; i < 200; i++) {
      const keys = keysAt(i);
      M.step(truth, { keys, prev, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
      prev = keys;
      truthSlide.push(truth.slideTime);
      truthAt.push({
        x: truth.x, y: truth.y, z: truth.z,
        vx: truth.vx, vy: truth.vy, vz: truth.vz,
        onGround: truth.onGround, height: truth.height,
      });
    }

    // The client: the same inputs, plus a rewind-and-replay every other tick.
    const local = M.createState(0, 0.5, 0, 0);
    const pending = [];
    let cPrev = 0;
    const localSlide = [];
    for (let i = 0; i < 200; i++) {
      const keys = keysAt(i);
      const inp = { keys, prev: cPrev, yaw: 0, pitch: 0, pre: M.carry(local) };
      cPrev = keys;
      pending.push(inp);
      M.step(local, inp, flat, K.TICK_DT);

      // A snapshot lands: everything older than LAG ticks has been consumed, so
      // rewind to it and replay what is left. The authoritative half is taken
      // from `truth` at that tick, which is exactly what the packet carries.
      if (i % 2 === 1 && i >= LAG) {
        const ackAt = i - LAG;
        while (pending.length > LAG) pending.shift();
        const t = truthAt[ackAt];
        local.x = t.x; local.y = t.y; local.z = t.z;
        local.vx = t.vx; local.vy = t.vy; local.vz = t.vz;
        local.onGround = t.onGround; local.height = t.height;
        M.restore(local, pending[0]?.pre);
        for (const p2 of pending) M.step(local, p2, flat, K.TICK_DT);
      }
      localSlide.push(local.slideTime);
    }

    const drift = Math.max(...localSlide.map((v, i) => Math.abs(v - truthSlide[i])));
    info(`slide clock drifts ${(drift * 1000).toFixed(1)} ms over ${localSlide.length} ticks`);
    // Both bodies must actually have slid, or this proves nothing.
    return Math.max(...truthSlide) > 0.5 && drift < K.TICK_DT * 1.5;
  })(), 'the timers a snapshot does not carry are rewound with the ones it does');

  suite('Movement — carving');

  /** Signed angle in (-π, π]; the raw remainder keeps the sign of its dividend. */
  const wrap = (a) => {
    let v = a % (2 * Math.PI);
    if (v > Math.PI) v -= 2 * Math.PI;
    if (v < -Math.PI) v += 2 * Math.PI;
    return v;
  };
  /** How far the body's momentum points away from its own crosshair, in degrees. */
  const offCrosshair = (b, yaw) => Math.abs(wrap(Math.atan2(-b.vx, -b.vz) - yaw)) * 180 / Math.PI;

  /** Run up to speed on the flat, then hold `keys` while swinging the mouse. */
  const swing = (keys, radians, ticks = 90) => {
    const b = M.createState(0, 0.5, 0, 0);
    for (let i = 0; i < 90; i++) M.step(b, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
    const entered = Math.hypot(b.vx, b.vz);
    let yaw = 0;
    for (let i = 0; i < ticks; i++) {
      if (i < 36) yaw += radians / 36;
      M.step(b, { keys: tap(keys, i), yaw, pitch: 0 }, flat, K.TICK_DT);
    }
    return { entered, speed: Math.hypot(b.vx, b.vz), off: offCrosshair(b, yaw), state: b };
  };

  const hopCarve = swing(M.KEY.FWD | M.KEY.JUMP, Math.PI / 2);
  check('a bunny hop follows the crosshair round a 90° turn',
    hopCarve.off < 5,
    `${hopCarve.off.toFixed(1)}° off the crosshair at ${hopCarve.speed.toFixed(2)} u/s`);

  const slideCarve = swing(M.KEY.FWD | M.KEY.CROUCH, Math.PI / 2, 40);
  check('so does a slide, and harder — that is what the crouch bought',
    slideCarve.off < 5 && slideCarve.state.sliding,
    `${slideCarve.off.toFixed(1)}° off the crosshair at ${slideCarve.speed.toFixed(2)} u/s`);

  check('carving turns momentum without spending any of it', (() => {
    /*
     * The whole rule: speed is earned by hopping and sliding, and steering only
     * decides where it goes. A carve that cost speed would make the fastest line
     * a straight one, which is the opposite of the point.
     */
    const straight = swing(M.KEY.FWD | M.KEY.JUMP, 0);
    const carved = swing(M.KEY.FWD | M.KEY.JUMP, Math.PI / 2);
    info(`straight ${straight.speed.toFixed(2)} u/s · through 90° ${carved.speed.toFixed(2)} u/s`);
    return carved.speed > straight.speed * 0.97;
  })());

  check('a strafe key takes the wheel back, so air-strafing still builds speed', (() => {
    // The two cannot be layered: strafe speed comes entirely from the angle
    // between where you are going and where you are pushing, and carving exists
    // to close exactly that angle. Measured, any carve at all collapses a
    // strafe run from ~3.1× base speed to ~1.4×, so they take turns instead.
    const b = M.createState(0, 0.5, 0, 0);
    for (let i = 0; i < 90; i++) M.step(b, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
    const base = Math.hypot(b.vx, b.vz);
    let yaw = 0, top = 0;
    for (let i = 0; i < 420; i++) {
      yaw += 1.05 * K.TICK_DT;
      M.step(b, { keys: tap(M.KEY.FWD | M.KEY.RIGHT | M.KEY.JUMP, i), yaw, pitch: 0 }, flat, K.TICK_DT);
      top = Math.max(top, Math.hypot(b.vx, b.vz));
    }
    info(`${base.toFixed(2)} → ${top.toFixed(2)} u/s (${(top / base).toFixed(2)}×) with D held`);
    return top > base * 2.5;
  })());

  check('a standing turn does not pivot the body on the spot', (() => {
    // Carving is momentum being redirected, so there has to be momentum. Below
    // the floor it does nothing, or a walk would slide like ice.
    const b = M.createState(0, 0.5, 0, 0);
    for (let i = 0; i < 40; i++) M.step(b, { keys: 0, yaw: 0, pitch: 0 }, flat, K.TICK_DT);
    b.vx = 0; b.vz = -K.STEER_MIN_SPEED * 0.5;      // crawling forward, below the floor
    b.onGround = false;
    const before = { vx: b.vx, vz: b.vz };
    for (let i = 0; i < 20; i++) M.step(b, { keys: M.KEY.JUMP, yaw: Math.PI / 2, pitch: 0 }, flat, K.TICK_DT);
    const turned = Math.abs(wrap(Math.atan2(-b.vx, -b.vz) - Math.atan2(-before.vx, -before.vz))) * 180 / Math.PI;
    info(`${turned.toFixed(1)}° of drift at ${Math.hypot(before.vx, before.vz).toFixed(2)} u/s`);
    return turned < 45;
  })());

  suite('Movement — god mode flight');

  {
    const flyWorld = new World(getMap('crossfire'));
    const hover = () => {
      const s = M.createState(0, 6, 0, 0);
      for (let i = 0; i < 120; i++) M.step(s, { keys: 0, yaw: 0, pitch: 0 }, flyWorld, K.TICK_DT, { fly: true });
      return s;
    };

    check('gravity is off — a flyer holding nothing stays where it is', (() => {
      const s = hover();
      info(`y ${s.y.toFixed(3)}, vy ${s.vy.toFixed(3)}`);
      return Math.abs(s.y - 6) < 0.02 && Math.abs(s.vy) < 0.05;
    })());

    check('jump climbs and crouch descends', (() => {
      const up = M.createState(0, 6, 0, 0);
      for (let i = 0; i < 60; i++) M.step(up, { keys: M.KEY.JUMP, yaw: 0, pitch: 0 }, flyWorld, K.TICK_DT, { fly: true });
      const down = M.createState(0, 20, 0, 0);
      for (let i = 0; i < 60; i++) M.step(down, { keys: M.KEY.CROUCH, yaw: 0, pitch: 0 }, flyWorld, K.TICK_DT, { fly: true });
      info(`up ${up.y.toFixed(1)} · down ${down.y.toFixed(1)}`);
      return up.y > 12 && down.y < 14;
    })());

    check('forward follows the crosshair, not the floor', (() => {
      const s = M.createState(0, 8, 0, 0);
      for (let i = 0; i < 60; i++) {
        M.step(s, { keys: M.KEY.FWD, yaw: 0, pitch: 0.9 }, flyWorld, K.TICK_DT, { fly: true });
      }
      info(`climbed to y ${s.y.toFixed(1)} while flying forward`);
      return s.y > 12;
    })());

    check('a flyer is never grounded, so nothing downstream calls it a landing', (() => {
      const s = M.createState(0, 0.2, 0, 0);
      let landed = false;
      for (let i = 0; i < 120; i++) {
        M.step(s, { keys: M.KEY.CROUCH, yaw: 0, pitch: 0 }, flyWorld, K.TICK_DT, { fly: true });
        if (s.landed || s.onGround) landed = true;
      }
      return !landed && M.fallDamage(s.fallSpeed) === 0;
    })());

    check('collision still applies — flight is not noclip', (() => {
      const s = M.createState(0, 1.2, 0, 0);
      const start = { x: s.x, z: s.z };
      // Straight at the map for two seconds; something has to stop it.
      let hitSomething = false;
      for (let i = 0; i < 800; i++) {
        M.step(s, { keys: M.KEY.FWD, yaw: 0, pitch: 0 }, flyWorld, K.TICK_DT, { fly: true });
        if (flyWorld.overlapsAny(s.x - K.PLAYER_RADIUS, s.y, s.z - K.PLAYER_RADIUS,
          s.x + K.PLAYER_RADIUS, s.y + s.height, s.z + K.PLAYER_RADIUS)) hitSomething = true;
      }
      info(`travelled ${Math.hypot(s.x - start.x, s.z - start.z).toFixed(1)} u, never inside geometry: ${!hitSomething}`);
      return !hitSomething;
    })());
  }

  suite('Movement performance');
  const bodies = Array.from({ length: 12 }, (_, i) => M.createState(i * 3 - 18, 4, 0, 0));
  const t0 = performance.now();
  for (let t = 0; t < 600; t++) {
    for (const b of bodies) M.step(b, { keys: tap(M.KEY.FWD | M.KEY.JUMP, t), yaw: t * 0.01, pitch: 0 }, world, K.TICK_DT);
  }
  const ms = performance.now() - t0;
  check('12 players simulate far faster than real time', ms < 1000,
    `10 s of simulation in ${ms.toFixed(0)} ms (${(ms / 100).toFixed(2)}% of one core)`);
}
