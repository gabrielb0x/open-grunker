/**
 * Open Grunker — REST API, mounted at /api/v1.
 *
 * Accounts, progression, leaderboards, loadouts and server browser. Auth is a
 * bearer token that is also set as an HttpOnly cookie, so the game client can
 * use either transport.
 */
import * as K from '../../shared/constants.js';
import { CLASSES, SKINS, CLASS_IDS, loadoutFor, RARITY } from '../../shared/weapons.js';
import { mapList } from '../../shared/maps.js';
import { GAME_VERSION } from '../../shared/patchnotes.js';
import { Router, ApiError } from './router.js';
import { ok, fail, json, readJson, readBody, cookieHeader } from '../util/http.js';
import { hashPassword, verifyPassword, newToken, hashToken } from '../util/auth.js';
import {
  newSecret, verifyTotp, otpauthUri, newRecoveryCodes, hashRecoveryCode, PERIOD as TOTP_PERIOD,
  DIGITS as TOTP_DIGITS,
} from '../util/totp.js';
import { take } from '../util/ratelimit.js';
import * as turnstile from '../util/turnstile.js';
import * as ipintel from '../util/ipintel.js';
import { looksLikeEmail } from '../util/mailer.js';
import { sendVerification } from '../util/verify.js';
import { validateAvatar } from '../util/image.js';
import * as avatars from '../util/avatar.js';
import { registerClanRoutes, clanRules } from './clans.js';
import { reportStanding } from '../util/reports.js';
import config from '../config.js';
import log from '../util/log.js';

const logger = log.child('api');
export const COOKIE = 'og_session';

/** Every weapon id in the game, for the mastery board. */
const ALL_WEAPON_IDS = [...new Set(CLASS_IDS.flatMap((id) => loadoutFor(id).map((w) => w.id)))];

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * One account, as JSON.
 *
 * `self` is what separates a profile page from your own account: an address is
 * nobody else's business, and this same shape answers `/players/:name` for any
 * visitor.
 */
const publicUser = (u, s = null, l = null, { self = false } = {}) => ({
  id: u.id,
  username: u.username,
  level: u.level,
  xp: u.xp,
  nextLevelXp: K.xpForLevel(u.level + 1),
  levelXp: K.xpForLevel(u.level),
  gr: u.gr,
  verified: !!u.verified,
  // Null when this account has never uploaded one; the client draws initials.
  avatar: avatars.urlFor(u.avatar),
  ...(self ? {
    email: u.email ?? null,
    emailVerified: !!u.email_verified,
    // Whether this account is behind a second factor. Own-account only: it is
    // nobody else's business which accounts are the easy ones to attack.
    totp: { enabled: !!u.totp_secret, since: u.totp_enabled_at ?? null },
  } : {}),
  nameChanges: u.name_changes ?? 0,
  // The tag, and whether the clan behind it is verified — which is the only
  // difference between a grey tag and a gold one wherever a name is drawn.
  clan: u.clan ?? null,
  clanId: u.clan_id ?? null,
  clanVerified: !!u.clan_verified,
  role: u.role,
  createdAt: u.created_at,
  lastLogin: u.last_login ?? null,
  /*
   * The daily play streak, and whether today has already been claimed. Public,
   * because a streak nobody else can see is half a streak — it reads on a
   * profile the same way a K/D does. `todayDone` is what the menu uses to say
   * "come back tomorrow" rather than dangling a bonus that is already spent.
   */
  streak: {
    days: u.play_streak ?? 0,
    best: u.best_streak_days ?? 0,
    todayDone: (u.last_play_day ?? 0) === K.dayIndex(),
    next: K.streakReward(((u.last_play_day ?? 0) === K.dayIndex() ? (u.play_streak ?? 0) : (u.play_streak ?? 0) + 1)),
    firstWinDone: (u.last_win_day ?? 0) === K.dayIndex(),
    firstWin: K.FIRST_WIN_BONUS,
  },
  stats: s ? {
    kills: s.kills, deaths: s.deaths, assists: s.assists, headshots: s.headshots,
    kd: Math.round((s.kills / Math.max(1, s.deaths)) * 100) / 100,
    accuracy: s.shots_fired ? Math.round((s.shots_hit / s.shots_fired) * 1000) / 10 : 0,
    wins: s.wins, losses: s.losses, matches: s.matches, score: s.score ?? 0,
    damage: s.damage_dealt, bestStreak: s.best_streak, playtime: s.playtime_sec,
    shotsFired: s.shots_fired, shotsHit: s.shots_hit,
  } : null,
  loadout: l ? {
    classId: l.class_id,
    skins: safeJson(l.skins, {}),
    owned: safeJson(l.owned, []),
    settings: safeJson(l.settings, {}),
    keybinds: safeJson(l.keybinds, {}),
  } : null,
});

/** Mastery rows joined with the tier they translate to. */
function masteryPayload(db, userId) {
  const raw = db.mastery.forUser(userId);
  const out = {};
  for (const w of ALL_WEAPON_IDS) {
    const kills = raw[w]?.kills ?? 0;
    const m = K.masteryFor(kills);
    out[w] = {
      kills,
      headshots: raw[w]?.headshots ?? 0,
      tier: m.tier, tierName: m.name, progress: Math.round(m.progress * 100) / 100,
      toNext: m.toNext, nextName: m.next?.name ?? null,
    };
  }
  return out;
}

/** One board's worth of challenges with this player's progress on each. */
function challengeItems(db, userId, period, list) {
  const rows = new Map(db.challenges.forUser(userId, period).map((r) => [r.id, r]));
  return list.map((c) => {
    const row = rows.get(c.id);
    const progress = Math.min(c.goal, row?.progress ?? 0);
    return {
      id: c.id, name: c.name, desc: c.desc, goal: c.goal, xp: c.xp, gr: c.gr,
      progress, done: !!row?.claimed || progress >= c.goal,
    };
  });
}

/**
 * Both challenge boards, and the career list underneath them.
 *
 * `items` is still the day's three, unchanged, because that is what the client
 * has always read. The week's three and the milestone ledger ride alongside it.
 */
