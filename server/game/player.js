/**
 * Open Grunker — server-side player entity.
 *
 * Owns the authoritative movement state, weapon/ammo state, score, and the
 * short position history that lag compensation rewinds through.
 */
import * as K from '../../shared/constants.js';
import { createState, eyeY } from '../../shared/movement.js';
import { getClass, loadoutFor, PISTOL, KNIFE } from '../../shared/weapons.js';
import { SLOT, DEFAULT_EQUIP } from '../../shared/cosmetics.js';
import { CheatState } from './anticheat.js';

const HISTORY = 40;                                  // ~0.66 s at 60 Hz

let nextId = 1;

export class Player {
  /** A blank match scorecard. */
  static emptyScore() {
    return {
      kills: 0, deaths: 0, assists: 0, headshots: 0,
      damage: 0, shotsFired: 0, shotsHit: 0, streak: 0, bestStreak: 0, score: 0,
      midairs: 0, noscopes: 0, drifts: 0, melees: 0, longestShot: 0, multikills: 0,
      longshots: 0, captures: 0, defends: 0, nukes: 0,
    };
  }

  /** @param {object} o { ws, name, userId, classId, isBot } */
  constructor(o = {}) {
    this.id = nextId++;
    this.ws = o.ws ?? null;
    this.isBot = !!o.isBot;
    this.userId = o.userId ?? null;
    this.name = o.name ?? 'Guest';
    this.level = o.level ?? 1;
    this.skin = o.skin ?? 'default';
    /** Every class's chosen primary finish, so a class swap swaps the finish with it. */
    this.skins = o.skins ?? {};
    /**
     * The whole worn loadout: `{ <slot>: <itemId> }` for all nine slots.
     *
     * It travels on the profile rather than being looked up per player per
     * frame, because everybody else's renderer needs it exactly once — when
     * the body is built — and never again until it changes.
     */
    this.cos = o.cos ?? { ...DEFAULT_EQUIP };
    /** Per-class primary finishes, as item ids. Swapped into `cos` on a class change. */
    this.primaries = o.primaries ?? {};
    this.verified = !!o.verified;
    /**
     * Creator status, as `{ kind, status }` or null — the two fields
     * `creatorCan()` asks about and nothing else.
     *
     * It rides on the player rather than being looked up per kill for the same
     * reason the clan tag does: the room needs it at the exact moment somebody
     * dies, and a database read on the death path is a database read sixty
     * times a minute in a busy match.
     */
    this.creator = o.creator ?? null;
    /**
     * The anthem this player's kills play, as a URL, and what it is called.
     *
     * Resolved once at the handshake — the server is what turns a stored
     * filename into a public URL, so a client can never name the file it wants
     * played into somebody else's ears.
     */
    this.anthem = o.anthem ?? null;
    this.anthemTitle = o.anthemTitle ?? null;
    this.clan = o.clan ?? null;
    /** Is the clan behind that tag one the developers have verified? Gold, not grey. */
    this.clanVerified = !!o.clanVerified;
    this.role = K.ROLES.includes(o.role) ? o.role : 'player';
    /** Chat mute: 0 none, -1 permanent, else unix seconds. Seeded from the db. */
    this.mutedUntil = o.mutedUntil ?? 0;
    /** Connection address, bare (no ::ffff: prefix) — used by IP bans. */
    this.ip = o.ip ? String(o.ip).replace(/^::ffff:/i, '').toLowerCase() : null;
    /** Watching the map from the menu: present on the socket, absent from the match. */
    this.spectator = !!o.spectator;
    /**
     * God mode: invincible and flying. Admins only, and never persisted — it
     * lasts as long as the connection that asked for it and no longer.
     */
    this.god = false;
    this.team = K.TEAM.NONE;

    this.classId = o.classId ?? 'triggerman';
    this.state = createState(0, 0, 0, 0);
    this.health = K.MAX_HEALTH;
    this.alive = false;
    this.respawnAt = 0;
    this.protectedUntil = 0;
    this.lastDamageAt = -999;
    this.lastCombatAt = -999;      // dealt *or* took damage — drives the class swap rule
    this.joinedAt = Date.now();

    this.slot = 0;
    this.weapons = [];
    this.setClass(this.classId, true);

    this.inputQueue = [];
    this.lastSeq = 0;
    /** The room's own shot counter — what a round's spread is actually seeded from. */
    this.shotSeq = 0;
    /**
     * The last sequence this client *claimed*, which is a different number.
     *
     * The client counts every round it fires; the room counts every round it
     * accepts, and it declines plenty. Only the client's claim against its own
     * previous claim says anything about whether a seed was picked rather than
     * counted — see `Room.checkShotSeq`.
     */
    this.claimedShotSeq = null;
    this.rtt = 0.08;
    this.lastMessageAt = Date.now();

    /* ── What the server will not take this client's word for ──────────────
     * Everything below is measured or counted here rather than read out of a
     * packet, because every one of them used to be a field a client could
     * simply fill in: how far behind it was running, where it was looking, how
     * many simulation steps it was owed, whether it was aiming down sights.
     * ────────────────────────────────────────────────────────────────────── */

    /** Anti-cheat bookkeeping for this connection — see game/anticheat.js. */
    this.cheat = new CheatState();

    /**
     * Round trip, timed by the server.
     *
     * Every PONG carries a token; the client hands the last one it saw back on
     * its next PING, and the gap between sending that token and seeing it again
     * is one measured round trip. A median of the last few is what lag
     * compensation rewinds by, and a claim in a packet is never read again —
     * inflating it was the whole of the backtrack exploit.
     */
    this.rttSamples = [];
    this.pingToken = 0;
    this.pingSentAt = 0;
    /** What the client last claimed its ping was. Kept only to compare. */
    this.claimedRtt = 0;

    /**
     * Simulation steps this connection has earned but not yet spent.
     *
     * Refilled one per tick, capped at INPUT_BUDGET_BURST. A client that sends
     * three inputs per tick forever gets one per tick forever, which is what
     * turns the speed hack into a queue that only ever grows.
     */
    this.inputCredit = K.INPUT_BUDGET_START;
    /** Inputs discarded because the budget ran dry — the speed-hack signature. */
    this.inputOverflow = 0;

    /**
     * The view this client has actually been streaming, newest last.
     *
     * A shot's claimed angles are checked against this rather than believed.
     * Two entries is all the check needs — the freshest view and the one before
     * it, which together give the turn rate the tolerance opens with.
     */
    this.viewYaw = 0;
    this.viewPitch = 0;
    this.viewAt = 0;
    this.viewTurnRate = 0;
    /**
     * The ADS bit of the freshest input received, queued or not.
     *
     * `ads` below is the one the tick spent, which is what the body moved at;
     * this is what the trigger was pulled under. They differ for exactly one
     * shot — the one fired on the tick the sights come down — and that shot is
     * a quickscope.
     */
    this.heldAds = null;
    /** Consecutive shots claiming sights the stream never held. */
    this.adsMismatch = 0;

    /**
     * When this connection last did something a person does.
     *
     * A page left open still streams sixty inputs a second and answers every
     * ping; none of that is playing. Only a key held or the view moving counts,
     * which is also why an anti-AFK cheat has nothing to send.
     */
    this.lastActiveAt = Date.now();
    /**
     * What the client currently has on screen about it: 'warn', 'out', or null.
     *
     * Kept apart from the idleness itself on purpose. The sweep compares this
     * against what is now true and sends the difference, so a notice is put up
     * once, taken down once, and never re-sent every second it stands — and
     * coming back to the keyboard is what takes it down rather than anything
     * having to remember it was up.
     */
    this.afkNotified = null;
    /** Set once the seat has been handed back, so it is handed back once. */
    this.afk = false;
    /** Input packets seen in the current second — the flood ceiling. */
    this.packetWindow = 0;
    this.packetWindowAt = -1;
    this.lastChatAt = 0;
    this.lastModAt = 0;
    this.lastGodAt = 0;
    /** Last report filed from this connection — the double-click guard. */
    this.lastReportAt = 0;
    this.warnings = 0;

    /**
     * The lag-compensation ring, allocated once and written through.
     *
     * One tick per player per 60th of a second is one object per player per
     * 60th of a second, and every one of them was garbage before the next
     * second was out. Filling the ring up front turns the busiest allocation
     * in the server into six field writes.
     */
    this.history = Array.from({ length: HISTORY }, () => ({ t: -1, x: 0, y: 0, z: 0, h: 0, alive: false }));
    this.histIndex = 0;
    this.histCount = 0;

    /** attackerId -> { damage, at } for assist credit. */
    this.damagedBy = new Map();

    this.score = Player.emptyScore();
    this.lastKillAt = -999;
    this.lastKilledBy = 0;
    this.dirtyLoadout = false;

    /** Gun Game: which rung of the ladder this player is on, and kills on it. */
    this.ggRung = 0;
    this.ggKills = 0;
    /** Weapon mastery: kills this match, per weapon id, flushed on match end. */
    this.weaponKills = new Map();
    /** Which map this player voted for during the intermission. */
    this.vote = null;
    /**
     * Whether this client has been told the nuke is theirs to launch.
     *
     * Mirrored here so the room only sends the frame when the answer actually
     * changes — it is re-tested twice a second for everybody in the match.
     */
    this.nukeArmed = false;
    /** Spectator camera target when watching rather than playing. */
    this.specTarget = 0;
    /**
     * Has this player asked to watch rather than play?
     *
     * Separate from `spectator`, which is what they *are* right now. Someone
     * alive in the middle of a firefight who flips the switch does not vanish
     * out of it: the wish is recorded here and the room acts on it at the next
     * death, which is the only moment a body can leave the world without
     * anybody else noticing something impossible.
     */
    this.wantsSpectate = false;
    /**
     * Did watching cost this player a seat?
     *
     * Turning the switch off has to put them back where they came from: into
     * the match for someone who was playing it, and back to the menu for
     * someone who flipped the switch while watching the backdrop and has still
     * never pressed PLAY.
     */
    this.specFromSeat = false;
  }

