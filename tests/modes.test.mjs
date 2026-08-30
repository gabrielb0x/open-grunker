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
import { World } from '../shared/physics.js';
import { step, createState, KEY } from '../shared/movement.js';
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

  /* ── Perks ─────────────────────────────────────────────────────────────────
   *
   * The mode where the body is the choice. Every check below is the same
   * question asked of a different system: does the number the perk promises
   * actually reach the place that decides the fight, and does it reach *only*
   * that place — a perk that leaked into Team Deathmatch would be a silent
   * balance change to every other mode in the game.
   * ────────────────────────────────────────────────────────────────────────*/

  suite('Perks — the trade');

  const pk = makeRoom({ id: 'test-perks', mapId: 'nova', modeId: 'perks' });
  const runner = addHuman(pk, 'Runner', 201);
  const jug = addHuman(pk, 'Jug', 202);
  /**
   * Picks a perk the way a player out of combat does: cleanly, at once.
   *
   * The latch is cleared first, because the pick is once per match and the
   * checks below are a dozen different bodies asked for out of one room. Every
   * one of them is standing in for "a fresh match, chosen at the start" — which
   * is what `startMatch` does for real — and the latch itself has a suite of
   * its own further down.
   */
  const pick = (p, id) => {
    p.lastCombatAt = -999;
    p.perkChosen = false;
    pk.onPerkChange(p, { p: id });
  };

  check('everybody starts on the default, and nobody starts having chosen',
    runner.perkOn && runner.perkId === K.DEFAULT_PERK && !runner.perkChosen,
    `${K.PERK_IDS.length} perks, default ${K.DEFAULT_PERK}`);

  check('choosing one changes what the body *is*, not what it carries', (() => {
    pick(runner, 'runner');
    const p = K.getPerk('runner');
    return runner.perkId === 'runner'
      && runner.maxHealth === Math.round(K.MAX_HEALTH * p.health)
      && Math.abs(runner.speedMult(false) - p.speed) < 1e-9;
  })(), `Runner: ${runner.maxHealth} hp, ${runner.speedMult(false).toFixed(2)}× speed`);

  check('and the movement it hands the shared step is the whole of its physics', (() => {
    const opts = runner.moveOpts(false);
    const p = K.getPerk('runner');
    return opts.hopKeep === p.hopKeep && opts.airMax === p.airMax && opts.jumpMult === p.jump;
  })(), JSON.stringify(runner.moveOpts(false)));

  check('a Runner really does hop faster, and it is the air cap that lets them', (() => {
    // The same strafe-hop the movement suite uses, run twice: once with no
    // perk and once with Runner's. A plain body tops out at MAX_AIR_SPEED; the
    // whole of Runner's upside is that its ceiling is higher and its hops stop
    // bleeding into it.
    const flat = new World({ boxes: [], solids: [], size: 400, ground: { size: 400 } });
    const tap = (keys, tick) => (tick % 2 === 0 ? keys : keys & ~KEY.JUMP);
    const top = (opts) => {
      const s = createState(0, 0.5, 0, 0);
      let yaw = 0;
      for (let i = 0; i < 900; i++) {
        yaw += 1.05 * K.TICK_DT;
        step(s, { keys: tap(KEY.FWD | KEY.RIGHT | KEY.JUMP, i), yaw, pitch: 0 }, flat, K.TICK_DT, opts);
      }
      return Math.hypot(s.vx, s.vz);
    };
    const plain = top({ speedMult: 1 });
    const fast = top(runner.moveOpts(false));
    info(`plain tops out at ${plain.toFixed(1)} u/s, a Runner at ${fast.toFixed(1)} u/s`);
    return Math.abs(plain - K.MAX_AIR_SPEED) < 0.5
      && fast > plain * 1.25;
  })());

  check('two perks meet on every bullet, and neither player has to know the other', (() => {
    pick(runner, 'marksman');
    pick(jug, 'juggernaut');
    jug.health = jug.maxHealth;
    jug.protectedUntil = -1;
    const before = jug.health;
    pk.applyHit(runner, jug, 100, false, runner.weaponDef, { x: 0, y: 0, z: 0 }, {});
    const dealt = before - jug.health;
    const want = Math.round(Math.round(100 * K.getPerk('marksman').damage) * K.getPerk('juggernaut').taken);
    info(`100 raw → ${dealt} through a Marksman's gun into a Juggernaut (expected ${want})`);
    return dealt === want && jug.maxHealth === Math.round(K.MAX_HEALTH * 1.9);
  })());

  check('a Berserker never regenerates a single point', (() => {
    pick(runner, 'berserker');
    runner.alive = true;
    runner.health = 40;
    runner.lastDamageAt = -999;
    runner.regen(100, 10);
    return runner.health === 40;
  })(), `${runner.health} hp after ten seconds untouched`);

  check('…and a Medic is healing again before anybody else has stopped bleeding', (() => {
    pick(runner, 'medic');
    runner.alive = true;
    runner.health = 40;
    // Two seconds since the last hit: under the ordinary delay, over the
    // Medic's. This is the whole of what the perk buys.
    runner.lastDamageAt = 98;
    runner.regen(100, 1);
    const healed = runner.health - 40;
    const ordinary = (() => {
      pick(runner, 'trooper');
      runner.health = 40;
      runner.lastDamageAt = 98;
      runner.regen(100, 1);
      return runner.health - 40;
    })();
    info(`Medic recovers ${healed.toFixed(1)} hp where a Trooper recovers ${ordinary.toFixed(1)}`);
    return healed > 20 && ordinary === 0;
  })());

  check('a Scavenger holds a bigger magazine, and a kill fills it', (() => {
    /*
     * Deliberately the *magazine* and not the reserve. Reserves are unlimited
     * across the whole game (INFINITE_AMMO), so a perk that handed out spare
     * ammunition would have been a card promising something that could not
     * happen — what actually costs a fight is being the one who has to reload.
     */
    pick(jug, 'scavenger');
    pk.respawn(jug, true);
    const w = jug.weapon;
    const mag = jug.magOf(w);
    const bigger = mag === Math.max(1, Math.round(w.def.magSize * K.getPerk('scavenger').mag));
    const spawnedFull = w.ammo === mag;
    w.ammo = 3;
    scriptKill(pk, jug, runner);
    info(`magazine ${w.def.magSize} → ${mag}, and a kill took it from 3 to ${w.ammo}`);
    return bigger && mag > w.def.magSize && spawnedFull && w.ammo === mag;
  })());

  check('…and the room refuses a reload it has already filled', (() => {
    const w = jug.weapon;
    w.ammo = jug.magOf(w);
    w.reloading = false;
    pk.onReload(jug);
    // A gun the *weapon* thinks is over-full is a gun the old check would have
    // refused to reload from the moment the magazine passed thirty.
    const refusedWhenFull = !w.reloading;
    w.ammo = w.def.magSize;                       // full by the weapon, not by us
    pk.onReload(jug);
    return refusedWhenFull && w.reloading;
  })(), 'a bigger magazine is not a permanently full one');

  check('the cone a perk narrows is the one the pellets are actually drawn from', (() => {
    // Client and server both call `spreadFor` with the shooter's own multiplier
    // and derive pellet directions from the result: a cone the two disagreed
    // about would draw a tracer where nothing was fired.
    const w = runner.weaponDef;
    const plain = spreadFor(w, { moving: true, burst: 4 });
    const keen = spreadFor(w, { moving: true, burst: 4, mult: K.getPerk('marksman').spread });
    return Math.abs(keen - plain * K.getPerk('marksman').spread) < 1e-12 && keen < plain;
  })());

  suite('Perks — and nowhere else');

  check('no other mode has them at all', (() => {
    const plain = makeRoom({ id: 'test-noperks', mapId: 'crossfire', modeId: 'tdm' });
    const p = addHuman(plain, 'Ordinary', 203);
    // The field exists on every player in every mode so the damage path has no
    // null check; what must not exist anywhere else is its *effect*.
    p.perkId = 'runner';
    const untouched = !p.perkOn && p.maxHealth === K.MAX_HEALTH
      && p.speedMult(false) === 1
      && p.moveOpts(false).hopKeep === K.HOP_SPEED_KEEP
      && p.moveOpts(false).airMax === 1;
    plain.onPerkChange(p, { p: 'juggernaut' });
    const refused = p.perkId === 'runner'
      && plain.messages.some((m) => m.phase === 'perkLocked' && m.reason === 'mode');
    return untouched && refused;
  })());

  check('and no perk rides on the wire where nobody chose one', (() => {
    const plain = makeRoom({ id: 'test-noperks2', mapId: 'crossfire', modeId: 'tdm' });
    const p = addHuman(plain, 'Ordinary', 204);
    const perky = makeRoom({ id: 'test-perky', mapId: 'nova', modeId: 'perks' });
    const q = addHuman(perky, 'Chooser', 205);
    return p.profile().perk === undefined && q.profile().perk === K.DEFAULT_PERK;
  })());

  /* ── The pick is once ──────────────────────────────────────────────────────
   *
   * The mode is built on committing to a trade, so the rule that makes it a
   * trade is worth as many checks as the numbers are: a perk you can drop the
   * moment it stops paying is a menu, not a choice.
   * ────────────────────────────────────────────────────────────────────────*/

  check('a first pick made under fire waits for the respawn', (() => {
    const p = addHuman(pk, 'Fighter', 206);
    p.alive = true;
    p.lastCombatAt = pk.now;            // shot at, right now
    pk.onPerkChange(p, { p: 'juggernaut' });
    const queued = p.perkId === K.DEFAULT_PERK && p.pendingPerk === 'juggernaut';
    // …and it is applied *before* the spawn, because `spawnAt` reads the
    // ceiling and the spare ammunition off it.
    p.alive = false;
    p.respawnAt = -1;
    pk.onRespawnRequest(p);
    return queued && p.perkId === 'juggernaut' && p.pendingPerk === null
      && p.health === p.maxHealth;
  })(), 'queued, then applied on the respawn at full health');

  check('and a second answer in the same match is refused, with the perk they have', (() => {
    const p = addHuman(pk, 'Committed', 207);
    p.lastCombatAt = -999;
    pk.onPerkChange(p, { p: 'runner' });
    pk.messages.length = 0;
    pk.onPerkChange(p, { p: 'juggernaut' });
    const refusal = pk.messages.find((m) => m.phase === 'perkLocked');
    return p.perkId === 'runner' && p.pendingPerk === null
      && refusal?.reason === 'chosen' && refusal.perk === 'runner';
  })(), 'a perk is a trade, and a trade you can walk out of is not one');

  check('…and the next match asks again', (() => {
    const p = addHuman(pk, 'Asked', 208);
    p.lastCombatAt = -999;
    pk.onPerkChange(p, { p: 'medic' });
    pk.messages.length = 0;
    pk.startMatch();
    const asked = pk.messages.find((m) => m.phase === 'perkPick');
    return !p.perkChosen && !!asked && asked.list?.length === K.PERK_IDS.length;
  })());

  check('a nuke still kills the hardest body in the game', (() => {
    // Two hundred points of damage against a Juggernaut's hundred and ninety
    // health and fifteen per cent damage reduction is a nuke somebody walks
    // away from. The blast is measured against *their* ceiling now.
    const p = addHuman(pk, 'Tank', 207);
    pick(p, 'juggernaut');
    pk.respawn(p, true);
    p.protectedUntil = -1;
    p.applyDamage(p.maxHealth * 4, pk.now, 0);
    return p.health <= 0;
  })());
}
