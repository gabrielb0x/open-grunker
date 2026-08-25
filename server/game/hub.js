/**
 * Open Grunker — room hub.
 *
 * Owns every room and drives them from a single fixed-timestep loop, so the
 * process has one timer no matter how many matches are running.
 *
 * The room list is not fixed. `config.rooms` is the *floor* — one room per
 * flavour the server advertises, so a server browser is never blank and every
 * mode is always playable — and everything past it is opened and closed by
 * demand. A fixed list is wrong in both directions at once: on a quiet night it
 * scatters four players across eight empty matches, and on a busy one it turns
 * people away with "every room is full" while the machine sits idle.
 */
import * as K from '../../shared/constants.js';
import { Room, roomCode } from './room.js';
import { Player } from './player.js';
import { MAP_IDS } from '../../shared/maps.js';
import config from '../config.js';
import log from '../util/log.js';

const logger = log.child('hub');
const nowSec = () => Number(process.hrtime.bigint() / 1000n) / 1e6;

export class Hub {
  /** @param {object} db the database module (nullable for tests) */
  constructor(db = null) {
    this.db = db;
    this.rooms = new Map();
    this.playersById = new Map();          // playerId -> { player, room }
    this.running = false;
    this.stats = {
      ticks: 0, snapshots: 0, maxTickMs: 0, lastTickMs: 0, drops: 0,
      roomsOpened: 0, roomsClosed: 0, peakPlayers: 0, peakRooms: 0,
    };
    /** Every room code currently in use, so a new room never shadows an old one. */
    this.codes = new Set();
    /** Rooms in `config.rooms`, which are never retired however empty they get. */
    this.permanent = new Set();
    /** Per-mode counter behind the ids of demand-opened rooms. */
    this.spawnSeq = new Map();

    for (const spec of config.rooms) {
      const [mapId, modeId = 'ffa'] = spec.split(':');
      const room = this.openRoom({ id: `${mapId}-${modeId}`, mapId, modeId, permanent: true });
      if (room) this.permanent.add(room.id);
    }
    // No bots yet: every room starts dormant, and a dormant room is staffed by
    // nobody. `maintain()` fills them in as soon as somebody wakes one.
  }

  /* ── The room list ─────────────────────────────────────────────────────── */

  /**
   * Room codes are a hash of the room id, so a shared link survives a restart.
   * Two ids could collide in four characters; re-salt until they don't.
   */
  claimCode(id) {
    let salt = 0;
    let code = `${config.region}:${roomCode(id)}`;
    while (this.codes.has(code) && salt < 50) code = `${config.region}:${roomCode(id, ++salt)}`;
    this.codes.add(code);
    return code;
  }

  /** Builds a room and puts it on the list. Returns null if the id is taken. */
  openRoom({ id, mapId, modeId, permanent = false }) {
    if (this.rooms.has(id)) return null;
    const room = new Room({ id, mapId, modeId, hub: this });
    room.code = this.claimCode(id);
    room.permanent = permanent;
    room.emptySince = 0;
    this.rooms.set(id, room);
    this.stats.roomsOpened++;
    if (this.rooms.size > this.stats.peakRooms) this.stats.peakRooms = this.rooms.size;
    return room;
  }

  /**
   * Takes a room off the list.
   *
   * Only ever called on a room nobody is in — see `balanceRooms` — so there is
   * no seat to salvage and no socket to warn. The bots go first so the room's
   * own bookkeeping stays consistent on the way out.
   */
  closeRoom(room) {
    if (!this.rooms.has(room.id) || room.permanent) return false;
    room.fillBots(0);
    this.rooms.delete(room.id);
    this.codes.delete(room.code);
    this.stats.roomsClosed++;
    return true;
  }

