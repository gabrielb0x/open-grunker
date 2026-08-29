/**
 * What the room refuses to believe.
 *
 * Every check here is written against the userscript that made it necessary:
 * the client-trust suite in `cheat.user.js`, which never touched the server and
 * got everything it got by changing what a packet *said*. Each suite reproduces
 * one of its features exactly as it sends it, and asserts the two things that
 * matter about the fix — that the advantage is gone, and that an honest client
 * doing the same thing a millisecond earlier is unaffected.
 *
 * The second half is the one worth being strict about. An anti-cheat that only
 * ever proves it catches the cheat is an anti-cheat nobody can tell apart from
 * a broken server.
 */
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import * as ac from '../server/game/anticheat.js';
import * as K from '../shared/constants.js';
import { KEY } from '../shared/movement.js';
import { shotDirections, shotSeed } from '../shared/shot.js';
import { spreadFor, shotInterval, recoilKick, CLASS_IDS } from '../shared/weapons.js';
import { suite, check, info } from './harness.mjs';

/** A room with two players in it and every outbound frame captured. */
function arena(id, { gap = 18 } = {}) {
  const room = new Room({ id, mapId: 'subzero', modeId: 'ffa' });
  room.wake();
  const sent = [];
  room.broadcast = room.broadcastNear = () => {};
  room.sendTo = (p, m) => sent.push({ to: p.id, ...m });

  const a = new Player({ name: 'Shooter', ws: { readyState: 1, send() {}, close() {} } });
  const b = new Player({ name: 'Target', ws: { readyState: 1, send() {}, close() {} } });
  room.players.set(a.id, a);
  room.players.set(b.id, b);
  room.invalidateRoster();
  a.spawnAt(0, 40, 0, 0, room.now);
  b.spawnAt(0, 40, gap, 0, room.now);
  a.protectedUntil = -1;
  b.protectedUntil = -1;
  a.state.onGround = true;
  b.state.onGround = true;
  for (let i = 0; i < 40; i++) {
    room.now += K.TICK_DT;
    a.recordHistory(room.now);
    b.recordHistory(room.now);
  }
  return { room, a, b, sent };
}