  /** Records a kill against the weapon that made it, for mastery progress. */
  creditWeapon(weaponId) {
    if (!weaponId || this.isBot || !this.userId) return;
    this.weaponKills.set(weaponId, (this.weaponKills.get(weaponId) ?? 0) + 1);
  }

  /* ── Loadout ───────────────────────────────────────────────────────────── */

  setClass(classId, force = false) {
    const def = getClass(classId);
    if (!force && def.id === this.classId) return false;
    this.classId = def.id;
    this.skin = this.skins?.[def.id] ?? 'default';
    // The primary finish follows the class, the other eight slots do not.
    const primary = this.primaries?.[def.id];
    if (primary) this.cos = { ...this.cos, [SLOT.PRIMARY]: primary };
    this.weapons = loadoutFor(def.id).map((w) => ({
      def: w,
      ammo: w.magSize ?? 0,
      // -1 means "unlimited": every class carries infinite reserve ammo.
      reserve: K.INFINITE_AMMO ? -1 : (w.reserve ?? 0),
      reloading: false,
      reloadEnd: 0,
      lastShot: -999,
      burst: 0,
      pumpUntil: 0,
    }));
    this.slot = 0;
    return true;
  }

  /** Stable key for one human across a leave/rejoin inside the same match. */
  get identity() { return this.userId ? `u${this.userId}` : `n${this.name.toLowerCase()}`; }

