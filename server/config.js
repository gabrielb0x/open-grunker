/** Open Grunker — runtime configuration (env-driven, with sane defaults). */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import {
  RENAME_COST as K_RENAME_COST,
  AVATAR_MAX_BYTES as K_AVATAR_MAX_BYTES,
  AVATAR_MAX_DIM as K_AVATAR_MAX_DIM,
  REPORT_MAX_PER_HOUR as K_REPORT_MAX_PER_HOUR,
  REPORT_MAX_PER_DAY as K_REPORT_MAX_PER_DAY,
  REPORT_MAX_OPEN as K_REPORT_MAX_OPEN,
  REPORT_COOLDOWN_SEC as K_REPORT_COOLDOWN_SEC,
  REPORT_REPEAT_COOLDOWN_SEC as K_REPORT_REPEAT_COOLDOWN_SEC,
  REPORT_MIN_LEVEL as K_REPORT_MIN_LEVEL,
  REPORT_DISMISSED_LOCKOUT as K_REPORT_DISMISSED,
  CLAN_JOIN_LEVEL as K_CLAN_JOIN_LEVEL,
  CLAN_CREATE_LEVEL as K_CLAN_CREATE_LEVEL,
  CLAN_CREATE_COST as K_CLAN_CREATE_COST,
  CLAN_MAX_MEMBERS as K_CLAN_MAX_MEMBERS,
  CLAN_MAX_INVITES as K_CLAN_MAX_INVITES,
  CLAN_INVITE_TTL_HOURS as K_CLAN_INVITE_TTL_HOURS,
  AFK_WARN_SEC as K_AFK_WARN_SEC,
  AFK_KICK_SEC as K_AFK_KICK_SEC,
  CHEAT_WARN_SCORE as K_CHEAT_WARN_SCORE,
  CHEAT_KICK_SCORE as K_CHEAT_KICK_SCORE,
  FRIENDS_MAX as K_FRIENDS_MAX,
  FRIEND_REQUESTS_MAX as K_FRIEND_REQUESTS_MAX,
  FRIEND_REQUESTS_INBOX_MAX as K_FRIEND_REQUESTS_INBOX_MAX,
  FRIEND_REQUEST_COOLDOWN_SEC as K_FRIEND_REQUEST_COOLDOWN_SEC,
  FRIEND_MIN_LEVEL as K_FRIEND_MIN_LEVEL,
} from '../shared/constants.js';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Minimal .env loader — no dependency, only fills in unset variables. */
function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const bool = (k, d) => (env[k] === undefined ? d : /^(1|true|yes|on)$/i.test(env[k]));
const str = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
const list = (k, d) => (env[k] ? env[k].split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  env: str('NODE_ENV', 'production'),

  // Network — 8080/8081 are deliberately avoided; they're taken on this host.
  host: str('HOST', '127.0.0.1'),
  port: num('PORT', 7420),
  publicUrl: str('PUBLIC_URL', 'https://grunker.g0x.dev'),
  trustProxy: bool('TRUST_PROXY', true),
  // Is this site actually served through Cloudflare's proxy (orange cloud)?
  // Only then is CF-Connecting-IP a header rather than a client's suggestion.
  cfProxy: bool('CF_PROXY', false),
  corsOrigins: list('CORS_ORIGINS', ['https://grunker.g0x.dev', 'http://localhost:7420', 'http://127.0.0.1:7420']),

  // Storage
  dbPath: resolve(ROOT, str('DB_PATH', 'data/open-grunker.db')),
  clientDir: resolve(ROOT, str('CLIENT_DIR', 'client')),
  sharedDir: resolve(ROOT, 'shared'),
  serveStatic: bool('SERVE_STATIC', true),
  // Profile pictures. One file per account, served from /avatars/<file>.
  avatarDir: resolve(ROOT, str('AVATAR_DIR', 'data/avatars')),
  // Clan pictures. Same shape, same limits, its own directory and URL prefix.
  clanAvatarDir: resolve(ROOT, str('CLAN_AVATAR_DIR', 'data/clans')),
  avatars: {
    enabled: bool('AVATARS_ENABLED', true),
    // Ceilings the upload route enforces. The client downscales to
    // AVATAR_SIZE before it uploads, so a normal picture lands far below these.
    maxBytes: num('AVATAR_MAX_BYTES', K_AVATAR_MAX_BYTES),
    maxDimension: num('AVATAR_MAX_DIM', K_AVATAR_MAX_DIM),
    // How long a browser may cache one. The filename carries a content hash,
    // so a new picture is a new URL and this can be as long as you like.
    cacheSeconds: num('AVATAR_CACHE_SEC', 31_536_000),
  },

  /**
   * Away-from-keyboard.
   *
   * Counted from real input — a key held or the view moving — and never from
   * the socket being alive, because a page left open answers every heartbeat
   * and so does the timer an anti-AFK script is built out of.
   */
  afk: {
    enabled: bool('AFK_ENABLED', true),
    warnSec: num('AFK_WARN_SEC', K_AFK_WARN_SEC),
    kickSec: num('AFK_KICK_SEC', K_AFK_KICK_SEC),
  },

  /**
   * The anti-cheat.
   *
   * Every check refuses a packet and hands back the authoritative value
   * whatever these say; what they turn on is the *scoring* of those refusals
   * and the kick at the end of it, which is the part with a false-positive cost
   * attached. Turning it off leaves a server that is still not fooled — just
   * one that never drops anybody for trying.
   */
  anticheat: {
    enabled: bool('ANTICHEAT_ENABLED', true),
    // Drop the connection, or only ever warn and log. A server that would
    // rather review its own queue by hand sets this false.
    kick: bool('ANTICHEAT_KICK', true),
    warnScore: num('ANTICHEAT_WARN_SCORE', K_CHEAT_WARN_SCORE),
    kickScore: num('ANTICHEAT_KICK_SCORE', K_CHEAT_KICK_SCORE),
  },

  // Player reports
  reports: {
    enabled: bool('REPORTS_ENABLED', true),
    // Ceilings on one account's reporting, so the queue stays readable. Each
    // one answers a different way of abusing the button — see the block comment
    // on REPORT_MAX_PER_HOUR in shared/constants.js.
    maxPerHour: num('REPORTS_MAX_PER_HOUR', K_REPORT_MAX_PER_HOUR),
    maxPerDay: num('REPORTS_MAX_PER_DAY', K_REPORT_MAX_PER_DAY),
    maxOpen: num('REPORTS_MAX_OPEN', K_REPORT_MAX_OPEN),
    cooldownSec: num('REPORTS_COOLDOWN_SEC', K_REPORT_COOLDOWN_SEC),
    repeatCooldownSec: num('REPORTS_REPEAT_COOLDOWN_SEC', K_REPORT_REPEAT_COOLDOWN_SEC),
    minLevel: num('REPORTS_MIN_LEVEL', K_REPORT_MIN_LEVEL),
    // Crying wolf: N dismissed reports inside the window shuts the button for
    // `lockoutHours`, counted from the last dismissal. 0 disables it.
    dismissedMax: num('REPORTS_DISMISSED_MAX', K_REPORT_DISMISSED.max),
    dismissedWindowDays: num('REPORTS_DISMISSED_WINDOW_DAYS', K_REPORT_DISMISSED.windowDays),
    dismissedLockoutHours: num('REPORTS_DISMISSED_LOCKOUT_HOURS', K_REPORT_DISMISSED.lockoutHours),
    /**
     * How long a *settled* report is kept. `0` — the default — keeps it for
     * good.
     *
     * The queue is a to-do list, but the history behind it is the only record
     * of what a moderator decided and why, and it is the thing anyone asks for
     * six months later when the same name comes back. Deleting it on a ninety
     * day timer threw away exactly the evidence that a repeat offender is a
     * repeat offender, and the admin panel's own HANDLED tab had nothing older
     * than a quarter in it. Open reports were never pruned and still are not.
     */
    keepResolvedDays: num('REPORTS_KEEP_RESOLVED_DAYS', 0),
  },

  /**
   * Friends.
   *
   * Each ceiling answers one way of turning a friend list into a nuisance
   * vector: a list nobody can fill, a request queue nobody can flood, and a
   * name that cannot be asked over and over.
   */
  friends: {
    enabled: bool('FRIENDS_ENABLED', true),
    max: num('FRIENDS_MAX', K_FRIENDS_MAX),
    maxRequests: num('FRIEND_REQUESTS_MAX', K_FRIEND_REQUESTS_MAX),
    maxInbox: num('FRIEND_REQUESTS_INBOX_MAX', K_FRIEND_REQUESTS_INBOX_MAX),
    cooldownSec: num('FRIEND_REQUEST_COOLDOWN_SEC', K_FRIEND_REQUEST_COOLDOWN_SEC),
    minLevel: num('FRIEND_MIN_LEVEL', K_FRIEND_MIN_LEVEL),
  },

  // Clans
  clans: {
    enabled: bool('CLANS_ENABLED', true),
    joinLevel: num('CLAN_JOIN_LEVEL', K_CLAN_JOIN_LEVEL),
    createLevel: num('CLAN_CREATE_LEVEL', K_CLAN_CREATE_LEVEL),
    createCost: num('CLAN_CREATE_COST', K_CLAN_CREATE_COST),
    maxMembers: num('CLAN_MAX_MEMBERS', K_CLAN_MAX_MEMBERS),
    maxInvites: num('CLAN_MAX_INVITES', K_CLAN_MAX_INVITES),
    inviteTtlHours: num('CLAN_INVITE_TTL_HOURS', K_CLAN_INVITE_TTL_HOURS),
  },

  // Auth
  sessionTtlDays: num('SESSION_TTL_DAYS', 30),
  scryptCost: num('SCRYPT_COST', 16384),
  registrationOpen: bool('REGISTRATION_OPEN', true),
  /** What a nickname change costs a signed-in player. Guests cannot rename. */
  renameCost: num('RENAME_COST', K_RENAME_COST),

  // Cloudflare Turnstile — one widget for the sign-up form, one for sign-in.
  // Each has its own key pair; a secret is what actually enforces the check, so
  // a missing secret turns that form's check off rather than failing shut.
  turnstile: {
    enabled: bool('TURNSTILE_ENABLED', true),
    register: {
      siteKey: str('TURNSTILE_SITEKEY_REGISTER', ''),
      secret: str('TURNSTILE_SECRET_REGISTER', ''),
    },
    login: {
      siteKey: str('TURNSTILE_SITEKEY_LOGIN', ''),
      secret: str('TURNSTILE_SECRET_LOGIN', ''),
    },
    // Cloudflare's verification endpoint; overridable so tests can stub it.
    verifyUrl: str('TURNSTILE_VERIFY_URL', 'https://challenges.cloudflare.com/turnstile/v0/siteverify'),
    timeoutMs: num('TURNSTILE_TIMEOUT_MS', 5000),
  },

  // Email verification
  mail: {
    // 'smtp' talks to a real server; 'log' prints the link to the log, which is
    // what a dev box without any mail credentials should do.
    transport: str('MAIL_TRANSPORT', 'log'),
    host: str('SMTP_HOST', ''),
    port: num('SMTP_PORT', 587),
    // true = implicit TLS (port 465). false = plain connect, then STARTTLS.
    secure: bool('SMTP_SECURE', false),
    startTls: bool('SMTP_STARTTLS', true),
    tlsRejectUnauthorized: bool('SMTP_TLS_REJECT_UNAUTHORIZED', true),
    user: str('SMTP_USER', ''),
    pass: str('SMTP_PASS', ''),
    from: str('MAIL_FROM', 'no-reply@g0x.dev'),
    fromName: str('MAIL_FROM_NAME', 'Open Grunker'),
    replyTo: str('MAIL_REPLY_TO', ''),
    timeoutMs: num('SMTP_TIMEOUT_MS', 15_000),
  },
  emailVerification: {
    enabled: bool('EMAIL_VERIFICATION', true),
    // An address is mandatory at sign-up when verification is on.
    required: bool('EMAIL_REQUIRED', true),
    // Refuse to seat an unverified account in a match.
    enforce: bool('EMAIL_VERIFY_ENFORCE', true),
    ttlHours: num('EMAIL_VERIFY_TTL_HOURS', 48),
    resendCooldownSec: num('EMAIL_RESEND_COOLDOWN_SEC', 120),
  },

  // One account, one live game. A second connection either takes the seat
  // ('takeover') or is turned away ('refuse').
  singleSession: bool('SINGLE_SESSION', true),
  singleSessionPolicy: /^refuse$/i.test(str('SINGLE_SESSION_POLICY', 'takeover')) ? 'refuse' : 'takeover',

  // VPN / proxy / datacenter blocking
  vpn: {
    block: bool('VPN_BLOCK', true),
    // 'ipapi' (free, no key, HTTP only) | 'proxycheck' (key, HTTPS) | 'none'
    provider: str('VPN_PROVIDER', 'ipapi').toLowerCase(),
    proxycheckKey: str('PROXYCHECK_KEY', ''),
    // Hosting/datacenter ranges are where most cheap VPNs live, but they also
    // cover a few corporate networks; turn this off to only block flagged proxies.
    blockHosting: bool('VPN_BLOCK_HOSTING', true),
    blockTor: bool('VPN_BLOCK_TOR', true),
    // When the lookup fails or times out: true lets the player in anyway.
    failOpen: bool('VPN_FAIL_OPEN', true),
    allow: list('VPN_ALLOWLIST', []),
    cacheHours: num('VPN_CACHE_HOURS', 72),
    timeoutMs: num('VPN_TIMEOUT_MS', 2500),
    // Endpoint bases, overridable so tests can point them at a local stub.
    // ip-api's paid tier is the same shape at https://pro.ip-api.com/json/.
    ipapiUrl: str('VPN_IPAPI_URL', 'http://ip-api.com/json/'),
    proxycheckUrl: str('VPN_PROXYCHECK_URL', 'https://proxycheck.io/v2/'),
  },

  // Game
  // Region tag shown in shareable match codes, e.g. FRA:7K2Q.
  region: str('REGION', 'FRA').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'FRA',
  maxPlayersPerRoom: num('MAX_PLAYERS_PER_ROOM', 8),
  botCount: num('BOT_COUNT', 4),
  botsEnabled: bool('BOTS_ENABLED', true),
  // The practice range keeps a couple of bots regardless of BOTS_ENABLED —
  // a range with nothing to shoot at is not a range. Set 0 to turn it off.
  practiceBots: num('PRACTICE_BOTS', 3),
  // The rooms that are always up, whatever the hour. Everything past this is
  // opened and closed by demand — see `dynamicRooms` below.
  rooms: list('ROOMS', [
    'littletown:tdm', 'littletown:ffa', 'burgtown:ffa', 'crossfire:tdm',
    'shipyard:gg', 'sandstorm:dom', 'subzero:ffa', 'range:range',
  ]),

  /**
   * Rooms that come and go with the player count.
   *
   * A fixed room list is wrong in both directions at once: on a quiet Tuesday
   * it spreads four players across eight empty matches, and on a busy evening
   * it turns everyone away with "every room is full" while the hardware sits
   * idle. The list above is the floor — every mode stays represented so a
   * server browser is never blank — and this opens more of whichever mode is
   * actually filling up, then closes them again when they empty.
   */
  dynamicRooms: {
    enabled: bool('DYNAMIC_ROOMS', true),
    // Never more than this many rooms in total, floor included. The ceiling is
    // about the tick loop, not about seats: every room costs CPU every tick.
    max: num('ROOMS_MAX', 32),
    // Open another room of a mode when the free seats across that mode drop to
    // this or below. Two is one duo arriving together.
    headroom: num('ROOM_HEADROOM', 2),
    // …and close a surplus room once it has been completely empty this long.
    // Long enough that a map rotation or a reconnect never costs a room.
    idleSec: num('ROOM_IDLE_SEC', 120),
    // How often the housekeeping pass reconsiders the room list.
    checkSec: num('ROOM_CHECK_SEC', 5),
  },

  /** Telemetry sampling — what the admin panel's STATS tab draws. */
  metrics: {
    enabled: bool('METRICS_ENABLED', true),
    // One sample per series per interval. Five minutes is 288 points a day.
    intervalSec: num('METRICS_INTERVAL_SEC', 300),
    keepDays: num('METRICS_KEEP_DAYS', 90),
  },

  // Admin panel — private network only, never reachable through the public vhost.
  adminPassword: str('ADMIN_PASSWORD', ''),
  adminEnabled: bool('ADMIN_ENABLED', true),
  // Restrict admin requests to loopback + RFC1918 addresses. Turning this off
  // would put the panel on the open internet; don't.
  adminLocalOnly: bool('ADMIN_LOCAL_ONLY', true),
  // Also accept private LAN addresses, so a phone or laptop on the same
  // network can open the panel. Loopback-only when false.
  adminAllowLan: bool('ADMIN_ALLOW_LAN', true),
  // Its own listener, so the game server keeps its loopback-only binding.
  adminHost: str('ADMIN_HOST', '0.0.0.0'),
  adminPort: num('ADMIN_PORT', 7421),
  adminTokenTtlMin: num('ADMIN_TOKEN_TTL_MIN', 120),

  // Moderation — shown on the ban screen so a player knows where to appeal.
  banAppealContact: str('BAN_APPEAL_CONTACT', 'appeal@grunker.g0x.dev'),

  // Anti-abuse
  rateWindowMs: num('RATE_WINDOW_MS', 60_000),
  rateMaxRequests: num('RATE_MAX_REQUESTS', 240),
  rateMaxAuth: num('RATE_MAX_AUTH', 12),
  maxWsPerIp: num('MAX_WS_PER_IP', 6),

  logLevel: str('LOG_LEVEL', 'info'),
};

export default config;