/** Yaw/pitch from one player's eye to a fraction of the other's height. */
function aimAt(a, b, heightFrac = 0.5) {
  const eye = a.eye();
  const dx = b.state.x - eye.x;
  const dy = (b.state.y + b.state.height * heightFrac) - eye.y;
  const dz = b.state.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** Puts one input through the same door a real packet comes in by. */
function streamView(room, p, yaw, pitch, keys = 0) {
  room.onInput(p, { i: [[++p.__seq || (p.__seq = 1), keys, yaw, pitch]] });
}

const ready = (room, p) => {
  const w = p.weapon;
  w.lastShot = -99;
  w.pumpUntil = 0;
  w.reloading = false;
  w.ammo = w.def.magSize;
};

const deg = (rad) => (rad * 180) / Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export default function run() {
  /* ── Silent aim ──────────────────────────────────────────────────────────
   * The cheat's `net.shoot` hook: solve for the target, put those angles in the
   * packet, never move the view. The room used to trace from whatever arrived.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — silent aim');
  {
    const { room, a, b } = arena('ac-silent');
    const aim = aimAt(a, b);

    // Honest: the view is streamed, then the shot follows it down the same
    // socket a millisecond later. This must be untouched.
    streamView(room, a, aim.yaw, aim.pitch);
    const honest = room.resolveAim(a, { y: aim.yaw, p: aim.pitch });
    check('a shot that matches the streamed view is traced from exactly it',
      honest.yaw === aim.yaw && Math.abs(honest.pitch - aim.pitch) < 1e-9,
      `${deg(honest.yaw).toFixed(2)}°`);
    check('and costs the connection nothing', a.cheat.incidents === 0);

    // The cheat: looking one way, firing another. 180° is the Rage preset's
    // aim FOV, which is what it takes to shoot somebody behind you.
    streamView(room, a, aim.yaw + Math.PI, aim.pitch);
    const silent = room.resolveAim(a, { y: aim.yaw, p: aim.pitch });
    check('a shot fired away from the streamed view is refused',
      Math.abs(ac.angleDelta(silent.yaw, aim.yaw + Math.PI)) < 1e-6,
      `traced from the view, ${deg(ac.angleDelta(silent.yaw, aim.yaw)).toFixed(0)}° off the claim`);
    check('and is recorded against the connection', a.cheat.counts.aim === 1);

    // The whole point: the shot still happens. A refused packet is played as
    // though the client had told the truth, never dropped.
    ready(room, a);
    a.cheat.score = 0;
    a.state.yaw = aim.yaw + Math.PI;
    a.state.pitch = aim.pitch;
    const hp = b.health;
    room.onShoot(a, { y: aim.yaw, p: aim.pitch, n: a.shotSeq + 1 });
    check('the round is fired down the barrel they were really pointing',
      b.health === hp, `target untouched at ${b.health} hp`);
  }

  /* ── The flick that is not a cheat ─────────────────────────────────────── */
  suite('Anti-cheat — silent aim, false positives');
  {
    const { room, a, b } = arena('ac-flick');
    const aim = aimAt(a, b);

    // A real flick: the view is already moving fast when the shot lands, and
    // the packet carries the frame the tick loop had not sampled yet.
    let yaw = aim.yaw - 0.9;
    for (let i = 0; i < 6; i++) {
      room.now += K.TICK_DT;
      yaw += 0.15;                                    // ~9 rad/s, a hard flick
      streamView(room, a, yaw, aim.pitch);
    }
    room.now += K.TICK_DT * 0.6;
    const flick = room.resolveAim(a, { y: yaw + 0.09, p: aim.pitch });
    check('a shot one frame ahead of a fast flick is taken at face value',
      flick.yaw === yaw + 0.09, `turning at ${a.viewTurnRate.toFixed(1)} rad/s`);
    check('and the flick costs nothing either', a.cheat.incidents === 0);

    // Rounding: the wire carries four decimals, the room must not care.
    streamView(room, a, aim.yaw, aim.pitch);
    const rounded = room.resolveAim(a, {
      y: Math.round(aim.yaw * 1e4) / 1e4, p: Math.round(aim.pitch * 1e4) / 1e4,
    });
    check('four-decimal wire rounding is not a refusal', a.cheat.incidents === 0,
      `${deg(Math.abs(rounded.yaw - aim.yaw)).toFixed(4)}° apart`);

    // Going quiet before firing must not *buy* a wider gate than the mouse ever
    // earned: staleness is clamped and the whole allowance is capped.
    streamView(room, a, aim.yaw, aim.pitch);
    room.now += 1.5;                                  // a long, deliberate silence
    const bought = room.resolveAim(a, { y: aim.yaw + 1.2, p: aim.pitch });
    check('a client cannot go quiet to widen the gate',
      Math.abs(ac.angleDelta(bought.yaw, aim.yaw)) < 1e-6 && a.cheat.counts.aim === 1,
      `${deg(1.2).toFixed(0)}° off the streamed view, refused`);
  }

  /* ── Seed grinding ───────────────────────────────────────────────────────
   * The cheat's `grindSeq`: search 160 sequence numbers for the one whose cone
   * lands dead centre, and send that. The room used to take any seq above the
   * last one it saw.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — no-spread seed grinding');
  {
    const { room, a, b } = arena('ac-seed');
    const aim = aimAt(a, b);
    a.state.yaw = aim.yaw;
    a.state.pitch = aim.pitch;
    streamView(room, a, aim.yaw, aim.pitch);

    const d = a.weaponDef;
    const spread = spreadFor(d, { moving: false, airborne: false, ads: false, crouching: false, burst: 0 });
    // Exactly the search the userscript runs.
    let best = a.shotSeq + 1, bestErr = Infinity;
    for (let n = a.shotSeq + 1; n < a.shotSeq + 161; n++) {
      const dir = shotDirections(aim.yaw, aim.pitch, spread, shotSeed(a.id, n), 1)[0];
      const f = { x: -Math.sin(aim.yaw) * Math.cos(aim.pitch), y: Math.sin(aim.pitch), z: -Math.cos(aim.yaw) * Math.cos(aim.pitch) };
      const err = 1 - (dir.x * f.x + dir.y * f.y + dir.z * f.z);
      if (err < bestErr) { bestErr = err; best = n; }
    }
    check('the grinder does find a centred seed to ask for', best !== a.shotSeq + 1,
      `seq ${best}, ${best - a.shotSeq - 1} ahead`);

    ready(room, a);
    const before = a.shotSeq;
    room.onShoot(a, { y: aim.yaw, p: aim.pitch, n: best });
    check('the room uses its own next sequence, not the one asked for',
      a.shotSeq === before + 1, `seq ${a.shotSeq}, asked for ${best}`);
    check('so the first grind costs nothing but buys nothing',
      a.cheat.counts.seq === undefined, 'no baseline to jump from yet');

    // Every subsequent one is a jump away from its own last claim, which is the
    // only thing a search can look like.
    ready(room, a);
    room.onShoot(a, { y: aim.yaw, p: aim.pitch, n: best + 90 });
    check('and every one after it is recorded', a.cheat.counts.seq === 1,
      a.cheat.evidence.seq);
  }

  /* ── Holding the trigger ─────────────────────────────────────────────────
   * The room counts the rounds it *accepts*; a client counts the rounds it
   * fires, and the room declines plenty — a shot a hair inside the fire-rate
   * window, one fired into a magazine the server had already emptied, one that
   * landed during a reload. Measuring the claim against the room's own counter
   * meant that from the first of those onward every single round was flagged,
   * and holding the trigger reached the kick in about two seconds.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — holding the trigger');
  {
    const { room, a, b } = arena('ac-spray');
    room.state = 'live';
    const aim = aimAt(a, b);
    // A client counting its own rounds, firing far faster than the room will
    // take them, so most of these are declined — exactly the case that broke.
    let claimed = 0, seq = 0, sent = 0;
    for (let tick = 0; tick < 60 * 8; tick++) {
      room.onInput(a, { i: [[++seq, KEY.FIRE, aim.yaw, aim.pitch]] });
      if (tick % 3 === 0) {
        room.onShoot(a, { y: aim.yaw, p: aim.pitch, a: 0, n: ++claimed, b: 0 });
        sent++;
      }
      room.tick(K.TICK_DT);
    }
    info(`${sent} rounds sent, ${a.shotSeq} accepted — ${sent - a.shotSeq} declined by the room`);
    check('a client the room keeps declining is not a cheating client',
      a.cheat.incidents === 0 && a.cheat.score === 0, JSON.stringify(a.cheat.summary()));
    check('and the two counters being far apart is the normal case',
      sent > a.shotSeq, `client counted ${sent}, room counted ${a.shotSeq}`);
  }

  /* ── Spread centrality ─────────────────────────────────────────────────── */
  suite('Anti-cheat — the average a grinder cannot hide from');
  {
    const p = new Player({ name: 'Grinder' });
    // Every round landing at the centre of its cone: what burning shots to skip
    // an unwanted seed converges on.
    let caught = false;
    for (let i = 0; i < 40; i++) caught = ac.trackSpread(p, 0.0005, 0.03) || caught;
    check('forty centred rounds is evidence', caught);

    const honest = new Player({ name: 'Honest' });
    // The real draw, sampled from the same function the room fires through.
    let falsePositive = false;
    for (let i = 1; i <= 400; i++) {
      const dir = shotDirections(0, 0, 0.03, shotSeed(honest.id, i), 1)[0];
      const off = Math.acos(Math.max(-1, Math.min(1, -dir.z)));
      falsePositive = ac.trackSpread(honest, off, 0.03) || falsePositive;
    }
    check('four hundred honest rounds are not', !falsePositive);
  }

  /* ── ADS spoofing ────────────────────────────────────────────────────────
   * The cheat's `forceAds`: claim the sights in the packet, keep hip-fire
   * movement speed, collapse the cone for free.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — claimed sights');
  {
    const { room, a, b } = arena('ac-ads');
    const aim = aimAt(a, b);
    a.state.yaw = aim.yaw;
    a.state.pitch = aim.pitch;

    // A client that never presses the key and says it did, on every shot.
    const cones = [];
    room.broadcastNear = (m) => { if (m.spread !== undefined) cones.push(m.spread); };
    for (let i = 0; i < 5; i++) {
      streamView(room, a, aim.yaw, aim.pitch);          // no ADS bit, ever
      ready(room, a);
      room.onShoot(a, { y: aim.yaw, p: aim.pitch, a: 1, n: i + 1 });
    }
    const opts = { moving: false, airborne: false, crouching: false, burst: 0 };
    const wouldBe = (ads) => spreadFor(a.weaponDef, { ...opts, ads });
    check('a packet cannot put a player in their sights',
      a.heldAds === false && cones[0] > wouldBe(true),
      `fired the ${cones[0].toFixed(4)} hip-fire cone, not the ${wouldBe(true).toFixed(4)} scoped one`);
    check('and claiming it over and over is recorded', (a.cheat.counts.ads ?? 0) > 0,
      a.cheat.evidence.ads);

    // A quickscope: the sights come down and the trigger is pulled on the same
    // tick, so that input is received but the tick has not spent it yet. This
    // is the shot the check used to punish *and* fire with the wrong cone.
    const q = arena('ac-quickscope');
    q.a.setClass('hunter', true);
    const qaim = aimAt(q.a, q.b);
    const qcones = [];
    q.room.broadcastNear = (m) => { if (m.spread !== undefined) qcones.push(m.spread); };
    for (let i = 0; i < 6; i++) {
      q.room.onInput(q.a, { i: [[i + 1, KEY.ADS, qaim.yaw, qaim.pitch]] });
      ready(q.room, q.a);
      q.room.onShoot(q.a, { y: qaim.yaw, p: qaim.pitch, a: 1, n: i + 1 });
      q.room.tick(K.TICK_DT);
    }
    check('but the sights the client is holding right now count as held',
      (q.a.cheat.counts.ads ?? 0) === 0, JSON.stringify(q.a.cheat.summary()));
    check('and a quickscope fires the scoped cone, not the hip-fire one',
      qcones[0] === 0, `cone ${qcones[0]}`);
  }

  /* ── Fake latency ────────────────────────────────────────────────────────
   * The cheat's `net.ping` hook: report 180 ms, get 180 ms of rewind, shoot at
   * where everybody used to be. The round trip is now timed by the server.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — fake latency');
  {
    /**
     * One second of the real client's heartbeat: a PING, the PONG it answers
     * with, and the ACK the client fires the instant that PONG lands.
     *
     * The ack has its own frame rather than riding the next PING precisely
     * because of this cadence — echoing the token a second later would time the
     * *gap between two heartbeats* rather than a round trip, and hand every
     * connection in the room the maximum rewind.
     */
    const heartbeat = (room, p, { rtt, claimMs, ackDelay = 0 }) => {
      room.onPing(p, { t: room.now, rtt: claimMs });
      const token = p.pingToken;
      room.now += rtt + ackDelay;
      room.onAck(p, { k: token });
      room.now += Math.max(0.01, 1 - rtt - ackDelay);
    };

    const honest = arena('ac-lag-honest');
    for (let i = 0; i < 8; i++) heartbeat(honest.room, honest.a, { rtt: 0.04, claimMs: 40 });
    check('the server times one round trip, not the gap between two heartbeats',
      Math.abs(honest.a.rtt - 0.04) < 0.005, `${Math.round(honest.a.rtt * 1000)}ms of a real 40`);
    check('so an honest client is rewound by half its own trip plus interpolation',
      Math.abs(honest.room.rewindFor(honest.a) - (0.04 / 2 + K.INTERP_DELAY)) < 0.006,
      `${Math.round(honest.room.rewindFor(honest.a) * 1000)}ms`);
    check('and is never flagged for it', (honest.a.cheat.counts.lag ?? 0) === 0);

    // Somebody genuinely far away, whose two medians disagree the way a jittery
    // line makes them: still not a cheat.
    const far = arena('ac-lag-far');
    for (let i = 0; i < 8; i++) heartbeat(far.room, far.a, { rtt: 0.30, claimMs: 240 });
    check('a real 300ms connection gets its real 300ms of rewind',
      Math.abs(far.a.rtt - 0.30) < 0.01 && (far.a.cheat.counts.lag ?? 0) === 0,
      `${Math.round(far.room.rewindFor(far.a) * 1000)}ms rewind, no flag`);

    /*
     * A line that is genuinely unstable, which is what this check kept
     * mistaking for a cheat.
     *
     * The two numbers being compared are medians of different halves of
     * different round trips, one timed at each end. On a connection swinging
     * between 60 ms and 400 ms they disagree all evening without anybody lying
     * about anything — and the check used to run on *both* halves of every
     * heartbeat at eight points a time, which out-accumulated the decay four to
     * one. A player riding a train was reaching a kick in eight seconds.
     */
    const jittery = arena('ac-lag-jitter');
    const swing = [0.06, 0.34, 0.09, 0.41, 0.07, 0.28, 0.38, 0.05, 0.30, 0.11,
      0.36, 0.08, 0.26, 0.40, 0.06, 0.33, 0.12, 0.29, 0.07, 0.37,
      0.10, 0.31, 0.05, 0.39, 0.08, 0.27, 0.35, 0.06, 0.32, 0.09];
    for (let i = 0; i < swing.length; i++) {
      // What such a client honestly reports: a median of its own last eight
      // trips, which is not the same eight the server took a median of.
      const seen = swing.slice(Math.max(0, i - 7), i + 1).sort((x, y) => x - y);
      heartbeat(jittery.room, jittery.a, {
        rtt: swing[i], claimMs: Math.round(seen[seen.length >> 1] * 1000),
      });
    }
    check('a line swinging between 50 and 400ms is never a cheat',
      (jittery.a.cheat.counts.lag ?? 0) === 0,
      `${swing.length} heartbeats, jitter ±${Math.round(jittery.a.rttJitter() * 1000)}ms, `
      + `${jittery.a.cheat.counts.lag ?? 0} flags`);

    // The cheat: `net.ping` rewritten to report 300 ms it does not have. It has
    // to keep saying it — one disagreement is jitter, and a run of them all in
    // the same direction is the only thing a made-up constant can produce.
    const liar = arena('ac-lag-liar');
    const liarBeats = K.RTT_SAMPLES + K.CHEAT_LAG_STREAK + 1;
    for (let i = 0; i < liarBeats; i++) heartbeat(liar.room, liar.a, { rtt: 0.04, claimMs: 300 });
    check('a claimed round trip moves nothing',
      Math.abs(liar.a.rtt - 0.04) < 0.005, `still ${Math.round(liar.a.rtt * 1000)}ms`);
    check('the rewind stays where the measurement puts it',
      Math.abs(liar.room.rewindFor(liar.a) - (0.04 / 2 + K.INTERP_DELAY)) < 0.006,
      `${Math.round(liar.room.rewindFor(liar.a) * 1000)}ms`);
    check('and a run of the same claim is recorded against the connection',
      (liar.a.cheat.counts.lag ?? 0) > 0,
      `${liar.a.cheat.counts.lag} flags after ${liarBeats} heartbeats`);

    // …but not before the run is long enough to mean something. Half a streak
    // of disagreement is a bad minute on a bad line.
    const brief = arena('ac-lag-brief');
    for (let i = 0; i < K.RTT_SAMPLES + (K.CHEAT_LAG_STREAK >> 1); i++) {
      heartbeat(brief.room, brief.a, { rtt: 0.04, claimMs: 300 });
    }
    check('a short run of it is not', (brief.a.cheat.counts.lag ?? 0) === 0,
      `${K.CHEAT_LAG_STREAK >> 1} disagreeing samples, no flag`);

    // The harder version: sit on the acknowledgement instead of lying about it.
    // It is bounded by MAX_LAG_COMP either way, and it is still a flag.
    const staller = arena('ac-lag-stall');
    for (let i = 0; i < liarBeats; i++) {
      heartbeat(staller.room, staller.a, { rtt: 0.04, claimMs: 40, ackDelay: 0.3 });
    }
    check('and sitting on the acknowledgement is one too',
      (staller.a.cheat.counts.lag ?? 0) > 0
      && staller.room.rewindFor(staller.a) <= K.MAX_LAG_COMP,
      `${Math.round(staller.room.rewindFor(staller.a) * 1000)}ms, ${staller.a.cheat.counts.lag} flags`);

    // Refusing to answer at all is the one thing that buys nothing: no samples
    // means the default, which is well under the ceiling.
    const mute = arena('ac-lag-mute');
    for (let i = 0; i < 8; i++) { mute.room.onPing(mute.a, { t: i }); mute.room.now += 1; }
    check('a client that never answers keeps the default, not the maximum',
      mute.room.rewindFor(mute.a) < K.MAX_LAG_COMP * 0.6,
      `${Math.round(mute.room.rewindFor(mute.a) * 1000)}ms`);
  }

  /* ── Speed hack ──────────────────────────────────────────────────────────
   * The cheat's `simulateTick` hook: feed the extra inputs the drain cap would
   * accept. The cap stays; each step is now paid for out of a bucket that
   * refills at real time.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — speed hack');
  {
    const run = (perTick) => {
      const { room, a } = arena(`ac-speed-${perTick}`);
      a.state.z = 0;
      a.state.x = 0;
      const start = a.state.z;
      let seq = 0, owed = 0;
      for (let tick = 0; tick < 600; tick++) {
        // Through the same door a real packet comes in by, so the queue that
        // backs up behind the budget is the one the detector actually reads.
        owed += perTick;
        const batch = [];
        while (owed >= 1) { batch.push([++seq, KEY.FWD, 0, 0]); owed -= 1; }
        if (batch.length) room.onInput(a, { i: batch });
        room.tick(K.TICK_DT);
      }
      return { room, a, moved: Math.hypot(a.state.x, a.state.z - start) };
    };

    const honest = run(1);
    const cheating = run(3);
    const ratio = cheating.moved / Math.max(0.001, honest.moved);
    check('three inputs a tick no longer buys three times the distance',
      ratio < 1.08, `${ratio.toFixed(3)}× over four seconds`);
    info(`honest ${honest.moved.toFixed(1)}u · cheating ${cheating.moved.toFixed(1)}u`);
    check('and the backlog it leaves behind is what gets recorded',
      (cheating.a.cheat.counts.speed ?? 0) > 0, `${cheating.a.cheat.counts.speed} flags`);
    check('an honest client is never held back by the budget',
      (honest.a.cheat.counts.speed ?? 0) === 0 && honest.a.inputQueue.length === 0);
    // Two machines never agree on how long a second is; a slightly quick
    // oscillator must never read as three times the speed.
    check('a client half a percent fast is not a speed hack',
      run(1.005).a.cheat.incidents === 0);

    // A burst after a stall still catches up: that is what the reserve is for.
    const { room, a } = arena('ac-burst');
    for (let i = 0; i < 8; i++) a.inputQueue.push({ seq: i + 1, keys: KEY.FWD, yaw: 0, pitch: 0 });
    for (let t = 0; t < 4; t++) room.tick(K.TICK_DT);
    check('a burst arriving after a stall is still spent',
      a.inputQueue.length === 0 && (a.cheat.counts.speed ?? 0) === 0,
      `${a.lastSeq} of 8 applied in 4 ticks`);
  }

  /* ── Packet flooding ───────────────────────────────────────────────────── */
  suite('Anti-cheat — input flooding');
  {
    const { room, a } = arena('ac-flood');
    let seq = 0;
    for (let i = 0; i < 400; i++) {
      room.onInput(a, { i: [[++seq, 0, 0, 0]] });
    }
    check('a client cannot send more input packets than a second holds',
      a.lastSeq === 0 && a.inputQueue.length <= 90, `${a.inputQueue.length} queued from 400 packets`);
    check('and the flood is recorded', (a.cheat.counts.rate ?? 0) > 0);
  }

  /* ── What it costs ─────────────────────────────────────────────────────── */
  suite('Anti-cheat — scoring');
  {
    const p = new Player({ name: 'Suspect', ws: { readyState: 1, send() {}, close() {} } });
    check('one refusal is never acted on', ac.flag(p, 'aim') === 'none');
    let verdict = 'none';
    for (let i = 0; i < 40 && verdict !== 'kick'; i++) verdict = ac.flag(p, 'aim');
    check('a sustained run of them reaches the kick', verdict === 'kick',
      `score ${Math.round(p.cheat.score)} over ${p.cheat.incidents} refusals`);

    const clean = new Player({ name: 'Unlucky' });
    ac.flag(clean, 'aim');
    ac.decay(clean, 0);
    ac.decay(clean, 400);
    check('and suspicion is shed for clean play', clean.cheat.score === 0);

    // The kick has to leave something behind that survives a reconnect.
    const { room, a } = arena('ac-report');
    const filed = [];
    room.hub = { db: { reports: { add: (o) => { filed.push(o); return { id: 'r1' }; } } } };
    a.cheat.score = 999;
    a.cheat.incidents = 20;
    a.cheat.counts.aim = 20;
    ac.enforce(room, a, 'kick', 'aim');
    check('a kick files a report a moderator reads next to the human ones',
      filed.length === 1 && filed[0].reason === 'cheat' && filed[0].reporterName === 'anti-cheat',
      filed[0]?.detail?.slice(0, 60));
    check('naming the account it was filed against',
      filed[0]?.targetName === 'Shooter');
  }

  /* ── AFK ─────────────────────────────────────────────────────────────────
   * The cheat's `antiAfk`: a heartbeat every twelve seconds. Activity is now
   * counted from input a person produces, which a heartbeat is not.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — away from keyboard');
  {
    const { room, a } = arena('ac-afk');
    const frames = [];
    room.sendTo = (p, m) => frames.push(m);
    room.state = 'live';

    // A page left open: sixty empty inputs a second and a heartbeat, forever.
    a.lastActiveAt = Date.now() - (K.AFK_WARN_SEC + 2) * 1000;
    room.onInput(a, { i: [[1, 0, 0, 0]] });
    room.onPing(a, { t: 1 });
    check('an empty input stream is not activity',
      a.idleSec() > K.AFK_WARN_SEC, `${Math.round(a.idleSec())}s idle`);

    room.afkSweptAt = 0;
    room.sweepAfk();
    check('the warning lands first',
      frames.some((f) => f.o === K.S2C.AFK && f.phase === 'warn'));

    // A key held is. That is all it takes to answer it.
    room.onInput(a, { i: [[2, KEY.FWD, 0, 0]] });
    check('a key held clears it', a.idleSec() < 1);
    frames.length = 0;
    room.afkSweptAt = 0;
    room.sweepAfk();
    check('and the notice is taken back down',
      frames.some((f) => f.o === K.S2C.AFK && f.phase === 'clear'));

    // Ignoring it hands the seat back.
    a.lastActiveAt = Date.now() - (K.AFK_KICK_SEC + 2) * 1000;
    frames.length = 0;
    room.afkSweptAt = 0;
    room.sweepAfk();
    check('ignoring it returns the player to the menu',
      frames.some((f) => f.o === K.S2C.AFK && f.phase === 'out'));

    // And the respawn is held in the meantime, which is the half that stops a
    // dead body being fed back into the match by a script.
    const held = [];
    room.sendTo = (p, m) => held.push(m);
    a.alive = false;
    a.respawnAt = room.now - 1;
    a.afk = false;
    a.lastActiveAt = Date.now() - (K.AFK_WARN_SEC + 2) * 1000;
    room.onRespawnRequest(a);
    check('an idle body is not respawned',
      !a.alive && held.some((f) => f.o === K.S2C.AFK && f.phase === 'held'));

    a.noteActivity();
    room.onRespawnRequest(a);
    check('and is the moment somebody is at the keyboard again', a.alive);
  }

  /* ── Every class, played hard, at every frame rate ───────────────────────
   * The suite above checks each rule against the cheat it exists for. This is
   * the other half, and it is the half that has actually caught things: nine
   * classes played the way people play them — moving, jumping, strafing, the
   * mouse never still, the trigger held through magazine after magazine, the
   * sights tapped on and off, and the odd rocket at one's own feet — with the
   * client's own frame ordering and its own ammo counter, which is precisely
   * what drifts away from the server's.
   *
   * Everything it has found was a false positive: a sequence counter measured
   * against the wrong number, a quickscope firing the hip-fire cone, a dead
   * body's input queue backing up into the speed-hack signature.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — an ordinary player, at every frame rate');
  {
    const play = ({ fps, classId, seconds = 8 }) => {
      const { room, a, b } = arena(`soak-${classId}-${fps}`, { gap: 30 });
      room.state = 'live';
      const kicked = [];
      room.sendTo = (p, m) => { if (m.o === K.S2C.ERROR) kicked.push(m.code); };
      a.setClass(classId, true);

      const view = { yaw: 0, pitch: 0 };
      const w = a.weaponDef;
      const interval = shotInterval(w);
      let seq = 0, claimed = 0, lastShotAt = -99, burst = 0, ammo = w.magSize ?? 1;
      let batch = [], flushAcc = 0, acc = 0, now = 0, reloadUntil = 0, fired = 0;
      const dt = 1 / fps;
      const flush = () => { if (batch.length) { room.onInput(a, { i: batch }); batch = []; } };

      for (let f = 0; f < seconds * fps; f++) {
        now += dt;
        view.yaw += Math.sin(now * 2.3) * 0.02;
        view.pitch = clamp(view.pitch + Math.cos(now * 1.7) * 0.008, -1.4, 1.4);
        const ads = Math.floor(now * 3) % 2 === 0;
        const keys = (Math.floor(now * 1.3) % 2 ? KEY.FWD : KEY.BACK)
          | (Math.floor(now * 5) % 7 === 0 ? KEY.JUMP : 0)
          | (Math.floor(now * 2) % 3 === 0 ? KEY.LEFT : KEY.RIGHT)
          | (ads ? KEY.ADS : 0) | KEY.FIRE;

        acc += dt;
        let ticks = 0;
        while (acc >= K.TICK_DT && ticks < 5) {
          batch.push([++seq, keys, Math.round(view.yaw * 1e4) / 1e4, Math.round(view.pitch * 1e4) / 1e4]);
          if (batch.length > K.MAX_INPUTS_PER_PACKET) batch.shift();
          acc -= K.TICK_DT;
          ticks++;
        }
        flushAcc += dt;
        if (flushAcc >= K.SNAPSHOT_DT) { flushAcc = 0; flush(); }

        if (!w.melee && now >= reloadUntil && now - lastShotAt >= interval) {
          if (ammo <= 0) { reloadUntil = now + (w.reloadTime ?? 2); ammo = w.magSize ?? 1; }
          else {
            lastShotAt = now;
            ammo--;
            fired++;
            flush();                                   // net.shoot flushes first
            room.onShoot(a, {
              y: view.yaw, p: view.pitch, a: ads ? 1 : 0, n: ++claimed, b: Math.round(burst),
            });
            burst++;
            const kick = recoilKick(w, Math.round(burst) + 1);
            view.pitch = Math.min(Math.PI / 2 - 0.001, view.pitch + kick.pitch * (ads ? 0.62 : 1));
            view.yaw += kick.yaw * (ads ? 0.62 : 1);
          }
        }
        for (let i = 0; i < ticks; i++) room.tick(K.TICK_DT);
      }
      return { fired, accepted: a.shotSeq, cheat: a.cheat, kicked: kicked.length > 0, b };
    };

    const failures = [];
    let rounds = 0, declined = 0, worst = 0;
    for (const classId of CLASS_IDS) {
      for (const fps of [30, 60, 144, 240]) {
        const r = play({ fps, classId });
        rounds += r.fired;
        declined += r.fired - r.accepted;
        worst = Math.max(worst, r.cheat.score);
        if (r.cheat.incidents || r.kicked) {
          failures.push(`${classId}@${fps} ${JSON.stringify(r.cheat.summary())}`);
        }
      }
    }
    info(`${CLASS_IDS.length} classes × 4 frame rates · ${rounds} rounds fired, `
      + `${declined} of them declined by the room`);
    check('nobody playing the game is ever flagged for playing it',
      failures.length === 0, failures.slice(0, 3).join(' · '));
    check('and nothing comes close to the warning, let alone the kick',
      worst < K.CHEAT_WARN_SCORE / 4, `worst score ${worst.toFixed(1)} of ${K.CHEAT_WARN_SCORE}`);
    check('the room really was declining rounds throughout — that is the case that broke',
      declined > 0, `${declined} declined`);
  }

  /* ── The mouse is still the mouse ─────────────────────────────────────── */
  suite('Anti-cheat — an ordinary match is untouched');
  {
    const { room, a, b } = arena('ac-clean');
    room.state = 'live';
    let seq = 0, yaw = 0;
    for (let tick = 0; tick < 300; tick++) {
      const keys = (tick % 90 < 45 ? KEY.FWD : KEY.BACK) | (tick % 37 === 0 ? KEY.JUMP : 0);
      const shooting = tick % 20 === 0;
      // Exactly the client's own order: the tick's input carries the aim, the
      // shoot packet follows it down the same socket carrying the same angles.
      const aim = shooting ? aimAt(a, b) : { yaw: yaw + 0.02 * Math.sin(tick * 0.11), pitch: 0.05 };
      yaw = aim.yaw;
      room.onInput(a, { i: [[++seq, keys, aim.yaw, aim.pitch]] });
      if (shooting) {
        ready(room, a);
        room.onShoot(a, { y: aim.yaw, p: aim.pitch, a: a.ads ? 1 : 0, n: a.shotSeq + 1 });
      }
      room.tick(K.TICK_DT);
    }
    check('five seconds of ordinary play trips nothing at all',
      a.cheat.incidents === 0 && a.cheat.score === 0,
      JSON.stringify(a.cheat.summary()));
    check('and the shots landed', b.health < K.MAX_HEALTH, `${Math.round(b.health)} hp left`);
  }

  /* ── A bad connection is not a cheat ─────────────────────────────────────
   * Three of the seven checks are downstream of *arrival times* rather than of
   * packet contents, and arrival times on a lossy line are not a measurement of
   * the client at all: TCP holds a stalled stream and hands over the whole
   * backlog the moment it clears. Every case below is a real connection doing
   * something entirely normal, and every one of them used to be flagged.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — lag is not cheating');
  {
    // A two-second stall, then everything the client queued during it arriving
    // in one frame. This is the single most common shape on a mobile network.
    const { room, a } = arena('ac-stall');
    let seq = 0;
    const burst = [];
    for (let i = 0; i < 120; i++) burst.push([++seq, KEY.FWD, 0, 0]);
    for (let i = 0; i < burst.length; i += K.MAX_INPUTS_PER_PACKET) {
      room.onInput(a, { i: burst.slice(i, i + K.MAX_INPUTS_PER_PACKET) });
    }
    check('a two-second backlog delivered in one frame is not a speed hack',
      (a.cheat.counts.speed ?? 0) === 0 && (a.cheat.counts.rate ?? 0) === 0,
      `${a.inputQueue.length} queued, ${a.cheat.incidents} incidents`);

    // …and it drains. Which is the whole difference: a stall catches up, a
    // speed hack never does, and only the second one is ever counted.
    for (let tick = 0; tick < 240; tick++) {
      room.tick(K.TICK_DT);
      if (tick % 2 === 0) room.onInput(a, { i: [[++seq, KEY.FWD, 0, 0]] });
    }
    check('and once it has drained the connection is clean again',
      (a.cheat.counts.speed ?? 0) === 0 && a.inputQueue.length <= K.MAX_INPUTS_PER_PACKET,
      `${a.inputQueue.length} queued after catching up`);

    // A flurry of packets — a stall's worth arriving inside one second — is a
    // burst, and the burst is explicitly forgiven. Only a client that never
    // stops sending them fills the bucket.
    const flood = arena('ac-flood');
    let fseq = 0;
    for (let i = 0; i < 140; i++) flood.room.onInput(flood.a, { i: [[++fseq, 0, 0, 0]] });
    check('a second of held-back packets arriving at once is not a flood',
      (flood.a.cheat.counts.rate ?? 0) === 0,
      `140 packets in one second, ${flood.a.cheat.counts.rate ?? 0} flags`);

    // The 144 fps flick, which is the aim check's own false positive: the view
    // rides a simulation tick, the trigger is pulled on a frame, and above
    // 60 fps there are frames with no tick in them — so the mouse has moved
    // through a whole tick nothing described by the time the shot goes out.
    const fast = arena('ac-flick-fps');
    let vseq = 0, flagged = 0;
    let vyaw = 0;
    const TURN = 12;                               // rad/s — a hard flick
    for (let frame = 0; frame < 400; frame++) {
      const dt = 1 / 144;
      vyaw += TURN * dt;
      // Two frames in three carry no tick at 144 fps: the input stream is a
      // third of the frame rate, and the shot lands on one of the other two.
      if (frame % 3 === 0) {
        fast.room.onInput(fast.a, { i: [[++vseq, 0, vyaw, 0.1]] });
      }
      if (frame % 12 === 0) {
        ready(fast.room, fast.a);
        const before = fast.a.cheat.counts.aim ?? 0;
        fast.room.onShoot(fast.a, { y: vyaw, p: 0.1, n: fast.a.shotSeq + 1 });
        if ((fast.a.cheat.counts.aim ?? 0) > before) flagged++;
      }
      fast.room.tick(dt);
    }
    check('flicking at 144 fps is not silent aim',
      flagged === 0, `${flagged} of 34 shots flagged, turning ${TURN} rad/s`);
  }

  /* ── The report a person has to read ─────────────────────────────────────
   * A queue entry nobody can act on is a queue entry that gets closed with "no
   * action", which is the same as never having filed it.
   * ──────────────────────────────────────────────────────────────────────── */
  suite('Anti-cheat — the report body');
  {
    const { room, a } = arena('ac-report');
    a.userId = 'u-test';
    room.now += 12;
    ac.flag(a, 'aim', 'shot 173.4\u00b0 off the streamed view (allowed 6.1\u00b0)', null, room.now);
    room.now += 30;
    ac.flag(a, 'aim', 'shot 179.9\u00b0 off the streamed view (allowed 5.9\u00b0)', null, room.now);
    ac.flag(a, 'seq', 'skipped 160 of its own shot sequences', null, room.now);
    a.cheat.worstRtt = 0.21;
    a.cheat.worstJitter = 0.06;
    const body = ac.reportBody(room, a, 'aim');

    check('it names the kind in words before it names it in code',
      body.includes(K.CHEAT_KIND_INFO.aim.title) && body.includes('(aim)'));
    check('it says what a cheat doing this would be buying',
      body.includes('Silent aim'));
    check('it answers the question that settles most of these — could lag do it',
      /Can a bad connection cause it\?/.test(body));
    check('it quotes the first and the last piece of evidence, not just one',
      body.includes('173.4') && body.includes('179.9'));
    check('it says when it started and when it stopped',
      /First .* before the disconnect, last .* before it\./.test(body));
    check('it prints the connection that was live while it happened',
      body.includes('210ms') && body.includes('60ms'));
    check('every kind seen is listed, not only the one that tripped it',
      body.includes(K.CHEAT_KIND_INFO.seq.title));
    check('and it fits in the column the queue stores it in',
      body.length < 4000, `${body.length} characters`);
  }
}