  /** Can this player act on other players — mute them from a match's chat? */
  get isStaff() { return K.canModerate(this.role); }

  /** Is this player's chat currently muted? A lapsed mute reads as clean. */
  get muted() {
    return this.mutedUntil === -1
      || (this.mutedUntil > 0 && this.mutedUntil > Math.floor(Date.now() / 1000));
  }

  /** The badges that follow this nickname wherever it is drawn. */
  get tags() {
    return {
      level: this.level, verified: !!this.verified,
      clan: this.clan ?? null, clanVerified: !!this.clanVerified, role: this.role,
      // The discipline, or null — one short string that every scoreboard,
      // killfeed and card turns into the same badge. `status` never travels:
      // a pending application is not a badge, so `setCreator` below is what
      // decides, once, whether there is anything here to draw at all.
      creator: this.creatorKind,
      // Is there a profile behind this name? Guests and bots have none, so the
      // client knows not to offer a link that could only ever 404.
      account: !!this.userId,
    };
  }

  /**
   * Re-badges a live connection after its account changed underneath it —
   * founding a clan, being invited into one, being removed from one.
   *
   * The room re-broadcasts the scoreboard afterwards, so nobody has to
   * reconnect to stop wearing a tag they no longer hold.
   */
  /** The discipline to draw beside this name, or null. Approved only. */
  get creatorKind() {
    return this.creator?.status === 'approved' ? this.creator.kind : null;
  }

