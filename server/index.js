/**
 * Open Grunker — server entry point.
 *
 * One process serves three things:
 *   • the REST API at /api/v1
 *   • the realtime game at ws://…/ws
 *   • (optionally) the static client, so `npm start` is playable on its own
 */
import { createServer } from 'node:http';
import { createReadStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

import * as K from '../shared/constants.js';
import { getClass } from '../shared/weapons.js';
import config from './config.js';
import log from './util/log.js';
import * as db from './db/index.js';
import { Hub } from './game/hub.js';
import { Telemetry } from './game/telemetry.js';
import { createApi, COOKIE } from './api/index.js';
import { createAdminApi, isLocalRequest } from './api/admin.js';
import { guestName } from './util/auth.js';
import { serveStatic } from './util/static.js';
import * as avatars from './util/avatar.js';
import { clientIp, cors, fail, parseCookies } from './util/http.js';
import { take } from './util/ratelimit.js';
import * as ipintel from './util/ipintel.js';

const logger = log.child('server');
const API_PREFIX = `/api/${K.API_VERSION}`;

/* ── Game ────────────────────────────────────────────────────────────────── */

db.maintain();
setInterval(() => db.maintain(), 3600_000).unref();

const hub = new Hub(db);
const api = createApi({ db, hub });
// The sampler is handed a socket counter rather than the socket server: it
// reads one number, and wiring it to `wss` would be a cycle through a module
// that has not been built yet at this point in the file.
const telemetry = new Telemetry({ db, hub, socketCount: () => wss.clients.size });
const adminApi = createAdminApi({ db, hub, telemetry, banPayload: (info) => banPayload(info) });
hub.start();

/* ── HTTP ────────────────────────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  const ip = clientIp(req);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return fail(res, 400, 'bad_request');
  }
  const path = url.pathname;

  res.setHeader('x-powered-by', 'open-grunker');
  if (cors(req, res)) return;

  // ── API ──
  if (path === '/api' || path === '/api/') {
    return fail(res, 404, 'pick_a_version', { versions: [K.API_VERSION], base: API_PREFIX });
  }
  if (path.startsWith('/api/')) {
    if (!path.startsWith(API_PREFIX + '/') && path !== API_PREFIX) {
      return fail(res, 404, 'unknown_api_version', { supported: [K.API_VERSION] });
    }
    const rate = take(`api:${ip}`);
    if (!rate.allowed) {
      res.setHeader('retry-after', String(rate.retryAfter));
      return fail(res, 429, 'rate_limited');
    }

    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      || parseCookies(req)[COOKIE] || null;

    const ctx = {
      req, res, ip, url, path: path.slice(API_PREFIX.length) || '/',
      method: req.method, query: url.searchParams, token,
      auth: api.resolveSession(token),
    };
    // The admin API guards itself: private socket, no proxy headers, password
    // from .env.
    if (ctx.path.startsWith('/admin')) {
      if (await adminApi.handle(ctx)) return;
      return fail(res, 404, 'not_found', { path: ctx.path });
    }
    if (await api.handle(ctx)) return;
    return fail(res, 404, 'not_found', { path: ctx.path });
  }

  // ── Admin panel (static) ──
  if (path === '/admin' || path.startsWith('/admin/')) {
    if (await serveAdminPanel(req, res, path)) return;
    return fail(res, 404, 'not_found');
  }

  // ── Profile pictures ──
  // Their own prefix rather than a folder inside the client: they are user
  // content, they live under data/ with the database, and the filename carries
  // a content hash so the browser can cache one for a year.
  // Clans first: their files live under the same public prefix on purpose, so
  // that nginx — which proxies `^~ /avatars/` wholesale — needs to know nothing
  // about them. See the note on `clanAvatars` in util/avatar.js.
  if (path.startsWith('/avatars/clans/')) {
    if (await serveAvatar(avatars.clanAvatars, req, res, path.slice('/avatars/clans/'.length))) return;
    return fail(res, 404, 'not_found');
  }
  if (path.startsWith('/avatars/')) {
    if (await serveAvatar(avatars, req, res, path.slice('/avatars/'.length))) return;
    return fail(res, 404, 'not_found');
  }

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return;
  }

  // ── Static (dev / standalone) ──
  if (!config.serveStatic) return fail(res, 404, 'not_found');

  if (path.startsWith('/shared/')) {
    if (await serveStatic(req, res, config.sharedDir, path.slice('/shared'.length))) return;
    return fail(res, 404, 'not_found');
  }
  if (await serveStatic(req, res, config.clientDir, path, { spa: 'index.html' })) return;
  return fail(res, 404, 'not_found');
});

/**
 * Serves one stored picture — an account's, or a clan's.
 *
 * The name is matched against a strict pattern before it ever reaches the
 * filesystem, and the content type comes from that name rather than from
 * anything the uploader said, so a file can only ever be served as the image
 * format it was accepted as. `store` decides which directory that pattern is
 * resolved against; the two stores never see each other's files.
 */
async function serveAvatar(store, req, res, name) {
  const file = store.pathFor(decodeURIComponent(name));
  if (!file) return false;

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `"${name}"`;                        // the name *is* a content hash
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end();
    return true;
  }

  res.writeHead(200, {
    'content-type': store.mimeFor(name),
    'content-length': stat.size,
    'cache-control': `public, max-age=${config.avatars.cacheSeconds}, immutable`,
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    etag,
  });
  if (req.method === 'HEAD') { res.end(); return true; }

  await new Promise((done) => {
    const stream = createReadStream(file);
    stream.on('error', () => { res.destroy(); done(); });
    stream.on('end', done);
    stream.pipe(res);
  });
  return true;
}

