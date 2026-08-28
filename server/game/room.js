/**
 * Open Grunker — authoritative match room.
 *
 * One room owns one map, one match, and up to MAX_PLAYERS_PER_ROOM players.
 * It simulates movement at TICK_RATE, resolves every shot server-side with
 * lag compensation, and broadcasts snapshots at SNAPSHOT_RATE.
 */
import * as K from '../../shared/constants.js';
import { World, rayBox } from '../../shared/physics.js';
import { getMap, MAP_IDS, ALL_MAP_IDS } from '../../shared/maps.js';
import { step, lookDir, fallDamage, KEY } from '../../shared/movement.js';
import { shotDirections, shotSeed } from '../../shared/shot.js';
import { drawStamp, shotInterval, spreadFor, falloff, getClass, weaponById } from '../../shared/weapons.js';
import { Player } from './player.js';
import { BotBrain } from './bot.js';
import log from '../util/log.js';
import { reportStanding, repeatDenial } from '../util/reports.js';
import * as ac from './anticheat.js';
import config from '../config.js';

const logger = log.child('room');

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const CTRL = /[\x00-\x1f\x7f]/g;

/** Hitbox is a touch wider than the collision box, the way arena shooters do it. */
/**
 * Short, stable, shareable code for a room id — `burgtown-ffa` becomes `7K2Q`.
 * Derived from the id (FNV-1a) rather than randomised, so a link someone
 * shared still points at the same room after a restart.
 */
