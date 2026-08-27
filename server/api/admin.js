/**
 * Open Grunker — administration API.
 *
 * Deliberately unreachable from the internet: every route refuses a request
 * that did not arrive on loopback (the public nginx vhost never proxies
 * /admin either), and the password lives in .env rather than in the accounts
 * table. Sessions are in-memory bearer tokens that die with the process.
 *
 * Mounted at /api/v1/admin, with the panel itself served from /admin.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as K from '../../shared/constants.js';
import { Router, ApiError } from './router.js';
import { ok, json, readJson } from '../util/http.js';
import { hashPassword } from '../util/auth.js';
import * as avatars from '../util/avatar.js';
import { getMap } from '../../shared/maps.js';
import { getClass } from '../../shared/weapons.js';
import { clanAvatars } from '../util/avatar.js';
import config from '../config.js';
import log, { recent as recentLogs } from '../util/log.js';
import { SERIES_META, GAUGES, COUNTERS } from '../game/telemetry.js';

const logger = log.child('admin');

/**
 * Does this path segment look like an entity id?
 *
 * Every id in the database is a UUID, and no nickname or clan tag can be one —
 * both are far too short and neither may contain a hyphen — so this is what
 * lets `/players/:id` accept an id or a name without either shadowing the other.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => UUID_RE.test(String(v ?? ''));

/**
 * How a connected guest is addressed: `guest:<connection id>`.
 *
 * A connection id is a small integer handed out by the process and reused
 * after a restart, which is exactly right for something that only means
 * anything while the socket is open. It cannot collide with a UUID or with a
 * nickname — no name may contain a colon.
 */
const GUEST_RE = /^guest:(\d+)$/i;

/* ── Sessions ────────────────────────────────────────────────────────────── */

/** token -> expiry (ms). Cleared on restart, which is the point. */
const tokens = new Map();
const FAILURES = new Map();          // ip -> { count, until }

const nowMs = () => Date.now();

function issueToken() {
  const token = randomBytes(24).toString('base64url');
  tokens.set(token, nowMs() + config.adminTokenTtlMin * 60_000);
  for (const [t, exp] of tokens) if (exp < nowMs()) tokens.delete(t);
  return token;
}

function validToken(token) {
  if (!token) return false;
  const exp = tokens.get(token);
  if (!exp) return false;
  if (exp < nowMs()) { tokens.delete(token); return false; }
  return true;
}

