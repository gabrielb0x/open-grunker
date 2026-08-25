/**
 * Open Grunker — the room list scales with the crowd.
 *
 * The hub is driven directly here rather than through sockets: what is on trial
 * is the rule that decides how many rooms exist, and a websocket adds nothing
 * to that except a way for it to be flaky. Players are `Player` objects with no
 * socket, which is exactly what a bot is, so every count the balancer reads is
 * the real one.
 */
import { suite, check, info } from './harness.mjs';
import config from '../server/config.js';
import { Hub } from '../server/game/hub.js';
import { Player } from '../server/game/player.js';

/** Seats `n` humans into whichever rooms of `modeId` still have room. */
function fill(hub, modeId, n) {
  const seated = [];
  for (let i = 0; i < n; i++) {
    const room = [...hub.rooms.values()]
      .filter((r) => r.modeId === modeId && !r.isFull)
      .sort((a, b) => b.playerCount - a.playerCount)[0];
    if (!room) break;
    const p = new Player({ ws: null, name: `Filler${i}`, classId: 'triggerman' });
    room.add(p);
    hub.playersById.set(p.id, { player: p, room });
    seated.push(p);
  }
  return seated;
}

export default async function run() {
  suite('Rooms — the list scales with the crowd');

  const cfg = config.dynamicRooms;
  const previous = { ...cfg };
  Object.assign(cfg, { enabled: true, max: 20, headroom: 2, idleSec: 10, checkSec: 5 });

  const hub = new Hub(null);
  const floor = hub.rooms.size;
  const modeOf = (id) => [...hub.rooms.values()].filter((r) => r.modeId === id).length;

  check('the configured rooms are all up and none of them can be retired',
    floor === config.rooms.length && [...hub.rooms.values()].every((r) => r.permanent),
    `${floor} room(s)`);

  // Nobody is playing: an empty server must not invent rooms for itself.
  hub.balanceRooms(30);
  check('an empty server opens nothing', hub.rooms.size === floor, `${hub.rooms.size} room(s)`);

  /* ── Filling up ──────────────────────────────────────────────────────── */

  const ffaRooms = modeOf('ffa');
  const seats = ffaRooms * config.maxPlayersPerRoom;
  fill(hub, 'ffa', seats - 1);                 // one free seat left across FFA
  hub.balanceRooms(1);
  check('a mode down to its last seats gets another room',
    modeOf('ffa') === ffaRooms + 1, `${modeOf('ffa')} FFA room(s), was ${ffaRooms}`);

  const opened = [...hub.rooms.values()].find((r) => !r.permanent);
  check('the new room carries its own shareable code',
    !!opened && /^[A-Z]+:[A-Z0-9]{4}$/.test(opened.code)
    && [...hub.rooms.values()].filter((r) => r.code === opened.code).length === 1,
    opened?.code);
  check('and it is a different map from the ones already running',
    !!opened && [...hub.rooms.values()].filter((r) => r.mapId === opened.mapId).length >= 1,
    `${opened?.mapId} / ${opened?.modeId}`);

  // The fresh room is empty, so the mode now has a room's worth of headroom
  // again — which must be enough to stop it opening a third.
  const afterOne = hub.rooms.size;
  hub.balanceRooms(1);
  check('one new room is enough — the list does not run away',
    hub.rooms.size === afterOne, `${hub.rooms.size} room(s)`);

  /* ── A full server still seats people ────────────────────────────────── */

  const before = hub.rooms.size;
  for (const room of hub.rooms.values()) {
    if (room.mode.practice) continue;
    fill(hub, room.modeId, config.maxPlayersPerRoom);
  }
  const picked = hub.pickRoom(null);
  check('nobody is turned away while the list is allowed to grow',
    !!picked && !picked.isFull, picked ? `${picked.id} (${picked.playerCount}/8)` : 'no room');
  info(`${before} room(s) before the rush, ${hub.rooms.size} after`);

  /* ── Emptying out ────────────────────────────────────────────────────── */

  for (const id of [...hub.playersById.keys()]) hub.leave(id);
  check('everyone left', hub.humanCount === 0);

  hub.balanceRooms(cfg.idleSec - 1);
  check('a room is not retired the instant it empties',
    hub.rooms.size > floor, `${hub.rooms.size} room(s)`);

  hub.balanceRooms(cfg.idleSec + 1);
  check('and every surplus room is gone once the idle window passes',
    hub.rooms.size === floor, `${hub.rooms.size} room(s), floor ${floor}`);
  check('the floor survived it', [...hub.rooms.values()].every((r) => r.permanent));
  check('and the codes it freed went with it',
    hub.codes.size === hub.rooms.size, `${hub.codes.size} code(s) for ${hub.rooms.size} room(s)`);

  /* ── Switched off ────────────────────────────────────────────────────── */

  cfg.enabled = false;
  for (const room of hub.rooms.values()) {
    if (room.mode.practice) continue;
    fill(hub, room.modeId, config.maxPlayersPerRoom);
  }
  hub.balanceRooms(1);
  check('DYNAMIC_ROOMS=false pins the list exactly where it was',
    hub.rooms.size === floor, `${hub.rooms.size} room(s)`);
  check('and a full server turns a player away rather than overfilling a room',
    hub.pickRoom(null) === null);
  check('…while a watcher is still given something to watch',
    !!hub.pickRoom(null, { spectate: true }));

  for (const id of [...hub.playersById.keys()]) hub.leave(id);
  hub.stop();
  Object.assign(cfg, previous);
}
