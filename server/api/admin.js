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
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import * as K from '../../shared/constants.js';
import { Router, ApiError } from './router.js';
import { ok, json, readJson } from '../util/http.js';
import { hashPassword } from '../util/auth.js';
import * as avatars from '../util/avatar.js';
import { getMap } from '../../shared/maps.js';
import { getClass } from '../../shared/weapons.js';
import * as COS from '../../shared/cosmetics.js';
import { clanAvatars } from '../util/avatar.js';
import * as anthems from '../util/anthem.js';
import config from '../config.js';
import log, {
  recent as recentLogs, stats as logStats, CAT_NAMES, LEVEL_NAMES,
} from '../util/log.js';
import { SERIES_META, GAUGES, COUNTERS } from '../game/telemetry.js';

const logger = log.child('admin', 'admin');

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
    logger.info(action, { target: target ?? null, detail: detail ?? null, actor: 'admin@local' });
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
      // Two more queues on the same badge line as the reports one.
      pendingCreators: config.creators.enabled ? db.creators.countPending() : 0,
      openSkinRequests: config.creators.enabled ? db.creators.skinRequests.list({ status: 'open', limit: 1 }).open : 0,
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
   * The moderation queue, in two piles.
   *
   * `status=open` is the to-do list and `status=handled` is everything already
   * settled — the panel's two tabs. Both counts come back on every request
   * whichever pile was asked for, so the tabs can carry their own size without
   * a second round trip. A stored state (`actioned`, `rejected`) still works as
   * a filter for anyone querying the API directly.
   */
  r.get('/admin/reports', (ctx) => {
    requireAdmin(ctx);
    const { rows, total, open, handled } = db.reports.list({
      status: ctx.query.get('status') ?? '',
      q: ctx.query.get('q') ?? '',
      limit: num(ctx.query.get('limit'), 1, 200, 50),
      offset: num(ctx.query.get('offset'), 0, 1e6, 0),
    });
    ok(ctx.res, { total, open, handled, reports: rows.map(reportPayload) });
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

  /* ── Creators ──────────────────────────────────────────────────────────────
   *
   * The queue behind the CREATOR tab. Everything here is somebody reading an
   * application and answering it — there is no automatic path from applying to
   * being one, which is the entire point of the status.
   * ────────────────────────────────────────────────────────────────────────── */

  const findCreator = (ctx) => {
    const raw = String(ctx.params.id ?? '');
    const user = (isUuid(raw) ? db.users.byId(raw) : null) ?? db.users.byName(raw);
    if (!user) throw new ApiError(404, 'not_found', 'no such account');
    const creator = db.creators.get(user.id);
    if (!creator) throw new ApiError(404, 'not_found', 'that account has not applied');
    return { user, creator };
  };

  /**
   * One application, as the panel draws it.
   *
   * The links are resolved to URLs here rather than in the browser for the same
   * reason they are on the public card: shared/constants.js is the only thing
   * that turns a handle into a destination, and a moderator is about to click
   * these to go and look at somebody's work.
   */
  const creatorPayload = (c) => ({
    ...c,
    kindName: K.getCreatorKind(c.kind)?.name ?? c.kind,
    askedName: K.getCreatorKind(c.asked)?.name ?? c.asked,
    links: c.links.map((l) => ({
      ...l, label: K.creatorLinkLabel(l), url: K.creatorLinkUrl(l),
    })).filter((l) => l.url),
    anthemUrl: anthems.urlFor(c.anthem),
  });

  r.get('/admin/creators', (ctx) => {
    requireAdmin(ctx);
    const { rows, total, pending, approved } = db.creators.list({
      status: ctx.query.get('status') ?? '',
      kind: ctx.query.get('kind') ?? '',
      q: ctx.query.get('q') ?? '',
      limit: num(ctx.query.get('limit'), 1, 200, 50),
      offset: num(ctx.query.get('offset'), 0, 1e6, 0),
    });
    ok(ctx.res, {
      total, pending, approved,
      byKind: db.creators.byKind(),
      kinds: K.CREATOR_KINDS,
      creators: rows.map(creatorPayload),
    });
  });

  r.get('/admin/creators/:id', (ctx) => {
    requireAdmin(ctx);
    const { user, creator } = findCreator(ctx);
    ok(ctx.res, {
      creator: creatorPayload(creator),
      // Who this is, so a decision can be made without leaving the queue: an
      // application from an account with three open reports against it is a
      // different application.
      account: adminUser(user, db.stats.get(user.id), db.ipBans.forUser(user.id),
        db.chatBans.active(user.id), db.reportBans.active(user.id)),
      reports: db.reports.against(user.id, user.username, 10),
      skinRequests: db.creators.skinRequests.forUser(user.id, 20),
    });
  });

  /**
   * Answers one application.
   *
   * `kind` is part of the decision rather than read back off the application,
   * because the person reading it is the one who knows which queue somebody
   * belongs in — a pitch filed as music that is really a portfolio of skin
   * concepts gets approved as art, in one call, and the row keeps `asked` so it
   * still reads honestly afterwards.
   *
   * Revoking sweeps the anthem off the disk. A perk that outlives the status it
   * came from is a perk nobody took away.
   */
  r.post('/admin/creators/:id/decide', async (ctx) => {
    requireAdmin(ctx);
    const { user, creator } = findCreator(ctx);
    const body = await readJson(ctx.req);

    const status = K.CREATOR_STATUSES.includes(body.status) ? body.status : null;
    if (!status || status === 'pending') {
      throw new ApiError(400, 'bad_status', 'approve, reject or revoke');
    }
    const kind = K.CREATOR_KIND_IDS.includes(body.kind) ? body.kind : null;
    const verdict = typeof body.verdict === 'string' && body.verdict.trim()
      ? body.verdict.trim().slice(0, K.CREATOR_VERDICT_MAX)
      : null;

    if (status !== 'approved' && creator.anthem) {
      await anthems.remove(user.id);
      db.creators.setAnthem(user.id, null, null);
    }
    const updated = db.creators.decide({
      userId: user.id, status, kind, verdict, actor: 'admin@local',
    });
    db.events.add({
      kind: `creator.${status}`, userId: user.id, name: user.username, detail: updated.kind,
    });
    audit('creator.decide', user.username, `${status} · ${updated.kind}`);
    // The badge follows the nickname, so a session already in a match is
    // re-badged rather than made to reconnect to stop wearing one.
    for (const { player, room } of hub.findConnections({ userId: user.id })) {
      player.setCreator(db.creators.standing(user.id));
      room.pushScore();
    }
    ok(ctx.res, { creator: creatorPayload(updated) });
  });

  /** Takes an anthem down without touching the status behind it. */
  r.delete('/admin/creators/:id/anthem', async (ctx) => {
    requireAdmin(ctx);
    const { user, creator } = findCreator(ctx);
    if (!creator.anthem) throw new ApiError(404, 'not_found', 'no anthem on that account');
    const removed = await anthems.remove(user.id);
    const updated = db.creators.setAnthem(user.id, null, null);
    audit('creator.anthem.remove', user.username, creator.anthemTitle ?? null);
    for (const { player } of hub.findConnections({ userId: user.id })) player.setAnthem(null, null);
    ok(ctx.res, { removed, creator: creatorPayload(updated) });
  });

  /* ── Skin commissions ──────────────────────────────────────────────────── */

  r.get('/admin/skin-requests', (ctx) => {
    requireAdmin(ctx);
    const { rows, total, open } = db.creators.skinRequests.list({
      status: ctx.query.get('status') ?? '',
      q: ctx.query.get('q') ?? '',
      limit: num(ctx.query.get('limit'), 1, 200, 50),
      offset: num(ctx.query.get('offset'), 0, 1e6, 0),
    });
    ok(ctx.res, { total, open, requests: rows });
  });

  r.post('/admin/skin-requests/:id/decide', async (ctx) => {
    requireAdmin(ctx);
    const request = db.creators.skinRequests.get(String(ctx.params.id ?? ''));
    if (!request) throw new ApiError(404, 'not_found', 'no such brief');
    const body = await readJson(ctx.req);
    const status = K.SKIN_REQUEST_STATUSES.includes(body.status) ? body.status : null;
    if (!status || status === 'open') {
      throw new ApiError(400, 'bad_status', 'accept, ship or decline it');
    }
    // The item id is only meaningful once the finish really exists, so it is
    // checked against the catalogue rather than stored as whatever was typed.
    const itemId = COS.ITEMS?.[body.itemId] ? String(body.itemId) : null;
    const updated = db.creators.skinRequests.decide({
      id: request.id,
      status,
      verdict: typeof body.verdict === 'string' ? body.verdict.trim() : null,
      actor: 'admin@local',
      itemId,
    });
    audit('creator.skin.decide', `${request.username ?? request.userId} · ${request.name}`, status);
    ok(ctx.res, { request: updated });
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
  /* ── Cosmetics ─────────────────────────────────────────────────────────── */

  /**
   * Moderating an item economy.
   *
   * Two things make this different from moderating chat. The first is that
   * everything here is *reversible but expensive*: a revoked item is somebody's
   * money, and a trade ban stops somebody spending theirs. The second is that
   * the interesting failure is not one bad actor but a leak — an item minting
   * faster than it is being spent, or a case whose realised drops do not match
   * its published odds. So the summary route deliberately reports the shape of
   * the whole economy first, and the per-account views second.
   */

  /** Catalogue and economy at a glance. */
  r.get('/admin/cosmetics', (ctx) => {
    requireAdmin(ctx);
    const summary = db.cosmeticsAdmin.summary();
    ok(ctx.res, {
      summary,
      /*
       * The published odds beside the realised ones.
       *
       * This is the whole reason `case_openings` is kept forever. If a case
       * says 0.25% mythic and has paid out 3% across ten thousand opens, the
       * roll is wrong — and this is the only place anybody would find out.
       */
      cases: COS.CASE_IDS.map((id) => {
        const opened = summary.cases.byCase.find((c) => c.caseId === id);
        return {
          id, name: COS.CASES[id].name, price: COS.CASES[id].price,
          pool: COS.casePool(id).length,
          odds: COS.caseOdds(id),
          opens: opened?.opens ?? 0, spent: opened?.spent ?? 0,
        };
      }),
      catalogue: {
        items: COS.ITEM_IDS.length,
        bySlot: Object.fromEntries(COS.SLOT_IDS.map((s) => [s, COS.itemsInSlot(s).length])),
        byRarity: Object.fromEntries(COS.RARITY_ORDER.map((rr) =>
          [rr, COS.ITEM_IDS.filter((id) => COS.ITEMS[id].rarity === rr).length])),
        animated: COS.ITEM_IDS.filter((id) => COS.ITEMS[id].anim).length,
      },
      rarities: COS.RARITY,
    });
  });

  /** The whole catalogue, for the item picker in the grant form. */
  r.get('/admin/cosmetics/items', (ctx) => {
    requireAdmin(ctx);
    const q = String(ctx.query.get('q') ?? '').toLowerCase();
    const slot = ctx.query.get('slot') ?? '';
    const items = COS.ITEM_IDS.map((id) => COS.ITEMS[id])
      .filter((i) => (!slot || i.slot === slot) && (!q || i.name.toLowerCase().includes(q)
        || i.id.toLowerCase().includes(q)))
      .slice(0, 300)
      .map((i) => ({
        id: i.id, name: i.name, slot: i.slot, rarity: i.rarity,
        price: i.price, anim: i.anim, tradable: i.tradable,
      }));
    ok(ctx.res, { items });
  });

  /** One account's inventory, with where every unit came from. */
  r.get('/admin/cosmetics/inventory/:id', (ctx) => {
    requireAdmin(ctx);
    const user = findUser(ctx);
    ok(ctx.res, {
      user: { id: user.id, username: user.username, gr: Number(user.gr ?? 0) },
      tradeBannedUntil: Number(user.trade_banned_until ?? 0),
      units: db.cosmeticsAdmin.inventoryOf(user.id).map((u) => ({
        ...u, name: COS.getItem(u.itemId)?.name ?? u.itemId,
        rarity: COS.getItem(u.itemId)?.rarity ?? 'common',
        worth: COS.priceOf(COS.getItem(u.itemId)),
      })),
      openings: db.cases.forUser(user.id, 40),
    });
  });

  /** Puts an item into an account. */
  r.post('/admin/cosmetics/grant', async (ctx) => {
    requireAdmin(ctx);
    const { user: who, itemId, note } = await readJson(ctx.req);
    const user = db.users.byId(String(who ?? '')) ?? db.users.byName(String(who ?? ''));
    if (!user) throw new ApiError(404, 'not_found', 'no such account');
    const item = COS.getItem(itemId);
    if (!item) throw new ApiError(404, 'not_found', 'no such item');
    let unit;
    try {
      unit = db.inventory.mint(user.id, item.id, {
        source: 'grant', origin: String(note ?? 'admin').slice(0, 60),
      });
    } catch (err) {
      throw new ApiError(400, err.code ?? 'refused', err.message);
    }
    audit('cosmetics.grant', user.username, `${item.id} #${unit.serial}`);
    ok(ctx.res, { unitId: unit.id, itemId: item.id, serial: Number(unit.serial) });
  });

  /**
   * Takes a unit off an account.
   *
   * Anything the unit was staked in — an open trade, a standing listing — is
   * cancelled with it, because a trade that settles against a row that no
   * longer exists is a trade that silently gives one side nothing.
   */
  r.post('/admin/cosmetics/revoke', async (ctx) => {
    requireAdmin(ctx);
    const { unitId } = await readJson(ctx.req);
    let gone;
    try {
      gone = db.cosmeticsAdmin.revoke(String(unitId ?? ''));
    } catch (err) {
      throw new ApiError(400, err.code ?? 'refused', err.message);
    }
    const owner = db.users.byId(gone.userId);
    audit('cosmetics.revoke', owner?.username ?? gone.userId, gone.itemId);
    ok(ctx.res, gone);
  });

  /** Bars an account from trading and the market, and clears what it has out. */
  r.post('/admin/cosmetics/trade-ban', async (ctx) => {
    requireAdmin(ctx);
    const { user: who, days } = await readJson(ctx.req);
    const user = db.users.byId(String(who ?? '')) ?? db.users.byName(String(who ?? ''));
    if (!user) throw new ApiError(404, 'not_found', 'no such account');
    const n = Number(days) || 0;
    // 0 lifts it, -1 is permanent, anything else is that many days.
    const until = n === 0 ? 0
      : n < 0 ? Math.floor(Date.now() / 1000) + 100 * 365 * 86400
        : Math.floor(Date.now() / 1000) + Math.min(3650, n) * 86400;
    const res = db.cosmeticsAdmin.setTradeBan(user.id, until);
    audit('cosmetics.tradeban', user.username, until ? `until ${until}` : 'lifted');
    ok(ctx.res, res);
  });

  /** The economy's moving parts: recent opens, listings and offers. */
  r.get('/admin/cosmetics/activity', (ctx) => {
    requireAdmin(ctx);
    const limit = num(ctx.query.get('limit'), 1, 200, 40);
    const name = (id) => COS.getItem(id)?.name ?? id;
    ok(ctx.res, {
      drops: db.cases.recent(limit).map((d) => ({ ...d, name: name(d.itemId),
        rarity: COS.getItem(d.itemId)?.rarity ?? 'common' })),
      listings: db.market.recent(limit).map((l) => ({ ...l, name: name(l.itemId) })),
      trades: db.trades.recent(limit).map((t) => ({
        ...t,
        fromItems: t.fromItems.map(name),
        toItems: t.toItems.map(name),
      })),
    });
  });

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

  /**
   * The stream, narrowed by whatever the panel asked for.
   *
   * Everything is optional and everything composes: level and category accept
   * comma lists, `q` is free text over the message and the fields, and
   * `player`/`userId`/`room` are the identity filters that make a line
   * findable from somebody's account page. `since` is an id, so the panel's
   * live tail asks only for what it has not already drawn.
   */
  r.get('/admin/logs', (ctx) => {
    requireAdmin(ctx);
    const pick = (name, allowed) => {
      const raw = (ctx.query.get(name) ?? '').split(',').map((v) => v.trim()).filter(Boolean);
      const kept = raw.filter((v) => allowed.includes(v));
      return kept.length ? kept.join(',') : null;
    };
    const lines = recentLogs({
      limit: num(ctx.query.get('limit'), 1, 1000, 250),
      level: pick('level', LEVEL_NAMES),
      cat: pick('cat', CAT_NAMES),
      ns: (ctx.query.get('ns') || '').slice(0, 40) || null,
      q: (ctx.query.get('q') || '').slice(0, 120) || null,
      player: (ctx.query.get('player') || '').slice(0, 40) || null,
      userId: (ctx.query.get('userId') || '').slice(0, 64) || null,
      room: (ctx.query.get('room') || '').slice(0, 32) || null,
      sinceId: num(ctx.query.get('since'), 0, 1e12, 0),
      since: num(ctx.query.get('at'), 0, 1e15, 0),
    });
    ok(ctx.res, {
      lines,
      stats: logStats(),
      levels: LEVEL_NAMES,
      categories: CAT_NAMES,
      settings: log.settingsState(),
      audit: db.audit.recent(num(ctx.query.get('auditLimit'), 1, 500, 100)),
    });
  });

  /** Both switches, plus what the disk copy currently looks like. */
  r.get('/admin/logs/config', (ctx) => {
    requireAdmin(ctx);
    ok(ctx.res, { settings: log.settingsState(), files: log.sink.list().slice(0, 60) });
  });

  /**
   * Flips a switch, and remembers it for this instance.
   *
   * Persisted in the database rather than the environment because it is a
   * decision about *this* server that has to survive a restart without a
   * redeploy — which is exactly what the request asked for.
   */
  r.post('/admin/logs/config', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const before = log.settingsState();
    const state = log.updateStored(db.settings, {
      toDisk: body.toDisk,
      trace: body.trace,
      keepDays: body.keepDays,
      maxFileMb: body.maxFileMb,
      maxTotalMb: body.maxTotalMb,
    });
    if (before.disk.enabled !== state.disk.enabled) {
      audit('logs.disk', state.disk.enabled ? 'on' : 'off', state.disk.dir);
    }
    if (before.trace !== state.trace) audit('logs.trace', state.trace ? 'on' : 'off', null);
    ok(ctx.res, { settings: state, files: log.sink.list().slice(0, 60) });
  });

  /** What is on disk right now. */
  r.get('/admin/logs/files', (ctx) => {
    requireAdmin(ctx);
    ok(ctx.res, { dir: log.sink.dir, files: log.sink.list(), state: log.sink.state() });
  });

  /**
   * One file, as it was written.
   *
   * `resolve` is the boundary: the name comes off a query string, so it is
   * reduced to a basename and matched against the pattern this server writes
   * before it is ever joined to a path.
   */
  r.get('/admin/logs/file', (ctx) => {
    requireAdmin(ctx);
    const path = log.sink.resolve(ctx.query.get('name'));
    if (!path) throw new ApiError(404, 'not_found', 'no such log file');
    const name = basename(path);
    ctx.res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    createReadStream(path).on('error', () => ctx.res.end()).pipe(ctx.res);
  });

  /** Deletes every log file except the one being written to. */
  r.delete('/admin/logs/files', (ctx) => {
    requireAdmin(ctx);
    const out = log.sink.purge();
    audit('logs.purge', `${out.removed} files`, `${Math.round(out.freed / 1024)} KB`);
    ok(ctx.res, { ...out, files: log.sink.list(), state: log.sink.state() });
  });

  /** Empties the in-memory ring. The files on disk are untouched. */
  r.delete('/admin/logs', (ctx) => {
    requireAdmin(ctx);
    log.clear();
    audit('logs.clear', 'buffer', null);
    ok(ctx.res, { stats: logStats() });
  });

  return r;
}

export default createAdminApi;