export function roomCode(id, salt = 0) {
  let h = 0x811c9dc5;
  for (const ch of `${id}#${salt}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no I/O/0/1
  let out = '';
  for (let i = 0; i < 4; i++) { out += ALPHABET[h % ALPHABET.length]; h = Math.floor(h / ALPHABET.length); }
  return out;
}

const HIT_RADIUS = 0.46;
const HEAD_RADIUS = 0.26;
/** How far off a struck surface a warhead actually goes off — see stepProjectiles. */
const BLAST_OFFSET = 0.12;
const MAX_INPUTS_PER_TICK = 3;
const MAX_QUEUED_INPUTS = 40;
const INPUT_STARVE_GRACE = 0.25;   // s before we simulate a silent client
/**
 * Input packets one connection may send per second.
 *
 * The client flushes at SNAPSHOT_RATE (30/s) plus one extra flush per shot, so
 * the fastest legitimate weapon emptying a magazine still lands well inside
 * this. Anything above it is a client producing ticks a second does not hold.
 */
const INPUT_PACKETS_PER_SEC = 90;
/** Shots in a row claiming sights the input stream never held, before it counts. */
const ADS_MISMATCH_RUN = 3;
/** Keys whose being held means somebody is at the keyboard. */
const ACTIVE_KEYS = KEY.FWD | KEY.BACK | KEY.LEFT | KEY.RIGHT
  | KEY.JUMP | KEY.CROUCH | KEY.FIRE | KEY.ADS;

export class Room {
  constructor({ id, mapId = 'littletown', modeId = 'ffa', hub = null, code = null, permanent = false }) {
    this.id = id;
    this.hub = hub;
    /** Set by the hub: a floor room is never retired, however empty it gets. */
    this.permanent = permanent;
    /** Seconds this room has been completely empty, counted by the balancer. */
    this.emptySince = 0;
    this.modeId = K.MODES[modeId] ? modeId : 'ffa';
    this.mode = K.MODES[this.modeId];
    this.players = new Map();
    this.projectiles = [];
    this.nextProjectileId = 1;
    this.now = 0;                       // seconds since room creation
    this.startedAtMs = Date.now();
    /** identity -> scorecard, so a rejoin or class change never wipes a score. */
    this.savedScores = new Map();
    this.matchNumber = 0;
    /** This match's chat, newest last, at most K.CHAT_HISTORY lines. */
    this.chat = [];
    /**
     * What this room has done since the sampler last looked.
     *
     * Rates are what a graph of a shooter is actually made of, and a row per
     * kill is a row per second per player that answers nothing a count does
     * not. So the high-frequency facts are counted here and drained into one
     * `metrics` sample per interval; only things that happen once — a match
     * ending, a level crossed — get an `events` row of their own.
     */
    this.counters = {
      kills: 0, headshots: 0, shots: 0, damage: 0, chat: 0,
      joins: 0, leaves: 0, matches: 0, deaths: 0,
    };
    this.code = code ?? `${config.region}:${roomCode(id)}`;
    /**
     * Membership figures, recomputed only when membership actually changes.
     *
     * `roster` is read once per snapshot and again on every scoreboard push,
     * and it used to spread the player map into a fresh array and filter it
     * every single time — twenty allocations a second per room before anybody
     * had done anything, and that was with a fixed room list. With the list
     * scaling to thirty-two it is the difference between the tick loop
     * noticing and not.
     */
    this._roster = [];
    this._counts = { players: 0, bots: 0, spectators: 0 };
    this._rosterDirty = true;
    /**
     * The nuke in the air, if there is one: `{ by, name, team, at }`.
     *
     * Exactly one per room at a time. A second launch during a countdown would
     * be two flashes and one match ending, so the arming check refuses it.
     */
    this.nuke = null;
    /** When the flash stops holding and the end card comes up. */
    this.nukeEndAt = 0;
    this.nukeStateAcc = 0;
    /** Wall clock of the last AFK sweep — it runs once a second, not per tick. */
    this.afkSweptAt = 0;
    /**
     * Asleep until somebody is in it.
     *
     * A room with nobody in it has nothing to simulate, nothing to broadcast
     * and no match worth recording — it used to run its clock anyway, rotate
     * maps at four-minute intervals and write a `matches` row every time, so a
     * server that nobody played on all night still filled the stats with
     * hundreds of matches that never happened. Eight rooms doing that is eight
     * tick loops burning CPU on an empty arena.
     *
     * A dormant room is still listed and still joinable: `wake()` runs on the
     * first human through the door and starts a fresh match for them.
     */
    this.dormant = true;
    this.loadMap(mapId);
    this.startMatch();
    logger.info(`room "${id}" (${this.code}) up — ${this.map.name} / ${this.mode.name} (idle)`);
  }

  /* ── Map & match lifecycle ─────────────────────────────────────────────── */

  loadMap(mapId) {
    this.mapId = ALL_MAP_IDS.includes(mapId) ? mapId : 'littletown';
    this.map = getMap(this.mapId);
    this.world = new World(this.map);
    this.buildObjectives();
  }

  /**
   * Domination points, taken from the map's own list. Every map declares three;
   * only the objective modes actually use them.
   */
  buildObjectives() {
    const list = this.mode.objectives ? (this.map.objectives ?? []) : [];
    this.objectives = list.map((o) => ({
      id: o.id, x: o.x, y: o.y, z: o.z,
      owner: K.TEAM.NONE,
      /** Progress toward `contender`, 0-1. */
      progress: 0,
      contender: K.TEAM.NONE,
      contested: false,
    }));
    this.domAcc = 0;
    this.objDirty = true;
  }

  startMatch() {
    this.state = 'live';
    this.matchStart = this.now;
    /** Wall clock, for the database row this match may or may not deserve. */
    this.matchStartedAt = Math.floor(Date.now() / 1000);
    this.matchEnd = this.now + this.mode.timeLimit;
    this.teamScore = { [K.TEAM.RED]: 0, [K.TEAM.BLUE]: 0 };
    /*
     * No row yet.
     *
     * The `matches` table used to get one the moment a room opened a match,
     * which meant every empty room wrote a row every four minutes for a match
     * with no players in it — most of the table, on a quiet server. The row is
     * now written at the *end*, and only when somebody was actually in it, so
     * "matches played" counts matches that were played.
     */
    this.matchDbId = null;
    this.matchNumber++;
    this.firstBloodTaken = false;
    this.savedScores.clear();               // a new match starts everyone at zero
    this.buildObjectives();
    this.voteOptions = null;
    this.nuke = null;
    this.nukeEndAt = 0;
    for (const p of this.roster) {
      p.score = Player.emptyScore();
      p.nukeArmed = false;
      p.lastKillAt = -999;
      p.lastKilledBy = 0;
      p.ggRung = 0;
      p.ggKills = 0;
      p.vote = null;
      p.weaponKills.clear();
      if (this.mode.gunGame) this.applyGunGameRung(p, true);
      this.respawn(p, true);
    }
    if (this.objectives.length) this.pushObjectives();
  }

  /* ── Gun Game ──────────────────────────────────────────────────────────── */

  /** Puts a player on the class their current rung calls for. */
  applyGunGameRung(player, silent = false) {
    const rung = Math.min(player.ggRung, K.GUN_GAME_LADDER.length - 1);
    const classId = K.GUN_GAME_LADDER[rung];
    if (player.classId !== classId) player.setClass(classId, true);
    player.pendingClass = null;
    if (silent) return;
    const w = player.weapon;
    this.sendTo(player, {
      o: K.S2C.MATCH, phase: 'classSet', classId, ammo: w.ammo, reserve: w.reserve, immediate: true,
    });
    this.sendTo(player, {
      o: K.S2C.GUNGAME, rung: player.ggRung, total: K.GUN_GAME_LADDER.length,
      classId, kills: player.ggKills, need: K.GUN_GAME_KILLS_PER_RUNG,
    });
    if (player.alive) this.broadcast({ o: K.S2C.JOIN, player: player.profile() }, player);
  }

  /** Credits a Gun Game kill and promotes when the rung is cleared. */
  gunGameKill(killer) {
    killer.ggKills++;
    if (killer.ggKills < K.GUN_GAME_KILLS_PER_RUNG) {
      this.sendTo(killer, {
        o: K.S2C.GUNGAME, rung: killer.ggRung, total: K.GUN_GAME_LADDER.length,
        classId: killer.classId, kills: killer.ggKills, need: K.GUN_GAME_KILLS_PER_RUNG,
      });
      return;
    }
    killer.ggKills = 0;
    killer.ggRung++;
    if (killer.ggRung >= K.GUN_GAME_LADDER.length) {
      // The ladder is finished: the match is over the moment it happens.
      killer.score.score += 500;
      this.pushSystemChat(`${killer.name} finished the ladder!`);
      this.endMatch('gungame');
      return;
    }
    killer.score.score += 40;
    this.pushSystemChat(`${killer.name} → ${getClass(K.GUN_GAME_LADDER[killer.ggRung]).name}`);
    this.applyGunGameRung(killer);
  }

  /* ── Domination ────────────────────────────────────────────────────────── */

  /**
   * Capture points tick toward whichever team is standing on them alone. A
   * contested point freezes rather than flipping, so a defender only has to
   * arrive — not out-shoot — to stall a capture.
   */
  stepObjectives(dt) {
    if (!this.objectives.length || this.state !== 'live') return;
    const r2sq = K.DOM_CAPTURE_RADIUS * K.DOM_CAPTURE_RADIUS;

    for (const obj of this.objectives) {
      let red = 0, blue = 0;
      for (const p of this.players.values()) {
        if (p.spectator || !p.alive) continue;
        const dx = p.state.x - obj.x, dz = p.state.z - obj.z, dy = p.state.y - obj.y;
        if (dx * dx + dz * dz > r2sq || Math.abs(dy) > 4) continue;
        if (p.team === K.TEAM.RED) red++;
        else if (p.team === K.TEAM.BLUE) blue++;
      }

      const before = obj.owner;
      obj.contested = red > 0 && blue > 0;
      if (obj.contested) continue;

      const holder = red > 0 ? K.TEAM.RED : blue > 0 ? K.TEAM.BLUE : K.TEAM.NONE;
      if (holder === K.TEAM.NONE) continue;
      if (holder === obj.owner) {
        if (obj.progress < 1 || obj.contender !== holder) {
          obj.contender = holder; obj.progress = 1; this.objDirty = true;
        }
        continue;
      }

      // More attackers capture faster, up to double speed.
      const rate = (1 + Math.min(2, Math.max(red, blue) - 1) * 0.5) / K.DOM_CAPTURE_TIME;
      if (obj.contender !== holder) { obj.contender = holder; obj.progress = 0; }
      obj.progress = Math.min(1, obj.progress + rate * dt);
      this.objDirty = true;

      if (obj.progress >= 1) {
        obj.owner = holder;
        this.objDirty = true;
        for (const p of this.players.values()) {
          if (p.spectator || !p.alive || p.team !== holder) continue;
          const dx = p.state.x - obj.x, dz = p.state.z - obj.z;
          if (dx * dx + dz * dz > r2sq) continue;
          p.score.captures++;
          this.award(p, [{ key: 'CAPTURE', points: K.DOM_CAPTURE_SCORE, label: `CAPTURED ${obj.id}` }]);
        }
        this.pushSystemChat(
          `${K.TEAM_NAMES[holder]} captured ${obj.id}${before !== K.TEAM.NONE ? ` from ${K.TEAM_NAMES[before]}` : ''}`);
      }
    }

    // Score ticks for every point a team is holding.
    this.domAcc += dt;
    if (this.domAcc >= K.DOM_TICK_INTERVAL) {
      this.domAcc -= K.DOM_TICK_INTERVAL;
      let red = 0, blue = 0;
      for (const obj of this.objectives) {
        if (obj.owner === K.TEAM.RED) red++;
        else if (obj.owner === K.TEAM.BLUE) blue++;
      }
      if (red) this.teamScore[K.TEAM.RED] += K.DOM_TICK_POINTS * red;
      if (blue) this.teamScore[K.TEAM.BLUE] += K.DOM_TICK_POINTS * blue;
      if (red || blue) { this.pushScore(); this.checkWinCondition(); }
    }

    this.objPushAcc = (this.objPushAcc ?? 0) + dt;
    if (this.objDirty && this.objPushAcc > 0.2) {
      this.objPushAcc = 0;
      this.objDirty = false;
      this.pushObjectives();
    }
  }

  pushObjectives() {
    if (!this.objectives.length) return;
    this.broadcast({
      o: K.S2C.OBJECTIVE,
      points: this.objectives.map((o) => ({
        id: o.id, x: o.x, y: o.y, z: o.z,
        owner: o.owner, progress: Math.round(o.progress * 100) / 100,
        contender: o.contender, contested: o.contested,
      })),
    });
  }

  /** Was this kill a defence of a point our team already holds? */
  isDefendKill(killer, victim) {
    if (!this.objectives.length || !killer) return false;
    const r2sq = (K.DOM_CAPTURE_RADIUS + 3) ** 2;
    for (const obj of this.objectives) {
      if (obj.owner !== killer.team) continue;
      const dx = victim.state.x - obj.x, dz = victim.state.z - obj.z;
      if (dx * dx + dz * dz <= r2sq) return true;
    }
    return false;
  }

  endMatch(reason = 'time') {
    if (this.state !== 'live') return;
    this.state = 'intermission';
    // A countdown outlives nothing: the clock running out mid-launch must not
    // leave a warning on screen through the whole end card.
    this.nukeEndAt = 0;
    if (this.nuke && reason !== 'nuke') this.cancelNuke('match over');
    // A copy: `roster` hands back the room's own array now, and sorting it in
    // place would leave the snapshot list ordered by score for the next match.
    const rows = [...this.roster].sort((a, b) => b.score.score - a.score.score || b.score.kills - a.score.kills);
    let winner;
    if (this.mode.teams) {
      const red = this.teamScore[K.TEAM.RED], blue = this.teamScore[K.TEAM.BLUE];
      winner = red === blue ? 'draw' : red > blue ? 'RED' : 'BLUE';
    } else if (this.mode.gunGame) {
      const best = [...rows].sort((a, b) => b.ggRung - a.ggRung || b.score.score - a.score.score)[0];
      winner = best?.name ?? null;
    } else {
      winner = rows[0]?.name ?? null;
    }

    // One winner test, shared by the board the players see and the rows that go
    // into the database — they used to disagree for FFA, so a scoreboard could
    // credit a win the stats table did not.
    const top = rows[0] ?? null;
    const won = (p) => (this.mode.teams
      ? (winner === 'RED' && p.team === K.TEAM.RED) || (winner === 'BLUE' && p.team === K.TEAM.BLUE)
      : !!top && top.id === p.id && winner !== null);

    const nextIn = K.INTERMISSION_TIME;
    // The clock has to exist before the vote quotes it, or the first vote of a
    // room's life advertises zero seconds left.
    this.intermissionUntil = this.now + nextIn;
    this.openVote();
    this.broadcast({
      o: K.S2C.MATCH, phase: 'end', reason, winner,
      map: this.mapId, mapName: this.map.name, mode: this.modeId, modeName: this.mode.name,
      duration: Math.round(this.now - this.matchStart),
      teamScore: this.mode.teams ? { red: this.teamScore[K.TEAM.RED], blue: this.teamScore[K.TEAM.BLUE] } : null,
      scoreboard: rows.map((p) => ({ ...p.scoreboardRow(), won: won(p), gr: K.grFromScore(p.score.score, won(p)) })),
      nextIn,
      vote: this.voteState(),
    });

    // The chat belonged to the match that just finished; nothing from it
    // carries into the next one.
    this.purgeChat();

    /*
     * Only a match somebody played is a match that happened.
     *
     * A dormant room never gets here, but a room that empties out mid-round
     * still finishes the round it was in the middle of, and a round with
     * nothing but bots left in it is not a record of anything: no row, no
     * counter, no journal entry, no payouts.
     */
    const humans = rows.filter((p) => !p.isBot);
    if (!humans.length) return;

    this.counters.matches++;
    this.logEvent(null, {
      kind: 'match.end',
      name: winner ?? null,
      value: Math.round(this.now - this.matchStart),
      detail: {
        reason, humans: humans.length, bots: rows.length - humans.length,
        accounts: humans.filter((p) => p.userId).length,
        topScore: Math.round(rows[0]?.score.score ?? 0),
      },
    });

    this.persistMatch(winner, rows, won);
  }

  /**
   * Writes the match to the database and pays everyone out.
   *
   * Every player is settled inside its own try/catch: one bad row (a closed
   * socket, a constraint, a challenge that will not claim) used to abort the
   * loop and cost *everybody else* their stats and GR for that match.
   */
  persistMatch(winner, rows, won) {
    const db = this.hub?.db;
    if (!db) return;
    const playedSec = Math.max(0, this.now - this.matchStart);

    // The row is written at the end rather than at the start, so an empty room
    // can never leave one behind. `matchStartedAt` is the real clock time the
    // match began, not the time this line runs.
    try {
      this.matchDbId = db.matches.start(this.id, this.modeId, this.mapId, this.matchStartedAt);
      db.matches.finish(this.matchDbId, winner);
    } catch (e) {
      this.matchDbId = null;
      logger.warn('match row failed:', e.message);
    }

    for (const p of rows) {
      try {
        this.persistPlayer(db, p, won(p), playedSec);
      } catch (e) {
        logger.warn(`persist failed for ${p.name}:`, e.message);
      }
    }
  }

  /** Stats, XP, GR, mastery and dailies for one player. */
  persistPlayer(db, p, won, playedSec) {
    const sc = p.score;
    let gr = K.grFromScore(sc.score, won);

    if (this.matchDbId) {
      db.matches.addPlayer(this.matchDbId, {
        userId: p.userId, name: p.name, team: p.team, classId: p.classId,
        kills: sc.kills, deaths: sc.deaths, score: Math.round(sc.score), gr, won,
      });
    }
    if (p.isBot) return;
    if (!p.userId) {
      // A guest earns nothing, which is exactly the fact worth stating. The
      // number is real — it is the match they just played, priced by the same
      // two functions an account is paid by — so the card can put a figure in
      // front of them instead of a slogan.
      const forfeit = K.guestForfeit(sc.score, won);
      if (forfeit.xp > 0) {
        this.sendTo(p, {
          o: K.S2C.MATCH, phase: 'guestReward',
          score: Math.round(sc.score), won,
          forfeit,
          signup: K.SIGNUP_REWARD,
        });
      }
      return;
    }

    db.stats.bump(p.userId, {
      kills: sc.kills, deaths: sc.deaths, assists: sc.assists,
      headshots: sc.headshots, shotsFired: sc.shotsFired, shotsHit: sc.shotsHit,
      damage: Math.round(sc.damage), wins: won ? 1 : 0, losses: won ? 0 : 1,
      matches: 1, bestStreak: sc.bestStreak, score: Math.round(sc.score), playtime: playedSec,
    });

    // The match pays back exactly what the scoreboard said it was worth: 3204
    // points is 3204 XP. Scoring already prices a headshot above a body shot
    // and a win above a loss, so a second formula on top of it could only
    // disagree with the number the player watched climb all match.
    let xp = K.xpFromScore(sc.score);

    // Weapon mastery, then the day's and the week's challenges, then whatever
    // lifetime thresholds this match just carried the account over. All of it
    // is pure progression: it pays XP and GR and never touches a number that
    // decides a fight.
    db.mastery.bump(p.userId, p.weaponKills);
    const finished = this.settleChallenges(db, p, won);
    for (const c of finished) { xp += c.xp; gr += c.gr; }
    /*
     * After `stats.bump` above, so the thousandth kill pays on the match that
     * landed it rather than on the one after it.
     *
     * In its own try/catch for the same reason every player is settled in one:
     * this is a bonus on top of a match, and a milestone table that will not
     * answer must cost the player their milestone, not the match they just
     * played. The whole payout used to be one block, so one bad row took
     * everything with it.
     */
    let passed = [];
    try {
      passed = this.settleMilestones(db, p);
    } catch (e) {
      logger.warn(`milestones failed for ${p.name}:`, e.message);
    }
    for (const m of passed) { xp += m.xp; gr += m.gr; }

    // Two bonuses that only exist to make tomorrow worth showing up for. Both
    // are claimed here rather than at login, so what they pay for is playing a
    // match, not opening the menu, and both are idempotent for the rest of the
    // day — a second match cannot claim either one twice.
    const day = K.dayIndex();
    const streak = db.users.checkInDay(p.userId, day) ?? { streak: 0, best: 0, fresh: false, xp: 0, gr: 0 };
    const firstWin = won ? db.users.claimFirstWin(p.userId, day) : { xp: 0, gr: 0, fresh: false };
    xp += streak.xp + firstWin.xp;
    gr += streak.gr + firstWin.gr;

    const prog = db.users.addProgress(p.userId, xp, gr);
    const levelledUp = !!prog?.leveledUp;
    const levelGr = prog?.bonusGr ?? 0;
    p.level = prog?.level ?? p.level;
    // A level is a set of gates, not a number on a card. Crossing CHAT_MIN_LEVEL
    // or REPORT_MIN_LEVEL has to reach the HUD in the same breath as the reward,
    // or the player is told they levelled up and then finds the chat still
    // locked until they reload the page.
    if (levelledUp) {
      this.sendChatState(p);
      this.sendReportState(p);
      this.pushScore();                    // the board carries the level too
      this.logEvent(db, {
        kind: 'level.up', userId: p.userId, name: p.name, value: prog.level,
        detail: { from: prog.level - prog.levelsGained, gained: prog.levelsGained, gr: levelGr },
      });
    }
    // `prog` carries the account *totals*; xp/gr here are what this match paid.
    // Spreading it last used to overwrite both, so the card showed a lifetime
    // XP figure as the match reward.
    this.sendTo(p, {
      o: K.S2C.MATCH, phase: 'reward',
      xp, gr, score: Math.round(sc.score), won,
      level: prog?.level ?? p.level,
      leveledUp: levelledUp,
      // Paid by addProgress the moment the level was crossed, and reported
      // apart from `gr` so the card can name what bought it.
      levelGr,
      levelsGained: prog?.levelsGained ?? 0,
      nextLevelXp: K.xpForLevel((prog?.level ?? p.level) + 1),
      levelXp: K.xpForLevel(prog?.level ?? p.level),
      totalXp: prog?.xp ?? null,
      totalGr: prog?.gr ?? null,
      challenges: finished.map((c) => ({ id: c.id, name: c.name, xp: c.xp, gr: c.gr })),
      // Listed apart from the challenges: a milestone is a career line, not a
      // daily, and the card says so rather than burying it among three dailies.
      milestones: passed.map((m) => ({ id: m.id, name: m.name, desc: m.desc, xp: m.xp, gr: m.gr })),
      mastery: [...p.weaponKills.entries()].map(([id, n]) => ({ id, kills: n })),
      streak: { days: streak.streak, best: streak.best, fresh: streak.fresh, xp: streak.xp, gr: streak.gr },
      // What tomorrow is worth, on the card at the moment somebody is deciding
      // whether to play one more or close the tab. The streak panel has always
      // known this; nothing ever said it where it mattered.
      tomorrow: streak.streak > 0 ? { day: streak.streak + 1, ...K.streakReward(streak.streak + 1) } : null,
      firstWin: firstWin.fresh ? { xp: firstWin.xp, gr: firstWin.gr } : null,
    });
  }

  /**
   * What this match contributed, in the units every challenge is counted in.
   *
   * One object, shared by the dailies and the weeklies, because a kill is a
   * kill on both boards and two functions that disagreed about that would be a
   * bug waiting for somebody to notice.
   */
  challengeSource(p, won) {
    const sc = p.score;
    return {
      kills: sc.kills, headshots: sc.headshots, assists: sc.assists,
      midairs: sc.midairs, noscopes: sc.noscopes, drifts: sc.drifts, melees: sc.melees,
      longshots: sc.longshots, score: Math.max(0, sc.score), damage: Math.round(sc.damage),
      matches: 1, wins: won ? 1 : 0,
      // A streak challenge is pass/fail per match rather than cumulative.
      bestStreak: 0,
    };
  }

  /**
   * Rolls the match into one period's challenges and returns what completed.
   *
   * Dailies and weeklies are the same machinery over the same table: only the
   * period number and the list differ. See `K.weeklyPeriod` for why a week's
   * number is pushed above a million.
   */
  settlePeriod(db, p, period, list, source, sc) {
    const before = new Map();
    for (const row of db.challenges.forUser(p.userId, period)) before.set(row.id, row);

    const deltas = {};
    for (const c of list) {
      if (before.get(c.id)?.claimed) continue;
      let d = source[c.stat] ?? 0;
      if (c.stat === 'bestStreak') d = sc.bestStreak >= c.goal ? c.goal : 0;
      if (d > 0) deltas[c.id] = d;
    }
    if (!Object.keys(deltas).length) return [];
    db.challenges.bump(p.userId, period, deltas);

    const done = [];
    for (const row of db.challenges.forUser(p.userId, period)) {
      const c = list.find((x) => x.id === row.id);
      if (!c || row.claimed || row.progress < c.goal) continue;
      if (db.challenges.claim(p.userId, period, c.id)) done.push(c);
    }
    return done;
  }

  /**
   * Both boards, in one call.
   *
   * Weeklies are what a daily cannot be: a goal that survives the night. A
   * daily is worth one evening and is gone whether or not it was finished,
   * which makes it useless to somebody who plays twice a week — the target
   * resets before they can reach it, so there is never anything to come back
   * *to*. A week's worth of progress is.
   */
  settleChallenges(db, p, won) {
    const day = K.dayIndex();
    const week = K.weekIndex();
    const source = this.challengeSource(p, won);
    return [
      ...this.settlePeriod(db, p, day, K.dailyChallenges(day), source, p.score),
      ...this.settlePeriod(db, p, K.weeklyPeriod(week), K.weeklyChallenges(week), source, p.score),
    ];
  }

  /**
   * Career milestones the account has just crossed.
   *
   * Read off the lifetime stats row *after* this match has been added to it, so
   * the thousandth kill pays on the match that landed it rather than the one
   * after. Each is claimed through a primary key rather than a check-then-write,
   * which is what stops two matches ending at the same instant paying the same
   * one twice.
   */
  settleMilestones(db, p) {
    const stats = db.stats.get?.(p.userId);
    if (!stats || !db.milestones) return [];
    const value = {
      kills: stats.kills, wins: stats.wins, headshots: stats.headshots,
      matches: stats.matches, bestStreak: stats.best_streak,
      damage: stats.damage_dealt, playtime: stats.playtime_sec,
    };
    const already = new Set(db.milestones.claimedFor(p.userId));
    const done = [];
    for (const m of K.MILESTONES) {
      if (already.has(m.id)) continue;
      if ((value[m.stat] ?? 0) < m.goal) continue;
      if (db.milestones.claim(p.userId, m.id)) done.push(m);
    }
    return done;
  }

  rotate() {
    this.loadMap(this.winningVote());
    this.startMatch();
    this.broadcast({
      o: K.S2C.MATCH, phase: 'start', mode: this.modeId,
      map: this.mapPayload(), endsIn: this.mode.timeLimit,
    });
    // Spectators are watching, not playing: spawning them would put a live body
    // in the world that nothing else in the room knows about — but their camera
    // still has to find somebody on the new map.
    for (const p of this.roster) this.respawn(p, true);
    for (const p of this.players.values()) if (p.spectator) this.focusSpectator(p);
    logger.info(`room "${this.id}" rotated to ${this.map.name}`);
  }

  /**
   * What a joining client is told about the level.
   *
   * Every map in `shared/maps.js` is built from the same module the browser
   * already loaded, so for those we send the id and nothing else and let the
   * client build the geometry itself. That matters more than it used to: a
   * dressed town map is well over a thousand boxes, and shipping it as JSON on
   * every join and every rotation was a six-figure payload for data the client
   * could reproduce exactly.
   *
   * `objectives` and `targets` still come from here, because which of them are
   * live is the *mode's* business, not the map's. Anything not in the shared
   * registry — a server running its own level — falls back to sending the box
   * list in full.
   */
  mapPayload() {
    const builtin = ALL_MAP_IDS.includes(this.map.id);
    return {
      id: this.map.id, name: this.map.name, description: this.map.description, size: this.map.size,
      builtin,
      ...(builtin ? {} : {
        sky: this.map.sky, fog: this.map.fog, sun: this.map.sun,
        ambient: this.map.ambient, ground: this.map.ground, boxes: this.map.boxes,
      }),
      objectives: this.mode.objectives ? (this.map.objectives ?? []) : [],
      targets: this.map.targets ?? [],
    };
  }

  /* ── Map voting ────────────────────────────────────────────────────────── */

  /**
   * Offers three maps at the end of a match. The current one is never a
   * candidate, so a room always moves on even when nobody votes.
   */
  openVote() {
    const pool = MAP_IDS.filter((id) => id !== this.mapId);
    const options = [];
    // Deterministic per match number so a reconnecting client sees the same list.
    let h = (this.matchNumber * 2654435761) >>> 0;
    while (options.length < Math.min(K.VOTE_OPTIONS, pool.length)) {
      h = (Math.imul(h ^ (h >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0;
      const pick = pool[h % pool.length];
      if (!options.includes(pick)) options.push(pick);
    }
    this.voteOptions = options;
    for (const p of this.players.values()) p.vote = null;
    this.broadcast({ o: K.S2C.VOTE, ...this.voteState() });
  }

  voteState() {
    if (!this.voteOptions) return null;
    const tally = {};
    for (const id of this.voteOptions) tally[id] = 0;
    for (const p of this.players.values()) {
      if (p.vote && tally[p.vote] !== undefined) tally[p.vote]++;
    }
    return {
      options: this.voteOptions.map((id) => ({ id, name: getMap(id).name })),
      tally,
      endsIn: Math.max(0, Math.round((this.intermissionUntil ?? this.now) - this.now)),
    };
  }

  onVote(player, msg) {
    if (!this.voteOptions || this.state !== 'intermission') return;
    const id = String(msg.m ?? '');
    if (!this.voteOptions.includes(id)) return;
    if (player.vote === id) return;
    player.vote = id;
    this.broadcast({ o: K.S2C.VOTE, ...this.voteState() });
  }

  /** The map the room rotates to: the vote leader, else the next in rotation. */
  winningVote() {
    const fallback = MAP_IDS[(MAP_IDS.indexOf(this.mapId) + 1) % MAP_IDS.length];
    if (!this.voteOptions) return fallback;
    const tally = this.voteState().tally;
    let best = null, bestN = 0;
    for (const [id, n] of Object.entries(tally)) {
      if (n > bestN) { bestN = n; best = id; }
    }
    return bestN > 0 ? best : fallback;
  }

  /* ── Membership ────────────────────────────────────────────────────────── */

  /**
   * Marks the cached roster and counts stale.
   *
   * Called from everywhere membership *or* the spectator flag changes — a seat
   * taken, a body given up for a camera, a bot topped up. The flag is the whole
   * contract: nothing else may write `players` or `spectator` without it.
   */
  invalidateRoster() { this._rosterDirty = true; }

  _refreshRoster() {
    const roster = this._roster;
    roster.length = 0;
    let bots = 0, spectators = 0, players = 0;
    for (const p of this.players.values()) {
      if (p.spectator) { spectators++; continue; }
      roster.push(p);
      if (p.isBot) bots++;
      else players++;
    }
    this._counts.players = players;
    this._counts.bots = bots;
    this._counts.spectators = spectators;
    this._rosterDirty = false;
  }

  /** Humans actually playing. Spectators watching from the menu don't count. */
  get playerCount() { if (this._rosterDirty) this._refreshRoster(); return this._counts.players; }
  /**
   * Everybody in the room who is not a bot — seated or watching.
   *
   * This, and not `playerCount`, is what decides whether the room runs: a
   * spectator is a person looking at the arena, and an arena that stopped
   * moving underneath them would be a bug rather than a saving.
   */
  get humanCount() {
    if (this._rosterDirty) this._refreshRoster();
    return this._counts.players + this._counts.spectators;
  }
  get botCount() { if (this._rosterDirty) this._refreshRoster(); return this._counts.bots; }
  get spectatorCount() { if (this._rosterDirty) this._refreshRoster(); return this._counts.spectators; }
  get isFull() { return this.playerCount >= config.maxPlayersPerRoom; }

  /**
   * Everyone taking part — the scoreboard, the snapshot list, the win check.
   *
   * The array is the room's own and is rebuilt in place; callers that sort or
   * keep it must copy first. `endMatch` does, which is why it says so.
   */
  get roster() { if (this._rosterDirty) this._refreshRoster(); return this._roster; }

  /* ── Sleeping and waking ───────────────────────────────────────────────
     A room only simulates while somebody is in it. Everything below is about
     the two moments that changes: the first person through the door, and the
     last one out. ─────────────────────────────────────────────────────── */

  /**
   * Somebody arrived: start a match for them.
   *
   * Whatever clock the room was carrying when it went to sleep is thrown away.
   * Handing an arrival forty seconds of a match that nobody played is worse
   * than handing them a fresh one, and a stale intermission would sit them in
   * front of an end card for a match that never happened.
   */
  wake() {
    if (!this.dormant) return;
    this.dormant = false;
    this.savedScores.clear();
    this.startMatch();
    // Staffed here rather than at the next housekeeping pass: bots exist so
    // that somebody walking into a quiet room has something to shoot at, and
    // five seconds of empty arena is exactly the first impression they are for.
    if (this.mode.practice) this.fillBots(config.practiceBots);
    else if (config.botsEnabled) this.fillBots(config.botCount);
    logger.info(`room "${this.id}" (${this.code}) woke up`);
  }

  /**
   * The last person left: stop.
   *
   * The match in progress is abandoned rather than ended. It has no row to
   * close — rows are written by `persistMatch`, at the end, only for matches
   * somebody played — and nobody is left to pay, because a player's scorecard
   * is parked by `remove` the moment they go.
   */
  sleep() {
    if (this.dormant) return;
    this.dormant = true;
    this.fillBots(0);
    this.nuke = null;
    this.nukeEndAt = 0;
    this.projectiles.length = 0;
    this.purgeChat();
    logger.info(`room "${this.id}" (${this.code}) went idle — nobody left in it`);
  }

  add(player) {
    this.players.set(player.id, player);
    this.invalidateRoster();
    // Before anything else: a dormant room has a stale clock and a stale
    // scoreboard, and seating somebody into either would show them a match
    // that was over before they arrived.
    if (!player.isBot) this.wake();
    // A spectator is just a socket watching the map from the menu: no spawn,
    // no announcement, invisible to everyone in the match.
    if (player.spectator) return player;
    this.seat(player);
    return player;
  }

  /** Puts a player into the match proper, restoring any parked scorecard. */
  seat(player) {
    player.spectator = false;
    this.invalidateRoster();
    player.team = this.mode.teams ? this.pickTeam() : K.TEAM.NONE;
    // Rejoining mid-match picks the scorecard back up where it was left.
    const saved = player.isBot ? null : this.savedScores.get(player.identity);
    if (saved) {
      player.score = saved.score;
      player.team = this.mode.teams ? saved.team : K.TEAM.NONE;
      player.ggRung = saved.ggRung ?? 0;
      player.ggKills = saved.ggKills ?? 0;
      this.savedScores.delete(player.identity);
    }
    if (this.mode.gunGame) this.applyGunGameRung(player, true);
    this.respawn(player, true);
    this.broadcast({ o: K.S2C.JOIN, player: player.profile() }, player);
    if (!player.isBot) {
      this.counters.joins++;
      this.pushSystemChat(`${player.name} joined`);
      this.logEvent(null, {
        kind: 'player.join', userId: player.userId ?? null, name: player.name,
        detail: { guest: !player.userId, level: player.level },
      });
    }
    this.sendChatState(player);
    this.sendReportState(player);
    this.pushScore();
    return player;
  }

  /** A spectator pressing PLAY. */
  onPlayRequest(player) {
    if (!player.spectator) return;
    if (this.isFull) {
      this.sendTo(player, { o: K.S2C.ERROR, code: 'room_full', message: 'this match is full — try another server' });
      return;
    }
    // Asking to play is the plainest possible way of saying you have stopped
    // watching; leaving the switch on would put the seat straight back.
    player.wantsSpectate = false;
    this.seat(player);
    this.sendTo(player, {
      o: K.S2C.MATCH, phase: 'joined', classId: player.classId,
      you: player.profile(), scoreboard: this.roster.map((p) => p.scoreboardRow()),
    });
  }

  /* ── Spectating ────────────────────────────────────────────────────────── */

  /**
   * The spectator switch, flipped from the menu.
   *
   * Turning it on takes effect at the next death, or straight away when there
   * is no body to take out of the world — which is the whole of the rule the
   * player is shown. Turning it off puts them back in the match immediately,
   * because a watcher asking to play has nothing to wait for.
   */
  onSpectateMode(player, msg) {
    const want = !!msg.v;
    if (player.isBot) return;
    const chose = player.wantsSpectate;
    player.wantsSpectate = want;

    if (want) {
      // Alive, mid-match: the switch is armed and the next death honours it.
      // A body cannot leave the world in front of the people shooting at it.
      if (player.alive && !player.spectator && this.state === 'live') {
        this.sendTo(player, { o: K.S2C.MATCH, phase: 'specMode', on: true, queued: true });
        return;
      }
      // Nothing standing anywhere: dead, between rounds, or watching the
      // menu's backdrop. All three are "not spawned", so it lands now.
      this.enterSpectate(player);
      return;
    }

    // Switching it off. Someone who never switched it on is a socket watching
    // the menu, and dropping it into a match would be a seat nobody asked for.
    if (!player.spectator || !chose) {
      this.sendTo(player, { o: K.S2C.MATCH, phase: 'specMode', on: false, queued: false });
      return;
    }
    // …and someone who arrived here from the menu goes back to the menu, not
    // into the match: they still have not pressed PLAY.
    if (!player.specFromSeat) {
      player.specTarget = 0;
      this.sendTo(player, { o: K.S2C.MATCH, phase: 'specMode', on: false, queued: false, menu: true });
      return;
    }
    if (this.isFull) {
      this.sendTo(player, {
        o: K.S2C.ERROR, code: 'room_full',
        message: 'this match filled up while you were watching — try another server',
      });
      return;
    }
    this.seat(player);
    this.sendTo(player, {
      o: K.S2C.MATCH, phase: 'joined', classId: player.classId,
      you: player.profile(), scoreboard: this.roster.map((p) => p.scoreboardRow()),
    });
  }

  /**
   * Takes a seated player out of the match and hands them a camera.
   *
   * The scorecard is parked exactly as a disconnect parks it, so watching a
   * round out and then sitting back down does not cost anybody their match.
   */
  enterSpectate(player) {
    if (this.nuke && this.nuke.by === player.id) this.cancelNuke('the caller left the match');
    // Whether there was a seat to give up decides where turning the switch back
    // off puts them: into the match they left, or back to the menu they were
    // watching from.
    const hadSeat = !player.spectator;
    player.specFromSeat = hadSeat;

    if (hadSeat) {
      player.alive = false;
      player.spectator = true;
      this.invalidateRoster();
      if (!player.isBot && this.state === 'live') {
        this.savedScores.set(player.identity, {
          score: player.score, team: player.team, at: this.now,
          ggRung: player.ggRung, ggKills: player.ggKills,
        });
      }
      // To everybody else this is simply someone leaving: the roster, the
      // scoreboard and the snapshot list all key off `spectator`.
      this.broadcast({ o: K.S2C.LEAVE, id: player.id }, player);
      this.pushSystemChat(`${player.name} is spectating`);
      this.pushScore();
      // Chat and reporting are both seat-only; say so rather than letting the
      // player find a dead key.
      this.sendChatState(player);
      this.sendReportState(player);
    }

    const target = this.pickSpectateTarget(player);
    this.sendTo(player, {
      o: K.S2C.MATCH, phase: 'specMode', on: true, queued: false,
      targetId: target?.id ?? 0, name: target?.name ?? null,
      scoreboard: this.roster.map((p) => p.scoreboardRow()),
    });
  }

  /** Whoever is worth watching right now — the leader, failing that anyone alive. */
  pickSpectateTarget(player) {
    const live = this.roster.filter((p) => p.alive);
    if (!live.length) { player.specTarget = 0; return null; }
    const best = live.reduce((a, b) => ((b.score?.score ?? 0) > (a.score?.score ?? 0) ? b : a));
    player.specTarget = best.id;
    return best;
  }

  /**
   * Moves every camera that was pointed at `goneId` somewhere else.
   *
   * Called when the watched player dies or leaves. Without it a spectator is
   * left staring at a body that is no longer there and has to press a key to
   * find that out — which is precisely the moment they are least likely to be
   * pressing keys.
   */
  retargetSpectators(goneId) {
    for (const p of this.players.values()) {
      if (p.spectator && p.specTarget === goneId) this.focusSpectator(p);
    }
  }

  /** Points one watcher at whoever is worth watching, and tells them who. */
  focusSpectator(player) {
    const next = this.pickSpectateTarget(player);
    this.sendTo(player, {
      o: K.S2C.MATCH, phase: 'spectate',
      targetId: next?.id ?? 0, name: next?.name ?? null,
    });
    return next;
  }

  remove(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (this.nuke && this.nuke.by === playerId) this.cancelNuke('the caller left');
    this.players.delete(playerId);
    this.invalidateRoster();
    if (p.spectator) {                          // never joined the match
      // …but a watcher is still a person in the room, and the last one out
      // turns the lights off exactly like the last player does.
      if (!p.isBot && this.humanCount === 0) this.sleep();
      return;
    }
    // Park the scorecard: a disconnect or a trip through the menu must not
    // cost anyone the match they are in the middle of.
    if (!p.isBot && this.state === 'live') {
      this.savedScores.set(p.identity, {
        score: p.score, team: p.team, at: this.now, ggRung: p.ggRung, ggKills: p.ggKills,
      });
    }
    this.broadcast({ o: K.S2C.LEAVE, id: playerId });
    this.retargetSpectators(playerId);
    if (!p.isBot) {
      this.counters.leaves++;
      this.pushSystemChat(`${p.name} left`);
      if (this.humanCount === 0) this.sleep();
    }
  }

  pickTeam() {
    let red = 0, blue = 0;
    for (const p of this.players.values()) {
      if (p.team === K.TEAM.RED) red++;
      else if (p.team === K.TEAM.BLUE) blue++;
    }
    if (red === blue) return Math.random() < 0.5 ? K.TEAM.RED : K.TEAM.BLUE;
    return red < blue ? K.TEAM.RED : K.TEAM.BLUE;
  }

  /* ── Spawning ──────────────────────────────────────────────────────────── */

  spawnPoints(team) {
    const s = this.map.spawns;
    if (this.mode.teams) {
      if (team === K.TEAM.RED && s.red?.length) return s.red;
      if (team === K.TEAM.BLUE && s.blue?.length) return s.blue;
    }
    return s.ffa;
  }

  /** Picks the spawn point that is furthest from — and unseen by — live enemies. */
  chooseSpawn(player) {
    const points = this.spawnPoints(player.team);
    const enemies = [...this.players.values()].filter(
      (p) => p !== player && p.alive && (!this.mode.teams || p.team !== player.team));

    let best = null, bestScore = -Infinity;
    for (const pt of points) {
      const [x, y, z] = pt;
      let occupied = false;
      for (const other of this.players.values()) {
        if (other === player || !other.alive) continue;
        if (Math.abs(other.state.x - x) < 1.2 && Math.abs(other.state.z - z) < 1.2
            && Math.abs(other.state.y - y) < 2) { occupied = true; break; }
      }
      if (occupied) continue;

      let nearest = Infinity, seen = false;
      for (const e of enemies) {
        const d = Math.hypot(e.state.x - x, e.state.y - y, e.state.z - z);
        if (d < nearest) nearest = d;
        if (d < 45 && this.world.lineOfSight(x, y + 1.5, z, e.state.x, e.state.y + 1.4, e.state.z)) seen = true;
      }
      const score = (nearest === Infinity ? 200 : nearest) - (seen ? 90 : 0) + Math.random() * 12;
      if (score > bestScore) { bestScore = score; best = pt; }
    }
    return best ?? points[Math.floor(Math.random() * points.length)] ?? [0, 4, 0, 0];
  }

  respawn(player, immediate = false) {
    const [x, y, z, yaw] = this.chooseSpawn(player);
    player.spawnAt(x, y + 0.05, z, yaw, this.now);
    this.sendTo(player, {
      o: K.S2C.SPAWN, x: r2(x), y: r2(y + 0.05), z: r2(z), yaw: r2(yaw),
      health: K.MAX_HEALTH, classId: player.classId,
      ammo: player.weapon.ammo, reserve: player.weapon.reserve, immediate,
    });
  }

  /* ── Networking ────────────────────────────────────────────────────────── */

  sendTo(player, msg) {
    if (player.isBot || !player.ws || player.ws.readyState !== 1) return;
    try { player.ws.send(JSON.stringify(msg)); } catch { /* socket died mid-send */ }
  }

  broadcast(msg, except = null) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p === except || p.isBot || !p.ws || p.ws.readyState !== 1) continue;
      try { p.ws.send(data); } catch { /* socket died mid-send */ }
    }
  }

  /** Broadcast to everyone within `radius` of a point — cheap interest management. */
  broadcastNear(msg, x, y, z, radius = 160, except = null) {
    const r = radius * radius;
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p === except || p.isBot || !p.ws || p.ws.readyState !== 1) continue;
      const dx = p.state.x - x, dy = p.state.y - y, dz = p.state.z - z;
      if (dx * dx + dy * dy + dz * dz > r) continue;
      try { p.ws.send(data); } catch { /* socket died mid-send */ }
    }
  }

  /* ── Telemetry ─────────────────────────────────────────────────────────── */

  /**
   * One line in the `events` table, never at the cost of the match.
   *
   * Everything about telemetry is best-effort by construction: a database that
   * refuses a write must not take a firefight down with it, and there is no
   * answer worth having in the STATS tab that is worth one dropped snapshot.
   */
  logEvent(db, payload) {
    const store = db ?? this.hub?.db;
    if (!store?.events) return;
    try {
      store.events.add({ room: this.code, map: this.mapId, mode: this.modeId, ...payload });
    } catch (e) {
      logger.debug('event write failed:', e.message);
    }
  }

  /** Hands the accumulated counters to the sampler and starts the next window. */
  drainCounters() {
    const out = this.counters;
    this.counters = {
      kills: 0, headshots: 0, shots: 0, damage: 0, chat: 0,
      joins: 0, leaves: 0, matches: 0, deaths: 0,
    };
    return out;
  }

  /* ── Chat ──────────────────────────────────────────────────────────────── */

  /**
   * Appends a line to this match's chat and sends it to the room.
   *
   * The log belongs to the match, not to the server: it holds the last
   * `CHAT_HISTORY` lines, anyone arriving mid-match is handed them, and the
   * whole thing is dropped when the match ends. `keep: false` broadcasts
   * without storing — live match chatter (joins, captures, ladder promotions)
   * means nothing replayed twenty minutes later, so it is not replayed.
   */
  pushChat(entry, keep = true) {
    const line = { ...entry, o: K.S2C.CHAT, at: Date.now() };
    if (keep) {
      this.chat.push(line);
      // A ring rather than a hard stop: the fifty-first message pushes the
      // first off the end instead of silencing the room for the rest of the match.
      if (this.chat.length > K.CHAT_HISTORY) this.chat.splice(0, this.chat.length - K.CHAT_HISTORY);
    }
    this.broadcast(line);
    return line;
  }

  /**
   * A system line in everyone's chat. `kind` lets the client colour it — 'ban'
   * renders red, so a moderation event is impossible to miss mid-match.
   */
  pushSystemChat(text, kind = null, keep = false) {
    return this.pushChat({ system: true, text, kind }, keep);
  }

  /** Drops the match's chat and tells every client to clear its log. */
  purgeChat() {
    this.chat.length = 0;
    this.broadcast({ o: K.S2C.CHAT, purge: true });
  }

  /**
   * Why this player may not write into the chat, or null when they may.
   *
   * Writing needs an account at `CHAT_MIN_LEVEL` or above. A guest name costs
   * nothing to make, so gating on one is what keeps the chat from being a free
   * megaphone; reading it is open to everyone.
   */
  chatDenial(player) {
    if (player.isBot) return 'bots do not talk';
    if (player.spectator) return 'take a seat in the match to chat';
    if (!player.userId) return 'sign in to use the chat';
    if (player.level < K.CHAT_MIN_LEVEL) return `reach level ${K.CHAT_MIN_LEVEL} to use the chat`;
    if (player.muted) return `you are muted ${K.muteUntilText(player.mutedUntil)}`;
    return null;
  }

  /** This match's chat as a new arrival receives it: the log plus their standing. */
  chatPayload(player) {
    const reason = this.chatDenial(player);
    return {
      history: this.chat,
      canSend: !reason,
      reason,
      mutedUntil: player.mutedUntil ?? 0,
      minLevel: K.CHAT_MIN_LEVEL,
      max: K.CHAT_HISTORY,
    };
  }

  /** Tells one player whether they may write, and why not when they may not. */
  sendChatState(player, reason = undefined) {
    const why = reason === undefined ? this.chatDenial(player) : reason;
    this.sendTo(player, {
      o: K.S2C.CHATSTATE,
      canSend: !why,
      reason: why ?? null,
      mutedUntil: player.mutedUntil ?? 0,
    });
  }

  /* ── Reporting ─────────────────────────────────────────────────────────── */

  /**
   * Why this player may not report anybody, or null when they may.
   *
   * Deliberately the same shape as `chatDenial`, and for the same reason: the
   * scoreboard needs to draw a button that says why it is off. Everything past
   * the obvious cases is `reportStanding`, which is the single place the
   * ceilings live — so the greyed-out button and the server's refusal always
   * give the identical sentence.
   */
  reportDenial(player) {
    if (!this.reportsEnabled) return 'reporting is switched off on this server';
    if (player.isBot) return 'bots do not report';
    if (player.spectator) return 'take a seat in the match to report a player';
    if (!player.userId) return 'sign in to report a player';
    try {
      const standing = reportStanding(this.hub.db, { id: player.userId, level: player.level });
      return standing.allowed ? null : (standing.reason ?? 'you cannot report right now');
    } catch (e) {
      logger.warn('report standing failed:', e.message);
      return 'reporting is unavailable right now';
    }
  }

  /** Does this server have reporting at all? The one refusal nobody can clear. */
  get reportsEnabled() { return !!(config.reports.enabled && this.hub?.db?.reports); }

  /** Whether this player may report, and why not — the scoreboard's copy of it. */
  reportPayload(player) {
    const reason = this.reportDenial(player);
    return {
      enabled: this.reportsEnabled,
      canReport: !reason,
      reason,
      minLevel: config.reports.minLevel,
    };
  }

  /** Pushes that standing after anything that could have changed it. */
  sendReportState(player, reason = undefined) {
    const why = reason === undefined ? this.reportDenial(player) : reason;
    this.sendTo(player, {
      o: K.S2C.REPORTSTATE, enabled: this.reportsEnabled, canReport: !why, reason: why ?? null,
    });
  }

  /**
   * Mutes (or, with `until: 0`, unmutes) a player.
   *
   * The database row is what survives a reconnect; the live connections are
   * what make the mute land in the match it was issued in rather than on the
   * next login. A mute follows the account, so every room it is playing in is
   * updated and told.
   * @returns {number} how many live connections it landed on
   */
  applyMute(target, { until, by = 'a moderator', reason = null, persist = true }) {
    const db = this.hub?.db;
    if (persist && target.userId && db?.chatBans) {
      try {
        if (until === 0) db.chatBans.remove(target.userId);
        else db.chatBans.set({ userId: target.userId, until, reason, actor: by, username: target.name });
      } catch (e) {
        logger.warn('chat ban write failed:', e.message);
      }
    }

    const live = target.userId ? (this.hub?.findConnections?.({ userId: target.userId }) ?? []) : [];
    const touched = live.length ? live : [{ player: target, room: this }];
    const text = until === 0
      ? `${target.name} can chat again`
      : `${target.name} was muted ${K.muteUntilText(until)} by ${by}${reason ? ` \u2014 ${reason}` : ''}`;

    const rooms = new Set();
    for (const { player, room } of touched) {
      player.mutedUntil = until;
      (room ?? this).sendChatState(player);
      rooms.add(room ?? this);
    }
    for (const room of rooms) {
      room.pushSystemChat(text, until === 0 ? 'notice' : 'mute', true);
      room.pushScore();                    // the board carries a MUTED chip
    }
    return touched.length;
  }

  /**
   * Blocks (or, with `until: 0`, unblocks) one account's REPORT button.
   *
   * Same shape as `applyMute`, and same reasoning: the database row survives a
   * reconnect, the live connections are what make the decision land in the
   * match it was issued in. Nothing is announced to the room — a report is
   * private in both directions, so losing the button is private too.
   * @returns {number} how many live connections it landed on
   */
  applyReportBan(target, { until, by = 'a moderator', reason = null, persist = true }) {
    const db = this.hub?.db;
    if (persist && target.userId && db?.reportBans) {
      try {
        if (until === 0) db.reportBans.remove(target.userId);
        else db.reportBans.set({ userId: target.userId, until, reason, actor: by, username: target.name });
      } catch (e) {
        logger.warn('report ban write failed:', e.message);
      }
    }

    const live = target.userId ? (this.hub?.findConnections?.({ userId: target.userId }) ?? []) : [];
    const touched = live.length ? live : [{ player: target, room: this }];
    for (const { player, room } of touched) (room ?? this).sendReportState(player);
    // Told privately, once, so a player who reaches for the button already
    // knows why it is grey rather than discovering it mid-match.
    const text = until === 0
      ? 'You can file reports again.'
      : `Reporting has been switched off for your account${reason ? ` \u2014 ${reason}` : ''}.`;
    for (const { player, room } of touched) {
      (room ?? this).sendTo(player, { o: K.S2C.CHAT, system: true, kind: 'notice', text });
    }
    return touched.length;
  }

  /**
   * Lands a ban on someone who is already connected: the room is told in red,
   * the player gets the ban screen, and the socket goes shortly after so the
   * screen has time to arrive.
   * @param {Player} player
   * @param {{chat: ?string, payload: object}} notice
   */
  applyBan(player, { chat = null, payload }) {
    if (chat && !player.spectator) this.pushSystemChat(chat, 'ban', true);
    else if (chat) this.sendTo(player, { o: K.S2C.CHAT, system: true, kind: 'ban', text: chat });
    this.sendTo(player, payload);
    const ws = player.ws;
    setTimeout(() => { try { ws?.close(4013, 'banned'); } catch { /* already gone */ } }, 400);
  }

  welcomePayload(player) {
    return {
      o: K.S2C.WELCOME,
      protocol: K.PROTOCOL_VERSION,
      id: player.id,
      room: this.id,
      code: this.code,
      mode: this.modeId,
      tickRate: K.TICK_RATE,
      snapshotRate: K.SNAPSHOT_RATE,
      serverTime: Math.round(this.now * 1000),
      map: this.mapPayload(),
      you: {
        ...player.profile(), health: player.health,
        ammo: player.weapon.ammo, reserve: player.weapon.reserve,
        spectator: player.spectator,
      },
      spawn: this.map.spawns.ffa?.[0] ?? [0, 4, 0, 0],
      players: this.roster.filter((p) => p !== player).map((p) => p.profile()),
      objectives: this.objectives.map((o) => ({
        id: o.id, x: o.x, y: o.y, z: o.z, owner: o.owner,
        progress: o.progress, contender: o.contender, contested: o.contested,
      })),
      gunGame: this.mode.gunGame
        ? { ladder: K.GUN_GAME_LADDER, need: K.GUN_GAME_KILLS_PER_RUNG, rung: player.ggRung, kills: player.ggKills }
        : null,
      vote: this.state === 'intermission' ? this.voteState() : null,
      chat: this.chatPayload(player),
      report: this.reportPayload(player),
      match: {
        phase: this.state, endsIn: this.mode.practice ? -1 : Math.max(0, Math.round(this.matchEnd - this.now)),
        scoreLimit: this.mode.scoreLimit,
        modeName: this.mode.name,
        practice: !!this.mode.practice,
        nextIn: this.state === 'intermission' ? Math.max(0, Math.round(this.intermissionUntil - this.now)) : 0,
        teamScore: this.mode.teams ? { red: this.teamScore[K.TEAM.RED], blue: this.teamScore[K.TEAM.BLUE] } : null,
      },
      scoreboard: this.roster.map((p) => p.scoreboardRow()),
    };
  }

  /* ── Message handling ──────────────────────────────────────────────────── */

  onMessage(player, msg) {
    player.lastMessageAt = Date.now();
    if (player.spectator
        && msg.o !== K.C2S.PLAY && msg.o !== K.C2S.PING && msg.o !== K.C2S.ACK
        && msg.o !== K.C2S.CLASS && msg.o !== K.C2S.SPECTATE
        && msg.o !== K.C2S.SPECMODE) return;
    switch (msg.o) {
      case K.C2S.INPUT: return this.onInput(player, msg);
      case K.C2S.SHOOT: return this.onShoot(player, msg);
      case K.C2S.MELEE: return this.onMelee(player, msg);
      case K.C2S.RELOAD: return this.onReload(player);
      case K.C2S.SWITCH: return this.onSwitch(player, msg);
      case K.C2S.CHAT: return this.onChat(player, msg);
      case K.C2S.RESPAWN: return this.onRespawnRequest(player);
      case K.C2S.CLASS: return this.onClassChange(player, msg);
      case K.C2S.PLAY: return this.onPlayRequest(player);
      case K.C2S.VOTE: return this.onVote(player, msg);
      case K.C2S.SPECTATE: return this.onSpectateTarget(player, msg);
      case K.C2S.SPECMODE: return this.onSpectateMode(player, msg);
      case K.C2S.MOD: return this.onModAction(player, msg);
      case K.C2S.REPORT: return this.onReport(player, msg);
      case K.C2S.NUKE: return this.onNukeRequest(player);
      case K.C2S.GOD: return this.onGodMode(player, msg);
      case K.C2S.PING: return this.onPing(player, msg);
      case K.C2S.ACK: return this.onAck(player, msg);
      default:
        return;
    }
  }

  /**
   * The heartbeat, and the only place the server learns how far away a client
   * really is.
   *
   * Every PONG carries a token; the client hands the last one it saw back on
   * its next PING, so the gap between issuing that token and seeing it again is
   * a round trip the server timed on its own clock. It is timed on the *room's*
   * clock specifically, because that is the clock `rewindFor` then subtracts it
   * from — measuring on one and rewinding on another would leave the two free
   * to drift apart. The room's clock always advances while anybody is connected
   * to it: a human walking in is what wakes it.
   *
   * What the client *says* its ping is arrives in `rtt` and is now kept for one
   * purpose only: a client claiming a fifth of a second more than the server
   * measured is the fake-lag exploit, which used to be the entire backtrack
   * cheat and is now a flag.
   */
  onPing(player, msg) {
    if (typeof msg.rtt === 'number' && Number.isFinite(msg.rtt)) {
      player.claimedRtt = clamp(msg.rtt / 1000, 0, 2);
      this.checkLagClaim(player);
    }
    // A fresh token every heartbeat, so a client cannot bank an old one and
    // answer it late to buy a rewind window it never earned.
    player.pingToken = (player.pingToken + 1 + Math.floor(Math.random() * 1e6)) % 0x7fffffff || 1;
    player.pingSentAt = this.now;
    this.sendTo(player, {
      o: K.S2C.PONG, t: msg.t, s: Math.round(this.now * 1000), k: player.pingToken,
    });
  }

  /**
   * The client answering a PONG's token, which closes one timed round trip.
   *
   * It has its own frame rather than riding the next PING because the client
   * only pings once a second: echoing the token there would have measured the
   * *interval between two heartbeats* — a flat second, for everybody — and
   * handed the whole room the maximum rewind. This lands the moment the PONG
   * does, so what is measured is one trip out and back and nothing else.
   *
   * A client that simply never answers keeps the default 80 ms, which is well
   * under the ceiling: refusing to be measured buys nothing.
   */
  onAck(player, msg) {
    if (!player.pingToken || msg.k !== player.pingToken) return;
    player.pingToken = 0;
    player.noteRtt(this.now - player.pingSentAt);
    this.checkLagClaim(player);
  }

  /**
   * Compares what the client says its latency is against what was measured.
   *
   * Honest clients agree: both numbers are a median of the same round trips,
   * one timed at each end. Disagreement in *either* direction is worth a flag,
   * and the two directions are two different attempts at the same exploit —
   * claiming more than you have, which is what the userscript did, or sitting
   * on the acknowledgement to make the measurement itself say more than you
   * have. The second is bounded by MAX_LAG_COMP whatever it buys, which is the
   * same ceiling an honest player on a bad line already gets.
   */
  checkLagClaim(player) {
    if (player.rttSamples.length < K.RTT_SAMPLES || player.claimedRtt <= 0) return;
    // Relative as well as absolute: the two numbers are medians of different
    // halves of different round trips, so a genuinely jittery 300 ms line will
    // have them disagree by tens of milliseconds all evening without anybody
    // lying about anything. What is not jitter is a claim half again as big as
    // the measurement.
    const gap = Math.abs(player.claimedRtt - player.rtt);
    if (gap <= Math.max(0.10, player.rtt * 0.5)) return;
    const verdict = ac.flag(player, 'lag',
      `claims ${Math.round(player.claimedRtt * 1000)}ms, measured ${Math.round(player.rtt * 1000)}ms`);
    if (verdict !== 'none') ac.enforce(this, player, verdict, 'lag');
  }

  /**
   * Who has stopped playing, and what the match does about it.
   *
   * A page left open on a match still streams sixty inputs a second and answers
   * every heartbeat, and until now that was indistinguishable from playing:
   * death respawned you whether or not anybody was at the keyboard, so an empty
   * body kept a seat, kept feeding the other team kills, and the only thing
   * that ever moved it was the socket dying. An anti-AFK cheat is a one-line
   * timer sending exactly the heartbeat that used to be enough.
   *
   * Activity is therefore counted from the one thing a script has no reason to
   * fake and a person cannot avoid: a key held, or the view actually moving.
   * The warning comes first and is answered by playing; ignoring it hands the
   * seat back and returns the player to the menu, which is where somebody who
   * is not at the keyboard belongs.
   *
   * Spectators are exempt on purpose — watching the map from the menu is what
   * the menu's backdrop *is*, and sitting still in it is not idling.
   */
  sweepAfk() {
    if (this.state !== 'live' || !config.afk.enabled) return;
    const nowMs = Date.now();
    if (nowMs - this.afkSweptAt < 1000) return;
    this.afkSweptAt = nowMs;

    for (const p of this.players.values()) {
      if (p.isBot || p.spectator || !p.ws) continue;
      const idle = p.idleSec(nowMs);
      const want = idle >= config.afk.kickSec ? 'out'
        : idle >= config.afk.warnSec ? 'warn'
          : null;
      // Only the difference is sent. A notice goes up once and comes down once,
      // rather than being re-sent every second it stands.
      if (want === p.afkNotified) continue;
      p.afkNotified = want;

      if (want === null) {
        this.sendTo(p, { o: K.S2C.AFK, phase: 'clear' });
        continue;
      }

      if (want === 'warn') {
        this.sendTo(p, {
          o: K.S2C.AFK,
          phase: 'warn',
          in: Math.max(1, Math.round(config.afk.kickSec - idle)),
        });
        continue;
      }

      if (p.afk) continue;
      p.afk = true;
      logger.info(`${p.name} (${p.id}) left the match — ${Math.round(idle)}s idle`);
      this.sendTo(p, {
        o: K.S2C.AFK,
        phase: 'out',
        idle: Math.round(idle),
        message: `You were away for ${Math.round(idle)} seconds, so the match gave your seat back.`,
      });
      // Enforced rather than requested: a client that ignores the frame still
      // loses the seat, which is the only version of this rule that a modified
      // page cannot simply switch off.
      setTimeout(() => {
        try { p.ws?.close(4011, 'afk'); } catch { /* already gone */ }
      }, 250);
    }
  }

  /** A watcher cycling which player the camera follows. */
  onSpectateTarget(player, msg) {
    const live = this.roster.filter((p) => p.alive);
    if (!live.length) { player.specTarget = 0; return; }
    const dir = msg.d === -1 ? -1 : 1;
    const idx = live.findIndex((p) => p.id === player.specTarget);
    const next = live[((idx < 0 ? 0 : idx + dir) + live.length) % live.length];
    player.specTarget = next.id;
    this.sendTo(player, { o: K.S2C.MATCH, phase: 'spectate', targetId: next.id, name: next.name });
  }

  /**
   * The client's movement stream.
   *
   * Three things happen here that used to happen nowhere. The packet rate is
   * capped, because a client that produces more ticks than a second contains is
   * not a client with a fast computer. Every view the packet carries is
   * recorded, because that stream — and not a field on the shoot packet — is
   * where a shot's angles are checked against. And a key held or a mouse moved
   * is the only thing on this connection that counts as *playing*, which is
   * what the AFK sweep reads and what an idle heartbeat cannot fake.
   *
   * What is *not* done here is throttling the queue: the ceiling on how fast a
   * player can move lives in the tick, where credit is spent, so that a burst
   * arriving after a stall still catches up instead of being thrown away.
   */
  onInput(player, msg) {
    if (!Array.isArray(msg.i)) return;

    // A packet-per-second ceiling, counted on the room's own clock: it is the
    // one that advances at the tick rate whatever the machine is doing, so a
    // stalled process cannot turn a normal second into a flood. The client
    // flushes at SNAPSHOT_RATE and once more per shot, so even a player
    // emptying a magazine stays far under this.
    const nowMs = Date.now();
    if (player.packetWindowAt < 0 || this.now - player.packetWindowAt >= 1) {
      player.packetWindowAt = this.now;
      player.packetWindow = 0;
    }
    if (++player.packetWindow > INPUT_PACKETS_PER_SEC) {
      if (player.packetWindow === INPUT_PACKETS_PER_SEC + 1) {
        const verdict = ac.flag(player, 'rate', `${player.packetWindow} input packets in one second`);
        if (verdict !== 'none') ac.enforce(this, player, verdict, 'rate');
      }
      return;
    }

    /*
     * The queue is a buffer, not an allowance.
     *
     * Dropping the oldest keeps the freshest inputs — the ones the player is
     * actually feeling — rather than wiping the lot and stalling the body for a
     * tick. It also *is* the speed-hack detector, and a far better one than any
     * count of inputs: the client's own batch holds at most
     * MAX_INPUTS_PER_PACKET, so a backlog this deep cannot be built out of
     * jitter or a stall however bad the line is. It is only ever a client
     * producing more simulation steps than a second contains, and finding the
     * bucket refuses to pay for them.
     */
    if (player.inputQueue.length > MAX_QUEUED_INPUTS) {
      player.inputQueue.splice(0, player.inputQueue.length - MAX_QUEUED_INPUTS);
      if (++player.inputOverflow % 30 === 0) {
        const verdict = ac.flag(player, 'speed',
          `${player.inputOverflow} inputs discarded past a ${MAX_QUEUED_INPUTS}-deep backlog`);
        if (verdict !== 'none') ac.enforce(this, player, verdict, 'speed');
      }
    } else if (!player.inputQueue.length) {
      player.inputOverflow = 0;
    }

    for (const e of msg.i.slice(0, K.MAX_INPUTS_PER_PACKET)) {
      if (!Array.isArray(e) || e.length < 4) continue;
      const [seq, keys, yaw, pitch] = e;
      if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= player.lastSeq) continue;
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) continue;
      const clean = { seq, keys: keys | 0, yaw, pitch: clamp(pitch, -1.56, 1.56) };

      // Recorded on arrival rather than on application: a shot arrives on the
      // same ordered socket immediately behind the input that carried its aim,
      // and the check has to see that input even though the tick has not spent
      // it yet.
      const moved = Math.hypot(ac.angleDelta(clean.yaw, player.viewYaw), clean.pitch - player.viewPitch);
      player.recordView(clean.yaw, clean.pitch, this.now);
      // The sight picture travels with the view for the same reason: a shot
      // fired on the very tick the sights come down arrives while that input is
      // still in the queue, and a quickscope is exactly that shot.
      player.heldAds = (clean.keys & KEY.ADS) !== 0;
      if ((clean.keys & ACTIVE_KEYS) !== 0 || moved > K.AFK_VIEW_EPSILON) player.noteActivity(nowMs);

      player.inputQueue.push(clean);
    }
  }

  onSwitch(player, msg) {
    const slot = msg.s | 0;
    if (slot < 0 || slot >= player.weapons.length || slot === player.slot) return;
    player.slot = slot;
    const w = player.weapon;
    w.reloading = false;
    // `Math.max` so that swapping away and back is not a way to skip a cooldown
    // the weapon had already started.
    w.lastShot = Math.max(w.lastShot, drawStamp(w.def, this.now, 0.15));
    this.sendTo(player, { o: K.S2C.AMMO, slot, ammo: w.ammo, reserve: w.reserve });
  }

  onClassChange(player, msg) {
    if (typeof msg.c !== 'string') return;
    if (this.mode.gunGame) {
      // The ladder decides your weapon; picking one would defeat the mode.
      this.sendTo(player, { o: K.S2C.MATCH, phase: 'classLocked', classId: player.classId });
      return;
    }
    const def = getClass(msg.c);
    if (def.id === player.classId && !player.pendingClass) {
      this.sendTo(player, { o: K.S2C.MATCH, phase: 'classSet', classId: def.id });
      return;
    }
    // Out of combat (or dead) the swap is immediate; mid-fight it waits for the
    // respawn so nobody rerolls their weapon while taking fire.
    const safe = !player.alive || this.now - player.lastCombatAt > 4;
    if (safe) {
      player.setClass(def.id);
      player.pendingClass = null;
      const w = player.weapon;
      this.sendTo(player, {
        o: K.S2C.MATCH, phase: 'classSet', classId: def.id,
        ammo: w.ammo, reserve: w.reserve, immediate: player.alive,
      });
      if (player.alive) this.broadcast({ o: K.S2C.JOIN, player: player.profile() }, player);
    } else {
      player.pendingClass = def.id;
      this.sendTo(player, { o: K.S2C.MATCH, phase: 'classQueued', classId: def.id });
    }
  }

  onReload(player) {
    const w = player.weapon;
    if (!player.alive || w.def.melee || w.reloading) return;
    if (w.ammo >= w.def.magSize || w.reserve === 0) return;
    w.reloading = true;
    w.reloadEnd = this.now + w.def.reloadTime;
    this.sendTo(player, {
      o: K.S2C.AMMO, slot: player.slot, ammo: w.ammo, reserve: w.reserve, reloading: w.def.reloadTime,
    });
  }

  onRespawnRequest(player) {
    if (player.alive || this.state !== 'live' || this.now < player.respawnAt) return;
    // Dying is not activity, and neither is a client that respawns itself. An
    // idle body goes back to the menu instead of back into the match — this is
    // the half of the AFK rule that an auto-respawn script runs into first.
    if (config.afk.enabled && player.ws && !player.isBot
        && player.idleSec() >= config.afk.warnSec) {
      this.sendTo(player, {
        o: K.S2C.AFK, phase: 'held',
        message: 'Move or look around to respawn — the match is waiting for a sign of life.',
      });
      return;
    }
    if (this.mode.gunGame) this.applyGunGameRung(player, true);
    else if (player.pendingClass) { player.setClass(player.pendingClass); player.pendingClass = null; }
    this.respawn(player);
  }

  onChat(player, msg) {
    const text = String(msg.m ?? '').slice(0, K.CHAT_MAX).replace(CTRL, '').trim();
    if (!text) return;

    // Refused privately: a room does not need to watch someone be turned away.
    const denial = this.chatDenial(player);
    if (denial) return this.sendChatState(player, denial);

    const nowMs = Date.now();
    if (nowMs - player.lastChatAt < K.CHAT_COOLDOWN_MS) return;
    player.lastChatAt = nowMs;

    this.counters.chat++;
    // The badges travel with the message. A client that only ever sees the
    // chat frame still draws the sender exactly as the scoreboard would.
    this.pushChat({ id: player.id, name: player.name, team: player.team, text, ...player.tags });
  }

  /**
   * A moderator acting on someone from the scoreboard.
   *
   * The only power on offer is the chat ban: a mute takes nobody out of the
   * match they are playing. Rank is checked server-side and strictly — equal
   * ranks cannot touch each other, so two mods can never silence one another.
   */
  onModAction(player, msg) {
    if (!player.isStaff) return;
    const action = String(msg.a ?? '');
    const target = this.players.get(msg.t | 0);
    const notice = (text) => this.sendTo(player, { o: K.S2C.CHAT, system: true, kind: 'notice', text });

    if (!target || target === player) return;
    if (target.isBot) return notice('bots have nothing to say');
    if (!K.outranks(player.role, target.role)) return notice(`${target.name} outranks you`);

    // Only the actions that actually land are rate limited: a double-click, or
    // a client stuck on the button, must not spray the room with notices or the
    // database with writes. A refusal costs nothing and answers immediately.
    const nowMs = Date.now();
    if (nowMs - player.lastModAt < 500) return;
    player.lastModAt = nowMs;

    if (action === 'unmute') {
      if (!target.muted) return notice(`${target.name} is not muted`);
      this.applyMute(target, { until: 0, by: player.name });
      return;
    }
    if (action !== 'mute') return;
    if (!target.userId) return notice(`${target.name} is a guest and cannot chat anyway`);

    // A year is the ceiling on a timed mute; anything longer is permanent.
    const minutes = clamp(msg.d | 0, 0, 525600);
    const until = minutes > 0 ? Math.floor(Date.now() / 1000) + minutes * 60 : -1;
    const reason = msg.r ? String(msg.r).slice(0, 200).replace(CTRL, '').trim() || null : null;
    this.applyMute(target, { until, by: player.name, reason });
  }

  /**
   * An admin switching god mode on or off.
   *
   * Admins only — moderators have the chat ban and nothing else, and the gap
   * between "can silence someone" and "cannot be shot" is exactly where the
   * line belongs. The rank is re-read from the player every time rather than
   * trusted from a flag set at join, so an account demoted mid-session loses it
   * at the next press.
   *
   * Nothing about this is persisted: it lasts as long as the socket. It is
   * written to the admin log instead, because a player who cannot be killed is
   * the sort of thing the operator should be able to find afterwards without
   * having to be told about it.
   */
  onGodMode(player, msg) {
    const notice = (text) => this.sendTo(player, { o: K.S2C.CHAT, system: true, kind: 'notice', text });
    if (player.role !== 'admin' || player.isBot) {
      player.god = false;
      this.sendTo(player, { o: K.S2C.GOD, on: false, allowed: false });
      return notice('god mode is an administrator tool');
    }
    // A held key or a stuck button must not spray the audit log.
    const nowMs = Date.now();
    if (nowMs - (player.lastGodAt ?? 0) < 400) return;
    player.lastGodAt = nowMs;

    const on = !!msg.v;
    if (on === player.god) {
      this.sendTo(player, { o: K.S2C.GOD, on, allowed: true });
      return;
    }
    player.god = on;
    // Coming back down: drop whatever velocity the flight left behind so the
    // first thing gravity does is a fall, not a launch.
    if (!on) { player.state.vy = Math.min(0, player.state.vy); player.state.vx *= 0.3; player.state.vz *= 0.3; }
    else {
      player.health = K.MAX_HEALTH;
      // Every magazine, not just the one in hand: nothing spends them from here
      // on, so a secondary left half empty would stay half empty for the rest
      // of the session. A reload already running is over — it has nothing left
      // to put in.
      for (const gun of player.weapons) {
        if (gun.def.melee) continue;
        gun.ammo = gun.def.magSize ?? 0;
        gun.reloading = false;
      }
      const held = player.weapon;
      if (held) this.sendTo(player, { o: K.S2C.AMMO, slot: player.slot, ammo: held.ammo, reserve: held.reserve });
    }
    this.sendTo(player, { o: K.S2C.GOD, on, allowed: true });
    notice(on
      ? 'God mode ON — you cannot be hurt, your magazine never empties, and SPACE / CTRL fly you up and down.'
      : 'God mode OFF.');
    try {
      this.hub?.db?.audit?.add(player.name, on ? 'god_on' : 'god_off', this.mapId ?? null,
        JSON.stringify({ room: this.code, mode: this.modeId }));
    } catch (e) {
      logger.warn('god mode audit write failed:', e.message);
    }
  }

  /**
   * One player reporting another from the scoreboard.
   *
   * Filing goes through the room rather than the REST API for one reason: the
   * room is the only thing that knows what actually happened. It resolves the
   * target from the match itself — so nobody can report a name they made up —
   * and files the match, the map and a snapshot of what had just been said
   * alongside it. A moderator reading the queue an hour later gets the context
   * that the room itself throws away when the match ends.
   *
   * Nothing here sanctions anybody: a report is a queue entry, and the queue is
   * read by a human in the admin panel.
   */
  onReport(player, msg) {
    const db = this.hub?.db;
    const notice = (text, kind = 'notice') =>
      this.sendTo(player, { o: K.S2C.CHAT, system: true, kind, text });
    const refuse = (text) => {
      this.sendTo(player, { o: K.S2C.REPORT, ok: false, message: text });
      notice(text, 'notice');
    };

    if (!config.reports.enabled || !db?.reports) return refuse('reporting is switched off on this server');
    if (!player.userId) return refuse('sign in to report a player');

    const target = this.players.get(msg.t | 0);
    if (!target || target === player) return;
    if (target.isBot) return refuse('bots are not worth reporting');

    // Two reports in the same second is a double-click, not two incidents.
    // Everything slower than that is the standing check below, which is where
    // the real ceilings live.
    const nowMs = Date.now();
    if (nowMs - player.lastReportAt < 1000) return;

    const reason = K.REPORT_REASON_IDS.includes(String(msg.r)) ? String(msg.r) : null;
    if (!reason) return refuse('pick a reason for the report');
    const detail = msg.d
      ? String(msg.d).slice(0, K.REPORT_DETAIL_MAX).replace(CTRL, '').trim() || null
      : null;

    try {
      // Every ceiling on one account's reporting, in one place — see
      // util/reports.js. A player who reports everybody they lose to costs a
      // moderator the time of every real report they buried.
      const standing = reportStanding(db, { id: player.userId, level: player.level });
      if (!standing.allowed) return refuse(standing.reason ?? 'you cannot report right now');
      const repeat = repeatDenial(db, player.userId, target.name);
      if (repeat) return refuse(repeat);

      const report = db.reports.add({
        reporterId: player.userId,
        reporterName: player.name,
        targetId: target.userId,
        targetName: target.name,
        targetIp: target.ip,
        reason,
        detail,
        room: this.code,
        mode: this.modeId,
        map: this.map.id,
        // Only the lines with an author: system notices are ours, not evidence.
        chatLog: this.chat.filter((line) => !line.system).slice(-25)
          .map((line) => ({ name: line.name, text: line.text, at: line.at })),
      });

      player.lastReportAt = nowMs;
      logger.info(`${player.name} reported ${target.name} (${reason}) in ${this.code}`);
      this.logEvent(db, {
        kind: 'report.filed', userId: player.userId, name: target.name,
        detail: { reason, by: player.name },
      });
      this.sendTo(player, {
        o: K.S2C.REPORT, ok: true, id: report.id, target: target.name, reason,
      });
      // Privately, and only to the reporter: the room never learns who was
      // reported, or by whom. That is what stops a report from being a weapon.
      notice(`Report filed against ${target.name}. A moderator will look at it — `
        + 'you can follow it under ACCOUNT ▸ REPORTS.', 'notice');
      // The cooldown starts now, so the button greys out now rather than on the
      // next click that would have been refused anyway.
      this.sendReportState(player);
    } catch (err) {
      logger.warn('report write failed:', err.message);
      refuse('the report could not be filed — try again shortly');
    }
  }

  /* ── Combat ────────────────────────────────────────────────────────────── */

  /**
   * Where this player was really pointing when they pulled the trigger.
   *
   * A shoot packet has always carried its own yaw and pitch, and the room has
   * always traced from them without ever asking whether they matched the view
   * the same client had been streaming a millisecond earlier. That single
   * missing question was silent aim: a shot fired at a target a hundred and
   * eighty degrees behind the crosshair, with the crosshair never moving.
   *
   * The stream is the answer. Input and shoot travel the same ordered socket
   * and the client flushes its batch immediately before firing, so an honest
   * shot arrives with its own view a millisecond or two old — the gate only has
   * to cover the mouse movement of one frame the tick loop had not sampled yet,
   * plus whatever the mouse was already doing. Someone mid-flick is forgiven
   * their own measured turn rate; someone perfectly still, which is what an
   * aimbot looks like from here, is forgiven almost nothing.
   *
   * Both halves of that are bounded, and deliberately: staleness is clamped and
   * the whole allowance has a ceiling, so going quiet for a moment before
   * firing cannot be used to *buy* a wider gate than the mouse ever earned.
   *
   * A shot that fails is still fired. It goes down the barrel the player was
   * actually pointing, which is both the honest outcome for a dropped packet
   * and, for a cheat, strictly worse than not cheating at all.
   *
   * @returns {{yaw:number, pitch:number}} the angles to trace from
   */
  resolveAim(player, msg) {
    const held = { yaw: player.viewAt > 0 ? player.viewYaw : player.state.yaw,
      pitch: player.viewAt > 0 ? player.viewPitch : player.state.pitch };
    if (!Number.isFinite(msg.y) || !Number.isFinite(msg.p)) return held;

    const claimed = { yaw: msg.y, pitch: clamp(msg.p, -1.56, 1.56) };
    // No stream yet — a shot in the first frames after a spawn. Take the claim:
    // there is nothing to check it against, and one shot is not an exploit.
    if (player.viewAt <= 0 || player.isBot) return claimed;

    const age = clamp(this.now - player.viewAt, 0, K.AIM_VIEW_MAX_AGE);
    const allowed = Math.min(K.AIM_TOLERANCE_MAX, K.AIM_TOLERANCE
      + age * (K.AIM_TOLERANCE_RATE + player.viewTurnRate * K.AIM_TOLERANCE_TURN_MULT));
    const off = ac.viewDistance(claimed.yaw, claimed.pitch, held.yaw, held.pitch);
    if (off <= allowed) return claimed;

    const verdict = ac.flag(player, 'aim',
      `shot ${(off * 180 / Math.PI).toFixed(1)}\u00b0 off the streamed view `
      + `(allowed ${(allowed * 180 / Math.PI).toFixed(1)}\u00b0)`);
    if (verdict !== 'none') ac.enforce(this, player, verdict, 'aim');
    return held;
  }

  /**
   * Whether this client picked the sequence it is claiming, or just counted.
   *
   * The seed a round is drawn from is the server's own counter and nothing
   * else, so this decides no gameplay — it is evidence, and it exists because a
   * client that searches a couple of hundred sequences for the one whose cone
   * lands dead centre has to *ask* for one, and asking is visible.
   *
   * What it must be measured against is the client's own last claim, never the
   * server's counter. The two are not the same number and were never going to
   * be: the client counts every round it fires, the room counts every round it
   * *accepts*, and it declines plenty — a shot that arrived a hair inside the
   * fire-rate window, one fired into a magazine the server had already emptied,
   * one that landed during a reload. Every one of those puts the two counters
   * one further apart for the rest of the life, and comparing them meant that
   * from the first divergence onward, every single round somebody fired was
   * flagged. Holding the trigger on a fast weapon reached the kick threshold in
   * about two seconds.
   *
   * Counted from its own last claim, an honest client is exactly one further on
   * every packet, forever, however many of them the room turns down. A grinder
   * jumps ahead by as many seeds as it searched.
   */
  checkShotSeq(player, msg) {
    if (!Number.isInteger(msg.n)) return;
    const previous = player.claimedShotSeq;
    player.claimedShotSeq = msg.n;
    // No baseline yet, or a counter that went backwards — a fresh connection
    // rather than a jump. Take the new number as the baseline and say nothing:
    // only going *forward* by more than one is a search.
    if (previous === null || msg.n <= previous) return;
    if (msg.n === previous + 1) return;

    const verdict = ac.flag(player, 'seq',
      `skipped ${msg.n - previous - 1} sequence(s) — claimed ${msg.n} after ${previous}`);
    if (verdict !== 'none') ac.enforce(this, player, verdict, 'seq');
  }

  onShoot(player, msg) {
    if (!player.alive || this.state !== 'live') return;
    const w = player.weapon;
    const d = w.def;
    if (d.melee) return this.onMelee(player, msg);

    // Before any of the reasons this shot might be refused: what the client
    // *called* it is checked against what it called the last one, and every
    // packet counts whether or not the round goes out. See `checkShotSeq`.
    this.checkShotSeq(player, msg);

    const interval = shotInterval(d);
    // God mode collapses every wait between two rounds — the fire rate, the
    // bolt, and whatever the swap left behind — to a floor no trigger outruns.
    // Nothing else about the shot changes: same cone, same damage, same seed.
    const gate = (player.god ? Math.min(interval, K.GOD_SHOT_INTERVAL) : interval) * 0.9;
    if (w.reloading || (this.now < w.pumpUntil && !player.god)) return;
    if (this.now - w.lastShot < gate) return;                // 10% jitter tolerance

    if (w.ammo <= 0) {
      this.sendTo(player, { o: K.S2C.AMMO, slot: player.slot, ammo: 0, reserve: w.reserve, dry: true });
      return;
    }

    const { yaw, pitch } = this.resolveAim(player, msg);
    player.state.yaw = yaw;
    player.state.pitch = pitch;

    // Bloom: how many rounds have gone out without the cone settling. Only the
    // time spent *not* firing counts toward recovery, so holding the trigger
    // keeps the cone open and letting go closes it.
    //
    // The client runs the identical rule and sends what it got; the server
    // takes that number when it agrees with its own within a couple of rounds,
    // which keeps a drawn tracer on exactly the ray that was tested without
    // ever trusting the client for more than rounding.
    const settle = d.bloomRecover ?? 12;
    const idle = this.now - w.lastShot - interval;
    let settled = w.burst;
    if (idle > 0) settled = Math.max(0, settled - idle * settle);
    const claimed = Number.isFinite(msg.b) ? clamp(msg.b | 0, 0, 60) : null;
    const burst = claimed !== null && Math.abs(claimed - settled) <= 3 ? claimed : Math.round(settled);

    w.lastShot = this.now;
    // God mode does not spend the magazine. An admin standing in a room to try
    // a weapon out is not playing a match, and a reload every thirty rounds is
    // the one thing the tool cannot make itself immune to. See `onGodMode`.
    if (!player.god) w.ammo--;
    w.burst = burst + 1;
    this.counters.shots++;
    if (d.boltTime) w.pumpUntil = this.now + d.boltTime;
    player.score.shotsFired++;
    player.noteActivity();

    /*
     * The sight picture is held, never claimed.
     *
     * A shoot packet asserting `a: 1` used to be believed outright, which was
     * scoped accuracy while hip-firing and moving at hip-fire speed. What
     * settles it now is the ADS bit of the client's own input stream.
     *
     * Specifically the freshest input *received*, not the last one the tick
     * spent. Input and shoot arrive on the same ordered socket and the client
     * flushes before firing, so a shot fired on the very tick the sights come
     * down lands with that input received but still queued — and a quickscope
     * is precisely that shot. Reading the consumed state instead meant the
     * server thought the sights were up for every quickscope in the game: the
     * wide cone, and a flag on top of it.
     */
    const adsHeld = player.heldAds ?? player.ads;
    if (msg.a !== undefined && !!msg.a !== adsHeld) {
      // A run of them, not one: a transient at the edge of a key press is not
      // the same thing as a client that claims the sights it never holds.
      if (++player.adsMismatch >= ADS_MISMATCH_RUN) {
        const verdict = ac.flag(player, 'ads',
          `claimed ads=${msg.a ? 1 : 0} on ${player.adsMismatch} shots the input stream never held it for`);
        if (verdict !== 'none') ac.enforce(this, player, verdict, 'ads');
      }
    } else {
      player.adsMismatch = 0;
    }

    /*
     * The spread seed is the server's counter, not the client's pick.
     *
     * Both sides still derive byte-identical pellet directions from it, which
     * is the whole reason a drawn tracer sits on the ray that was tested — but
     * the number is ours. Being allowed to *choose* it was the no-spread cheat
     * entire: search a couple of hundred seeds, keep the one whose cone lands
     * dead centre, fire that one. There is nothing left to search.
     */
    const seq = ++player.shotSeq;
    const seed = shotSeed(player.id, seq);
    const spread = spreadFor(d, {
      moving: Math.hypot(player.state.vx, player.state.vz) > 1.5,
      airborne: !player.state.onGround,
      ads: adsHeld,
      crouching: player.state.crouching,
      burst,
    });

    const eye = player.eye();
    this.sendTo(player, { o: K.S2C.AMMO, slot: player.slot, ammo: w.ammo, reserve: w.reserve });

    if (d.projectile) {
      this.spawnProjectile(player, d, eye, yaw, pitch, seed);
      return;
    }

    const dirs = shotDirections(yaw, pitch, spread, seed, d.pellets ?? 1);

    // How centred that draw came out. One round says nothing; the average over
    // a magazine is the only thing left that a client burning rounds to skip a
    // seed it does not like cannot hide from — see anticheat.trackSpread.
    if ((d.pellets ?? 1) === 1 && dirs[0]) {
      const f = lookDir(yaw, pitch);
      const dot = clamp(dirs[0].x * f.x + dirs[0].y * f.y + dirs[0].z * f.z, -1, 1);
      if (ac.trackSpread(player, Math.acos(dot), spread)) {
        const verdict = ac.flag(player, 'spread', 'rounds landing at the centre of every cone');
        if (verdict !== 'none') ac.enforce(this, player, verdict, 'spread');
      }
    }

    const rewindTime = this.now - this.rewindFor(player);

    const impacts = [];
    const perVictim = new Map();
    let hitAnyone = false;

    for (const dir of dirs) {
      const res = this.traceShot(player, eye, dir, rewindTime, d);
      if (res.victim) {
        hitAnyone = true;
        const cur = perVictim.get(res.victim) ?? { damage: 0, head: false, point: res.point, dist: res.dist };
        cur.damage += res.damage;
        cur.head = cur.head || res.head;
        cur.dist = Math.min(cur.dist, res.dist);
        perVictim.set(res.victim, cur);
      } else if (res.wall) {
        impacts.push(res.wall);
      }
    }

    const shotCtx = {
      ads: adsHeld,
      // Deliberately the *consumed* state and not `adsHeld`: this is how long
      // the sights have actually been up, and a shot taken on the tick they
      // came down has been up for no time at all. That is what a quickscope is,
      // and it is the number the award below is looking for.
      scopeTime: player.ads ? Math.max(0, this.now - (player.adsStart ?? this.now)) : 0,
      airborne: !player.state.onGround,
      sliding: player.state.sliding,
    };
    for (const [victim, info] of perVictim) {
      this.applyHit(player, victim, info.damage, info.head, d, info.point,
        { ...shotCtx, distance: info.dist });
    }
    if (hitAnyone) player.score.shotsHit++;

    for (const im of impacts.slice(0, 4)) {
      this.broadcastNear(
        { o: K.S2C.IMPACT, x: r2(im.x), y: r2(im.y), z: r2(im.z), nx: im.nx, ny: im.ny, nz: im.nz, s: im.mat },
        im.x, im.y, im.z, 120, player);
    }

    this.broadcastNear({
      o: K.S2C.SHOT, id: player.id, w: d.id, seq,
      x: r2(eye.x), y: r2(eye.y), z: r2(eye.z),
      yaw: r2(yaw), pitch: r2(pitch), spread: Math.round(spread * 1e4) / 1e4,
    }, eye.x, eye.y, eye.z, 220, player);
  }

  /**
   * How far back this player's shots are allowed to reach.
   *
   * Half a round trip, plus the interpolation delay every client renders remote
   * bodies at: together that is where the target genuinely was on the shooter's
   * screen. The round trip is the one the server timed off its own PONG token
   * (see `onPing`) — before that it was whatever number the client put in a
   * field, and a userscript writing `rtt: 300` bought itself a third of a
   * second of rewind and shot at where everybody used to be.
   *
   * A bot has no socket and no latency, so it gets none.
   */
  rewindFor(player) {
    if (player.isBot) return 0;
    return clamp(player.rtt / 2 + K.INTERP_DELAY, 0, K.MAX_LAG_COMP);
  }

  /**
   * One pellet: nearest of (world geometry, rewound enemy hitboxes).
   * @returns {{victim?:Player, damage?:number, head?:boolean, point?:object, wall?:object}}
   */
  traceShot(shooter, eye, dir, rewindTime, d) {
    const wallHit = this.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, K.MAX_SHOT_RANGE);

    let victim = null, vDist = wallHit ? wallHit.dist : K.MAX_SHOT_RANGE, vHead = false, vBody = null;
    for (const other of this.players.values()) {
      if (other === shooter || !other.alive) continue;
      if (this.mode.teams && other.team === shooter.team) continue;
      const h = other.rewind(rewindTime);
      if (!h || h.alive === false) continue;

      const bodyT = rayBox(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z,
        h.x - HIT_RADIUS, h.y, h.z - HIT_RADIUS,
        h.x + HIT_RADIUS, h.y + h.h, h.z + HIT_RADIUS, vDist);
      if (bodyT < 0 || bodyT >= vDist) continue;

      const headBottom = h.y + h.h - K.HEAD_HEIGHT;
      const headT = rayBox(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z,
        h.x - HEAD_RADIUS, headBottom, h.z - HEAD_RADIUS,
        h.x + HEAD_RADIUS, h.y + h.h, h.z + HEAD_RADIUS, vDist);

      victim = other;
      vDist = bodyT;
      vBody = h;
      vHead = headT >= 0;
    }

    if (victim) {
      const hitY = eye.y + dir.y * vDist;
      let mult = 1;
      if (vHead) mult = d.headMult ?? K.HEADSHOT_MULT;
      else if (hitY < vBody.y + vBody.h * 0.42) mult = K.LEG_MULT;
      return {
        victim,
        damage: d.damage * falloff(d, vDist) * mult,
        head: vHead,
        dist: vDist,
        point: { x: eye.x + dir.x * vDist, y: hitY, z: eye.z + dir.z * vDist },
      };
    }

    if (wallHit) {
      return {
        wall: {
          x: eye.x + dir.x * wallHit.dist,
          y: eye.y + dir.y * wallHit.dist,
          z: eye.z + dir.z * wallHit.dist,
          nx: wallHit.nx, ny: wallHit.ny, nz: wallHit.nz,
          mat: wallHit.mat ?? this.map.ground?.mat ?? null,
        },
      };
    }
    return {};
  }

  applyHit(attacker, victim, rawDamage, head, weaponDef, point, ctx = {}) {
    const amount = Math.max(1, Math.round(rawDamage));
    const res = victim.applyDamage(amount, this.now, attacker?.id ?? 0);
    if (res.damage <= 0) return;

    this.counters.damage += res.damage;
    if (attacker) {
      attacker.score.damage += res.damage;
      attacker.lastCombatAt = this.now;
      if (head) attacker.score.headshots++;
      this.sendTo(attacker, {
        o: K.S2C.HIT, target: victim.id, damage: res.damage, head, kill: res.dead,
        x: r2(point?.x ?? victim.state.x), y: r2(point?.y ?? victim.state.y), z: r2(point?.z ?? victim.state.z),
      });
    }
    this.sendTo(victim, {
      o: K.S2C.DAMAGE, from: attacker?.id ?? 0, damage: res.damage, health: Math.round(victim.health),
      x: r2(attacker?.state.x ?? victim.state.x),
      y: r2(attacker?.state.y ?? victim.state.y),
      z: r2(attacker?.state.z ?? victim.state.z), head,
    });

    if (res.dead) this.onKill(attacker, victim, weaponDef?.id ?? 'unknown', head, weaponDef, ctx);
  }

  /**
   * Points for one kill. Everything worth doing is worth points, and points
   * are what turn into GR at the end of the match — 100 points is 1 GR.
   * @returns {Array<{key:string, points:number, label:string}>}
   */
  killEvents(killer, victim, def, ctx, head) {
    const events = [];
    const add = (key) => {
      const points = K.SCORE[key] ?? 0;
      if (points) events.push({ key, points, label: K.SCORE_LABELS[key] ?? key });
    };

    add('KILL');
    if (head) add('HEADSHOT');
    if (!victim.state.onGround) add('MIDAIR');
    if (ctx.airborne) add('AIRSHOT');
    if (ctx.sliding) add('DRIFT');

    if (def?.melee) add(ctx.backstab ? 'BACKSTAB' : 'MELEE');
    else if (def?.scope) {
      if (!ctx.ads) add('NOSCOPE');
      else if (ctx.scopeTime <= K.NOSCOPE_GRACE) add('QUICKSCOPE');
    }

    const dist = ctx.distance ?? 0;
    if (dist > K.LONGSHOT_RANGE) add('LONGSHOT');
    else if (dist > 0 && dist < 4 && !def?.melee) add('POINTBLANK');

    if (!this.firstBloodTaken) { this.firstBloodTaken = true; add('FIRST_BLOOD'); }
    if (killer.lastKilledBy === victim.id) add('REVENGE');
    if (victim.score.streak >= 5) add('SHUTDOWN');
    if (this.now - (killer.lastKillAt ?? -999) <= K.MULTIKILL_WINDOW) {
      add('MULTIKILL');
      killer.score.multikills++;
    }
    for (const [n] of K.KILLSTREAK_LABELS) if (killer.score.streak + 1 === n) add('STREAK_STEP');

    return events;
  }

  /** Awards a list of score events and tells the player what they earned. */
  award(player, events, victimName = null) {
    if (!player || !events.length) return 0;
    let total = 0;
    for (const e of events) total += e.points;
    player.score.score = Math.max(0, player.score.score + total);
    this.sendTo(player, {
      o: K.S2C.POINTS, total, score: player.score.score,
      events: events.map((e) => ({ label: e.label, points: e.points })),
      victim: victimName,
    });
    return total;
  }

  onKill(killer, victim, weaponId, head, weaponDef = null, ctx = {}) {
    victim.kill(this.now);
    this.counters.deaths++;
    if (killer && killer !== victim) { this.counters.kills++; if (head) this.counters.headshots++; }

    if (killer && killer !== victim) {
      const friendly = this.mode.teams && killer.team === victim.team;
      killer.score.kills++;
      killer.score.streak++;
      killer.score.bestStreak = Math.max(killer.score.bestStreak, killer.score.streak);
      if (!victim.state.onGround) killer.score.midairs++;
      if (weaponDef?.scope && !ctx.ads) killer.score.noscopes++;
      if (ctx.sliding) killer.score.drifts++;
      if (weaponDef?.melee) killer.score.melees++;
      if ((ctx.distance ?? 0) > K.LONGSHOT_RANGE) killer.score.longshots++;
      killer.score.longestShot = Math.max(killer.score.longestShot, Math.round(ctx.distance ?? 0));
      killer.creditWeapon(weaponId);

      if (friendly) {
        this.award(killer, [{ key: 'TEAMKILL', points: K.SCORE.TEAMKILL, label: K.SCORE_LABELS.TEAMKILL }]);
      } else {
        const events = this.killEvents(killer, victim, weaponDef, ctx, head);
        if (this.mode.objectives && this.isDefendKill(killer, victim)) {
          killer.score.defends++;
          events.push({ key: 'DEFEND', points: K.DOM_DEFEND_SCORE, label: 'DEFENDED' });
        }
        this.award(killer, events, victim.name);
        // Domination scores from held points, not from bodies.
        if (this.mode.teams && !this.mode.objectives) {
          this.teamScore[killer.team] = (this.teamScore[killer.team] ?? 0) + 1;
        }
        if (this.mode.gunGame) this.gunGameKill(killer);
      }
      killer.lastKillAt = this.now;
      victim.lastKilledBy = killer.id;
    } else {
      this.award(victim, [{ key: 'SUICIDE', points: K.SCORE.SUICIDE, label: K.SCORE_LABELS.SUICIDE }]);
      victim.lastKilledBy = 0;
    }

    // Assists: anyone who damaged the victim recently and isn't the killer.
    const assisters = [];
    for (const [id, rec] of victim.damagedBy) {
      if (id === killer?.id || this.now - rec.at > 8) continue;
      const a = this.players.get(id);
      if (!a) continue;
      a.score.assists++;
      this.award(a, [{ key: 'ASSIST', points: K.SCORE.ASSIST, label: K.SCORE_LABELS.ASSIST }], victim.name);
      assisters.push(a.name);
    }

    let streakLabel = null;
    if (killer) {
      for (const [n, label] of K.KILLSTREAK_LABELS) if (killer.score.streak === n) streakLabel = label;
    }

    this.broadcast({
      o: K.S2C.KILL,
      killer: killer
        ? { id: killer.id, name: killer.name, team: killer.team, verified: !!killer.verified }
        : null,
      victim: { id: victim.id, name: victim.name, team: victim.team, verified: !!victim.verified },
      weapon: weaponId, head, assists: assisters, streak: streakLabel,
      killerStreak: killer?.score.streak ?? 0,
    });

    this.sendTo(victim, {
      o: K.S2C.DEATH, by: killer ? killer.name : 'the world', byId: killer?.id ?? 0,
      // The killer's badges travel too: the death screen is the one place their
      // name is written large, and a clan tag belongs beside it like anywhere else.
      byClan: killer?.clan ?? null, byClanVerified: !!killer?.clanVerified,
      weapon: weaponId, head, respawnIn: K.RESPAWN_TIME,
      killerHealth: killer ? Math.round(killer.health) : 0,
    });

    // Killing the caller is the only counterplay to a launch, so it has to
    // actually work — and reaching the streak has to light the launch up.
    if (this.nuke && this.nuke.by === victim.id) this.cancelNuke('killed');
    if (killer) this.sendNukeState(killer);
    this.sendNukeState(victim);

    this.pushScore();
    this.checkWinCondition();

    // Anyone watching this body now needs a different one.
    this.retargetSpectators(victim.id);

    // A switch flipped mid-firefight lands here, one frame after the death that
    // made it possible: the client has already been told it died, so the camera
    // it is handed next reads as a continuation rather than a teleport.
    if (victim.wantsSpectate && !victim.spectator) this.enterSpectate(victim);
  }

  checkWinCondition() {
    if (this.state !== 'live') return;
    if (this.mode.gunGame || this.mode.practice) return;   // decided elsewhere
    if (this.mode.teams) {
      if (this.teamScore[K.TEAM.RED] >= this.mode.scoreLimit
          || this.teamScore[K.TEAM.BLUE] >= this.mode.scoreLimit) this.endMatch('score');
    } else {
      for (const p of this.roster) {
        if (p.score.kills >= this.mode.scoreLimit) return this.endMatch('score');
      }
    }
  }

  pushScore() {
    this.broadcast({
      o: K.S2C.SCORE,
      teamScore: this.mode.teams ? { red: this.teamScore[K.TEAM.RED], blue: this.teamScore[K.TEAM.BLUE] } : null,
      rows: this.roster.map((p) => p.scoreboardRow()),
    });
  }

  /** Scoreboards drift as damage lands; refresh them on a slow timer too. */
  maybePushScore(dt) {
    this.scoreAcc = (this.scoreAcc ?? 0) + dt;
    if (this.scoreAcc < 2) return;
    this.scoreAcc = 0;
    if (this.players.size) this.pushScore();
  }

  onMelee(player) {
    if (!player.alive || this.state !== 'live') return;
    const knife = player.weapons[2];
    const cooldown = player.god ? Math.min(K.MELEE_COOLDOWN, K.GOD_SHOT_INTERVAL) : K.MELEE_COOLDOWN;
    if (this.now - knife.lastShot < cooldown) return;
    knife.lastShot = this.now;

    const eye = player.eye();
    const dir = lookDir(player.state.yaw, player.state.pitch);
    const rewindTime = this.now - this.rewindFor(player);

    let best = null, bestDist = knife.def.range;
    for (const other of this.players.values()) {
      if (other === player || !other.alive) continue;
      if (this.mode.teams && other.team === player.team) continue;
      const h = other.rewind(rewindTime);
      const t = rayBox(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z,
        h.x - HIT_RADIUS - 0.2, h.y, h.z - HIT_RADIUS - 0.2,
        h.x + HIT_RADIUS + 0.2, h.y + h.h, h.z + HIT_RADIUS + 0.2, bestDist);
      if (t >= 0 && t < bestDist) { best = other; bestDist = t; }
    }

    this.broadcastNear(
      { o: K.S2C.SHOT, id: player.id, w: 'knife', melee: true, x: r2(eye.x), y: r2(eye.y), z: r2(eye.z) },
      eye.x, eye.y, eye.z, 60, player);

    if (!best) return;
    // Backstab: the victim is facing roughly the same way the attacker is.
    const fromBehind = Math.cos(best.state.yaw - player.state.yaw) > 0.4;
    const dmg = fromBehind ? knife.def.backstab : knife.def.damage;
    this.applyHit(player, best, dmg, false, knife.def,
      { x: eye.x + dir.x * bestDist, y: eye.y + dir.y * bestDist, z: eye.z + dir.z * bestDist },
      {
        backstab: fromBehind, distance: bestDist, ads: false, scopeTime: 0,
        airborne: !player.state.onGround, sliding: player.state.sliding,
      });
  }

  /* ── Projectiles & explosions ──────────────────────────────────────────── */

  spawnProjectile(owner, def, eye, yaw, pitch, seed) {
    const dir = shotDirections(yaw, pitch, 0.002, seed, 1)[0];
    const p = {
      id: this.nextProjectileId++,
      owner: owner.id, team: owner.team, def,
      x: eye.x + dir.x * 0.8, y: eye.y + dir.y * 0.8, z: eye.z + dir.z * 0.8,
      vx: dir.x * def.projectile.speed, vy: dir.y * def.projectile.speed, vz: dir.z * def.projectile.speed,
      born: this.now,
    };
    this.projectiles.push(p);
    this.broadcast({
      o: K.S2C.SHOT, id: owner.id, w: def.id, projectile: p.id,
      x: r2(p.x), y: r2(p.y), z: r2(p.z), vx: r2(p.vx), vy: r2(p.vy), vz: r2(p.vz),
    });
  }

  stepProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.vy -= (p.def.projectile.gravity ?? 0) * dt;

      const dx = p.vx * dt, dy = p.vy * dt, dz = p.vz * dt;
      const len = Math.hypot(dx, dy, dz);
      let hitX = p.x + dx, hitY = p.y + dy, hitZ = p.z + dz;
      let exploded = false;
      let normal = null;

      if (len > 1e-6) {
        const nx = dx / len, ny = dy / len, nz = dz / len;
        const wall = this.world.raycast(p.x, p.y, p.z, nx, ny, nz, len);
        let travel = len;

        for (const other of this.players.values()) {
          if (!other.alive || other.id === p.owner) continue;
          if (this.mode.teams && other.team === p.team) continue;
          const s = other.state;
          const t = rayBox(p.x, p.y, p.z, nx, ny, nz,
            s.x - HIT_RADIUS, s.y, s.z - HIT_RADIUS,
            s.x + HIT_RADIUS, s.y + s.height, s.z + HIT_RADIUS, travel);
          if (t >= 0 && t < travel) travel = t;
        }
        if (wall && wall.dist < travel) { travel = wall.dist; normal = wall; }
        else if (travel < len) normal = { nx: -nx, ny: -ny, nz: -nz };

        if (travel < len) {
          hitX = p.x + nx * travel; hitY = p.y + ny * travel; hitZ = p.z + nz * travel;
          exploded = true;
        }
      }

      p.x = hitX; p.y = hitY; p.z = hitZ;
      if (!exploded && (this.now - p.born > 6 || p.y < -30)) exploded = true;

      if (exploded) {
        /*
         * Detonate just *off* the surface, never on it.
         *
         * `explode` decides who is in the blast with a line-of-sight test from
         * the burst point, and a burst point that sits exactly on a wall starts
         * that trace inside the wall: it returns a hit at zero distance for
         * everybody, so a rocket that touched any scenery at all did nothing to
         * anyone. That is why a direct hit on the wall a foot behind somebody
         * left them untouched, and why firing at your own feet never lifted you
         * — the rocket jump was being blocked by the floor it needs.
         *
         * A tenth of a unit along the surface normal is invisible and puts the
         * origin in open air, where the trace measures what a player expects it
         * to: whether there is anything between the blast and them.
         */
        this.explode(
          p,
          hitX + (normal?.nx ?? 0) * BLAST_OFFSET,
          hitY + (normal?.ny ?? 0) * BLAST_OFFSET,
          hitZ + (normal?.nz ?? 0) * BLAST_OFFSET,
        );
        this.projectiles.splice(i, 1);
      }
    }
  }

  explode(proj, x, y, z) {
    const splash = proj.def.splash;
    this.broadcastNear({ o: K.S2C.EXPLOSION, id: proj.id, x: r2(x), y: r2(y), z: r2(z), r: splash.radius },
      x, y, z, 220);

    const owner = this.players.get(proj.owner);
    for (const other of this.players.values()) {
      if (!other.alive) continue;
      const cx = other.state.x, cy = other.state.y + other.state.height * 0.5, cz = other.state.z;
      const dist = Math.hypot(cx - x, cy - y, cz - z);
      if (dist > splash.radius) continue;
      /*
       * Three traces, not one: chest, shins and head.
       *
       * A blast that goes off on the floor has a clean line to somebody's legs
       * and no line at all to their chest if there is a crate between the two,
       * and a single chest trace turns that into "the rocket that landed on
       * your foot missed". Any one of the three connecting is enough — cover has
       * to actually be between the blast and *all* of you.
       */
      const feet = other.state.y + 0.25;
      const head = other.state.y + other.state.height - 0.25;
      if (!this.world.lineOfSight(x, y, z, cx, cy, cz)
          && !this.world.lineOfSight(x, y, z, cx, feet, cz)
          && !this.world.lineOfSight(x, y, z, cx, head, cz)) continue;

      const isSelf = other.id === proj.owner;
      if (this.mode.teams && owner && other.team === proj.team && !isSelf) continue;

      const t = 1 - dist / splash.radius;
      let dmg = splash.minDamage + (splash.maxDamage - splash.minDamage) * t * t;
      if (isSelf) dmg *= splash.selfMult;

      // Rocket-jump impulse — the reason anyone plays Rocketeer.
      const push = splash.impulse * t;
      const len = Math.max(0.4, dist);
      other.state.vx += ((cx - x) / len) * push;
      other.state.vy += ((cy - y) / len) * push * 0.9 + push * 0.35;
      other.state.vz += ((cz - z) / len) * push;
      other.state.onGround = false;

      if (owner) {
        this.applyHit(owner, other, dmg, false, proj.def, { x, y, z }, {
          distance: dist, ads: false, scopeTime: 0,
          airborne: !owner.state.onGround, sliding: owner.state.sliding,
        });
      }
      else {
        const res = other.applyDamage(Math.round(dmg), this.now, 0);
        if (res.dead) this.onKill(null, other, proj.def.id, false);
      }
    }
  }

  /* ── The nuke ──────────────────────────────────────────────────────────── */

  /**
   * Has this player earned the launch?
   *
   * The streak has to be alive as well as long: dying resets it, and spending
   * it resets it, so the answer is simply "are you twelve kills into a run you
   * have not cashed in".
   */
  nukeReady(player) {
    return !!player
      && !player.spectator
      && player.alive
      && this.state === 'live'
      && !this.mode.practice
      && !this.nuke
      && player.score.streak >= K.NUKE_STREAK;
  }

  /** Tells one player whether the launch is theirs to press, and why not. */
  sendNukeState(player) {
    // No socket guard here: `sendTo` already drops frames for bots and dead
    // connections, and the flag below has to stay true of the player either
    // way — it is what decides whether the *next* change is worth a frame.
    const armed = this.nukeReady(player);
    if (armed === player.nukeArmed) return;
    player.nukeArmed = armed;
    this.sendTo(player, {
      o: K.S2C.NUKE, phase: 'armed', armed, streak: player.score.streak, need: K.NUKE_STREAK,
    });
  }

  /**
   * Somebody spending their streak.
   *
   * Everything about this is loud on purpose: the whole room is told the moment
   * the key is pressed, and then given seven seconds to do something about it —
   * kill the caller and the launch dies with them. That window is the only
   * counterplay there is, so it is generous, and it is the reason the nuke is
   * announced rather than simply happening.
   */
  onNukeRequest(player) {
    if (!this.nukeReady(player)) return;
    this.nuke = {
      by: player.id,
      name: player.name,
      team: player.team,
      at: this.now + K.NUKE_COUNTDOWN,
    };
    // Spent. Dying no longer cancels the streak reward, only the launch itself.
    player.score.streak = 0;
    player.nukeArmed = false;
    player.score.nukes = (player.score.nukes ?? 0) + 1;

    this.broadcast({
      o: K.S2C.NUKE, phase: 'launched',
      by: player.id, name: player.name, team: player.team,
      seconds: K.NUKE_COUNTDOWN,
    });
    this.pushSystemChat(`${player.name} called in a NUKE — ${Math.round(K.NUKE_COUNTDOWN)} seconds`, 'nuke');
    logger.info(`${player.name} launched a nuke in ${this.code}`);
    for (const p of this.players.values()) this.sendNukeState(p);
  }

  /** The caller died, left, or the match ended: the launch goes with them. */
  cancelNuke(reason = 'aborted') {
    if (!this.nuke) return;
    const { name } = this.nuke;
    this.nuke = null;
    this.broadcast({ o: K.S2C.NUKE, phase: 'aborted', name, reason });
    if (reason === 'killed') this.pushSystemChat(`${name} was stopped — the nuke is off`, 'nuke');
    for (const p of this.players.values()) this.sendNukeState(p);
  }

  /**
   * It lands.
   *
   * Everybody who is not on the caller's side dies where they stand, credited
   * to the caller, and the match ends on the flash. In a free-for-all "not on
   * the caller's side" is everybody else; in a team mode it is the other team,
   * which is what makes calling one in front of your own team a play rather
   * than a betrayal.
   */
  detonateNuke() {
    const nuke = this.nuke;
    if (!nuke) return;
    this.nuke = null;
    const caller = this.players.get(nuke.by);

    this.broadcast({ o: K.S2C.NUKE, phase: 'detonated', by: nuke.by, name: nuke.name, team: nuke.team });

    for (const other of [...this.players.values()]) {
      if (other.spectator || !other.alive || other.god) continue;
      if (other.id === nuke.by) continue;
      if (this.mode.teams && other.team === nuke.team) continue;
      other.protectedUntil = -1;                       // nothing survives this
      other.applyDamage(K.MAX_HEALTH * 2, this.now, caller?.id ?? 0);
      this.onKill(caller ?? null, other, 'nuke', false, null, { distance: 0, ads: false, scopeTime: 0 });
    }

    if (caller) {
      this.award(caller, [{ key: 'NUKE', points: K.SCORE.NUKE, label: K.SCORE_LABELS.NUKE }]);
      if (this.mode.teams) {
        // The nuke *is* the win condition in a team mode: it ends the match for
        // the side that earned it rather than adding a handful of eliminations.
        this.teamScore[nuke.team] = this.mode.scoreLimit;
      }
    }
    this.pushSystemChat(`${nuke.name}'s nuke landed`, 'nuke');
    this.pushScore();
    // The flash holds for a beat before the end card comes up over it.
    this.nukeEndAt = this.now + K.NUKE_BLAST_HOLD;
  }

  /* ── Simulation ────────────────────────────────────────────────────────── */

  tick(dt) {
    // Nobody in it: no clock, no physics, no projectiles, no map rotation and
    // no match to record. This is the whole of what "the room list scales with
    // the player count" means for a room that is listed but empty.
    if (this.dormant) return;
    this.now += dt;

    for (const p of this.players.values()) {
      if (p.spectator) continue;
      if (p.isBot && p.brain) p.brain.think(this, dt);

      const w = p.weapon;
      if (w.reloading && this.now >= w.reloadEnd) {
        const want = w.def.magSize - w.ammo;
        const take = w.reserve < 0 ? want : Math.min(want, w.reserve);
        w.ammo += take;
        if (w.reserve > 0) w.reserve -= take;
        w.reloading = false;
        w.burst = 0;
        this.sendTo(p, { o: K.S2C.AMMO, slot: p.slot, ammo: w.ammo, reserve: w.reserve });
      }

      // Auto-reload once the magazine runs dry.
      if (p.alive && !w.reloading && !w.def.melee && w.ammo === 0 && w.reserve !== 0
          && this.now - w.lastShot > 0.25) {
        this.onReload(p);
      }

      if (p.alive) {
        /*
         * One simulation step per tick, and no more.
         *
         * The drain used to be capped at three inputs a tick with no clock
         * attached to it, so a client that produced three inputs per tick
         * forever ran at three times everybody else's speed and the physics
         * never noticed: every step it asked for was a legal step. The cap
         * stays — a burst still catches up after a stall — but each step is now
         * paid for out of credit that refills at exactly real time, so the
         * sustained rate is the tick rate no matter what arrives.
         */
        p.inputCredit = Math.min(K.INPUT_BUDGET_BURST, p.inputCredit + 1 + K.INPUT_BUDGET_SLACK);
        let applied = 0;
        while (p.inputQueue.length && applied < MAX_INPUTS_PER_TICK && p.inputCredit >= 1) {
          const input = p.inputQueue.shift();
          p.inputCredit--;
          p.lastSeq = input.seq;
          p.lastInputAt = this.now;
          const wasAds = p.ads;
          p.ads = (input.keys & KEY.ADS) !== 0;
          if (p.ads && !wasAds) p.adsStart = this.now;
          p.firing = (input.keys & KEY.FIRE) !== 0;
          step(p.state, input, this.world, K.TICK_DT, { speedMult: p.speedMult(p.ads), fly: p.god });
          this.postStep(p);
          applied++;
        }
        if (applied === 0) {
          if (p.isBot) {
            step(p.state, p.botInput ?? { keys: 0, yaw: p.state.yaw, pitch: p.state.pitch },
              this.world, K.TICK_DT, { speedMult: p.speedMult(false) });
            this.postStep(p);
          } else if (this.now - (p.lastInputAt ?? this.now) > INPUT_STARVE_GRACE) {
            // The client stopped sending input (packet loss, tabbed out, dead
            // socket). Keep simulating with no keys held so the body falls and
            // settles instead of hovering. The grace window is long enough that
            // ordinary frame-rate jitter never triggers it, so prediction stays
            // correction-free in normal play.
            //
            // What it must *not* do is forget what the client last said it was
            // holding. Jumping is edge-triggered off exactly that memory, so a
            // silent gap that cleared it would hand a player who never let go
            // of the key a free hop on the far side of every lost packet.
            const held = p.state.prevKeys;
            step(p.state, { keys: 0, prev: 0, yaw: p.state.yaw, pitch: p.state.pitch },
              this.world, K.TICK_DT, { speedMult: p.speedMult(false), fly: p.god });
            p.state.prevKeys = held;
            this.postStep(p);
          }
        }
        p.regen(this.now, dt);
      } else {
        /*
         * A body with nobody in it still has a client streaming sixty inputs a
         * second at it, and nothing was consuming them.
         *
         * They piled up behind a queue that only drains inside the branch above,
         * which is the branch for the living — so a death was enough to build a
         * forty-deep backlog, and a backlog that deep is the speed-hack
         * signature. Somebody who blew themselves up with their own rocket was
         * being flagged for it while they waited to respawn.
         *
         * Dropping them is also the right thing on its own terms: they describe
         * a body that no longer exists, and replaying them into a fresh spawn
         * would walk it off the spawn point with input from before the death.
         */
        if (p.inputQueue.length) {
          p.lastSeq = p.inputQueue[p.inputQueue.length - 1].seq;
          p.lastInputAt = this.now;
          p.inputQueue.length = 0;
        }
        p.inputOverflow = 0;
        if (p.isBot && this.now >= p.respawnAt) this.respawn(p);
      }

      p.recordHistory(this.now);
      ac.decay(p, this.now);
    }

    this.sweepAfk();
    this.stepProjectiles(dt);
    this.stepObjectives(dt);
    this.maybePushScore(dt);

    // The nuke: its countdown, and the end of the match it brings with it.
    if (this.nuke && this.now >= this.nuke.at) this.detonateNuke();
    if (this.nukeEndAt && this.now >= this.nukeEndAt) {
      this.nukeEndAt = 0;
      this.endMatch('nuke');
    }
    if (this.nukeStateAcc === undefined) this.nukeStateAcc = 0;
    this.nukeStateAcc += dt;
    if (this.nukeStateAcc >= 0.5) {
      this.nukeStateAcc = 0;
      for (const p of this.players.values()) {
        if (!p.isBot && !p.spectator) this.sendNukeState(p);
      }
    }

    // The practice range never ends: there is nothing to win, so no clock.
    if (this.mode.practice) {
      this.matchEnd = this.now + 3600;
      return;
    }
    if (this.state === 'live' && this.now >= this.matchEnd) this.endMatch('time');
    else if (this.state === 'intermission' && this.now >= this.intermissionUntil) this.rotate();
  }

  /** Post-movement consequences: fall damage and the out-of-world kill plane. */
  postStep(p) {
    if (p.state.landed) {
      const fd = fallDamage(p.state.fallSpeed);
      if (fd > 0) {
        const res = p.applyDamage(fd, this.now, 0);
        if (res.damage > 0) {
          this.sendTo(p, { o: K.S2C.DAMAGE, from: 0, damage: res.damage, health: Math.round(p.health), fall: true });
        }
        if (res.dead) this.onKill(null, p, 'fall', false);
      }
    }
    // The void takes everybody except the one player it cannot: `applyDamage`
    // already refuses, and killing anyway would make god mode a slower death.
    if (p.alive && !p.god && p.state.y < -40) {
      p.applyDamage(K.MAX_HEALTH, this.now, 0);
      this.onKill(null, p, 'void', false);
    }
  }

  /**
   * Builds and sends one snapshot to every human in the room.
   *
   * The body of a snapshot is the same for everybody in it — one entry per
   * player on the roster — and only three fields differ: your own position,
   * your own health, and the fact that your entry is left out of the list.
   * So each entry is serialised **once** and the per-player message is
   * assembled by concatenating those strings, instead of handing
   * `JSON.stringify` the same eight arrays eight times.
   *
   * At eight players and 20 Hz that is 64 array serialisations a second per
   * room instead of 512, and the room list is no longer a fixed eight.
   */
  sendSnapshots() {
    if (this.dormant) return;            // nobody to send to, nothing to say
    const roster = this.roster;
    const ids = this._snapIds ?? (this._snapIds = []);
    const parts = this._snapParts ?? (this._snapParts = []);
    ids.length = 0;
    parts.length = 0;
    for (const p of roster) {
      ids.push(p.id);
      parts.push(JSON.stringify(p.netEntry(r2)));
    }

    const t = Math.round(this.now * 1000);
    const clock = this.state === 'live' && !this.mode.practice
      ? Math.round(this.matchEnd - this.now) : -1;
    const phase = this.state === 'live' ? 1 : 0;
    // Everyone's list, joined once. A player's own entry is cut out of it
    // below rather than the whole thing being rebuilt per recipient.
    const all = parts.join(',');

    for (const p of this.players.values()) {
      if (p.isBot || !p.ws || p.ws.readyState !== 1) continue;
      const s = p.state;

      let list = all;
      if (!p.spectator) {
        const self = ids.indexOf(p.id);
        if (self >= 0) {
          list = '';
          for (let i = 0; i < parts.length; i++) {
            if (i === self) continue;
            if (list) list += ',';
            list += parts[i];
          }
        }
      }

      // A spectator has no body of its own; it just watches the roster.
      const body = p.spectator ? 'null'
        : `[${r2(s.x)},${r2(s.y)},${r2(s.z)},${r2(s.vx)},${r2(s.vy)},${r2(s.vz)},`
          + `${s.onGround ? 1 : 0},${r2(s.height)}]`;

      /*
       * The one thing a watcher cannot read off the roster: how much is left in
       * the magazine of the person they are watching.
       *
       * Everything else on a spectator's HUD — health, weapon slot, class,
       * score — is already in the entry for that player, because everybody gets
       * everybody's. Ammo never was, so it rides along only for the body a
       * spectator is actually pointed at, and only to that spectator.
       */
      let extra = '';
      if (p.spectator && p.specTarget) {
        const watched = this.players.get(p.specTarget);
        const w = watched?.weapon;
        if (w) extra = `,"sa":[${w.ammo | 0},${w.reserve | 0},${w.reloading ? 1 : 0}]`;
      }

      const msg = `{"o":"${K.S2C.SNAPSHOT}","t":${t},"q":${p.lastSeq},"y":${body},`
        + `"h":${Math.round(p.health)},"p":[${list}],"m":${clock},"ph":${phase}${extra}}`;
      try { p.ws.send(msg); } catch { /* socket died mid-send */ }
    }
  }

  /* ── Bots ──────────────────────────────────────────────────────────────── */

  /**
   * Keeps roughly `target` bots in the room, capped by the player limit.
   *
   * A dormant room is staffed by nobody: bots exist so that a player who walks
   * into a quiet room has something to shoot at, and there is no such player.
   */
  fillBots(target) {
    const wanted = this.dormant ? 0 : target;
    const want = Math.max(0, Math.min(wanted, config.maxPlayersPerRoom - this.playerCount));
    let bots = this.botCount;
    while (bots < want) { this.addBot(); bots++; }
    while (bots > want) {
      const bot = [...this.players.values()].find((p) => p.isBot);
      if (!bot) break;
      this.remove(bot.id);
      bots--;
    }
  }

  addBot() {
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const classId = this.mode.gunGame ? K.GUN_GAME_LADDER[0] : BotBrain.pickClass();
    const bot = new Player({ isBot: true, name: BotBrain.pickName(taken), classId });
    bot.level = 1 + Math.floor(Math.random() * 40);
    bot.brain = new BotBrain(bot);
    this.add(bot);
    return bot;
  }

  info() {
    return {
      id: this.id, code: this.code, map: this.mapId, mapName: this.map.name,
      spectators: this.spectatorCount,
      mode: this.modeId, modeName: this.mode.name,
      players: this.playerCount, bots: this.botCount,
      capacity: config.maxPlayersPerRoom,
      // Listed and joinable, but not simulating: nobody is in it.
      idle: this.dormant,
      phase: this.dormant ? 'idle' : this.state,
      endsIn: Math.max(0, Math.round(this.matchEnd - this.now)),
      teamScore: this.mode.teams ? { red: this.teamScore[K.TEAM.RED], blue: this.teamScore[K.TEAM.BLUE] } : null,
      mapSize: this.map.size,
      tags: this.map.tags ?? [],
      practice: !!this.mode.practice,
      vote: this.state === 'intermission' ? this.voteState() : null,
    };
  }
}

export default Room;
