/**
 * Open Grunker — game mode tests.
 *
 * Gun Game's ladder, Domination's capture points and the end-of-match map vote
 * are all server-authoritative, so they are all testable by driving a headless
 * room the same way the hub does.
 */
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import * as K from '../shared/constants.js';
import { getMap } from '../shared/maps.js';
import { spreadFor } from '../shared/weapons.js';
import { suite, check, info } from './harness.mjs';

/** A room with every socket write captured instead of sent. */
function makeRoom(opts) {
  const room = new Room(opts);
  const out = [];
  room.broadcast = (m) => out.push(m);
  room.broadcastNear = (m) => out.push(m);
  room.sendTo = (p, m) => out.push({ ...m, _to: p.id });
  room.messages = out;
  return room;
}

function addHuman(room, name, userId = null) {
  const p = new Player({ ws: null, name, userId, classId: 'triggerman' });
  room.add(p);
  return p;
}

/** Drops `victim` to `killer`'s gun, the same path a real kill takes. */
function scriptKill(room, killer, victim) {
  victim.health = 1;
  victim.protectedUntil = -1;
  room.applyHit(killer, victim, 500, false, killer.weaponDef,
    { x: victim.state.x, y: victim.state.y, z: victim.state.z },
    { distance: 10, ads: false, scopeTime: 0, airborne: false, sliding: false });
}