  /**
   * Opens and closes rooms to match the crowd.
   *
   * One rule in each direction, and both are about *seats*, not players: a mode
   * whose free seats have fallen to `headroom` or fewer is about to turn a duo
   * away, so it gets another room; a surplus room that has been completely
   * empty for `idleSec` is costing a tick's worth of CPU for nobody, so it goes.
   * The idle window is deliberately longer than a map rotation and longer than
   * a reconnect, because a room that vanishes between two matches is a shared
   * link that stops working.
   */
  balanceRooms(dtSec = 5) {
    const cfg = config.dynamicRooms;
    if (!cfg.enabled) return;

    /** mode -> { free, players, rooms: Room[], dynamic: number } */
    const byMode = new Map();
    for (const room of this.rooms.values()) {
      if (room.mode.practice) continue;          // the range is one room, always
      let m = byMode.get(room.modeId);
      if (!m) byMode.set(room.modeId, (m = { free: 0, players: 0, rooms: [], dynamic: 0 }));
      m.rooms.push(room);
      m.players += room.playerCount;
      // A dormant room's seats count as free, because they are: walking into
      // one wakes it. Discounting them would make the room this pass just
      // opened invisible to the next pass, which is a server that opens a room
      // every five seconds for the same two players.
      m.free += Math.max(0, config.maxPlayersPerRoom - room.playerCount);
      if (!room.permanent) m.dynamic++;
    }

    // A room can never be needed by nobody, and headroom above one room's worth
    // of seats would ask for a room the room it just opened cannot satisfy —
    // which is a server that opens and closes rooms forever.
    const headroom = Math.max(0, Math.min(cfg.headroom, config.maxPlayersPerRoom - 1));

    /*
     * How many rooms this crowd is allowed to be spread across.
     *
     * The floor is never touched — every mode stays browsable — but the rooms
     * opened *by demand* are capped against the number of people actually here,
     * not against the ceiling. Without it a brief spike could leave a quiet
     * server carrying a dozen rooms for the length of the idle window, and a
     * room that opens for one arrival and empties again is a shared match code
     * that stops working. One extra room per full room's worth of players is
     * the most that can ever be justified.
     */
    const crowd = this.humanCount;
    const earned = Math.ceil(crowd / Math.max(1, config.maxPlayersPerRoom));
    const dynamicOpen = [...this.rooms.values()].filter((r) => !r.permanent).length;

    // ── Open ──
    for (const [modeId, m] of byMode) {
      if (this.rooms.size >= cfg.max) break;
      if (dynamicOpen >= earned) break;          // more rooms than there are people
      if (m.players === 0) continue;             // nobody is playing this mode
      if (m.free > headroom) continue;
      const room = this.openRoom({
        id: this.nextDynamicId(modeId),
        mapId: this.pickMapFor(m.rooms),
        modeId,
      });
      if (!room) continue;
      logger.info(`opened ${room.id} (${room.code}) — ${modeId} was down to ${m.free} free seat(s)`);
    }

    // ── Close ──
    for (const room of [...this.rooms.values()]) {
      if (room.permanent) continue;
      const occupied = room.playerCount > 0 || room.spectatorCount > 0;
      if (occupied) { room.emptySince = 0; continue; }
      room.emptySince += dtSec;
      if (room.emptySince < cfg.idleSec) continue;
      if (this.closeRoom(room)) logger.info(`closed ${room.id} (${room.code}) — empty for ${cfg.idleSec}s`);
    }
  }

  /** A stable, unique id for the next demand-opened room of a mode. */
  nextDynamicId(modeId) {
    let n = this.spawnSeq.get(modeId) ?? 1;
    let id;
    do { id = `${modeId}-x${n++}`; } while (this.rooms.has(id));
    this.spawnSeq.set(modeId, n);
    return id;
  }

  /**
   * The map for a new room: whichever one the mode is playing least.
   *
   * Opening a second Littletown next to a full Littletown is a worse answer
   * than opening a Shipyard — the seats are the point, but so is the reason
   * somebody clicked a different server.
   */
  pickMapFor(rooms) {
    const inUse = new Set(rooms.map((r) => r.mapId));
    const free = MAP_IDS.filter((id) => !inUse.has(id));
    const pool = free.length ? free : MAP_IDS;
    return pool[Math.floor(Math.random() * pool.length)] ?? 'littletown';
  }

  /** Finds a room by its id or by a shared match code (case-insensitive). */
  byCode(value) {
    if (!value) return null;
    if (this.rooms.has(value)) return this.rooms.get(value);
    const wanted = String(value).toUpperCase();
    for (const room of this.rooms.values()) {
      if (room.code === wanted || room.code.split(':')[1] === wanted) return room;
    }
    return null;
  }