/** Constant-time password comparison that tolerates different lengths. */
function passwordMatches(given) {
  const want = Buffer.from(config.adminPassword ?? '', 'utf8');
  const got = Buffer.from(String(given ?? ''), 'utf8');
  if (want.length === 0) return false;
  const padded = Buffer.alloc(want.length);
  got.copy(padded, 0, 0, Math.min(got.length, want.length));
  return timingSafeEqual(want, padded) && got.length === want.length;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Strips the IPv6 mapping Node puts on IPv4 sockets. */
const bare = (ip) => String(ip ?? '').replace(/^::ffff:/, '');

/** RFC1918 / link-local / unique-local — i.e. "somewhere on this network". */
export function isPrivateAddress(ip) {
  const a = bare(ip);
  if (LOOPBACK.has(a) || a === '::1') return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;                 // link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(a)) return true;          // unique-local IPv6
  if (/^fe80:/i.test(a)) return true;                      // link-local IPv6
  return false;
}

/**
 * True for a request that came from this machine or from the local network.
 *
 * The socket address alone is not enough: nginx proxies public traffic from
 * loopback too. A proxied request always carries forwarding headers, so a
 * private socket address with none of them is the one case that is genuinely
 * local. (nginx also refuses /admin outright — this is the second lock, and
 * the admin listener is a separate socket the public vhost never touches.)
 */
export function isLocalRequest(req) {
  if (!config.adminLocalOnly) return true;
  const socketIp = req?.socket?.remoteAddress ?? '';
  const allowed = config.adminAllowLan
    ? isPrivateAddress(socketIp)
    : LOOPBACK.has(socketIp);
  if (!allowed) return false;
  const h = req.headers ?? {};
  return !h['x-forwarded-for'] && !h['x-real-ip'] && !h['cf-connecting-ip'] && !h['x-forwarded-proto'];
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Puts a human-readable `name` on each row of a `{key, n}` mix. */
const named = (rows, lookup) => rows.map((r) => ({ ...r, name: lookup(r.key) ?? r.key }));

/** Clamped integer from a query string. Absent or unparseable falls back. */
const num = (v, min, max, fallback = 0) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const adminUser = (u, s, ipBans = null, chatBan = null, reportBan = null) => ({
  id: u.id,
  username: u.username,
  email: u.email ?? null,
  emailVerified: !!u.email_verified,
  level: u.level,
  xp: u.xp,
  gr: u.gr,
  verified: !!u.verified,
  avatar: avatars.urlFor(u.avatar),
  avatarAt: u.avatar_at ?? null,
  clan: u.clan ?? null,
  clanId: u.clan_id ?? null,
  clanVerified: !!u.clan_verified,
  role: u.role,
  bannedUntil: u.banned_until,
  banReason: u.ban_reason ?? null,
  banned: u.banned_until === -1 || (u.banned_until > 0 && u.banned_until > Math.floor(nowMs() / 1000)),
  createdAt: u.created_at,
  lastLogin: u.last_login ?? null,
  lastIp: u.last_ip ?? null,
  ipBans: ipBans ?? [],
  chatBan: chatBan
    ? { until: chatBan.until, reason: chatBan.reason ?? null, actor: chatBan.actor ?? null }
    : null,
  muted: !!chatBan,
  // The REPORT button, switched off for this one account. Deliberately its own
  // sanction rather than part of a mute: someone abusing the report queue is
  // usually not the same person as someone abusing the chat.
  reportBan: reportBan
    ? { until: reportBan.until, reason: reportBan.reason ?? null, actor: reportBan.actor ?? null }
    : null,
  reportsBlocked: !!reportBan,
  stats: {
    kills: s?.kills ?? 0, deaths: s?.deaths ?? 0, assists: s?.assists ?? 0,
    headshots: s?.headshots ?? 0, wins: s?.wins ?? 0, losses: s?.losses ?? 0,
    matches: s?.matches ?? 0, damage: s?.damage_dealt ?? 0, score: s?.score ?? 0,
    bestStreak: s?.best_streak ?? 0, playtime: s?.playtime_sec ?? 0,
    shotsFired: s?.shots_fired ?? 0, shotsHit: s?.shots_hit ?? 0,
    kd: Math.round(((s?.kills ?? 0) / Math.max(1, s?.deaths ?? 0)) * 100) / 100,
    accuracy: s?.shots_fired ? Math.round((s.shots_hit / s.shots_fired) * 1000) / 10 : 0,
  },
});

/**
 * A guest, as a row in the players table.
 *
 * Guests have no account, so there is nothing in the database to moderate —
 * and until now that meant the one player a moderator most often needs to
 * remove was the one player the panel could not see. A connected guest is put
 * on the list for exactly as long as they are connected, under the id
 * `guest:<connection>`, carrying the same field names an account row does so
 * the table, the search box and the status tag all keep working unchanged.
 *
 * Nothing about this is persisted. The row *is* the connection: it appears
 * when they join and is gone the moment they leave, which is also why the only
 * sanction it offers is one that outlives the socket — a ban on the address.
 */
const adminGuest = ({ player, room }, ipBan = null) => {
  const sc = player.score ?? {};
  const joined = Math.floor((player.joinedAt ?? nowMs()) / 1000);
  return {
    id: `guest:${player.id}`,
    guest: true,
    username: player.name,
    email: null,
    emailVerified: false,
    level: player.level ?? 1,
    xp: 0,
    gr: 0,
    verified: false,
    avatar: null,
    avatarAt: null,
    clan: null,
    clanId: null,
    clanVerified: false,
    role: 'guest',
    bannedUntil: ipBan?.until ?? 0,
    banReason: ipBan?.reason ?? null,
    banned: !!ipBan,
    createdAt: joined,
    lastLogin: joined,
    lastIp: player.ip ?? null,
    ipBans: ipBan ? [ipBan] : [],
    chatBan: null,
    muted: false,
    reportBan: null,
    reportsBlocked: false,
    /** Where they are right now — the only history a guest has. */
    live: {
      room: room?.code ?? null,
      roomId: room?.id ?? null,
      map: room?.mapId ?? null,
      mode: room?.modeId ?? null,
      spectator: !!player.spectator,
      since: joined,
    },
    // The current match's scorecard, not a career: there is nowhere to keep one.
    stats: {
      kills: sc.kills ?? 0, deaths: sc.deaths ?? 0, assists: sc.assists ?? 0,
      headshots: sc.headshots ?? 0, wins: 0, losses: 0, matches: 0,
      damage: sc.damage ?? 0, score: sc.score ?? 0, bestStreak: sc.bestStreak ?? 0,
      playtime: Math.max(0, Math.round(nowMs() / 1000) - joined),
      shotsFired: sc.shotsFired ?? 0, shotsHit: sc.shotsHit ?? 0,
      kd: Math.round(((sc.kills ?? 0) / Math.max(1, sc.deaths ?? 0)) * 100) / 100,
      accuracy: sc.shotsFired ? Math.round((sc.shotsHit / sc.shotsFired) * 1000) / 10 : 0,
    },
  };
};

/** One report as the panel renders it. The chat snapshot travels separately. */
const reportPayload = (rep) => ({
  id: rep.id,
  reporter: rep.reporterName,
  reporterId: rep.reporterId,
  target: rep.targetName,
  targetId: rep.targetId,
  targetIp: rep.targetIp,
  reason: rep.reason,
  reasonLabel: K.reportReasonLabel(rep.reason),
  detail: rep.detail,
  room: rep.room,
  mode: rep.mode,
  map: rep.map,
  at: rep.createdAt,
  status: rep.status,
  statusLabel: K.REPORT_STATUS[rep.status]?.label ?? String(rep.status).toUpperCase(),
  action: rep.action,
  outcome: rep.outcome,
  resolver: rep.resolver,
  resolvedAt: rep.resolvedAt,
  messages: rep.chatLog?.length ?? 0,
});

/* ── Router ──────────────────────────────────────────────────────────────── */

/**
 * @param {object} deps { db, hub }
 * @returns {Router}
 */
export function createAdminApi({ db, hub, telemetry = null, banPayload = null }) {
  const r = new Router();

  /**
   * Every address a ban should follow: the one on the account row plus any
   * this player is connected from right now.
   */
  const addressesFor = (user) => {
    const out = new Set();
    if (user.last_ip) out.add(db.normaliseIp(user.last_ip));
    for (const { player } of hub.findConnections({ userId: user.id })) {
      if (player.ip) out.add(player.ip);
    }
    out.delete('');
    return [...out];
  };

  /**
   * Lands a ban on the live connections it covers: a red line in their match's
   * chat, the ban screen, then the socket. Returns how many were dropped.
   *
   * A connection can be caught two ways, and they read differently to the room.
   * The banned account is named; anyone else sharing the address was collateral
   * of an IP ban and is told so rather than accused of something.
   */
  const enforce = (info, { userId = null, ips = [] } = {}) => {
    if (!banPayload) return 0;
    const seen = new Set();
    const targets = hub.findConnections({ userId }).map((t) => ({ ...t, scope: 'account' }));
    for (const ip of ips) {
      for (const t of hub.findConnections({ ip })) targets.push({ ...t, scope: 'ip' });
    }

    const reason = info.reason || 'no reason given';
    const untilText = info.until > 0
      ? `until ${new Date(info.until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : 'permanently';

    let dropped = 0;
    for (const { player, room, scope } of targets) {
      if (seen.has(player.id)) continue;
      seen.add(player.id);
      room.applyBan(player, {
        chat: scope === 'account'
          ? `${player.name} has been banned ${untilText} — ${reason}`
          : `${player.name} was disconnected: this network is banned ${untilText} — ${reason}`,
        payload: banPayload({ ...info, scope, ip: player.ip }),
      });
      dropped++;
    }
    return dropped;
  };

  /**
   * Lands a mute (or its removal) on the rooms an account is playing in right
   * now. `Room.applyMute` fans out to every connection for that account by
   * itself, so this only has to find one of them; the database row has already
   * been written by the route that called this.
   */
  const pushMute = (user, until, reason) => {
    const [first] = hub.findConnections({ userId: user.id });
    if (!first) return 0;
    return first.room.applyMute(first.player, {
      until, by: 'an administrator', reason, persist: false,
    });
  };

  /**
   * Same, for the REPORT button. `Room.applyReportBan` fans out to every
   * connection for the account, so one is enough to find.
   */
  const pushReportBan = (user, until, reason) => {
    const [first] = hub.findConnections({ userId: user.id });
    if (!first) return 0;
    return first.room.applyReportBan(first.player, {
      until, by: 'an administrator', reason, persist: false,
    });
  };

  /**
   * Re-badges whatever an account is doing right now after its clan changed.
   * Same reasoning as the public clan routes: a tag nobody sees change reads
   * as an edit that did not take.
   */
  const pushClanTag = (userId) => {
    const fresh = db.users.byId(userId);
    if (!fresh) return 0;
    return hub.rebadge?.(userId, { clan: fresh.clan ?? null, clanVerified: !!fresh.clan_verified }) ?? 0;
  };

  /** Guards everything except /admin/login and /admin/status. */
  const requireAdmin = (ctx) => {
    if (!config.adminEnabled) throw new ApiError(404, 'not_found', 'admin panel disabled');
    if (!isLocalRequest(ctx.req)) throw new ApiError(403, 'local_only', 'the admin panel is private-network only');
    const token = (ctx.req.headers['x-admin-token'] ?? '')
      || (ctx.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!validToken(token)) throw new ApiError(401, 'unauthorized', 'sign in to the admin panel');
    return token;
  };

  /** The live connection behind a `guest:<n>` id, or null for anything else. */
  const findGuest = (id) => {
    const m = GUEST_RE.exec(String(id ?? ''));
    if (!m) return null;
    const entry = hub.get(Number(m[1]));
    // An account that happens to hold that connection id is not a guest, and a
    // bot is not a person — neither may be reached through this door.
    if (!entry || entry.player.userId || entry.player.isBot) return null;
    return entry;
  };

  /**
   * `:id` is either an account's UUID or its nickname — the panel links by id
   * and a moderator types a name, and both have to land on the same row. A
   * UUID can never be a legal nickname, so trying the id first is unambiguous.
   */
  const findUser = (ctx) => {
    const raw = String(ctx.params.id ?? '');
    if (GUEST_RE.test(raw)) {
      // Two different failures wearing the same id: the guest is still here
      // and this route has nothing to do with them, or they have left and the
      // row the panel is holding no longer refers to anybody.
      if (!findGuest(raw)) {
        throw new ApiError(404, 'guest_gone',
          'that guest has left — a guest is on the list only while they are connected');
      }
      throw new ApiError(409, 'guest_has_no_account',
        'that is a guest: there is no account to act on. Ban the address, or kick them.');
    }
    const user = (isUuid(raw) ? db.users.byId(raw) : null) ?? db.users.byName(raw);
    if (!user) throw new ApiError(404, 'not_found', 'no such account');
    return user;
  };

  /**
   * Every guest connected right now, newest first, optionally filtered by name.
   *
   * Deduplicated by connection, not by address: two guests behind one router
   * are two people, and banning one of them by hand should be a decision made
   * with both of them visible.
   */
  const liveGuests = (q = '') => {
    const needle = q.trim().toLowerCase();
    const out = [];
    for (const entry of hub.playersById.values()) {
      const p = entry.player;
      if (p.userId || p.isBot) continue;
      if (needle && !p.name.toLowerCase().includes(needle)) continue;
      out.push(adminGuest(entry, p.ip ? db.ipBans.active(p.ip) : null));
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  };

  const findReport = (ctx) => {
    const report = isUuid(ctx.params.id) ? db.reports.get(String(ctx.params.id)) : null;
    if (!report) throw new ApiError(404, 'not_found', 'no such report');
    return report;
  };

  const audit = (action, target, detail) => {
    try { db.audit.add('admin@local', action, target, detail); } catch { /* audit is best-effort */ }
    // The same write, in the shape the STATS tab counts: `admin_log` is a
    // journal a human reads and `events` is a series a chart draws, and a
    // moderation spike is one of the few things worth seeing on both.
    try { db.events?.add({ kind: `admin.${action}`, name: target ?? null, detail: detail ?? null }); }
    catch { /* analytics is not the product */ }
    logger.info(`${action} ${target ?? ''} ${detail ?? ''}`.trim());
  };

  /* ── Session ───────────────────────────────────────────────────────────── */

  r.get('/admin/status', (ctx) => ok(ctx.res, {
    enabled: config.adminEnabled && !!config.adminPassword,
    configured: !!config.adminPassword,
    local: isLocalRequest(ctx.req),
    authed: validToken((ctx.req.headers['x-admin-token'] ?? '')),
  }));

  r.post('/admin/login', async (ctx) => {
    if (!config.adminEnabled) throw new ApiError(404, 'not_found', 'admin panel disabled');
    if (!isLocalRequest(ctx.req)) throw new ApiError(403, 'local_only', 'the admin panel is private-network only');
    if (!config.adminPassword) {
      throw new ApiError(503, 'not_configured', 'set ADMIN_PASSWORD in .env first');
    }

    // Five wrong tries buys a one-minute lockout for that address.
    const fail = FAILURES.get(ctx.ip);
    if (fail && fail.until > nowMs()) {
      throw new ApiError(429, 'locked_out', `too many attempts — wait ${Math.ceil((fail.until - nowMs()) / 1000)}s`);
    }

    const { password } = await readJson(ctx.req);
    if (!passwordMatches(password)) {
      const count = (fail?.count ?? 0) + 1;
      FAILURES.set(ctx.ip, { count, until: count >= 5 ? nowMs() + 60_000 : 0 });
      audit('login.failed', ctx.ip, `attempt ${count}`);
      throw new ApiError(401, 'bad_password', 'wrong password');
    }

    FAILURES.delete(ctx.ip);
    const token = issueToken();
    audit('login', ctx.ip, null);
    ok(ctx.res, { token, ttlMinutes: config.adminTokenTtlMin });
  });

  r.post('/admin/logout', (ctx) => {
    const token = (ctx.req.headers['x-admin-token'] ?? '');
    tokens.delete(token);
    ok(ctx.res, {});
  });

  /* ── Overview ──────────────────────────────────────────────────────────── */

  r.get('/admin/overview', (ctx) => {
    requireAdmin(ctx);
    const s = db.summary();
    ok(ctx.res, {
      db: s,
      game: hub.health(),
      rooms: hub.list(),
      online: hub.humanCount,
      openReports: db.reports.countOpen(),
      uptime: Math.round(process.uptime()),
      currency: K.CURRENCY,
      version: K.API_VERSION,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  });

  /* ── Players ───────────────────────────────────────────────────────────── */

  r.get('/admin/players', (ctx) => {
    requireAdmin(ctx);
    const q = ctx.query.get('q') ?? '';
    const offset = num(ctx.query.get('offset'), 0, 1e6, 0);
    const { rows, total } = db.users.list({
      q,
      limit: num(ctx.query.get('limit'), 1, 200, 50),
      offset,
      sort: ctx.query.get('sort') ?? 'id',
    });
    /*
     * Guests sit above the accounts, on the first page, in every sort order.
     *
     * They are not rows in the users table and cannot be paged or sorted with
     * them — but they are the people playing *right now*, which is what a
     * moderator opening this screen is usually looking for. Pinning them to
     * the top of the first page is the one placement that never buries them.
     */
    const guests = liveGuests(q);
    ok(ctx.res, {
      total,
      guests: guests.length,
      players: [...(offset === 0 ? guests : []), ...rows.map((u) => adminUser(u, u))],
    });
  });

  r.get('/admin/players/:id', (ctx) => {
    requireAdmin(ctx);
    const guest = findGuest(ctx.params.id);
    if (guest) {
      const ip = guest.player.ip;
      ok(ctx.res, {
        player: adminGuest(guest, ip ? db.ipBans.active(ip) : null),
        // A guest has no history to show: no finished matches under their
        // name, no sessions, and no report queue — reporting needs an account
        // on both ends. Sending the empty shapes keeps the panel's one
        // renderer honest instead of teaching it two payloads.
        matches: [],
        reports: null,
        sessions: 0,
        liveIps: ip ? [ip] : [],
      });
      return;
    }
    const user = findUser(ctx);
    ok(ctx.res, {
      player: adminUser(user, db.stats.get(user.id), db.ipBans.forUser(user.id),
        db.chatBans.active(user.id), db.reportBans.active(user.id)),
      matches: db.matches.recentFor(user.id, 20),
      // Both directions: what this account has been accused of, and what it has
      // accused others of. A player who files ten reports a night is its own
      // kind of problem, and the panel should not need a second screen to see it.
      reports: {
        against: db.reports.against(user.id, user.username, 20),
        filed: db.reports.forReporter(user.id, 20),
      },
      sessions: db.sessions.countFor(user.id),
      liveIps: [...new Set(hub.findConnections({ userId: user.id })
        .map(({ player }) => player.ip).filter(Boolean))],
    });
  });

  r.patch('/admin/players/:id', async (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    const body = await readJson(ctx.req);
    const patch = {};
    const touched = [];

    if (typeof body.username === 'string' && body.username !== user.username) {
      if (!K.NAME_RE.test(body.username)) throw new ApiError(400, 'invalid_username', 'bad username');
      const clash = db.users.byName(body.username);
      if (clash && clash.id !== user.id) throw new ApiError(409, 'username_taken', 'that name is taken');
      patch.username = body.username;
      touched.push(`username=${body.username}`);
    }
    if (body.email !== undefined) {
      patch.email = body.email === null || body.email === '' ? null : String(body.email).slice(0, 190);
      touched.push('email');
    }
    // Confirming by hand: the way support unsticks somebody whose confirmation
    // email will not arrive, without handing them the password reset.
    if (body.emailVerified !== undefined) {
      patch.email_verified = body.emailVerified ? 1 : 0;
      touched.push(`email_verified=${patch.email_verified}`);
    }
    if (body.gr !== undefined) { patch.gr = num(body.gr, 0, 1e9); touched.push(`gr=${patch.gr}`); }
    if (body.xp !== undefined) { patch.xp = num(body.xp, 0, 1e9); touched.push(`xp=${patch.xp}`); }
    if (body.level !== undefined) { patch.level = num(body.level, 1, 999); touched.push(`level=${patch.level}`); }
    if (body.verified !== undefined) {
      patch.verified = body.verified ? 1 : 0;
      touched.push(`verified=${patch.verified}`);
    }
    // `clan` is no longer a free-text field: it is a cache of a clan_members
    // row. Emptying it here is the one edit that still makes sense — pulling
    // somebody out of a clan — and it goes through the clan module so the tag,
    // the membership and every live connection stay in step.
    if (body.clan !== undefined && !body.clan) {
      const seat = db.clans.membership(user.id);
      if (seat) {
        const clan = db.clans.byId(seat.clan_id);
        if (seat.role === 'owner') {
          throw new ApiError(409, 'owner_cannot_leave',
            `${user.username} owns [${clan?.tag ?? '?'}] — hand it over or disband it first`);
        }
        db.clans.removeMember(seat.clan_id, user.id);
        pushClanTag(user.id);
        touched.push(`clan=- (was ${clan?.tag ?? '?'})`);
      }
    }
    if (body.role !== undefined) {
      if (!['player', 'mod', 'admin'].includes(body.role)) throw new ApiError(400, 'invalid_role', 'unknown role');
      patch.role = body.role;
      touched.push(`role=${body.role}`);
    }
    if (body.stats && typeof body.stats === 'object') {
      db.stats.set(user.id, body.stats);
      touched.push('stats');
    }

    const fresh = Object.keys(patch).length ? db.users.adminUpdate(user.id, patch) : user;
    audit('player.update', user.username, touched.join(' '));
    ok(ctx.res, { player: adminUser(fresh, db.stats.get(user.id)) });
  });

  /**
   * Bans an account and, by default, every address it is known to play from.
   * The ban is enforced immediately: anyone mid-match is told in chat, shown
   * the ban screen and disconnected, and the server refuses them from then on.
   */
  r.post('/admin/players/:id/ban', async (ctx) => {
    requireAdmin(ctx);
    const { days, reason, ip: alsoIp = true } = await readJson(ctx.req);

    /*
     * Banning a guest is banning an address, because that is all a guest is.
     *
     * There is no row to mark, no session to destroy and no name that means
     * anything after the socket closes — so the sanction is written against
     * the address they are playing from, carrying the name they were playing
     * under so the ip-bans list says who it was. Lifting it afterwards is done
     * from the IP BANS tab: the guest row itself is gone the moment they drop.
     */
    const guest = findGuest(ctx.params.id);
    if (guest) {
      const { player } = guest;
      if (!player.ip) {
        throw new ApiError(409, 'no_address', `${player.name} has no address on this connection`);
      }
      const gd = Number(days);
      const gUntil = Number.isFinite(gd) && gd > 0
        ? Math.floor(nowMs() / 1000) + Math.round(gd * 86400)
        : -1;
      const gWhy = reason ? String(reason).slice(0, 200) : null;
      const row = db.ipBans.add({
        ip: player.ip, reason: gWhy, days: gd > 0 ? gd : 0, userId: null, username: player.name,
      });
      const gDropped = enforce({ scope: 'ip', reason: gWhy, until: gUntil }, { ips: [player.ip] });
      audit('guest.ban', player.name,
        `${player.ip} · ${gUntil === -1 ? 'permanent' : `${gd} day(s)`}`
        + `${gDropped ? ` · dropped ${gDropped}` : ''}${gWhy ? ` · ${gWhy}` : ''}`);
      ok(ctx.res, { guest: true, ipBan: row, ipBans: [player.ip], dropped: gDropped });
      return;
    }

    const user = findUser(ctx);
    // days <= 0 (or missing) means permanent.
    const d = Number(days);
    const until = Number.isFinite(d) && d > 0
      ? Math.floor(nowMs() / 1000) + Math.round(d * 86400)
      : -1;
    const why = reason ? String(reason).slice(0, 200) : null;

    db.users.ban(user.id, until, why);
    db.sessions.destroyAllFor(user.id);

    const ips = alsoIp ? addressesFor(user) : [];
    for (const addr of ips) {
      db.ipBans.add({ ip: addr, reason: why, days: d > 0 ? d : 0, userId: user.id, username: user.username });
    }

    const dropped = enforce(
      { scope: 'account', reason: why, until, userId: user.id },
      { userId: user.id, ips },
    );

    audit('player.ban', user.username,
      `${until === -1 ? 'permanent' : `${d} day(s)`}${ips.length ? ` · ip ${ips.join(', ')}` : ''}`
      + `${dropped ? ` · dropped ${dropped}` : ''}${why ? ` · ${why}` : ''}`);
    ok(ctx.res, {
      player: adminUser(db.users.byId(user.id), db.stats.get(user.id), db.ipBans.forUser(user.id),
        db.chatBans.active(user.id), db.reportBans.active(user.id)),
      ipBans: ips, dropped,
    });
  });

  r.post('/admin/players/:id/unban', (ctx) => {
    requireAdmin(ctx);
    // A guest is only ever banned by address, so lifting it is lifting that.
    const guest = findGuest(ctx.params.id);
    if (guest) {
      const lifted = guest.player.ip ? db.ipBans.remove(guest.player.ip) : 0;
      audit('guest.unban', guest.player.name, guest.player.ip ?? null);
      ok(ctx.res, { guest: true, lifted });
      return;
    }
    const user = findUser(ctx);
    db.users.ban(user.id, 0, null);
    // Lifting an account ban lifts the address bans it created, so an appeal
    // never leaves someone locked out by a leftover row.
    let lifted = 0;
    for (const row of db.ipBans.forUser(user.id)) lifted += db.ipBans.remove(row.ip);
    audit('player.unban', user.username, lifted ? `${lifted} ip ban(s) lifted` : null);
    ok(ctx.res, {
      player: adminUser(db.users.byId(user.id), db.stats.get(user.id), [],
        db.chatBans.active(user.id), db.reportBans.active(user.id)),
      lifted,
    });
  });

  /* ── Chat bans (mutes) ─────────────────────────────────────────────────── */

  /**
   * Mutes an account. Unlike a ban this takes nobody out of a match: they play
   * on, they simply cannot write into the chat. `minutes <= 0` is permanent.
   */
  r.post('/admin/players/:id/mute', async (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    const { minutes, reason } = await readJson(ctx.req);
    const m = Number(minutes);
    const until = Number.isFinite(m) && m > 0
      ? Math.floor(nowMs() / 1000) + Math.round(m * 60)
      : -1;
    const why = reason ? String(reason).slice(0, 200) : null;

    db.chatBans.set({ userId: user.id, until, reason: why, actor: 'admin@local', username: user.username });
    const live = pushMute(user, until, why);

    audit('player.mute', user.username,
      `${until === -1 ? 'permanent' : `${m} minute(s)`}${live ? ` · ${live} live` : ''}${why ? ` · ${why}` : ''}`);
    ok(ctx.res, { chatBan: db.chatBans.get(user.id), live });
  });

  r.post('/admin/players/:id/unmute', (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    const lifted = db.chatBans.remove(user.id);
    const live = pushMute(user, 0, null);
    audit('player.unmute', user.username, live ? `${live} live` : null);
    ok(ctx.res, { lifted, live });
  });

  r.get('/admin/chat-bans', (ctx) => {
    requireAdmin(ctx);
    ok(ctx.res, { bans: db.chatBans.list(num(ctx.query.get('limit'), 1, 500, 200)) });
  });

  /* ── Report bans ───────────────────────────────────────────────────────── */

  /**
   * Switches the REPORT button off for one account.
   *
   * Every other ceiling on reporting clears itself, because the ordinary
   * failure is somebody reporting too eagerly. This is the case those cannot
   * answer: an account using the queue as a weapon, filing on whoever beat
   * them. It costs them nothing else — they keep playing and keep talking —
   * and the reason travels with it, so the button they find greyed says who
   * turned it off and why rather than looking broken.
   *
   * `minutes <= 0` is indefinite.
   */
  r.post('/admin/players/:id/report-ban', async (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    const { minutes, reason } = await readJson(ctx.req);
    const m = Number(minutes);
    const until = Number.isFinite(m) && m > 0
      ? Math.floor(nowMs() / 1000) + Math.round(m * 60)
      : -1;
    const why = reason ? String(reason).slice(0, 200) : null;

    db.reportBans.set({
      userId: user.id, until, reason: why, actor: 'admin@local', username: user.username,
    });
    const live = pushReportBan(user, until, why);

    audit('player.report-ban', user.username,
      `${until === -1 ? 'indefinite' : `${m} minute(s)`}${live ? ` · ${live} live` : ''}${why ? ` · ${why}` : ''}`);
    ok(ctx.res, { reportBan: db.reportBans.get(user.id), live });
  });

  r.post('/admin/players/:id/report-unban', (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    const lifted = db.reportBans.remove(user.id);
    const live = pushReportBan(user, 0, null);
    audit('player.report-unban', user.username, live ? `${live} live` : null);
    ok(ctx.res, { lifted, live });
  });

  r.get('/admin/report-bans', (ctx) => {
    requireAdmin(ctx);
    ok(ctx.res, { bans: db.reportBans.list(num(ctx.query.get('limit'), 1, 500, 200)) });
  });

  /* ── IP bans ───────────────────────────────────────────────────────────── */

  r.get('/admin/ip-bans', (ctx) => {
    requireAdmin(ctx);
    ok(ctx.res, { bans: db.ipBans.list(num(ctx.query.get('limit'), 1, 500, 200)) });
  });

  r.post('/admin/ip-bans', async (ctx) => {
    requireAdmin(ctx);
    const { ip, reason, days } = await readJson(ctx.req);
    const addr = db.normaliseIp(ip);
    if (!addr || addr.length > 64) throw new ApiError(400, 'invalid_ip', 'give an address to ban');
    const d = Number(days);
    const row = db.ipBans.add({
      ip: addr, reason: reason ? String(reason).slice(0, 200) : null,
      days: Number.isFinite(d) && d > 0 ? d : 0,
    });
    const dropped = enforce(
      { scope: 'ip', reason: row.reason, until: row.until, ip: addr },
      { ips: [addr] },
    );
    audit('ip.ban', addr, `${row.until === -1 ? 'permanent' : `${d} day(s)`}${dropped ? ` · dropped ${dropped}` : ''}`);
    ok(ctx.res, { ban: row, dropped });
  });

  r.delete('/admin/ip-bans/:ip', (ctx) => {
    requireAdmin(ctx);
    const addr = db.normaliseIp(ctx.params.ip);
    const removed = db.ipBans.remove(addr);
    audit('ip.unban', addr, null);
    ok(ctx.res, { removed });
  });

  r.post('/admin/players/:id/password', async (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    const { password } = await readJson(ctx.req);
    if (typeof password !== 'string' || password.length < K.PASSWORD_MIN) {
      throw new ApiError(400, 'invalid_password', `at least ${K.PASSWORD_MIN} characters`);
    }
    db.users.setPassword(user.id, await hashPassword(password));
    db.sessions.destroyAllFor(user.id);
    audit('player.password', user.username, 'reset');
    ok(ctx.res, {});
  });

  r.post('/admin/players/:id/kick', (ctx) => {
    requireAdmin(ctx);
    // One guest is one socket: there is no account to sweep other sessions for.
    const guest = findGuest(ctx.params.id);
    if (guest) {
      try { guest.player.ws?.close(4001, 'kicked by an administrator'); } catch { /* already gone */ }
      audit('guest.kick', guest.player.name, guest.player.ip ?? null);
      ok(ctx.res, { guest: true, kicked: 1 });
      return;
    }
    const user = findUser(ctx);
    let kicked = 0;
    for (const { player } of hub.playersById.values()) {
      if (player.userId !== user.id) continue;
      try { player.ws?.close(4001, 'kicked by an administrator'); } catch { /* already gone */ }
      kicked++;
    }
    db.sessions.destroyAllFor(user.id);
    audit('player.kick', user.username, `${kicked} socket(s)`);
    ok(ctx.res, { kicked });
  });

  r.delete('/admin/players/:id', async (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    db.sessions.destroyAllFor(user.id);
    // The row goes; so does the file it pointed at. Nothing on disk should
    // outlive the account that uploaded it.
    await avatars.remove(user.id);
    // Deleting an owner cascades their membership away and leaves the clan with
    // nobody who can invite, remove, hand over or disband it. Note which clan
    // that was before the row disappears, then put it back in somebody's hands.
    const seat = db.clans.membership(user.id);
    const removed = db.users.remove(user.id);
    let clanNote = null;
    if (seat) {
      const { disbanded, owner } = db.clans.reseat(seat.clan_id);
      const clan = disbanded ? null : db.clans.byId(seat.clan_id);
      if (disbanded) {
        await clanAvatars.remove(seat.clan_id).catch(() => 0);
        clanNote = 'clan disbanded (last member)';
      } else if (owner) {
        for (const m of db.clans.members(seat.clan_id)) pushClanTag(m.id);
        clanNote = `[${clan?.tag ?? '?'}] handed to ${owner.username}`;
      }
    }
    audit('player.delete', user.username, `#${user.id}${clanNote ? ` · ${clanNote}` : ''}`);
    ok(ctx.res, { removed, clan: clanNote });
  });

  /* ── Reports ───────────────────────────────────────────────────────────── */

  /**
   * The moderation queue.
   *
   * Open reports sort first regardless of age, because the queue is a to-do
   * list rather than a history; the history is what `status` filters for.
   */
  r.get('/admin/reports', (ctx) => {
    requireAdmin(ctx);
    const { rows, total, open } = db.reports.list({
      status: ctx.query.get('status') ?? '',
      q: ctx.query.get('q') ?? '',
      limit: num(ctx.query.get('limit'), 1, 200, 50),
      offset: num(ctx.query.get('offset'), 0, 1e6, 0),
    });
    ok(ctx.res, { total, open, reports: rows.map(reportPayload) });
  });

  r.get('/admin/reports/:id', (ctx) => {
    requireAdmin(ctx);
    const report = findReport(ctx);
    const target = report.targetId ? db.users.byId(report.targetId) : db.users.byName(report.targetName);
    const reporter = report.reporterId ? db.users.byId(report.reporterId) : null;
    ok(ctx.res, {
      report: reportPayload(report),
      // The chat as it stood when the report was filed. The match's own log is
      // long gone by the time anybody reads this.
      chatLog: report.chatLog ?? [],
      // Everything a moderator needs to act without leaving the report: who
      // this is, whether they are already banned or muted, and what else has
      // been said about them.
      target: target
        ? adminUser(target, db.stats.get(target.id), db.ipBans.forUser(target.id),
          db.chatBans.active(target.id), db.reportBans.active(target.id))
        : null,
      reporter: reporter ? adminUser(reporter, db.stats.get(reporter.id)) : null,
      history: db.reports.against(report.targetId, report.targetName, 20)
        .filter((row) => row.id !== report.id).map(reportPayload),
      online: !!hub.findConnections({ userId: report.targetId }).length,
    });
  });

  /**
   * Closes a report with a verdict.
   *
   * `outcome` is not bookkeeping: it is the line the player who filed the
   * report reads back in their own account panel, which is the only thing that
   * makes reporting worth their while. A resolve with no outcome gets the
   * default line for the action taken rather than silence.
   */
  r.post('/admin/reports/:id/resolve', async (ctx) => {
    requireAdmin(ctx);
    const report = findReport(ctx);
    const body = await readJson(ctx.req);

    const status = body.status === 'rejected' ? 'rejected' : 'actioned';
    const action = K.REPORT_ACTION_IDS.includes(body.action)
      ? body.action
      : (status === 'rejected' ? 'none' : 'warned');
    const outcome = typeof body.outcome === 'string' && body.outcome.trim()
      ? body.outcome.trim().slice(0, 400)
      : K.REPORT_ACTIONS[action];

    const updated = db.reports.resolve(report.id, { status, action, outcome, resolver: 'admin@local' });
    audit('report.resolve', `#${report.id} ${report.targetName}`, `${status} · ${action}`);
    ok(ctx.res, { report: reportPayload(updated) });
  });

  /** Puts a closed report back in the queue. */
  r.post('/admin/reports/:id/reopen', (ctx) => {
    requireAdmin(ctx);
    const report = findReport(ctx);
    const updated = db.reports.reopen(report.id);
    audit('report.reopen', `#${report.id} ${report.targetName}`, null);
    ok(ctx.res, { report: reportPayload(updated) });
  });

  r.delete('/admin/reports/:id', (ctx) => {
    requireAdmin(ctx);
    const report = findReport(ctx);
    const removed = db.reports.remove(report.id);
    audit('report.delete', `#${report.id} ${report.targetName}`, null);
    ok(ctx.res, { removed });
  });

  /* ── Clans ─────────────────────────────────────────────────────────────── */

  const findClan = (ctx) => {
    const raw = String(ctx.params.id ?? '');
    const clan = (isUuid(raw) ? db.clans.byId(raw) : null) ?? db.clans.byTag(K.normaliseClanTag(raw));
    if (!clan) throw new ApiError(404, 'not_found', 'no such clan');
    return clan;
  };

  const clanRow = (c) => ({
    id: c.id,
    tag: c.tag,
    verified: !!c.verified,
    avatar: clanAvatars.urlFor(c.avatar),
    ownerId: c.ownerId ?? null,
    // The listing joins the owner in; a single clan does not, so resolve it.
    // `createdBy` is the last resort and deliberately not the first: it is the
    // founder's name, which outlives the account and may be nobody's now.
    ownerName: c.ownerName ?? (c.ownerId ? db.users.byId(c.ownerId)?.username : null) ?? c.createdBy ?? null,
    members: c.members ?? 0,
    score: c.score ?? 0,
    kills: c.kills ?? 0,
    createdAt: c.createdAt,
    createdBy: c.createdBy ?? null,
  });

  r.get('/admin/clans', (ctx) => {
    requireAdmin(ctx);
    const { rows, total } = db.clans.list({
      q: ctx.query.get('q') ?? '',
      limit: num(ctx.query.get('limit'), 1, 200, 50),
      offset: num(ctx.query.get('offset'), 0, 1e6, 0),
    });
    ok(ctx.res, { total, clans: rows.map(clanRow) });
  });

  r.get('/admin/clans/:id', (ctx) => {
    requireAdmin(ctx);
    const clan = findClan(ctx);
    ok(ctx.res, {
      clan: clanRow(clan),
      members: db.clans.members(clan.id).map((m) => ({ ...m, avatar: avatars.urlFor(m.avatar) })),
      invites: db.clans.invitesForClan(clan.id),
    });
  });

  /**
   * The developers' stamp.
   *
   * This is the whole of what verification does: the clan's tag turns gold
   * everywhere it is drawn instead of grey. It confers nothing else, which is
   * exactly why it can be handed out on judgement rather than on a process.
   */
  r.post('/admin/clans/:id/verify', async (ctx) => {
    requireAdmin(ctx);
    const clan = findClan(ctx);
    const { verified = true } = await readJson(ctx.req);
    const updated = db.clans.setVerified(clan.id, !!verified);
    let live = 0;
    for (const m of db.clans.members(clan.id)) live += pushClanTag(m.id);
    audit('clan.verify', clan.tag, `${verified ? 'verified' : 'unverified'}${live ? ` · ${live} live` : ''}`);
    ok(ctx.res, { clan: clanRow(updated), live });
  });

  /**
   * Takes a clan's picture away without touching the clan — the same reasoning
   * as the account version: most of the time the picture is the whole problem.
   */
  r.delete('/admin/clans/:id/avatar', async (ctx) => {
    requireAdmin(ctx);
    const clan = findClan(ctx);
    const removed = await clanAvatars.remove(clan.id);
    db.clans.setAvatar(clan.id, null);
    audit('clan.avatar', clan.tag, removed ? `${removed} file(s) removed` : 'none stored');
    ok(ctx.res, { removed, clan: clanRow(db.clans.byId(clan.id)) });
  });

  /** Disbands a clan outright. Every member loses the tag on the spot. */
  r.delete('/admin/clans/:id', async (ctx) => {
    requireAdmin(ctx);
    const clan = findClan(ctx);
    const members = db.clans.members(clan.id).map((m) => m.id);
    db.clans.disband(clan.id);
    await clanAvatars.remove(clan.id).catch(() => 0);
    let live = 0;
    for (const id of members) live += pushClanTag(id);
    audit('clan.disband', clan.tag, `${members.length} member(s)${live ? ` · ${live} live` : ''}`);
    ok(ctx.res, { disbanded: clan.tag, members: members.length, live });
  });

  /* ── Profile pictures ──────────────────────────────────────────────────── */

  /**
   * Takes an account's picture away.
   *
   * A profile picture is user content in the one place moderation cannot reach
   * with a mute: it is on the scoreboard of every match they play. Removing it
   * is deliberately its own action rather than part of a ban, because most of
   * the time the picture is the entire problem.
   */
  r.delete('/admin/players/:id/avatar', async (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    const removed = await avatars.remove(user.id);
    db.users.setAvatar(user.id, null);
    audit('player.avatar', user.username, removed ? `${removed} file(s) removed` : 'none stored');
    ok(ctx.res, {
      removed,
      player: adminUser(db.users.byId(user.id), db.stats.get(user.id),
        db.ipBans.forUser(user.id), db.chatBans.active(user.id), db.reportBans.active(user.id)),
    });
  });

  /* ── Stats ─────────────────────────────────────────────────────────────── */

  /**
   * Every series the panel can draw, with the label and aggregation each one
   * wants. Sent once so the tab does not have to keep its own copy of the
   * sampler's vocabulary — a new series added to telemetry.js appears here on
   * the next restart without touching the client.
   */
  r.get('/admin/stats/series', (ctx) => {
    requireAdmin(ctx);
    ok(ctx.res, {
      gauges: GAUGES.map((name) => ({ name, ...(SERIES_META[name] ?? {}) })),
      counters: COUNTERS.map((name) => ({ name, ...(SERIES_META[name] ?? {}) })),
      present: db.metrics.names(0),
      intervalSec: config.metrics.intervalSec,
      enabled: !!config.metrics.enabled,
    });
  });

  /**
   * The whole STATS tab in one request.
   *
   * Deliberately one round trip rather than a dozen: every panel on the page
   * shares the same window, and a tab that painted itself in fourteen stages
   * would show fourteen different moments in time. `range` is a number of
   * hours; the bucket is derived from it so a day and a quarter both come back
   * as roughly two hundred points.
   */
  r.get('/admin/stats', (ctx) => {
    requireAdmin(ctx);
    const hours = num(ctx.query.get('hours'), 1, 24 * 400, 24);
    const until = Math.floor(Date.now() / 1000);
    const since = until - hours * 3600;
    // ~200 points whatever the window, floored at the sampling interval —
    // asking for finer buckets than the data has only draws a staircase.
    const bucket = Math.max(config.metrics.intervalSec, Math.round((hours * 3600) / 200 / 60) * 60 || 60);
    const dayBucket = hours <= 48 ? 3600 : 86400;

    const series = {};
    for (const name of [...GAUGES, ...COUNTERS]) {
      const meta = SERIES_META[name] ?? {};
      series[name] = db.metrics.series(name, { since, until, bucketSec: bucket, agg: meta.agg ?? 'avg' });
    }

    ok(ctx.res, {
      window: { since, until, hours, bucketSec: bucket, dayBucketSec: dayBucket },
      live: {
        game: hub.health(),
        rooms: hub.list(),
        db: db.summary(),
        uptime: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        sampling: !!telemetry?.enabled,
        lastSampleAt: telemetry?.lastSampleAt ?? 0,
        version: K.API_VERSION,
        currency: K.CURRENCY,
      },
      series,
      meta: SERIES_META,
      events: {
        mix: db.events.countByKind({ since, until }),
        signups: db.events.countSeries('signup', { since, until, bucketSec: dayBucket }),
        logins: db.events.countSeries('login', { since, until, bucketSec: dayBucket }),
        levelUps: db.events.countSeries('level.up', { since, until, bucketSec: dayBucket }),
        matches: db.events.countSeries('match.end', { since, until, bucketSec: dayBucket }),
      },
      game: {
        matches: db.analytics.matchesPlayed({ since, until, bucketSec: dayBucket }),
        activePlayers: db.analytics.activePlayers({ since, until, bucketSec: 86400 }),
        signups: db.analytics.signups({ since, until, bucketSec: 86400 }),
        // The display name is resolved here rather than in the panel: the panel
        // is served from its own port and cannot import shared/, and a second
        // copy of the map and class names is a second copy to keep in step.
        maps: named(db.analytics.mapMix({ since, until }), (id) => getMap(id)?.name),
        modes: named(db.analytics.modeMix({ since, until }), (id) => K.MODES[id]?.name),
        classes: named(db.analytics.classMix({ since, until }), (id) => getClass(id)?.name),
        hourOfDay: db.analytics.hourOfDay({ since, until }),
      },
      population: {
        levels: db.analytics.levelHistogram({ bucket: 5 }),
        economy: db.analytics.economy(),
        retention: db.analytics.retention({ since: 0, until }),
        newRetention: db.analytics.retention({ since, until }),
      },
      top: {
        players: db.users.list({ limit: 10, sort: 'level' }).rows.map((u) => ({
          id: u.id, username: u.username, level: u.level, xp: u.xp, gr: u.gr,
          kills: u.kills ?? 0, deaths: u.deaths ?? 0, matches: u.matches ?? 0,
          playtime: u.playtime_sec ?? 0,
        })),
      },
    });
  });

  /** The raw event journal, for anything a chart cannot answer. */
  r.get('/admin/stats/events', (ctx) => {
    requireAdmin(ctx);
    ok(ctx.res, {
      events: db.events.recent({
        limit: num(ctx.query.get('limit'), 1, 500, 120),
        kind: ctx.query.get('kind') || null,
        since: num(ctx.query.get('since'), 0, 1e12, 0),
      }),
    });
  });

  /* ── Logs ──────────────────────────────────────────────────────────────── */

  r.get('/admin/logs', (ctx) => {
    requireAdmin(ctx);
    const level = ctx.query.get('level');
    ok(ctx.res, {
      lines: recentLogs({
        limit: num(ctx.query.get('limit'), 1, 800, 200),
        level: ['error', 'warn', 'info', 'debug'].includes(level) ? level : null,
        sinceId: num(ctx.query.get('since'), 0, 1e12, 0),
      }),
      audit: db.audit.recent(num(ctx.query.get('auditLimit'), 1, 500, 100)),
    });
  });

  return r;
}

export default createAdminApi;