export default function run() {
  /* ── Gun Game ──────────────────────────────────────────────────────────── */

  suite('Gun Game');
  const gg = makeRoom({ id: 'test-gg', mapId: 'shipyard', modeId: 'gg' });
  const a = addHuman(gg, 'Climber', 101);
  const b = addHuman(gg, 'Target', 102);

  check('everyone starts on the first rung of the ladder',
    a.ggRung === 0 && a.classId === K.GUN_GAME_LADDER[0],
    `${K.GUN_GAME_LADDER.length} rungs, first is ${K.GUN_GAME_LADDER[0]}`);

  check('a kill short of the quota does not promote', (() => {
    scriptKill(gg, a, b);
    return a.ggRung === 0 && a.ggKills === 1;
  })(), `${a.ggKills}/${K.GUN_GAME_KILLS_PER_RUNG} kills on rung 1`);

  check('clearing the quota promotes and swaps the weapon', (() => {
    b.alive = true; b.health = 100;
    scriptKill(gg, a, b);
    return a.ggRung === 1 && a.ggKills === 0 && a.classId === K.GUN_GAME_LADDER[1];
  })(), `now on ${K.GUN_GAME_LADDER[1]}`);

  check('the promotion is announced to the player who earned it',
    gg.messages.some((m) => m.o === K.S2C.GUNGAME && m._to === a.id && m.rung === 1));

  check('a player cannot pick their own class in Gun Game', (() => {
    gg.messages.length = 0;
    gg.onClassChange(a, { c: 'hunter' });
    return a.classId === K.GUN_GAME_LADDER[1]
      && gg.messages.some((m) => m.phase === 'classLocked');
  })());

  check('finishing the ladder ends the match', (() => {
    for (let rung = 1; rung < K.GUN_GAME_LADDER.length; rung++) {
      for (let n = 0; n < K.GUN_GAME_KILLS_PER_RUNG; n++) {
        b.alive = true; b.health = 100;
        scriptKill(gg, a, b);
      }
    }
    return gg.state === 'intermission';
  })(), `winner ${gg.messages.find((m) => m.phase === 'end')?.winner}`);

  check('the winner is whoever climbed highest, not who scored most',
    gg.messages.find((m) => m.phase === 'end')?.winner === 'Climber');

  /* ── Domination ────────────────────────────────────────────────────────── */

  suite('Domination');
  const dom = makeRoom({ id: 'test-dom', mapId: 'sandstorm', modeId: 'dom' });
  const map = getMap('sandstorm');

  check('the map\'s capture points are loaded',
    dom.objectives.length === (map.objectives?.length ?? 0)
      && dom.objectives.every((o) => o.owner === K.TEAM.NONE),
    dom.objectives.map((o) => o.id).join(' '));

  const red = addHuman(dom, 'Red', 201);
  const blue = addHuman(dom, 'Blue', 202);
  red.team = K.TEAM.RED;
  blue.team = K.TEAM.BLUE;

  /** Stands a player on a capture point. */
  const standOn = (p, obj) => {
    p.alive = true;
    p.state.x = obj.x; p.state.y = obj.y; p.state.z = obj.z;
  };

  check('standing alone on a point captures it in the advertised time', (() => {
    const point = dom.objectives[0];
    standOn(red, point);
    blue.alive = false;
    let elapsed = 0;
    while (point.owner !== K.TEAM.RED && elapsed < 12) {
      dom.stepObjectives(K.TICK_DT);
      elapsed += K.TICK_DT;
    }
    info(`captured in ${elapsed.toFixed(1)} s (target ${K.DOM_CAPTURE_TIME} s)`);
    return point.owner === K.TEAM.RED && Math.abs(elapsed - K.DOM_CAPTURE_TIME) < 1.2;
  })());

  check('a capture pays the player who made it',
    red.score.captures === 1 && red.score.score >= K.DOM_CAPTURE_SCORE);

  check('a contested point freezes instead of flipping', (() => {
    const point = dom.objectives[0];
    standOn(blue, point);
    const before = point.owner;
    for (let i = 0; i < K.DOM_CAPTURE_TIME * 3 * K.TICK_RATE; i++) dom.stepObjectives(K.TICK_DT);
    return point.owner === before && point.contested;
  })());

  check('a point left alone to the attacker does flip', (() => {
    const point = dom.objectives[0];
    red.alive = false;
    for (let i = 0; i < K.DOM_CAPTURE_TIME * 3 * K.TICK_RATE; i++) dom.stepObjectives(K.TICK_DT);
    return point.owner === K.TEAM.BLUE;
  })());

  check('held points tick score for their team', (() => {
    const before = dom.teamScore[K.TEAM.BLUE];
    for (let i = 0; i < K.DOM_TICK_INTERVAL * 2.2 * K.TICK_RATE; i++) dom.stepObjectives(K.TICK_DT);
    const gained = dom.teamScore[K.TEAM.BLUE] - before;
    info(`blue gained ${gained} holding 1 point for ${(K.DOM_TICK_INTERVAL * 2.2).toFixed(0)} s`);
    return gained >= K.DOM_TICK_POINTS;
  })());

  check('kills do not score for the team in an objective mode', (() => {
    const before = dom.teamScore[K.TEAM.RED];
    red.alive = true; red.health = 100;
    blue.alive = true; blue.health = 100;
    scriptKill(dom, red, blue);
    return dom.teamScore[K.TEAM.RED] === before;
  })());

  /* ── Map voting ────────────────────────────────────────────────────────── */

  suite('Map voting');
  const vote = makeRoom({ id: 'test-vote', mapId: 'subzero', modeId: 'ffa' });
  const v1 = addHuman(vote, 'Voter1', 301);
  const v2 = addHuman(vote, 'Voter2', 302);
  vote.matchEnd = vote.now;
  vote.tick(K.TICK_DT);

  check('the intermission offers candidate maps that exclude the current one',
    vote.voteOptions?.length === K.VOTE_OPTIONS && !vote.voteOptions.includes('subzero'),
    vote.voteOptions?.join(', '));

  check('votes are tallied', (() => {
    const pick = vote.voteOptions[1];
    vote.onVote(v1, { m: pick });
    vote.onVote(v2, { m: pick });
    return vote.voteState().tally[pick] === 2;
  })());

  check('a vote for a map that is not on the ballot is ignored', (() => {
    const before = JSON.stringify(vote.voteState().tally);
    vote.onVote(v1, { m: 'nonsense' });
    return JSON.stringify(vote.voteState().tally) === before;
  })());

  check('the winning map is the one the room rotates to', (() => {
    const winner = vote.voteOptions[1];
    for (let t = 0; t < (K.INTERMISSION_TIME + 1) * K.TICK_RATE; t++) vote.tick(K.TICK_DT);
    info(`voted ${winner}, rotated to ${vote.mapId}`);
    return vote.mapId === winner;
  })());

  check('with no votes at all the room still moves on', (() => {
    const quiet = makeRoom({ id: 'test-vote2', mapId: 'burgtown', modeId: 'ffa' });
    addHuman(quiet, 'Silent', 401);
    const from = quiet.mapId;
    quiet.matchEnd = quiet.now;
    for (let t = 0; t < (K.INTERMISSION_TIME + 2) * K.TICK_RATE; t++) quiet.tick(K.TICK_DT);
    return quiet.mapId !== from;
  })());

  /* ── Practice range ────────────────────────────────────────────────────── */

  suite('Practice range');
  const range = makeRoom({ id: 'test-range', mapId: 'range', modeId: 'range' });
  addHuman(range, 'Trainee', 501);

  check('the range never runs out of clock', (() => {
    for (let t = 0; t < 400 * K.TICK_RATE; t++) range.tick(K.TICK_DT);
    return range.state === 'live';
  })(), `${(range.now / 60).toFixed(1)} minutes in, still live`);

  check('the range publishes no match timer',
    range.welcomePayload([...range.players.values()][0]).match.endsIn === -1);

  check('the map ships targets to shoot at', getMap('range').targets.length > 0,
    `${getMap('range').targets.length} targets`);

  /* ── Seating a spectator ───────────────────────────────────────────────── */

  suite('Taking a seat');
  const tdm = makeRoom({ id: 'test-seat', mapId: 'crossfire', modeId: 'tdm' });
  const watcher = new Player({ ws: null, name: 'Watcher', userId: 701, classId: 'triggerman', spectator: true });
  tdm.add(watcher);

  check('a spectator has no team while it is only watching',
    watcher.spectator && watcher.team === K.TEAM.NONE);

  tdm.messages.length = 0;
  tdm.onPlayRequest(watcher);

  check('taking a seat assigns a team', watcher.team !== K.TEAM.NONE,
    K.TEAM_NAMES[watcher.team]);

  check('the seat message tells the client which team it just joined', (() => {
    // The client keeps rendering its own side as the enemy without this.
    const joined = tdm.messages.find((m) => m.o === K.S2C.MATCH && m.phase === 'joined');
    info(`you.team = ${joined?.you?.team}`);
    return !!joined && joined.you && joined.you.team === watcher.team && joined.you.id === watcher.id;
  })());

  /* ── Bloom validation ──────────────────────────────────────────────────── */

  suite('Spread bloom');
  const shootRoom = makeRoom({ id: 'test-bloom', mapId: 'burgtown', modeId: 'ffa' });
  const shooter = addHuman(shootRoom, 'Shooter', 601);
  shooter.alive = true;
  shooter.state.onGround = true;
  shooter.state.vx = 0; shooter.state.vz = 0;

  check('a client burst count close to the server\'s is accepted', (() => {
    const spreads = [];
    shootRoom.messages.length = 0;
    for (let n = 0; n < 8; n++) {
      shooter.weapon.lastShot = shootRoom.now - 0.1;
      shooter.weapon.ammo = 30;
      shootRoom.onShoot(shooter, { y: 0, p: 0, a: 0, n: n + 1, b: n });
      const fx = shootRoom.messages.filter((m) => m.o === K.S2C.SHOT).pop();
      if (fx) spreads.push(fx.spread);
    }
    info(`spread over a burst: ${spreads.map((s) => (s * 1000).toFixed(1)).join(' → ')} mrad`);
    return spreads.length > 2 && spreads[spreads.length - 1] > spreads[0];
  })());

  check('an implausible burst count is replaced by the server\'s own', (() => {
    shooter.weapon.burst = 0;
    shooter.weapon.lastShot = shootRoom.now - 5;      // fully settled
    shooter.weapon.ammo = 30;
    shootRoom.messages.length = 0;
    shootRoom.onShoot(shooter, { y: 0, p: 0, a: 0, n: 999, b: 40 });
    const fx = shootRoom.messages.filter((m) => m.o === K.S2C.SHOT).pop();
    const settled = spreadFor(shooter.weaponDef, { burst: 0 });
    info(`claimed burst 40 → ${(fx.spread * 1000).toFixed(2)} mrad (settled is ${(settled * 1000).toFixed(2)})`);
    return Math.abs(fx.spread - settled) < 1e-3;
  })());

  /* ── The nuke ──────────────────────────────────────────────────────────── */

  suite('The nuke');

  const nk = makeRoom({ id: 'test-nuke', mapId: 'crossfire', modeId: 'ffa' });
  const caller = addHuman(nk, 'Streaker', 301);
  const victim = addHuman(nk, 'Bystander', 302);
  const third = addHuman(nk, 'Alsohere', 303);
  for (const p of [caller, victim, third]) {
    nk.respawn(p, true);
    p.protectedUntil = -1;
  }

  check('a launch is refused until the streak is actually there', (() => {
    caller.score.streak = K.NUKE_STREAK - 1;
    nk.onNukeRequest(caller);
    return nk.nuke === null;
  })(), `${K.NUKE_STREAK - 1} of ${K.NUKE_STREAK} kills`);

  check('reaching the streak arms it, and the player is told', (() => {
    caller.score.streak = K.NUKE_STREAK;
    nk.messages.length = 0;
    nk.sendNukeState(caller);
    const frame = nk.messages.find((m) => m.o === K.S2C.NUKE && m.phase === 'armed');
    return nk.nukeReady(caller) && frame?.armed === true && frame._to === caller.id;
  })());

  check('launching announces it to the whole room and spends the streak', (() => {
    nk.messages.length = 0;
    nk.onNukeRequest(caller);
    const frame = nk.messages.find((m) => m.o === K.S2C.NUKE && m.phase === 'launched');
    return !!nk.nuke && frame?.by === caller.id && caller.score.streak === 0
      && Math.abs(nk.nuke.at - (nk.now + K.NUKE_COUNTDOWN)) < 1e-6;
  })(), `${K.NUKE_COUNTDOWN}s on the clock`);

  check('a second launch cannot stack on the first', (() => {
    const at = nk.nuke.at;
    third.score.streak = K.NUKE_STREAK;
    nk.onNukeRequest(third);
    return nk.nuke.by === caller.id && nk.nuke.at === at;
  })());

  check('killing the caller calls it off — the only counterplay there is', (() => {
    nk.messages.length = 0;
    scriptKill(nk, victim, caller);
    const frame = nk.messages.find((m) => m.o === K.S2C.NUKE && m.phase === 'aborted');
    return nk.nuke === null && frame?.reason === 'killed';
  })());

  check('and one that survives its countdown kills everybody else', (() => {
    nk.respawn(caller, true);
    for (const p of [caller, victim, third]) {
      nk.respawn(p, true);
      p.protectedUntil = -1;
      p.health = K.MAX_HEALTH;
    }
    caller.score.streak = K.NUKE_STREAK;
    nk.onNukeRequest(caller);
    // Run the clock out the way the tick loop would.
    for (let i = 0; i < 700 && nk.nuke; i++) nk.tick(K.TICK_DT);
    info(`caller ${caller.alive ? 'alive' : 'dead'} · others ${[victim, third].filter((p) => p.alive).length} alive`);
    return caller.alive && !victim.alive && !third.alive
      && caller.score.score >= K.SCORE.NUKE;
  })());

  check('…and the match ends on the flash', (() => {
    for (let i = 0; i < 200 && nk.state === 'live'; i++) nk.tick(K.TICK_DT);
    return nk.state === 'intermission';
  })(), `state ${nk.state}`);
}