  /* ── Loop ──────────────────────────────────────────────────────────────── */

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = nowSec();
    this.acc = 0;
    this.snapAcc = 0;
    this.timer = setInterval(() => this.loop(), Math.max(1, Math.round(1000 / K.TICK_RATE)));
    const every = Math.max(1, config.dynamicRooms.checkSec);
    this.housekeeping = setInterval(() => this.maintain(every), every * 1000);
    logger.info(`simulation running — ${this.rooms.size} room(s) @ ${K.TICK_RATE}Hz, snapshots @ ${K.SNAPSHOT_RATE}Hz`
      + (config.dynamicRooms.enabled ? `, scaling to ${config.dynamicRooms.max}` : ''));
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.housekeeping);
  }

  loop() {
    const t0 = nowSec();
    let frame = t0 - this.lastTime;
    this.lastTime = t0;
    if (frame > 0.25) frame = 0.25;              // never try to catch up more than 250 ms

    this.acc += frame;
    let steps = 0;
    while (this.acc >= K.TICK_DT && steps < 8) {
      for (const room of this.rooms.values()) room.tick(K.TICK_DT);
      this.acc -= K.TICK_DT;
      steps++;
      this.stats.ticks++;
    }
    if (steps === 8) { this.acc = 0; this.stats.drops++; }

    this.snapAcc += frame;
    if (this.snapAcc >= K.SNAPSHOT_DT) {
      this.snapAcc -= K.SNAPSHOT_DT;
      if (this.snapAcc > K.SNAPSHOT_DT) this.snapAcc = 0;
      for (const room of this.rooms.values()) room.sendSnapshots();
      this.stats.snapshots++;
    }

    const ms = (nowSec() - t0) * 1000;
    this.stats.lastTickMs = ms;
    if (ms > this.stats.maxTickMs) this.stats.maxTickMs = ms;
  }

  /** Every few seconds: resize the room list, top up bots, drop dead sockets. */
  maintain(dtSec = 5) {
    const nowMs = Date.now();
    this.balanceRooms(dtSec);
    for (const room of this.rooms.values()) {
      if (room.dormant) {
        // Asleep: no bots, no idle sweep, nothing. Waking it is somebody
        // walking in, and that happens in `Room.add`.
        if (room.botCount) room.fillBots(0);
        continue;
      }
      if (room.mode.practice) {
        // The range keeps its sparring partners as long as somebody is in it.
        const want = room.playerCount > 0 ? config.practiceBots : 0;
        if (room.botCount !== want) room.fillBots(want);
      } else if (config.botsEnabled) {
        // Fewer bots as real players arrive, so a busy room stays human.
        const want = Math.max(0, Math.min(config.botCount, config.botCount + 2 - room.playerCount));
        if (room.botCount !== want) room.fillBots(want);
      }
      // A copy: dropping an idle player mutates the map being walked.
      for (const p of [...room.players.values()]) {
        if (p.isBot || !p.ws) continue;
        if (nowMs - p.lastMessageAt > 45_000) {
          logger.info(`dropping idle player ${p.name} (${p.id})`);
          try { p.ws.close(4008, 'idle timeout'); } catch { /* already gone */ }
          this.leave(p.id);
        }
      }
    }
    const online = this.humanCount;
    if (online > this.stats.peakPlayers) this.stats.peakPlayers = online;
  }

  /* ── Membership ────────────────────────────────────────────────────────── */

  /**
   * Best room for a new arrival: the one they asked for by id or match code,
   * else the busiest room with space — landing next to people beats landing
   * alone. When every room is full and the list is allowed to grow, one is
   * opened rather than turning the arrival away.
   * A spectator can watch a full room; only seating checks capacity.
   */
  pickRoom(requested, { spectate = false } = {}) {
    const asked = this.byCode(requested);
    if (asked && (spectate || !asked.isFull)) return asked;

    let best = null;
    for (const room of this.rooms.values()) {
      if (room.isFull || room.mode.practice) continue;
      if (!best || room.playerCount > best.playerCount) best = room;
    }
    if (best) return best;

    // Nothing with a seat in it. Opening one here rather than at the next
    // housekeeping tick is what keeps "every room is full" off the screen of
    // somebody who arrived one second before the balancer would have run.
    if (config.dynamicRooms.enabled && this.rooms.size < config.dynamicRooms.max) {
      const modeId = config.rooms[0]?.split(':')[1] ?? 'ffa';
      const room = this.openRoom({
        id: this.nextDynamicId(modeId),
        mapId: this.pickMapFor([...this.rooms.values()]),
        modeId,
      });
      if (room) {
        logger.info(`opened ${room.id} (${room.code}) — every room was full`);
        return room;
      }
    }
    // Every seat is taken and the list may not grow. A watcher still gets a
    // room — watching costs no seat — but somebody asking for one gets null,
    // and the handshake answers with the "every room is full" screen rather
    // than quietly seating a ninth player in an eight-seat room.
    if (!spectate) return null;
    for (const room of this.rooms.values()) if (!room.mode.practice) return room;
    return this.rooms.values().next().value ?? null;
  }

  join({ ws, name, userId, level, classId, skin, verified, clan, clanVerified, role, mutedUntil,
    ip, roomId, spectate = false }) {
    const room = this.pickRoom(roomId, { spectate });
    if (!room) return null;
    const player = new Player({
      ws, name, userId, level, classId, skin, verified, clan, clanVerified, role, mutedUntil,
      ip, spectator: spectate,
    });
    room.add(player);
    this.playersById.set(player.id, { player, room });
    const online = this.humanCount;
    if (online > this.stats.peakPlayers) this.stats.peakPlayers = online;
    logger.info(spectate
      ? `${name} watching ${room.id} (${room.code})`
      : `${name} -> ${room.id} (${room.playerCount}/${config.maxPlayersPerRoom})`);
    return { player, room };
  }

  leave(playerId) {
    const entry = this.playersById.get(playerId);
    if (!entry) return;
    this.playersById.delete(playerId);
    entry.room.remove(playerId);
  }

  get(playerId) { return this.playersById.get(playerId); }

  /**
   * Every live connection belonging to an account and/or an address — what a
   * ban needs so it lands on the session that is already in a match.
   * @returns {Array<{player: Player, room: Room}>}
   */
  findConnections({ userId = null, ip = null } = {}) {
    const wanted = ip ? String(ip).replace(/^::ffff:/i, '').toLowerCase() : null;
    const out = [];
    for (const entry of this.playersById.values()) {
      const p = entry.player;
      if (userId && p.userId === userId) { out.push(entry); continue; }
      if (wanted && p.ip && p.ip === wanted) out.push(entry);
    }
    return out;
  }

  /**
   * Re-badges every live connection for an account whose clan just changed, and
   * refreshes the scoreboards that were drawing the old tag.
   *
   * Without this a player who joins or leaves a clan keeps wearing whatever tag
   * they had when they connected until they reconnect, which reads as the
   * feature not having worked.
   * @returns {number} connections re-badged
   */
  rebadge(userId, { clan = null, clanVerified = false } = {}) {
    let touched = 0;
    const rooms = new Set();
    for (const { player, room } of this.findConnections({ userId })) {
      if (!player.setClan(clan, clanVerified)) continue;
      touched++;
      rooms.add(room);
    }
    for (const room of rooms) room.pushScore();
    return touched;
  }

  list() { return [...this.rooms.values()].map((r) => r.info()); }

  get humanCount() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.playerCount;
    return n;
  }

  get watchingCount() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.spectatorCount;
    return n;
  }

  get botTotal() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.botCount;
    return n;
  }

  /** Rooms actually simulating. The rest are listed, joinable and asleep. */
  get liveRooms() {
    let n = 0;
    for (const r of this.rooms.values()) if (!r.dormant) n++;
    return n;
  }

  /** Free seats across every room that is not the practice range. */
  get freeSeats() {
    let n = 0;
    for (const r of this.rooms.values()) {
      if (r.mode.practice) continue;
      n += Math.max(0, config.maxPlayersPerRoom - r.playerCount);
    }
    return n;
  }

  health() {
    return {
      rooms: this.rooms.size,
      // Of those, the ones with somebody in them. A quiet server carries its
      // whole room list and simulates none of it.
      liveRooms: this.liveRooms,
      dynamicRooms: this.rooms.size - this.permanent.size,
      maxRooms: config.dynamicRooms.enabled ? config.dynamicRooms.max : this.rooms.size,
      players: this.humanCount,
      watching: this.watchingCount,
      bots: this.botTotal,
      freeSeats: this.freeSeats,
      ticks: this.stats.ticks,
      lastTickMs: Math.round(this.stats.lastTickMs * 100) / 100,
      maxTickMs: Math.round(this.stats.maxTickMs * 100) / 100,
      overloadDrops: this.stats.drops,
      roomsOpened: this.stats.roomsOpened,
      roomsClosed: this.stats.roomsClosed,
      peakPlayers: this.stats.peakPlayers,
      peakRooms: this.stats.peakRooms,
    };
  }
}

export default Hub;