function challengePayload(db, userId) {
  const day = K.dayIndex();
  const week = K.weekIndex();
  const nowSec = Math.floor(Date.now() / 1000);
  const claimed = new Set(db.milestones.claimedFor(userId));
  const stats = db.stats.get(userId) ?? {};
  const value = {
    kills: stats.kills, wins: stats.wins, headshots: stats.headshots,
    matches: stats.matches, bestStreak: stats.best_streak,
    damage: stats.damage_dealt, playtime: stats.playtime_sec,
  };

  return {
    day,
    resetsIn: Math.max(0, (day + 1) * 86400 - nowSec),
    items: challengeItems(db, userId, day, K.dailyChallenges(day)),
    week: {
      index: week,
      // Weeks roll over on Monday morning; see `K.weekIndex`.
      resetsIn: Math.max(0, ((week + 1) * 7 - 3) * 86400 - nowSec),
      items: challengeItems(db, userId, K.weeklyPeriod(week), K.weeklyChallenges(week)),
    },
    /*
     * Every milestone, claimed or not, with where this account stands on it.
     *
     * The unclaimed ones are the point — a list that only showed what had
     * already been earned would be a trophy cabinet, and a trophy cabinet gives
     * nobody a reason to play tomorrow. The next rung of each track is what
     * does that, so it is sent with the number that is still missing from it.
     */
    milestones: K.MILESTONES.map((m) => {
      const at = Math.max(0, value[m.stat] ?? 0);
      return {
        id: m.id, name: m.name, desc: m.desc, goal: m.goal, stat: m.stat,
        xp: m.xp, gr: m.gr,
        progress: Math.min(at, m.goal),
        done: claimed.has(m.id),
      };
    }),
  };
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Has this player met the condition on an earned (never sold) finish? */
function skinUnlocked(db, user, skin, classId) {
  const u = skin.unlock;
  if (!u) return true;
  if (u.type === 'level') return user.level >= u.value;
  if (u.type === 'mastery') {
    const weaponId = CLASSES[classId]?.primary?.id;
    if (!weaponId) return false;
    const kills = db.mastery.forUser(user.id)[weaponId]?.kills ?? 0;
    return K.masteryFor(kills).tier >= u.value;
  }
  return false;
}

/**
 * The address rules for sign-up. An address is mandatory when verification is
 * switched on and required, optional otherwise, and always has to look real.
 */
function validateEmail(email, { required }) {
  const value = typeof email === 'string' ? email.trim() : '';
  if (!value) {
    if (required) {
      throw new ApiError(400, 'email_required',
        'an email address is required — you have to confirm it before you can play');
    }
    return null;
  }
  if (!looksLikeEmail(value)) {
    throw new ApiError(400, 'invalid_email', 'that email address does not look right');
  }
  return value.toLowerCase();
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !K.NAME_RE.test(username)) {
    throw new ApiError(400, 'invalid_username',
      `username must be ${K.NAME_MIN}-${K.NAME_MAX} chars: letters, digits, . _ -`);
  }
  if (typeof password !== 'string' || password.length < K.PASSWORD_MIN) {
    throw new ApiError(400, 'invalid_password', `password must be at least ${K.PASSWORD_MIN} characters`);
  }
}

/* ── Router ──────────────────────────────────────────────────────────────── */

/**
 * @param {object} deps { db, hub }
 * @returns {Router}
 */