  /**
   * Re-badges a live connection whose creator status changed underneath it.
   *
   * The mirror of `setClan`, and it exists for the same reason: an approval, a
   * rejection or a revocation lands while somebody is mid-match, and making
   * them reconnect to stop wearing a badge they no longer hold — or to start
   * wearing one they just earned — would be the wrong answer to both.
   */
  setCreator(creator) {
    const before = this.creatorKind;
    this.creator = creator ?? null;
    return before !== this.creatorKind;
  }

  /** Swaps the anthem a moderator just took down, without a reconnect. */
  setAnthem(url, title = null) {
    this.anthem = url ?? null;
    this.anthemTitle = title ?? null;
  }

  setClan(clan, verified = false) {
    const changed = (this.clan ?? null) !== (clan ?? null) || !!this.clanVerified !== !!verified;
    this.clan = clan ?? null;
    this.clanVerified = !!verified;
    return changed;
  }

  get weapon() { return this.weapons[this.slot]; }
  get weaponDef() { return this.weapons[this.slot].def; }

  /** Movement multiplier from the equipped weapon (and ADS). */
  speedMult(ads) {
    const d = this.weaponDef;
    const base = d.moveMult ?? 1;
    return ads ? base * (d.adsMoveMult ?? 0.6) : base;
  }

  /* ── What the server measures for itself ───────────────────────────────── */

  /**
   * Records the view an input packet carried, and the rate it is turning at.
   *
   * The rate is the whole reason the previous sample is kept: a shot that
   * arrives a few milliseconds after the input it belongs to is allowed to have
   * moved by however fast the mouse was already going, and no faster. Someone
   * mid-flick gets a wide gate; someone holding perfectly still — which is
   * exactly what a silent aim looks like from here — gets a narrow one.
   *
   * @param {number} yaw
   * @param {number} pitch
   * @param {number} atSec server clock, seconds
   */
  recordView(yaw, pitch, atSec) {
    if (this.viewAt > 0) {
      const dt = atSec - this.viewAt;
      if (dt > 1e-4 && dt < 0.5) {
        const moved = Math.hypot(yaw - this.viewYaw, pitch - this.viewPitch);
        // Smoothed, and only ever upwards in a hurry: the gate must already be
        // open on the first packet of a flick, not one packet late.
        const rate = moved / dt;
        this.viewTurnRate = rate > this.viewTurnRate
          ? rate
          : this.viewTurnRate + (rate - this.viewTurnRate) * 0.25;
      }
    }
    this.viewYaw = yaw;
    this.viewPitch = pitch;
    this.viewAt = atSec;
  }

  /**
   * Folds one server-timed round trip into the median this player is
   * lag-compensated by. Nothing the client says about its own latency is read.
   */
  noteRtt(seconds) {
    if (!(seconds >= 0) || seconds > K.RTT_MAX) return;
    this.rttSamples.push(seconds);
    if (this.rttSamples.length > K.RTT_SAMPLES) this.rttSamples.shift();
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    this.rtt = sorted[sorted.length >> 1];
  }

  /** Marks this connection as still being played by a person. */
  noteActivity(nowMs = Date.now()) {
    this.lastActiveAt = nowMs;
    this.afk = false;
  }

  /** Seconds since this connection last did something a person does. */
  idleSec(nowMs = Date.now()) { return (nowMs - this.lastActiveAt) / 1000; }

  /* ── Life cycle ────────────────────────────────────────────────────────── */

  spawnAt(x, y, z, yaw, now) {
    this.state = createState(x, y, z, yaw);
    this.health = K.MAX_HEALTH;
    this.alive = true;
    this.protectedUntil = now + K.SPAWN_PROTECTION;
    this.lastDamageAt = now;
    this.lastCombatAt = -999;
    this.damagedBy.clear();
    this.histCount = 0;
    for (const w of this.weapons) {
      w.ammo = w.def.magSize ?? 0;
      w.reserve = K.INFINITE_AMMO ? -1 : (w.def.reserve ?? 0);
      w.reloading = false;
      w.burst = 0;
    }
    this.slot = 0;
  }

  kill(now) {
    this.alive = false;
    this.health = 0;
    this.respawnAt = now + K.RESPAWN_TIME;
    this.score.deaths++;
    this.score.streak = 0;
  }