/** Serves the panel's static files. Returns false when the caller is not allowed. */
async function serveAdminPanel(req, res, path) {
  if (!config.adminEnabled || !isLocalRequest(req)) return false;
  const rest = path.slice('/admin'.length) || '/';
  return serveStatic(req, res, join(config.clientDir, 'admin'), rest, { spa: 'index.html' });
}

/* ── Admin listener ──────────────────────────────────────────────────────── */

/**
 * The panel gets its own socket so the game server can stay bound to loopback
 * while a phone or laptop on the same network can still reach /admin. It
 * serves nothing else: any other path is a flat 404.
 */
const adminServer = createServer(async (req, res) => {
  res.setHeader('x-powered-by', 'open-grunker');
  res.setHeader('x-robots-tag', 'noindex, nofollow');

  let url;
  try { url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`); }
  catch { return fail(res, 400, 'bad_request'); }
  const path = url.pathname;

  if (!config.adminEnabled) return fail(res, 404, 'not_found');
  if (!isLocalRequest(req)) return fail(res, 403, 'local_only');

  if (path === '/' || path === '') {
    res.writeHead(302, { location: '/admin/' }).end();
    return;
  }

  if (path.startsWith(`${API_PREFIX}/admin`)) {
    const rate = take(`admin:${clientIp(req)}`);
    if (!rate.allowed) {
      res.setHeader('retry-after', String(rate.retryAfter));
      return fail(res, 429, 'rate_limited');
    }
    const ctx = {
      req, res, ip: clientIp(req), url, path: path.slice(API_PREFIX.length),
      method: req.method, query: url.searchParams, token: null, auth: null,
    };
    if (await adminApi.handle(ctx)) return;
    return fail(res, 404, 'not_found', { path: ctx.path });
  }

  if (path === '/admin' || path.startsWith('/admin/')) {
    if (await serveAdminPanel(req, res, path)) return;
    return fail(res, 404, 'not_found');
  }

  // The panel loads two shared assets from the game client, plus the profile
  // pictures it moderates.
  if (path === '/check.png' || path === '/assets/favicon.svg') {
    if (await serveStatic(req, res, config.clientDir, path)) return;
  }
  if (path.startsWith('/avatars/clans/')) {
    if (await serveAvatar(avatars.clanAvatars, req, res, path.slice('/avatars/clans/'.length))) return;
    return fail(res, 404, 'not_found');
  }
  if (path.startsWith('/avatars/')) {
    if (await serveAvatar(avatars, req, res, path.slice('/avatars/'.length))) return;
    return fail(res, 404, 'not_found');
  }
  return fail(res, 404, 'not_found');
});

/**
 * First non-internal IPv4 address, for the "open it here" line at boot.
 * Enumerating interfaces needs AF_NETLINK, which a tight systemd sandbox may
 * withhold; the address is only ever cosmetic, so a failure is not one.
 */
function lanAddress() {
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch { /* sandboxed: fall back to the generic hint below */ }
  return null;
}

/* ── WebSocket ───────────────────────────────────────────────────────────── */

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const socketsPerIp = new Map();

/**
 * Guests do not choose a name.
 *
 * A nickname is something an account owns: it is what the leaderboard, the
 * killfeed and a report all point at. Letting anyone type one in means anyone
 * can wear anyone else's, so a guest is simply given one. Signing in is what
 * buys the right to be called something, and changing it after that costs GR.
 */
const assignGuestName = () => guestName((name) => !!db.users.byName(name));

/**
 * The single place a ban is turned into something the client can render.
 * `scope` is 'account' or 'ip'; `until` is -1 for permanent, else unix seconds.
 */
export function banPayload(info) {
  return {
    o: K.S2C.ERROR,
    code: 'banned',
    scope: info.scope,
    reason: info.reason || 'no reason given',
    until: info.until ?? -1,
    permanent: info.until === -1 || info.until === undefined,
    ref: banRef(info),
    appeal: config.banAppealContact,
    message: info.scope === 'ip'
      ? 'this network is banned from Open Grunker'
      : 'this account is banned from Open Grunker',
  };
}

/** A short, stable case number so a player can quote their ban in an appeal. */
function banRef(info) {
  let h = 0x811c9dc5;
  for (const ch of `${info.scope}|${info.userId ?? 0}|${info.ip ?? ''}|${info.until ?? -1}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `0x${h.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** The live ban on this connection, account first, then address. Null when clean. */
function banFor(user, ip) {
  const account = db.users.banInfo(user);
  if (account) return account;
  const row = db.ipBans.active(ip);
  if (row) {
    return {
      scope: 'ip',
      reason: row.reason || 'no reason given',
      until: row.until,
      userId: row.user_id ?? null,
      ip: db.normaliseIp(ip),
    };
  }
  return null;
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);

  // An address ban is checked before the socket is even counted: a banned
  // network never gets far enough to occupy a slot.
  const ipBan = db.ipBans.active(ip);
  if (ipBan) {
    try {
      ws.send(JSON.stringify(banPayload({
        scope: 'ip', reason: ipBan.reason, until: ipBan.until,
        userId: ipBan.user_id ?? null, ip: db.normaliseIp(ip),
      })));
    } catch { /* socket already gone */ }
    ws.close(4013, 'banned');
    return;
  }

  const count = (socketsPerIp.get(ip) ?? 0) + 1;
  socketsPerIp.set(ip, count);
  if (count > config.maxWsPerIp) {
    socketsPerIp.set(ip, count - 1);
    ws.close(4029, 'too many connections');
    return;
  }

  const session = { player: null, room: null, ip, msgCount: 0, windowStart: Date.now(), greeting: false };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // Flood guard: generous enough for 60 Hz input, tight enough to matter.
    const nowMs = Date.now();
    if (nowMs - session.windowStart > 1000) { session.windowStart = nowMs; session.msgCount = 0; }
    if (++session.msgCount > 250) {
      logger.warn(`flood from ${ip} — closing`);
      ws.close(4029, 'flood');
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.o !== 'string') return;

    if (!session.player) {
      if (msg.o !== K.C2S.HELLO || session.greeting) return;
      // The handshake awaits an address lookup, so a second HELLO can land
      // while the first is still in flight. One socket, one seat.
      session.greeting = true;
      handleHello(ws, session, msg)
        .catch((err) => {
          logger.error('handshake failed:', err.stack ?? err.message);
          try { ws.close(4000, 'handshake failed'); } catch { /* already gone */ }
        })
        .finally(() => { session.greeting = false; });
      return;
    }
    session.room.onMessage(session.player, msg);
  });

  ws.on('close', () => {
    const n = (socketsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, n);
    if (session.player) hub.leave(session.player.id);
  });

  ws.on('error', (err) => logger.debug('ws error:', err.message));
});

/** Sends one frame and closes, for a connection we are turning away. */
function refuse(ws, payload, code, reason) {
  try { ws.send(JSON.stringify({ o: K.S2C.ERROR, ...payload })); } catch { /* already gone */ }
  ws.close(code, reason);
}

/**
 * One account, one live game.
 *
 * `takeover` (the default) hands the seat to the newest connection and tells
 * the old one why it lost it — the only policy that cannot lock a player out
 * after a browser crash leaves a socket half-open. `refuse` turns the second
 * connection away instead, but only when the first one is actually in a match:
 * the menu keeps a spectating socket open while it renders the backdrop, and
 * pressing PLAY reconnects, so refusing that would refuse everybody.
 *
 * @returns {boolean} false when this connection must not be seated
 */
function enforceSingleSession(ws, userId, username) {
  if (!config.singleSession || !userId) return true;
  const others = hub.findConnections({ userId });
  if (!others.length) return true;

  if (config.singleSessionPolicy === 'refuse' && others.some((e) => !e.player.spectator)) {
    logger.info(`${username} is already playing — refusing the second connection`);
    refuse(ws, {
      code: 'already_playing',
      message: 'this account is already in a match — one player, one game',
    }, 4017, 'already playing');
    return false;
  }

  for (const entry of others) {
    logger.info(`${username} reconnected — dropping the older connection`);
    if (entry.player.ws && entry.player.ws !== ws) {
      refuse(entry.player.ws, {
        code: 'session_replaced',
        message: 'this account started playing somewhere else — one player, one game',
      }, 4018, 'signed in elsewhere');
    }
    hub.leave(entry.player.id);
  }
  return true;
}

async function handleHello(ws, session, msg) {
  if (msg.protocol !== undefined && msg.protocol !== K.PROTOCOL_VERSION) {
    ws.send(JSON.stringify({
      o: K.S2C.ERROR, code: 'protocol_mismatch',
      message: `server speaks protocol ${K.PROTOCOL_VERSION}, you sent ${msg.protocol} — reload the page`,
    }));
    ws.close(4010, 'protocol mismatch');
    return;
  }

  // The raw lookup ignores standing on purpose: a banned account presenting a
  // valid token has to be told it is banned, not quietly seated as a guest.
  const raw = msg.token ? api.resolveSessionRaw(msg.token) : null;
  const auth = raw && !db.users.isBanned(raw.user) ? raw : null;

  const ban = banFor(raw?.user ?? null, session.ip);
  if (ban) {
    try { ws.send(JSON.stringify(banPayload({ ...ban, ip: session.ip }))); } catch { /* gone */ }
    ws.close(4013, 'banned');
    return;
  }

  // A VPN, a proxy or a datacenter range. Checked here rather than at the
  // socket so the lookup never blocks the connection handler, and cached, so
  // the same player reconnecting between matches costs nothing.
  const verdict = await ipintel.check(session.ip);
  if (verdict.blocked) {
    if (ws.readyState !== ws.OPEN) return;
    refuse(ws, ipintel.refusalPayload(verdict.reason, verdict.info), 4014, 'vpn blocked');
    return;
  }
  if (ws.readyState !== ws.OPEN) return;               // gave up while we asked

  // An account that has not confirmed its address can sign in, look around and
  // ask for a new link — it just cannot take a seat.
  if (auth && config.emailVerification.enabled && config.emailVerification.enforce
      && !db.users.isEmailVerified(auth.user)) {
    refuse(ws, {
      code: 'email_unverified',
      message: 'confirm your email address to play — check your inbox, or ask for a new link',
      email: auth.user.email ?? null,
    }, 4016, 'email unverified');
    return;
  }

  if (auth && !enforceSingleSession(ws, auth.user.id, auth.user.username)) return;

  let name, userId = null, level = 1, skin = 'default', skins = {}, classId = getClass(msg.classId).id;
  let verified = false, clan = null, clanVerified = false, role = 'player', mutedUntil = 0;

  if (auth) {
    name = auth.user.username;
    userId = auth.user.id;
    level = auth.user.level;
    verified = !!auth.user.verified;
    // Both read straight off the account row: `users.clan` is a cache of the
    // clan's tag, kept by db.clans.syncMembers(), so seating a player costs no
    // join at all.
    clan = auth.user.clan ?? null;
    clanVerified = !!auth.user.clan_verified;
    role = auth.user.role ?? 'player';
    // A mute outlives the session that earned it: it is read back here, not
    // remembered by the room the player happened to be in when it landed.
    mutedUntil = db.chatBans.active(userId)?.until ?? 0;
    const l = db.loadouts.get(userId);
    try {
      // The whole map, not just this class's finish: skins are chosen per
      // class, so a player who switches class mid-match has to switch finish
      // with it — and everybody else has to see them do it.
      skins = JSON.parse(l.skins) ?? {};
      skin = skins[classId] ?? 'default';
    } catch { /* keep the default skin */ }
  } else {
    // Whatever the client sent is ignored: a guest is named, not self-named.
    name = assignGuestName();
  }

  const joined = hub.join({
    ws, name, userId, level, classId, skin, skins, verified, clan, clanVerified, role, mutedUntil, ip: session.ip,
    roomId: typeof msg.room === 'string' ? msg.room.slice(0, 32) : undefined,
    spectate: !!msg.spectate,
  });
  if (!joined) {
    ws.send(JSON.stringify({ o: K.S2C.ERROR, code: 'server_full', message: 'every room is full — try again shortly' }));
    ws.close(4003, 'full');
    return;
  }

  session.player = joined.player;
  session.room = joined.room;
  ws.send(JSON.stringify({
    ...joined.room.welcomePayload(joined.player),
    authed: !!auth,
    // A guest never picked this name; the client shows it rather than the box
    // the player used to be able to type into.
    assignedName: auth ? null : name,
    account: auth
      ? {
        id: auth.user.id, username: auth.user.username, level: auth.user.level,
        gr: auth.user.gr, verified: !!auth.user.verified, clan: auth.user.clan ?? null,
        clanVerified: !!auth.user.clan_verified,
        role: auth.user.role ?? 'player', emailVerified: !!auth.user.email_verified,
      }
      : null,
  }));
}

/** Drops half-open sockets that stopped answering pings. */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 30_000);
heartbeat.unref();

/* ── Boot & shutdown ─────────────────────────────────────────────────────── */

telemetry.start();

server.listen(config.port, config.host, () => {
  const s = db.summary();
  logger.info(`open-grunker listening on http://${config.host}:${config.port}`);
  logger.info(`  api      ${API_PREFIX}`);
  logger.info(`  realtime ws://${config.host}:${config.port}/ws`);
  logger.info(`  client   ${config.serveStatic ? config.clientDir : '(disabled — served by nginx)'}`);
  logger.info(`  db       ${s.path} — ${s.users} user(s), ${s.matches} match(es)`);
  logger.info(`  public   ${config.publicUrl}`);
  if (!config.adminEnabled || !config.adminPassword) {
    logger.info('  admin    (disabled — set ADMIN_PASSWORD in .env)');
  } else {
    adminServer.listen(config.adminPort, config.adminHost, () => {
      const lan = lanAddress();
      logger.info(`  admin    http://127.0.0.1:${config.adminPort}/admin`);
      if (config.adminAllowLan) {
        logger.info(`           http://${lan ?? '<this-machine-lan-ip>'}:${config.adminPort}/admin (this network only)`);
      }
    });
    adminServer.on('error', (err) => logger.error('admin listener:', err.message));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') logger.error(`port ${config.port} is already in use — set PORT in .env`);
  else logger.error('http server error:', err.message);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} — shutting down`);
  clearInterval(heartbeat);
  // One last bucket, so whatever happened since the previous sample is on the
  // graph rather than lost to the restart it is probably being read about.
  try { telemetry.sample(); } catch { /* the database may already be closing */ }
  telemetry.stop();
  hub.stop();
  try { adminServer.close(); } catch { /* never started */ }
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server restarting'); } catch { /* already gone */ }
  }
  server.close(() => {
    db.close();
    logger.info('bye');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => logger.error('uncaught:', err.stack ?? err.message));
process.on('unhandledRejection', (err) => logger.error('unhandled rejection:', err?.stack ?? err));