export function createApi({ db, hub }) {
  const r = new Router();

  /**
   * One line in the `events` table, best-effort.
   *
   * Telemetry is never allowed to fail a request: a sign-up that worked and an
   * analytics row that did not is a good day compared with the reverse.
   */
  const event = (kind, payload = {}) => {
    if (!db?.events) return;
    try { db.events.add({ kind, ...payload }); } catch { /* analytics is not the product */ }
  };

  /**
   * Resolves a bearer/cookie token to { user, session } regardless of standing.
   * Only the realtime handshake uses this — it needs to tell "no session" apart
   * from "banned session" so it can say which, instead of silently handing a
   * banned account a guest seat.
   */
  const resolveSessionRaw = (token) => {
    if (!token) return null;
    const row = db.sessions.get(hashToken(token));
    if (!row) return null;
    const user = db.users.byId(row.user_id);
    return user ? { user, session: row } : null;
  };
  r.resolveSessionRaw = resolveSessionRaw;

  /** Resolves a token to a usable session. A banned account has none. */
  const resolveSession = (token) => {
    const hit = resolveSessionRaw(token);
    return hit && !db.users.isBanned(hit.user) ? hit : null;
  };
  r.resolveSession = resolveSession;

  const requireAuth = (ctx) => {
    if (!ctx.auth) throw new ApiError(401, 'unauthorized', 'sign in first');
    return ctx.auth.user;
  };

  const limit = (ctx, bucket, max) => {
    const res = take(`${bucket}:${ctx.ip}`, max);
    if (!res.allowed) throw new ApiError(429, 'rate_limited', `slow down — retry in ${res.retryAfter}s`);
  };

  /** A banned address gets no new accounts and no new sessions. */
  const refuseBannedAddress = (ctx) => {
    const row = db.ipBans.active(ctx.ip);
    if (!row) return;
    throw new ApiError(403, 'banned', row.reason
      ? `this network is banned — ${row.reason}`
      : 'this network is banned from Open Grunker');
  };

  /**
   * Neither is a connection behind a VPN, a proxy or a datacenter. Checked on
   * the account routes as well as at the socket, so a blocked player finds out
   * at the sign-in form rather than after filling one in.
   */
  const refuseVpn = async (ctx) => {
    const verdict = await ipintel.check(ctx.ip);
    if (!verdict.blocked) return;
    logger.info(`refused ${ctx.ip} — ${verdict.info.detail ?? 'proxy'} (${verdict.info.source})`);
    throw new ApiError(403, 'vpn_blocked', verdict.reason);
  };

  /** Cloudflare Turnstile. A form with no secret configured is not challenged. */
  const requireChallenge = async (ctx, form, body) => {
    if (!turnstile.isProtected(form)) return;
    const token = body?.turnstileToken ?? body?.['cf-turnstile-response'];
    const res = await turnstile.verify(form, token, ctx.ip);
    if (res.ok) return;
    throw new ApiError(res.reason === 'unreachable' ? 503 : 400,
      'captcha_failed', turnstile.humanError(res));
  };

  /**
   * Checks a second factor and spends it, whichever kind it turns out to be.
   *
   * Six digits is the authenticator app; anything else is treated as a recovery
   * code. Both are single-use, and both say so through the *same* boolean, so
   * no caller can accidentally accept one and not consume it:
   *
   *   • A TOTP code is bound to a thirty-second step. `spendStep` refuses a
   *     step that is not strictly newer than the last one accepted, so the
   *     same six digits cannot be replayed inside their own lifetime — which
   *     is the one weakness bare TOTP has.
   *   • A recovery code is a row that is deleted-by-marking on use, and the
   *     `used_at IS NULL` in that UPDATE is what makes two simultaneous
   *     attempts with the same code resolve to exactly one success.
   *
   * @returns {boolean} true only when this call consumed a valid factor.
   */
  const spendSecondFactor = (user, answer) => {
    const given = String(answer ?? '').trim();
    if (!given) return false;
    if (/^\d{6}$/.test(given.replace(/\s/g, ''))) {
      const step = verifyTotp(user.totp_secret, given);
      return step !== null && db.totp.spendStep(user.id, step);
    }
    return db.totp.spendRecovery(user.id, hashRecoveryCode(given));
  };

  /** Everything the client needs to render the "confirm your address" state. */
  const verificationState = (user) => ({
    required: config.emailVerification.enabled && config.emailVerification.required,
    enforced: config.emailVerification.enabled && config.emailVerification.enforce,
    verified: !!user.email_verified,
    email: user.email ?? null,
  });

  /* ── Meta ──────────────────────────────────────────────────────────────── */

  /**
   * A health check, and only that for anyone who is not staff.
   *
   * Room population, tick timings and how many people are playing are a staff
   * readout: they are handed back here to a moderator's session and to nobody
   * else. Monitoring only ever needed `status`.
   */
  r.get('/health', (ctx) => ok(ctx.res, {
    status: 'up',
    version: K.API_VERSION,
    build: GAME_VERSION,
    uptime: Math.round(process.uptime()),
    ...(K.canModerate(ctx.auth?.user?.role) ? { game: hub.health() } : {}),
  }));

  r.get('/meta', (ctx) => ok(ctx.res, {
    apiVersion: K.API_VERSION,
    protocol: K.PROTOCOL_VERSION,
    modes: Object.values(K.MODES),
    maps: mapList(),
    rarities: Object.values(RARITY),
    masteryTiers: K.MASTERY_TIERS,
    classes: CLASS_IDS.map((id) => ({
      id, name: CLASSES[id].name, tagline: CLASSES[id].tagline,
      color: CLASSES[id].color, unlockLevel: CLASSES[id].unlockLevel,
      weapon: {
        name: CLASSES[id].primary.name,
        damage: CLASSES[id].primary.damage,
        fireRate: CLASSES[id].primary.fireRate,
        magSize: CLASSES[id].primary.magSize,
        moveMult: CLASSES[id].primary.moveMult,
      },
    })),
    skins: Object.values(SKINS),
    currency: K.CURRENCY,
    build: GAME_VERSION,
    scoring: K.SCORE,
    scoreLabels: K.SCORE_LABELS,
    grPerScore: K.GR_PER_SCORE,
    matchTime: K.MATCH_TIME,
    maxPlayers: config.maxPlayersPerRoom,
    registrationOpen: config.registrationOpen,
    renameCost: config.renameCost,
    // Only the *site* keys travel; they are public by design and the browser
    // needs them to render a widget at all.
    turnstile: {
      register: turnstile.siteKeyFor('register'),
      login: turnstile.siteKeyFor('login'),
    },
    emailVerification: {
      enabled: config.emailVerification.enabled,
      required: config.emailVerification.required,
      // When true, an unverified account is not seated in a match.
      enforced: config.emailVerification.enabled && config.emailVerification.enforce,
      resendCooldown: config.emailVerification.resendCooldownSec,
    },
    avatars: {
      enabled: config.avatars.enabled,
      size: K.AVATAR_SIZE,
      maxBytes: config.avatars.maxBytes,
      maxDimension: config.avatars.maxDimension,
      types: K.AVATAR_TYPES,
    },
    reports: {
      enabled: config.reports.enabled,
      reasons: K.REPORT_REASONS,
      detailMax: K.REPORT_DETAIL_MAX,
      minLevel: config.reports.minLevel,
      maxPerHour: config.reports.maxPerHour,
      maxPerDay: config.reports.maxPerDay,
      maxOpen: config.reports.maxOpen,
      cooldownSec: config.reports.cooldownSec,
      repeatCooldownSec: config.reports.repeatCooldownSec,
    },
    // The level ladder, assembled from this server's own thresholds rather
    // than the constants' defaults — an operator who moved one in .env has
    // moved it for the panel that promises it too.
    progression: K.progressionLadder({
      chatLevel: K.CHAT_MIN_LEVEL,
      reportLevel: config.reports.minLevel,
      clanJoinLevel: config.clans.joinLevel,
      clanCreateLevel: config.clans.createLevel,
      clanCreateCost: config.clans.createCost,
      clansEnabled: config.clans.enabled,
      reportsEnabled: config.reports.enabled,
    }),
    clans: clanRules(),
    // Guests play under an assigned name; only an account picks its own.
    namedGuests: false,
    vpnBlocked: config.vpn.block && config.vpn.provider !== 'none',
    singleSession: config.singleSession,
  }));

  r.get('/servers', (ctx) => ok(ctx.res, { servers: hub.list() }));

  /* ── Auth ──────────────────────────────────────────────────────────────── */

  r.post('/auth/register', async (ctx) => {
    if (!config.registrationOpen) throw new ApiError(403, 'registration_closed', 'registration is disabled');
    limit(ctx, 'auth', config.rateMaxAuth);
    refuseBannedAddress(ctx);
    await refuseVpn(ctx);
    const body = await readJson(ctx.req);
    await requireChallenge(ctx, 'register', body);
    const { username, password } = body;
    validateCredentials(username, password);
    const email = validateEmail(body.email, {
      required: config.emailVerification.enabled && config.emailVerification.required,
    });
    if (db.users.byName(username)) throw new ApiError(409, 'username_taken', 'that name is already taken');

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = db.users.create({ username, email, passwordHash, ip: ctx.ip });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new ApiError(409, 'username_taken', 'that name is already taken');
      throw err;
    }

    // An account with no verification to do starts out already cleared, so the
    // rest of the server only ever has one flag to read.
    if (!config.emailVerification.enabled || !email) {
      user = db.users.markVerified(user.id, email);
    }

    let mail = { ok: true, transport: 'none' };
    if (config.emailVerification.enabled && email) {
      mail = await sendVerification(db, { user, email, ip: ctx.ip });
    }
    // `log` means the link went to the server's journal, not to an inbox.
    // Telling the player to go and check their mail would be a lie.
    const delivered = mail.ok && mail.transport === 'smtp';

    const token = newToken();
    db.sessions.create({ tokenHash: hashToken(token), userId: user.id, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    db.users.touchLogin(user.id, ctx.ip);
    logger.info(`registered ${user.username} (#${user.id})${email ? ` <${email}>` : ''}`);
    event('signup', {
      userId: user.id, name: user.username, value: K.SIGNUP_REWARD.gr,
      detail: { email: !!email, verified: !!user.email_verified, mail: mail.transport },
    });

    json(ctx.res, 201, {
      ok: true,
      token,
      user: publicUser(db.users.byId(user.id), db.stats.get(user.id), db.loadouts.get(user.id), { self: true }),
      // What the account was just handed, so the client can show it rather than
      // leaving the player to notice a balance they never saw arrive.
      reward: K.SIGNUP_REWARD,
      verification: { ...verificationState(db.users.byId(user.id)), sent: delivered, transport: mail.transport },
      // A mail server that is down must not swallow the sign-up silently.
      mailError: mail.ok ? null : 'the confirmation email could not be sent — try "resend" in a minute',
    }, { 'set-cookie': cookieHeader(COOKIE, token) });
  });

  r.post('/auth/login', async (ctx) => {
    limit(ctx, 'auth', config.rateMaxAuth);
    refuseBannedAddress(ctx);
    await refuseVpn(ctx);
    const body = await readJson(ctx.req);
    await requireChallenge(ctx, 'login', body);
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new ApiError(400, 'invalid_body', 'username and password are required');
    }
    const user = db.users.byName(username);
    // Always run the KDF so a missing user and a wrong password take the same time.
    const okPass = await verifyPassword(password, user?.password_hash ?? 'scrypt$16384$8$1$AAAA$AAAA');
    if (!user || !okPass) throw new ApiError(401, 'bad_credentials', 'wrong username or password');
    if (db.users.isBanned(user)) {
      const until = user.banned_until > 0
        ? ` until ${new Date(user.banned_until * 1000).toISOString().slice(0, 10)}`
        : '';
      throw new ApiError(403, 'banned',
        `this account is banned${until} — ${user.ban_reason || 'no reason given'}`);
    }

    /*
     * The second factor, if this account has one.
     *
     * Deliberately *after* the password check: an account with 2FA on must not
     * be distinguishable from one without it until the password is already
     * right, or this route becomes a way to enumerate which accounts are worth
     * attacking. The password being right is what earns the `totp_required`
     * answer, and that answer carries no session and no token — it is a second
     * question, not a partial login.
     */
    if (user.totp_secret) {
      const answer = String(body.code ?? body.totp ?? '').trim();
      if (!answer) {
        throw new ApiError(401, 'totp_required',
          'this account is protected by an authenticator app — enter the six-digit code');
      }
      if (!spendSecondFactor(user, answer)) {
        throw new ApiError(401, 'totp_invalid',
          'that code is wrong or has already been used — wait for the next one');
      }
    }

    const token = newToken();
    db.sessions.create({ tokenHash: hashToken(token), userId: user.id, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
    const wasSeen = user.last_login ?? 0;
    db.users.touchLogin(user.id, ctx.ip);
    event('login', {
      userId: user.id, name: user.username, value: user.level,
      // How long they had been away. This, aggregated, is the only honest
      // answer the panel can give to "are people coming back".
      detail: { awaySec: wasSeen ? Math.max(0, Math.floor(Date.now() / 1000) - wasSeen) : null },
    });

    json(ctx.res, 200, {
      ok: true,
      token,
      user: publicUser(user, db.stats.get(user.id), db.loadouts.get(user.id), { self: true }),
      verification: verificationState(user),
    }, { 'set-cookie': cookieHeader(COOKIE, token) });
  });

  r.post('/auth/logout', (ctx) => {
    limit(ctx, 'auth', config.rateMaxAuth * 4);
    if (ctx.token) db.sessions.destroy(hashToken(ctx.token));
    json(ctx.res, 200, { ok: true }, { 'set-cookie': cookieHeader(COOKIE, '', { clear: true }) });
  });

  r.get('/auth/me', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, {
      user: publicUser(user, db.stats.get(user.id), db.loadouts.get(user.id), { self: true }),
      verification: verificationState(user),
      mastery: masteryPayload(db, user.id),
      challenges: challengePayload(db, user.id),
    });
  });

  /* ── Email verification ────────────────────────────────────────────────── */

  /**
   * Spends the token from the link. Deliberately unauthenticated: the link is
   * often opened in a different browser from the one that signed up.
   */
  r.post('/auth/verify', async (ctx) => {
    limit(ctx, 'verify', config.rateMaxAuth);
    const { token } = await readJson(ctx.req);
    if (typeof token !== 'string' || !token) {
      throw new ApiError(400, 'invalid_body', 'that link is missing its token');
    }

    const row = db.emailTokens.consume(hashToken(token));
    if (!row) {
      throw new ApiError(400, 'bad_token',
        'this link has expired or has already been used — sign in and ask for a new one');
    }
    const user = db.users.byId(row.user_id);
    if (!user) throw new ApiError(404, 'not_found', 'that account no longer exists');

    db.users.markVerified(user.id, row.email);
    logger.info(`verified ${user.username} <${row.email}>`);
    ok(ctx.res, { username: user.username, email: row.email, verified: true });
  });

  /** Sends a fresh link, invalidating the previous one. */
  r.post('/auth/verify/resend', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'verify', config.rateMaxAuth);
    if (user.email_verified) throw new ApiError(409, 'already_verified', 'this address is already confirmed');
    if (!user.email) throw new ApiError(400, 'no_email', 'add an email address first');

    const last = db.emailTokens.latestFor(user.id);
    const waitSec = last
      ? last.created_at + config.emailVerification.resendCooldownSec - Math.floor(Date.now() / 1000)
      : 0;
    if (waitSec > 0) {
      throw new ApiError(429, 'resend_cooldown', `a link was just sent — try again in ${waitSec}s`);
    }

    const mail = await sendVerification(db, { user, email: user.email, ip: ctx.ip });
    if (!mail.ok) throw new ApiError(502, 'mail_failed', 'the email could not be sent — try again shortly');
    ok(ctx.res, { sent: mail.transport === 'smtp', email: user.email, transport: mail.transport });
  });

  /** Corrects the address on an unconfirmed account, then re-sends the link. */
  r.post('/auth/email', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'verify', config.rateMaxAuth);
    const { email, password } = await readJson(ctx.req);
    if (!await verifyPassword(String(password ?? ''), user.password_hash)) {
      throw new ApiError(401, 'bad_credentials', 'your password is wrong');
    }
    const address = validateEmail(email, { required: true });
    if (address === (user.email ?? '').toLowerCase() && user.email_verified) {
      throw new ApiError(409, 'already_verified', 'that address is already confirmed');
    }

    if (!config.emailVerification.enabled) {
      // Nothing to confirm on this server; the address is simply an address.
      db.users.markVerified(user.id, address);
      logger.info(`${user.username} changed address to <${address}>`);
      ok(ctx.res, { email: address, sent: false, verification: verificationState(db.users.byId(user.id)) });
      return;
    }

    const updated = db.users.setEmail(user.id, address);
    const mail = await sendVerification(db, { user: updated, email: address, ip: ctx.ip });
    if (!mail.ok) throw new ApiError(502, 'mail_failed', 'the email could not be sent — try again shortly');
    logger.info(`${user.username} changed address to <${address}>`);
    ok(ctx.res, {
      email: address, sent: mail.transport === 'smtp',
      verification: verificationState(db.users.byId(user.id)),
    });
  });

  /* ── Nickname ──────────────────────────────────────────────────────────── */

  /**
   * A paid rename. Guests have no name to change — the server assigns theirs —
   * so this route exists only for accounts, and it costs GR.
   *
   * The GR is taken first and refunded if the name turns out to be gone: the
   * unique index on `username_lower`, not a prior SELECT, is what settles a
   * race between two people buying the same name in the same second.
   */
  r.post('/auth/username', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'auth', config.rateMaxAuth);
    const { username } = await readJson(ctx.req);
    if (typeof username !== 'string' || !K.NAME_RE.test(username.trim())) {
      throw new ApiError(400, 'invalid_username',
        `username must be ${K.NAME_MIN}-${K.NAME_MAX} chars: letters, digits, . _ -`);
    }
    const wanted = username.trim();
    if (wanted === user.username) {
      throw new ApiError(409, 'same_name', 'that is already your name');
    }

    const cost = config.renameCost;
    // Only a change of spelling ("bob" -> "Bob") is free; it collides with
    // nobody but the account itself.
    const restyle = wanted.toLowerCase() === user.username.toLowerCase();
    if (!restyle) {
      const taken = db.users.byName(wanted);
      if (taken) throw new ApiError(409, 'username_taken', 'that name is already taken');
      if (user.gr < cost) {
        throw new ApiError(402, 'insufficient_gr', `a new name costs ${cost} GR, you have ${user.gr}`);
      }
      db.users.addProgress(user.id, 0, -cost);
    }

    let fresh;
    try {
      fresh = db.users.rename(user.id, wanted);
    } catch (err) {
      if (!restyle) db.users.addProgress(user.id, 0, cost);      // lost the race, keep the GR
      if (String(err.message).includes('UNIQUE')) {
        throw new ApiError(409, 'username_taken', 'that name was taken a moment ago');
      }
      throw err;
    }

    // Live sockets still carry the old name; the next connection picks up the
    // new one, and telling the player that is kinder than a silent mismatch.
    logger.info(`${user.username} renamed to ${wanted}${restyle ? ' (restyle, free)' : ` for ${cost} GR`}`);
    ok(ctx.res, {
      user: publicUser(fresh, db.stats.get(fresh.id), db.loadouts.get(fresh.id), { self: true }),
      spent: restyle ? 0 : cost,
      gr: fresh.gr,
    });
  });

  /* ── Progression ───────────────────────────────────────────────────────── */

  r.get('/mastery', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, { mastery: masteryPayload(db, user.id) });
  });

  r.get('/challenges', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, challengePayload(db, user.id));
  });

  /** A public mastery board for any player, for profile pages. */
  r.get('/players/:name/mastery', (ctx) => {
    const user = db.users.byName(ctx.params.name);
    if (!user) throw new ApiError(404, 'not_found', 'no such player');
    ok(ctx.res, { mastery: masteryPayload(db, user.id) });
  });

  r.post('/auth/password', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'auth', config.rateMaxAuth);
    const { current, next, code } = await readJson(ctx.req);
    if (!await verifyPassword(String(current ?? ''), user.password_hash)) {
      throw new ApiError(401, 'bad_credentials', 'current password is wrong');
    }
    // A password change signs every device out, which makes it the one move
    // that turns a borrowed session into a stolen account. If this account has
    // a second factor, it is asked for here as well.
    if (user.totp_secret) {
      if (!String(code ?? '').trim()) {
        throw new ApiError(401, 'totp_required', 'enter the six-digit code from your authenticator app');
      }
      if (!spendSecondFactor(user, code)) {
        throw new ApiError(401, 'totp_invalid', 'that code is wrong or has already been used');
      }
    }
    if (typeof next !== 'string' || next.length < K.PASSWORD_MIN) {
      throw new ApiError(400, 'invalid_password', `password must be at least ${K.PASSWORD_MIN} characters`);
    }
    db.users.setPassword(user.id, await hashPassword(next));
    db.sessions.destroyAllFor(user.id);
    json(ctx.res, 200, { ok: true, message: 'password changed — sign in again' },
      { 'set-cookie': cookieHeader(COOKIE, '', { clear: true }) });
  });

  /* ── Two-factor authentication ─────────────────────────────────────────────
     Four routes: draw the secret, turn it on, turn it off, and mint a new set
     of recovery codes. Everything that *changes* the state of the second factor
     costs a password, because otherwise a borrowed session is enough to lock
     the owner out of their own account.
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * Hands out a fresh secret and the URI a QR code encodes.
   *
   * Nothing is stored. The secret becomes real at `/auth/totp/enable`, and only
   * once a code derived from it has been checked — an account that opened this
   * card and wandered off is exactly as it was, rather than locked behind a
   * secret nobody finished scanning.
   */
  r.post('/auth/totp/setup', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'auth', config.rateMaxAuth);
    if (user.totp_secret) {
      throw new ApiError(409, 'totp_already_on',
        'two-factor is already on for this account — turn it off first');
    }
    const secret = newSecret();
    ok(ctx.res, {
      secret,
      uri: otpauthUri({ secret, account: user.username }),
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      issuer: 'Open Grunker',
    });
  });

  /**
   * Turns it on.
   *
   * The secret comes back from the client because that is the only copy of it
   * that exists — this server deliberately did not keep one. It is safe: the
   * route costs a password, so a hijacked session cannot swap in a secret of
   * its own, and the code proves whoever is asking has actually scanned it.
   */
  r.post('/auth/totp/enable', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'auth', config.rateMaxAuth);
    const { secret, code, password } = await readJson(ctx.req);
    if (!await verifyPassword(String(password ?? ''), user.password_hash)) {
      throw new ApiError(401, 'bad_credentials', 'your password is wrong');
    }
    if (user.totp_secret) {
      throw new ApiError(409, 'totp_already_on', 'two-factor is already on for this account');
    }
    if (typeof secret !== 'string' || secret.length < 16) {
      throw new ApiError(400, 'invalid_body', 'start again from the setup step');
    }
    const step = verifyTotp(secret, code);
    if (step === null) {
      throw new ApiError(400, 'totp_invalid',
        'that code does not match — check your phone\'s clock and try the next one');
    }

    const { codes, hashes } = newRecoveryCodes();
    db.totp.enable(user.id, secret, hashes);
    db.totp.spendStep(user.id, step);            // the setup code is spent too
    logger.info(`${user.username} switched two-factor on`);
    event('totp.enable', { userId: user.id, name: user.username, value: codes.length });
    ok(ctx.res, {
      enabled: true,
      // Shown once and never again — there is nowhere to look them up, which is
      // the entire point of storing only their hashes.
      recovery: codes,
      user: publicUser(db.users.byId(user.id), db.stats.get(user.id), db.loadouts.get(user.id), { self: true }),
    });
  });

  /** Turns it off. Costs the password *and* a live code, like every 2FA worth having. */
  r.post('/auth/totp/disable', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'auth', config.rateMaxAuth);
    const { password, code } = await readJson(ctx.req);
    if (!user.totp_secret) throw new ApiError(409, 'totp_off', 'two-factor is not on for this account');
    if (!await verifyPassword(String(password ?? ''), user.password_hash)) {
      throw new ApiError(401, 'bad_credentials', 'your password is wrong');
    }
    if (!spendSecondFactor(user, code)) {
      throw new ApiError(401, 'totp_invalid', 'that code is wrong or has already been used');
    }
    db.totp.disable(user.id);
    logger.info(`${user.username} switched two-factor off`);
    event('totp.disable', { userId: user.id, name: user.username });
    ok(ctx.res, {
      enabled: false,
      user: publicUser(db.users.byId(user.id), db.stats.get(user.id), db.loadouts.get(user.id), { self: true }),
    });
  });

  /**
   * A fresh set of recovery codes, replacing whatever is left of the old ones.
   *
   * The old set stops working the moment this returns. That is the point: a
   * player regenerating them is usually a player who thinks the old list has
   * been seen by somebody else.
   */
  r.post('/auth/totp/recovery', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'auth', config.rateMaxAuth);
    const { password, code } = await readJson(ctx.req);
    if (!user.totp_secret) throw new ApiError(409, 'totp_off', 'two-factor is not on for this account');
    if (!await verifyPassword(String(password ?? ''), user.password_hash)) {
      throw new ApiError(401, 'bad_credentials', 'your password is wrong');
    }
    if (!spendSecondFactor(user, code)) {
      throw new ApiError(401, 'totp_invalid', 'that code is wrong or has already been used');
    }
    const { codes, hashes } = newRecoveryCodes();
    db.totp.resetRecovery(user.id, hashes);
    logger.info(`${user.username} regenerated their recovery codes`);
    ok(ctx.res, { recovery: codes });
  });

  /** How many recovery codes are left, for the panel to warn about. */
  r.get('/auth/totp', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, {
      enabled: !!user.totp_secret,
      since: user.totp_enabled_at ?? null,
      recoveryLeft: user.totp_secret ? db.totp.recoveryLeft(user.id) : 0,
    });
  });

  /* ── Profile picture ───────────────────────────────────────────────────── */

  /**
   * Replaces this account's picture.
   *
   * The body is the image itself, not a form and not JSON: the client has
   * already squared it, scaled it to AVATAR_SIZE and re-encoded it in a canvas,
   * so what arrives here is a small file rather than whatever came off a phone
   * camera. None of that is taken on trust — the bytes are sniffed, measured
   * and refused on their own merits, because the client is only ever a
   * convenience and never the check.
   */
  r.post('/avatar', async (ctx) => {
    const user = requireAuth(ctx);
    if (!config.avatars.enabled) {
      throw new ApiError(403, 'avatars_disabled', 'profile pictures are switched off on this server');
    }
    limit(ctx, 'avatar', 12);

    // One byte over the ceiling and the upload is dropped mid-flight rather
    // than buffered to completion first.
    let buf;
    try {
      buf = await readBody(ctx.req, config.avatars.maxBytes + 1024);
    } catch (err) {
      if (err.status === 413) {
        throw new ApiError(413, 'image_too_large',
          `keep it under ${Math.floor(config.avatars.maxBytes / 1024)} KB`);
      }
      throw err;
    }

    const verdict = validateAvatar(buf, {
      maxBytes: config.avatars.maxBytes,
      maxDimension: config.avatars.maxDimension,
    });
    if (!verdict.ok) throw new ApiError(400, verdict.code, verdict.message);

    const file = await avatars.save(user.id, buf, verdict.ext);
    const fresh = db.users.setAvatar(user.id, file);
    logger.info(`${user.username} set a new avatar (${verdict.width}×${verdict.height} ${verdict.ext}, `
      + `${Math.ceil(buf.length / 1024)} KB)`);
    ok(ctx.res, {
      avatar: avatars.urlFor(file),
      width: verdict.width, height: verdict.height, bytes: buf.length,
      user: publicUser(fresh, db.stats.get(user.id), db.loadouts.get(user.id), { self: true }),
    });
  });

  r.delete('/avatar', async (ctx) => {
    limit(ctx, 'avatar', 12);
    const user = requireAuth(ctx);
    const removed = await avatars.remove(user.id);
    const fresh = db.users.setAvatar(user.id, null);
    ok(ctx.res, {
      removed,
      user: publicUser(fresh, db.stats.get(user.id), db.loadouts.get(user.id), { self: true }),
    });
  });

  /* ── Reports ───────────────────────────────────────────────────────────── */

  /**
   * The reports this account has filed, and what became of each.
   *
   * Filing happens over the game socket, where the server can see for itself
   * who was in the room, what the match was and what had just been said in it.
   * This route is the other half: a report that vanishes into a queue nobody
   * ever hears back from is a report nobody bothers to file twice, so the
   * verdict a moderator writes comes back to the player who asked for it.
   */
  r.get('/reports/mine', (ctx) => {
    const user = requireAuth(ctx);
    const rows = db.reports.forReporter(user.id, 50);
    ok(ctx.res, {
      reports: rows.map((rep) => ({
        id: rep.id,
        target: rep.targetName,
        reason: rep.reason,
        reasonLabel: K.reportReasonLabel(rep.reason),
        detail: rep.detail,
        room: rep.room,
        mode: rep.mode,
        map: rep.map,
        at: rep.createdAt,
        status: rep.status,
        statusLabel: K.REPORT_STATUS[rep.status]?.label ?? rep.status.toUpperCase(),
        // Deliberately not "who": a reporter learns what happened, never which
        // moderator did it, and never the sanction's length.
        action: rep.action,
        actionLabel: rep.action ? K.REPORT_ACTIONS[rep.action] ?? rep.action : null,
        outcome: rep.outcome,
        resolvedAt: rep.resolvedAt,
      })),
      open: rows.filter((rep) => rep.status === 'open').length,
      // Not a summary of the rules — where this account actually stands against
      // each of them right now, from the same function the game socket asks
      // before it writes a row. The panel shows the truth or nothing.
      standing: reportStanding(db, { id: user.id, level: user.level }),
    });
  });

  /* ── Friends ───────────────────────────────────────────────────────────
   *
   * Presence is the whole reason this exists — a list of names is an address
   * book, and what anybody wants from a friend list is "who is on, and can I
   * get into their match". So every response here carries the live half from
   * the hub rather than a `last seen` out of the database, and a friend in a
   * room comes back with the code the server browser joins by.
   * ──────────────────────────────────────────────────────────────────────── */

  /** One friend, plus where they are this second. */
  const friendCard = (row, where) => ({
    id: row.id,
    username: row.username,
    level: row.level,
    verified: !!row.verified,
    avatar: avatars.urlFor(row.avatar),
    clan: row.clan ?? null,
    clanVerified: !!row.clanVerified,
    role: row.role,
    since: row.since ?? null,
    askedAt: row.askedAt ?? null,
    lastLogin: row.lastLogin ?? null,
    online: !!where?.online,
    playing: !!where?.playing,
    // Only ever a room somebody could actually walk into: a full one is not an
    // invitation, and neither is the menu backdrop a watcher is sitting in.
    room: where?.playing && !where?.full ? where.room : null,
    map: where?.playing ? where.map : null,
    mode: where?.playing ? where.mode : null,
    full: !!where?.full,
  });

  /** Everything the friends panel draws, in one request. */
  const friendsPayload = (user) => {
    const list = db.friends.list(user.id);
    const incoming = db.friends.incoming(user.id);
    const outgoing = db.friends.outgoing(user.id);
    const where = hub.presence([...list, ...incoming, ...outgoing].map((f) => f.id));
    return {
      friends: list.map((f) => friendCard(f, where.get(f.id)))
        // Whoever can be joined right now sorts first: that is the one row on
        // this panel anybody is actually looking for.
        .sort((a, b) => (b.playing - a.playing) || (b.online - a.online)
          || a.username.localeCompare(b.username)),
      incoming: incoming.map((f) => friendCard(f, where.get(f.id))),
      outgoing: outgoing.map((f) => friendCard(f, where.get(f.id))),
      online: list.filter((f) => where.get(f.id)?.online).length,
      // The operator's numbers rather than the defaults, so the panel greys a
      // button out on the same ceiling the route refuses with.
      limits: {
        max: config.friends.max,
        maxRequests: config.friends.maxRequests,
        minLevel: config.friends.minLevel,
      },
    };
  };

  const requireFriends = () => {
    if (!config.friends.enabled) {
      throw new ApiError(403, 'disabled', 'friends are switched off on this server');
    }
  };

  r.get('/friends', (ctx) => {
    const user = requireAuth(ctx);
    requireFriends();
    ok(ctx.res, friendsPayload(user));
  });

  /**
   * Asks somebody by nickname.
   *
   * Every refusal below is a way this button could otherwise be used on
   * somebody rather than with them: a full list, a flood of asks, a fresh
   * throwaway account, and the same name twice. The one deliberate asymmetry is
   * that a standing ask from the other side is *accepted* instead of a second
   * request being filed — two people who both pressed the button are friends,
   * not two people each waiting on the other.
   */
  r.post('/friends/requests', async (ctx) => {
    const user = requireAuth(ctx);
    requireFriends();
    limit(ctx, 'friend', 30);
    const body = await readJson(ctx.req);
    const name = String(body.username ?? body.name ?? '').trim();
    if (!name) throw new ApiError(400, 'bad_request', 'who do you want to add?');

    const target = db.users.byName(name);
    if (!target) throw new ApiError(404, 'not_found', `nobody plays under the name ${name}`);
    if (target.id === user.id) throw new ApiError(400, 'bad_request', 'you already have yourself');
    if ((user.level ?? 1) < config.friends.minLevel) {
      throw new ApiError(403, 'level_too_low', `reach level ${config.friends.minLevel} to add friends`);
    }
    if (db.friends.are(user.id, target.id)) {
      throw new ApiError(409, 'already_friends', `you and ${target.username} are already friends`);
    }
    if (db.friends.count(user.id) >= config.friends.max) {
      throw new ApiError(409, 'list_full', `your friend list is full at ${config.friends.max}`);
    }
    if (db.friends.count(target.id) >= config.friends.max) {
      throw new ApiError(409, 'list_full', `${target.username}'s friend list is full`);
    }
    if (db.friends.requested(user.id, target.id)) {
      throw new ApiError(409, 'already_asked', `${target.username} has not answered your last request yet`);
    }
    if (db.friends.countOutgoing(user.id) >= config.friends.maxRequests) {
      throw new ApiError(409, 'too_many', `you have ${config.friends.maxRequests} requests outstanding — `
        + 'wait for some of them to be answered');
    }
    if (db.friends.countIncoming(target.id) >= config.friends.maxInbox) {
      throw new ApiError(409, 'too_many', `${target.username} has too many requests waiting`);
    }
    const gap = db.friends.lastRequestAt(user.id) + config.friends.cooldownSec
      - Math.floor(Date.now() / 1000);
    if (gap > 0) throw new ApiError(429, 'rate_limited', `one at a time — try again in ${gap}s`);

    const outcome = db.friends.request(user.id, target.id);
    ok(ctx.res, { outcome, friend: target.username, ...friendsPayload(user) });
  });

  /** Takes a standing request — theirs to us. */
  r.post('/friends/requests/:id/accept', (ctx) => {
    const user = requireAuth(ctx);
    requireFriends();
    limit(ctx, 'friend', 60);
    const other = db.users.byId(String(ctx.params.id));
    if (!other) throw new ApiError(404, 'not_found', 'no such player');
    if (db.friends.count(user.id) >= config.friends.max) {
      throw new ApiError(409, 'list_full', `your friend list is full at ${config.friends.max}`);
    }
    if (!db.friends.accept(other.id, user.id)) {
      throw new ApiError(404, 'not_found', 'that request is no longer standing');
    }
    ok(ctx.res, { friend: other.username, ...friendsPayload(user) });
  });

  /**
   * Throws a request away — declining theirs or cancelling ours.
   *
   * One route for both, because it is one row either way and the person on the
   * other end is told nothing in both cases. A decline that notified the asker
   * would make declining a thing people avoid doing.
   */
  r.delete('/friends/requests/:id', (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'friend', 60);
    const otherId = String(ctx.params.id);
    const dropped = db.friends.drop(otherId, user.id) || db.friends.drop(user.id, otherId);
    if (!dropped) throw new ApiError(404, 'not_found', 'no such request');
    ok(ctx.res, friendsPayload(user));
  });

  /** Ends a friendship. It ends for both — there was only ever one row. */
  r.delete('/friends/:id', (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'friend', 60);
    const other = db.users.byId(String(ctx.params.id));
    if (!other) throw new ApiError(404, 'not_found', 'no such player');
    if (!db.friends.remove(user.id, other.id)) {
      throw new ApiError(404, 'not_found', 'you are not friends');
    }
    ok(ctx.res, { removed: other.username, ...friendsPayload(user) });
  });

  /* ── Players & leaderboard ─────────────────────────────────────────────── */

  r.get('/players/:name', (ctx) => {
    const user = db.users.byName(ctx.params.name);
    if (!user) throw new ApiError(404, 'not_found', 'no such player');
    ok(ctx.res, {
      user: publicUser(user, db.stats.get(user.id)),
      recent: db.matches.recentFor(user.id, 8),
    });
  });

  r.get('/players/:name/matches', (ctx) => {
    const user = db.users.byName(ctx.params.name);
    if (!user) throw new ApiError(404, 'not_found', 'no such player');
    const limitN = Math.min(50, Number(ctx.query.get('limit')) || 20);
    ok(ctx.res, { matches: db.matches.recentFor(user.id, limitN) });
  });

  r.get('/leaderboard', (ctx) => {
    const sort = ctx.query.get('sort') ?? 'kills';
    const limitN = Math.min(200, Number(ctx.query.get('limit')) || 50);
    const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
    const entries = db.stats.leaderboard({ sort, limit: limitN, offset })
      // `clanVerified` alongside the raw column: every other payload spells it
      // that way, and it is the flag that decides grey or gold on the board.
      .map((row) => ({ ...row, avatar: avatars.urlFor(row.avatar), clanVerified: !!row.clan_verified }));
    ok(ctx.res, { sort, entries });
  });

  /* ── Loadout & shop ────────────────────────────────────────────────────── */

  r.get('/loadout', (ctx) => {
    const user = requireAuth(ctx);
    const l = db.loadouts.get(user.id);
    ok(ctx.res, {
      loadout: {
        classId: l.class_id, skins: safeJson(l.skins, {}),
        owned: safeJson(l.owned, []), settings: safeJson(l.settings, {}),
        keybinds: safeJson(l.keybinds, {}),
      },
    });
  });

  r.put('/loadout', async (ctx) => {
    const user = requireAuth(ctx);
    // The client saves on every settings change, so this is deliberately loose
    // — it is a write ceiling, not a gameplay one.
    limit(ctx, 'loadout', 120);
    const body = await readJson(ctx.req);
    const cur = db.loadouts.get(user.id);
    const owned = safeJson(cur.owned, []);

    const classId = typeof body.classId === 'string' && CLASSES[body.classId] ? body.classId : cur.class_id;
    const skins = {};
    if (body.skins && typeof body.skins === 'object') {
      for (const [cls, skin] of Object.entries(body.skins)) {
        if (!CLASSES[cls] || typeof skin !== 'string' || !SKINS[skin]) continue;
        const def = SKINS[skin];
        if (def.price > 0 && !owned.includes(skin)) continue;           // not purchased
        if (def.price < 0 && !skinUnlocked(db, user, def, cls)) continue;  // not earned
        skins[cls] = skin;
      }
    }
    const clip = (value, fallback, max) => {
      if (!value || typeof value !== 'object') return fallback;
      const text = JSON.stringify(value);
      return text.length > max ? fallback : JSON.parse(text);
    };
    const settings = clip(body.settings, safeJson(cur.settings, {}), 8000);
    const keybinds = clip(body.keybinds, safeJson(cur.keybinds, {}), 4000);

    db.loadouts.save(user.id, { classId, skins, owned, settings, keybinds });
    ok(ctx.res, { loadout: { classId, skins, owned, settings, keybinds } });
  });

  r.post('/shop/buy', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'shop', 60);
    const { skinId } = await readJson(ctx.req);
    const skin = SKINS[skinId];
    if (!skin) throw new ApiError(404, 'no_such_skin', 'unknown skin');
    const l = db.loadouts.get(user.id);
    const owned = safeJson(l.owned, []);
    if (owned.includes(skin.id) || skin.price === 0) throw new ApiError(409, 'already_owned', 'you already have that');
    if (skin.price < 0) {
      throw new ApiError(403, 'not_for_sale', skin.hint ?? 'this finish has to be earned, not bought');
    }
    if (user.gr < skin.price) {
      throw new ApiError(402, 'insufficient_gr', `costs ${skin.price} GR, you have ${user.gr}`);
    }

    db.users.addProgress(user.id, 0, -skin.price);
    owned.push(skin.id);
    db.loadouts.save(user.id, {
      classId: l.class_id, skins: safeJson(l.skins, {}), owned,
      settings: safeJson(l.settings, {}), keybinds: safeJson(l.keybinds, {}),
    });
    const fresh = db.users.byId(user.id);
    event('shop.buy', {
      userId: user.id, name: user.username, value: skin.price,
      detail: { skin: skin.id, rarity: skin.rarity, balance: fresh.gr },
    });
    ok(ctx.res, { owned, gr: fresh.gr });
  });

  /* ── Clans ─────────────────────────────────────────────────────────────── */

  registerClanRoutes({ r, db, hub, requireAuth, limit, avatarUrl: avatars.urlFor });

  /* ── Global stats ──────────────────────────────────────────────────────── */

  /**
   * How many accounts, how many matches, how many people are playing.
   *
   * Staff only. It used to sit in the menu's footer for everybody, which meant
   * anyone could watch the population of a small server rise and fall — and a
   * quiet evening is not something a game should advertise to the people
   * deciding whether to press PLAY. `/servers` still publishes each room's own
   * population, because the browser cannot pick a match without it.
   */
  r.get('/stats/global', (ctx) => {
    if (!K.canModerate(ctx.auth?.user?.role)) {
      throw new ApiError(403, 'staff_only', 'these figures are for moderators');
    }
    const s = db.summary();
    ok(ctx.res, { ...s, online: hub.humanCount, servers: hub.list().length });
  });

  return r;
}

export { fail, ok };
export default createApi;