  /** @returns {{dead:boolean, damage:number}} */
  applyDamage(amount, now, attackerId = 0) {
    // God mode is checked here rather than at each of the half-dozen call
    // sites, so a bullet, a rocket, a nuke, a fall and the kill plane are all
    // covered by one rule and a new source of damage cannot forget it.
    if (this.god) return { dead: false, damage: 0 };
    if (!this.alive || now < this.protectedUntil) return { dead: false, damage: 0 };
    const dealt = Math.min(this.health, amount);
    this.health -= dealt;
    this.lastDamageAt = now;
    this.lastCombatAt = now;
    if (attackerId) {
      const prev = this.damagedBy.get(attackerId) ?? { damage: 0, at: 0 };
      this.damagedBy.set(attackerId, { damage: prev.damage + dealt, at: now });
    }
    return { dead: this.health <= 0, damage: dealt };
  }

  regen(now, dt) {
    if (!this.alive || this.health >= K.MAX_HEALTH) return;
    if (now - this.lastDamageAt < K.REGEN_DELAY) return;
    this.health = Math.min(K.MAX_HEALTH, this.health + K.REGEN_RATE * dt);
  }

  /* ── Lag-compensation history ──────────────────────────────────────────── */

  recordHistory(now) {
    const s = this.state;
    const e = this.history[this.histIndex];
    e.t = now; e.x = s.x; e.y = s.y; e.z = s.z; e.h = s.height; e.alive = this.alive;
    this.histIndex = (this.histIndex + 1) % HISTORY;
    if (this.histCount < HISTORY) this.histCount++;
  }

  /** Interpolated body position at a past server time. */
  rewind(time) {
    if (this.histCount === 0) {
      const s = this.state;
      return { x: s.x, y: s.y, z: s.z, h: s.height, alive: this.alive };
    }
    let newer = null, older = null;
    for (let i = 1; i <= this.histCount; i++) {
      const e = this.history[(this.histIndex - i + HISTORY) % HISTORY];
      if (!e) continue;
      if (e.t >= time) { newer = e; continue; }
      older = e;
      break;
    }
    if (!older) return newer ?? this.history[(this.histIndex - 1 + HISTORY) % HISTORY];
    if (!newer) return older;
    const span = newer.t - older.t;
    const a = span > 1e-6 ? (time - older.t) / span : 0;
    return {
      x: older.x + (newer.x - older.x) * a,
      y: older.y + (newer.y - older.y) * a,
      z: older.z + (newer.z - older.z) * a,
      h: older.h + (newer.h - older.h) * a,
      alive: older.alive,
    };
  }

  eye() { return { x: this.state.x, y: eyeY(this.state), z: this.state.z }; }

  /* ── Wire ──────────────────────────────────────────────────────────────── */

  /** Compact per-player entry for the snapshot. */
  netEntry(r2) {
    const s = this.state;
    let flags = 0;
    if (this.alive) flags |= 1;
    if (s.onGround) flags |= 2;
    if (s.crouching) flags |= 4;
    if (s.sliding) flags |= 8;
    if (this.ads) flags |= 16;
    if (this.firing) flags |= 32;
    return [
      this.id, r2(s.x), r2(s.y), r2(s.z), r2(s.yaw), r2(s.pitch),
      flags, Math.round(this.health), this.slot,
      r2(Math.hypot(s.vx, s.vz)),
    ];
  }

  /** Full descriptor sent on join / welcome. */
  profile() {
    return {
      id: this.id, name: this.name, team: this.team, classId: this.classId,
      skin: this.skin, cos: this.cos, bot: this.isBot, ...this.tags,
      kills: this.score.kills, deaths: this.score.deaths, score: this.score.score,
    };
  }

  scoreboardRow() {
    const sc = this.score;
    return {
      id: this.id, name: this.name, team: this.team, classId: this.classId,
      bot: this.isBot, ...this.tags, muted: this.muted,
      kills: sc.kills, deaths: sc.deaths, assists: sc.assists, headshots: sc.headshots,
      damage: Math.round(sc.damage), score: sc.score, streak: sc.streak,
      bestStreak: sc.bestStreak, midairs: sc.midairs, noscopes: sc.noscopes,
      accuracy: sc.shotsFired ? Math.round((sc.shotsHit / sc.shotsFired) * 1000) / 10 : 0,
      gr: Math.max(0, Math.floor(sc.score / K.GR_PER_SCORE)),
      ping: Math.round(this.rtt * 1000),
      rung: this.ggRung,
      captures: sc.captures,
    };
  }
}

export const SIDEARMS = { PISTOL, KNIFE };
export default Player;
