/** A full bot match: movement, engagement, scoring and match flow. */
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import * as K from '../shared/constants.js';
import { suite, check, info } from './harness.mjs';

export default function run() {
  suite('Bot match — 8 bots, 90 seconds of Burgtown FFA');
  const room = new Room({ id: 'test-sim', mapId: 'burgtown', modeId: 'ffa' });
  const kills = [];
  room.broadcast = (m) => { if (m.o === K.S2C.KILL) kills.push(m); };
  room.broadcastNear = () => {};
  room.sendTo = () => {};

  for (let i = 0; i < 8; i++) room.addBot();

  const t0 = performance.now();
  const SECONDS = 90;
  for (let t = 0; t < SECONDS * K.TICK_RATE; t++) room.tick(K.TICK_DT);
  const wall = performance.now() - t0;

  const players = [...room.players.values()];
  const shots = players.reduce((n, p) => n + p.score.shotsFired, 0);
  const hits = players.reduce((n, p) => n + p.score.shotsHit, 0);
  const moved = players.filter((p) => Math.hypot(p.state.x, p.state.z) > 1).length;
  const belowWorld = players.filter((p) => p.state.y < -1).length;

  info(`${SECONDS} s simulated in ${wall.toFixed(0)} ms `
    + `(${(wall / SECONDS / 10).toFixed(2)}% of one core), ${shots} shots fired`);

  check('bots engage and get kills', kills.length >= 10, `${kills.length} kills in ${SECONDS} s`);
  check('some kills are headshots', kills.some((k) => k.head),
    `${kills.filter((k) => k.head).length} headshots`);
  check('every bot navigates away from its spawn', moved === players.length,
    `${moved}/${players.length}`);
  check('no bot falls out of the world', belowWorld === 0);
  check('bots hit a plausible share of their shots', hits / shots > 0.05 && hits / shots < 0.75,
    `${((hits / shots) * 100).toFixed(1)}% accuracy`);
  check('the server keeps far ahead of real time', wall < SECONDS * 100,
    `${(wall / (SECONDS * 1000) * 100).toFixed(2)}% of wall-clock`);

  suite('Match flow');
  const scoreRoom = new Room({ id: 'test-flow', mapId: 'subzero', modeId: 'ffa' });
  const flowMsgs = [];
  scoreRoom.broadcast = (m) => flowMsgs.push(m);
  scoreRoom.broadcastNear = scoreRoom.sendTo = () => {};
  for (let i = 0; i < 4; i++) scoreRoom.addBot();
  const firstMap = scoreRoom.mapId;
  scoreRoom.matchEnd = scoreRoom.now + 0.5;

  for (let t = 0; t < 1.5 * K.TICK_RATE; t++) scoreRoom.tick(K.TICK_DT);
  const endMsg = flowMsgs.find((m) => m.o === K.S2C.MATCH && m.phase === 'end');
  check('the match ends with a full scoreboard for the intermission',
    !!endMsg && Array.isArray(endMsg.scoreboard) && endMsg.scoreboard.length === 4
      && endMsg.scoreboard.every((r) => 'accuracy' in r && 'gr' in r && 'damage' in r),
    `${endMsg?.scoreboard?.length ?? 0} rows, next map in ${endMsg?.nextIn}s`);
  check('nobody can respawn while the end-of-match scoreboard is up',
    scoreRoom.state === 'intermission');

  for (let t = 0; t < (K.INTERMISSION_TIME + 2) * K.TICK_RATE; t++) scoreRoom.tick(K.TICK_DT);
  check('a finished match rotates to the next map',
    scoreRoom.mapId !== firstMap && scoreRoom.state === 'live',
    `${firstMap} -> ${scoreRoom.mapId}`);

  suite('Scoring');
  const sc = new Room({ id: 'test-score', mapId: 'burgtown', modeId: 'ffa' });
  const points = [];
  sc.broadcast = sc.broadcastNear = () => {};
  sc.sendTo = (p, m) => { if (m.o === K.S2C.POINTS) points.push({ id: p.id, ...m }); };
  const a = sc.addBot(), b = sc.addBot();

  b.state.onGround = false;                      // victim is airborne
  a.state.sliding = true;                        // killer is drifting
  a.protectedUntil = b.protectedUntil = -1;      // past the spawn shield
  b.health = 1;
  sc.applyHit(a, b, 50, true, { id: 'sniper', scope: true }, { x: 0, y: 0, z: 0 },
    { ads: false, scopeTime: 0, airborne: false, sliding: true, distance: 80 });

  const ev = points.find((e) => e.id === a.id);
  const labels = new Set((ev?.events ?? []).map((e) => e.label));
  check('a kill pays out every bonus it earned',
    labels.has('KILL') && labels.has('HEADSHOT') && labels.has('MIDAIR')
      && labels.has('DRIFT KILL') && labels.has('NO SCOPE') && labels.has('LONGSHOT'),
    [...labels].join(' + '));
  check('the payout matches the score table',
    ev.total === K.SCORE.KILL + K.SCORE.HEADSHOT + K.SCORE.MIDAIR + K.SCORE.DRIFT
      + K.SCORE.NOSCOPE + K.SCORE.LONGSHOT + K.SCORE.FIRST_BLOOD,
    `${ev.total} points, worth ${K.grFromScore(ev.total)} GR`);
  check('100 points converts to 1 GR at the end of a match',
    K.grFromScore(100) === 1 && K.grFromScore(250) === 2 && K.grFromScore(99) === 0);

  suite('Score persistence');
  const keep = new Room({ id: 'test-keep', mapId: 'burgtown', modeId: 'ffa' });
  keep.broadcast = keep.broadcastNear = keep.sendTo = () => {};
  const human = new Player({ name: 'Tester', userId: 42, classId: 'triggerman' });
  keep.add(human);
  human.score.score = 730;
  human.score.kills = 9;

  human.setClass('hunter');
  check('changing class keeps the match score', human.score.score === 730 && human.score.kills === 9,
    `${human.score.score} points after switching to ${human.classId}`);

  keep.remove(human.id);
  const rejoined = new Player({ name: 'Tester', userId: 42, classId: 'hunter' });
  keep.add(rejoined);
  check('leaving and rejoining the same match restores the score',
    rejoined.score.score === 730 && rejoined.score.kills === 9,
    `${rejoined.score.score} points restored`);

  keep.startMatch();
  check('a brand new match starts everyone back at zero', rejoined.score.score === 0);

  suite('Spectators and match codes');
  const watch = new Room({ id: 'test-watch', mapId: 'burgtown', modeId: 'ffa' });
  const sent = [];
  watch.broadcast = (m) => sent.push(m);
  watch.broadcastNear = () => {};
  watch.sendTo = (p, m) => sent.push({ to: p.id, ...m });

  check('a room has a shareable code', /^[A-Z]{2,4}:[A-Z0-9]{4}$/.test(watch.code)
    && K.ROOM_CODE_RE.test(watch.code), watch.code);
  check('the code is derived from the id, not randomised',
    new Room({ id: 'test-watch', mapId: 'burgtown', modeId: 'ffa' }).code === watch.code,
    'a shared link survives a restart');

  const player = new Player({ name: 'Seated', classId: 'triggerman' });
  watch.add(player);
  sent.length = 0;

  const viewer = new Player({ name: 'Watcher', spectator: true });
  watch.add(viewer);
  check('joining as a spectator announces nothing', sent.length === 0);
  check('a spectator does not spawn', !viewer.alive && viewer.spectator);
  check('a spectator is not counted as a player',
    watch.playerCount === 1 && watch.spectatorCount === 1 && watch.roster.length === 1,
    `${watch.playerCount} playing, ${watch.spectatorCount} watching`);
  check('a spectator is absent from the scoreboard',
    !watch.roster.some((p) => p.spectator)
      && watch.welcomePayload(player).scoreboard.every((r) => r.name !== 'Watcher'));

  // Nothing a spectator sends can touch the match.
  const beforeScore = player.score.score;
  watch.onMessage(viewer, { o: K.C2S.SHOOT, y: 0, p: 0, n: 1 });
  watch.onMessage(viewer, { o: K.C2S.CHAT, m: 'hello' });
  check('a spectator cannot shoot or chat into the match',
    player.score.score === beforeScore && !sent.some((m) => m.o === K.S2C.CHAT));

  // …until it asks for a seat.
  sent.length = 0;
  watch.onPlayRequest(viewer);
  check('pressing play seats the spectator', viewer.alive && !viewer.spectator
    && watch.playerCount === 2 && watch.spectatorCount === 0,
    `${watch.playerCount} playing now`);
  check('the rest of the room is told about the new arrival',
    sent.some((m) => m.o === K.S2C.JOIN && m.player?.name === 'Watcher'));
  check('the new arrival gets its own joined event',
    sent.some((m) => m.o === K.S2C.MATCH && m.phase === 'joined' && m.to === viewer.id));

  // A full room can still be watched, just not joined.
  const full = new Room({ id: 'test-full', mapId: 'subzero', modeId: 'ffa' });
  full.broadcast = full.broadcastNear = full.sendTo = () => {};
  for (let i = 0; i < K.MAX_PLAYERS_PER_ROOM; i++) full.add(new Player({ name: `P${i}` }));
  const late = new Player({ name: 'Late', spectator: true });
  full.add(late);
  const refusals = [];
  full.sendTo = (p, m) => { if (m.o === K.S2C.ERROR) refusals.push(m.code); };
  full.onPlayRequest(late);
  check('a full room can be watched but not joined',
    full.isFull && late.spectator && refusals.includes('room_full'),
    `${full.playerCount}/${K.MAX_PLAYERS_PER_ROOM} seated`);

  suite('Team deathmatch');
  const tdm = new Room({ id: 'test-tdm', mapId: 'sandstorm', modeId: 'tdm' });
  tdm.broadcast = tdm.broadcastNear = tdm.sendTo = () => {};
  for (let i = 0; i < 8; i++) tdm.addBot();
  const teams = [...tdm.players.values()].map((p) => p.team);
  const red = teams.filter((t) => t === K.TEAM.RED).length;
  const blue = teams.filter((t) => t === K.TEAM.BLUE).length;
  check('teams are balanced on join', Math.abs(red - blue) <= 1, `${red} red vs ${blue} blue`);

  for (let t = 0; t < 60 * K.TICK_RATE; t++) tdm.tick(K.TICK_DT);
  const scored = tdm.teamScore[K.TEAM.RED] + tdm.teamScore[K.TEAM.BLUE];
  check('team scores accumulate from kills', scored > 0,
    `red ${tdm.teamScore[K.TEAM.RED]} — blue ${tdm.teamScore[K.TEAM.BLUE]}`);

  const friendlyFire = [...tdm.players.values()].some((p) => p.score.damage > 0 && p.score.kills === 0
    && p.score.damage > 500);
  check('no runaway friendly fire', !friendlyFire);
}
