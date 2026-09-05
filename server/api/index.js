/**
 * Open Grunker — REST API, mounted at /api/v1.
 *
 * Accounts, progression, leaderboards, loadouts and server browser. Auth is a
 * bearer token that is also set as an HttpOnly cookie, so the game client can
 * use either transport.
 */
import { randomInt } from 'node:crypto';
import * as K from '../../shared/constants.js';
import { CLASSES, CLASS_IDS, DEFAULT_CLASS, loadoutFor } from '../../shared/weapons.js';
import * as COS from '../../shared/cosmetics.js';
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
import { validateAnthem, level } from '../util/audio.js';
import * as avatars from '../util/avatar.js';
import * as anthems from '../util/anthem.js';
import { registerClanRoutes, clanRules } from './clans.js';
import { reportStanding } from '../util/reports.js';
import config from '../config.js';
import log from '../util/log.js';

const logger = log.child('api', 'account');
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
/**
 * One creator, as JSON.
 *
 * Two shapes, and the difference between them is the whole privacy rule here.
 * `self` sees the application: what they wrote, what they asked for, what they
 * were told and by whom. Everybody else sees only what an *approved* creator
 * chose to put on their card — the discipline, the links, the anthem — and an
 * application that is pending, rejected or revoked reads as no creator at all.
 *
 * The link URLs are built here rather than sent as URLs, so nothing a player
 * typed ever reaches another player's screen as a destination: see the block
 * comment on CREATOR_PLATFORMS in shared/constants.js.
 */
const publicCreator = (c, { self = false } = {}) => {
  if (!c) return null;
  const approved = c.status === 'approved';
  if (!approved && !self) return null;
  const kind = K.getCreatorKind(c.kind);
  const links = c.links
    .map((l) => ({
      platform: l.platform,
      handle: l.handle,
      label: K.creatorLinkLabel(l),
      url: K.creatorLinkUrl(l),
    }))
    .filter((l) => l.url);
  return {
    kind: c.kind,
    kindName: kind?.name ?? c.kind,
    status: c.status,
    since: c.decidedAt ?? null,
    links,
    // Only an approved music creator's anthem is ever named. The file is on
    // disk either way — a revoked creator's is swept by the route that revoked
    // them — and this is the second lock on the same door.
    anthem: approved && K.creatorCan(c, 'anthem') ? anthems.urlFor(c.anthem) : null,
    anthemTitle: approved && K.creatorCan(c, 'anthem') ? c.anthemTitle : null,
    ...(self ? {
      asked: c.asked,
      pitch: c.pitch,
      verdict: c.verdict,
      decidedBy: c.decidedBy,
      appliedAt: c.appliedAt,
      grants: kind?.grants ?? [],
    } : {}),
  };
};

const publicUser = (u, s = null, l = null, { self = false, creator = null } = {}) => ({
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
  // How this account has styled its card. Public on purpose: a card only its
  // owner can see the colours of is a card nobody bothers to style. Normalised
  // on the way out as well as on the way in, so a row written before this
  // existed answers with a whole default card rather than a null.
  card: K.normaliseCard(safeJson(u.card, null)),
  /*
   * Creator status, or null. Public for exactly the reason the card is: the
   * badge and the links are most of what the status is *for*, and one only its
   * owner could see would be a status nobody bothers to apply for. Everything
   * private about an application — the pitch, the verdict, who read it — is
   * behind `self` inside publicCreator, not here.
   *
   * Passed in by the caller rather than looked up, so a route that lists a
   * hundred rows does not do a hundred queries it did not ask for.
   */
  creator: publicCreator(creator, { self }),
  ...(self ? {
    // Own account only: which of your answers is set to what is itself an
    // answer, and a stranger reading "this one shows nobody anything" learns
    // something about an account that asked not to be read.
    privacy: K.normalisePrivacy(safeJson(u.privacy, null)),
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

/**
 * What one account is to another: 'self', 'friend', or 'none'.
 *
 * Every privacy answer is written against these three words, so this is the one
 * place the question is asked and `canSee` is the one place it is answered.
 */
function relationOf(db, viewer, owner) {
  if (!viewer) return 'none';
  if (viewer.id === owner.id) return 'self';
  return db.friends.are(viewer.id, owner.id) ? 'friend' : 'none';
}

/**
 * One profile, with everything its owner has not shown this viewer removed.
 *
 * Removed, not flagged: a field a viewer may not see never leaves the server,
 * so there is nothing in the response for a modified client to un-hide. What
 * *is* sent is a small `hidden` list — the names of the sections that were
 * withheld — because "they have not shared their stats" and "they have no
 * stats" are different things and a card that cannot tell them apart reads as
 * broken.
 */
function visibleProfile(db, owner, viewer, { stats = null, recent = [] } = {}) {
  const relation = relationOf(db, viewer, owner);
  const privacy = db.users.privacy(owner);
  const hidden = [];
  const allow = (field) => {
    const okToSee = K.canSee(privacy[field], relation);
    if (!okToSee) hidden.push(field);
    return okToSee;
  };

  const user = publicUser(owner, allow('showStats') ? stats : null, null,
    { creator: db.creators.get(owner.id) });
  if (!allow('showClan')) { user.clan = null; user.clanId = null; user.clanVerified = false; }
  if (!allow('showStreak')) user.streak = null;
  if (!allow('showJoined')) user.createdAt = null;

  return {
    user,
    relation,
    hidden,
    recent: allow('showMatches') ? recent : [],
    // Only ever what this viewer is allowed to act on, so the card draws the
    // buttons the server would actually honour rather than guessing.
    can: {
      add: canBeAddedBy(db, owner, viewer, privacy),
      join: K.canSee(privacy.allowJoin, relation),
      seePresence: K.canSee(privacy.showPresence, relation),
    },
  };
}

/**
 * Whether `viewer` is allowed to send `owner` a friend request right now.
 *
 * Answers the setting *and* the state: somebody who already has you, has asked
 * you, or is you cannot be asked again, and the card wants one boolean rather
 * than four.
 */
function canBeAddedBy(db, owner, viewer, privacy = db.users.privacy(owner)) {
  if (!viewer || viewer.id === owner.id) return false;
  if (!config.friends.enabled) return false;
  if (db.friends.are(viewer.id, owner.id)) return false;
  // An ask already in flight, in either direction, is not a second ask: one is
  // waiting to be cancelled and the other is waiting to be accepted. Both have
  // their own button, and neither of them is this one.
  if (db.friends.requested(viewer.id, owner.id)) return false;
  if (db.friends.requested(owner.id, viewer.id)) return false;
  if (privacy.whoCanAdd === 'nobody') return false;
  if (privacy.whoCanAdd === 'mutuals' && !db.friends.share(viewer.id, owner.id)) return false;
  return true;
}

/**
 * Everything a card editor may offer, straight from shared/constants.js.
 *
 * Sent rather than hard-coded in the client so a server that adds a pattern
 * does not need a new build of the browser side, and so the list the editor
 * shows is by construction the list the save route accepts.
 */
const cardCatalogue = () => ({
  patterns: K.CARD_PATTERNS,
  frames: K.CARD_FRAMES,
  layouts: K.CARD_LAYOUTS,
  intensities: K.CARD_INTENSITIES,
  accentModes: K.CARD_ACCENT_MODES,
  stats: K.CARD_STATS,
  featuredMax: K.CARD_FEATURED_MAX,
  titleMax: K.CARD_TITLE_MAX,
  bioMax: K.CARD_BIO_MAX,
  defaults: K.CARD_DEFAULTS,
  privacy: {
    fields: K.PRIVACY_FIELDS,
    labels: K.PRIVACY_AUDIENCE_LABELS,
    defaults: K.PRIVACY_DEFAULTS,
  },
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

/**
 * A uniform [0,1) from the OS entropy pool.
 *
 * Case rolls run on this rather than Math.random. Math.random is seeded once
 * per process and its internal state is recoverable from a long enough run of
 * outputs — which, in the one place in this game where predicting the next
 * number is worth real GR, is not a theoretical objection.
 *
 * 32 bits, not 48: `randomInt` refuses a range wider than 2^48-1, and a drop
 * table with a hundred and nineteen items in it has no use for more than four
 * billion distinct outcomes anyway.
 */
const cryptoRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
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

  /**
   * The whole of one account, to its owner.
   *
   * Eight routes answered with the same four-argument expression and now answer
   * with this: register, sign-in, /auth/me, the address change, the rename, the
   * password change and both avatar routes all mean "here is your account as it
   * now stands". Written once so that adding something to that shape — the
   * creator status was the thing that made this worth doing — is one edit and
   * not eight.
   */
  const selfUser = (u) => publicUser(
    u, db.stats.get(u.id), db.loadouts.get(u.id),
    { self: true, creator: db.creators.get(u.id) },
  );

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
    logger.as('moderation').info('refused an address — proxy or datacenter', {
      ip: ctx.ip, detail: verdict.info.detail ?? 'proxy', source: verdict.info.source,
    });
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

  /**
   * What a browser says about how the game is actually running on it.
   *
   * The server can measure its own tick and nothing else. Whether the *client*
   * is drawing at a hundred and forty frames a second or at nine is invisible
   * from here — and "the game is unplayably slow on my machine" is not a
   * question anybody can answer without knowing which machine, which map,
   * which settings and which GPU. So the client says so, and it lands in the
   * log next to everything else that happened at that moment.
   *
   * Deliberately small and deliberately cheap to refuse:
   *
   *   • no session required — a guest's frame rate matters as much as anybody's
   *   • rate limited per address, hard, because it is an unauthenticated write
   *   • every field is clamped or dropped here rather than trusted
   *   • nothing is stored except a log line; there is no table to fill
   *
   * A report whose frame rate is bad enough to be a problem comes in as a
   * warning, so it stands out in the panel without anybody having to look for
   * it. Everything else is an info line the operator can filter to.
   */
  r.post('/diag', async (ctx) => {
    limit(ctx, 'diag', 20);
    const body = await readJson(ctx.req);
    const str = (v, n = 120) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    const int = (v, lo, hi) => {
      const x = Math.round(Number(v));
      return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null;
    };
    const kind = ['perf', 'error', 'boot'].includes(body.kind) ? body.kind : 'perf';
    const who = ctx.auth?.user ?? null;
    const client = logger.as('client').with({
      player: who?.username ?? str(body.name, 24),
      userId: who?.id ?? null,
      ip: ctx.ip,
      room: str(body.room, 32),
      map: str(body.map, 32),
      mode: str(body.mode, 16),
    });

    if (kind === 'error') {
      client.error(`client error — ${str(body.message, 200) ?? 'unknown'}`, {
        source: str(body.source, 160), line: int(body.line, 0, 1e7),
        stack: str(body.stack, 300), build: str(body.build, 24),
        gpu: str(body.gpu, 120), ua: str(body.ua, 160),
      });
      return ok(ctx.res, { ok: true });
    }

    const fps = int(body.fps, 0, 1000);
    const fields = {
      fps,
      fps1pctLow: int(body.fpsLow, 0, 1000),
      worstFrameMs: int(body.worstMs, 0, 60_000),
      quality: str(body.quality, 16),
      resolution: str(body.resolution, 16),
      pixelRatio: int(body.pixelRatio, 0, 8),
      draws: int(body.draws, 0, 100_000),
      triangles: int(body.triangles, 0, 50_000_000),
      programs: int(body.programs, 0, 4000),
      shadows: body.shadows === undefined ? null : !!body.shadows,
      post: body.post === undefined ? null : !!body.post,
      gpu: str(body.gpu, 120),
      screen: str(body.screen, 24),
      build: str(body.build, 24),
      ua: str(body.ua, 160),
      sampleSec: int(body.sampleSec, 0, 3600),
    };
    // Fifteen is the line below which the game stops being playable and starts
    // being a slideshow, which is exactly the report worth surfacing.
    if (kind === 'perf' && fps !== null && fps < 15) {
      client.warn(`frame rate collapsed — ${fps} fps`, fields);
    } else if (kind === 'boot') {
      client.info('client started', fields);
    } else {
      client.debug(`${fps ?? '?'} fps`, fields);
    }
    ok(ctx.res, { ok: true });
  });

  r.get('/meta', (ctx) => ok(ctx.res, {
    apiVersion: K.API_VERSION,
    protocol: K.PROTOCOL_VERSION,
    modes: Object.values(K.MODES),
    maps: mapList(),
    rarities: Object.values(COS.RARITY),
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
    // The catalogue itself is a static module the browser imports; what
    // travels here is the shape of it, for anything that only needs the
    // headline figures (the admin panel, a status page, a bot).
    slots: Object.values(COS.SLOT_META),
    cases: COS.CASE_IDS.map((id) => ({ ...COS.CASES[id], odds: COS.caseOdds(id), pool: COS.casePool(id).length })),
    itemCount: COS.ITEM_IDS.length,
    marketFee: COS.MARKET_FEE,
    currency: K.CURRENCY,
    build: GAME_VERSION,
    scoring: K.SCORE,
    scoreLabels: K.SCORE_LABELS,
    grPerScore: K.GR_PER_SCORE,
    matchTime: K.MATCH_TIME,
    maxPlayers: config.maxPlayersPerRoom,
    registrationOpen: config.registrationOpen,
    renameCost: config.renameCost,
    // What the browser falls back to when it has not asked for a language this
    // game speaks. The list of languages is the client's; this is one id out of
    // it, and an id the client does not know is simply ignored.
    defaultLanguage: config.defaultLanguage,
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
      devLevel: config.devMode.level,
      devEnabled: config.devMode.enabled,
      creatorLevel: config.creators.minLevel,
      creatorsEnabled: config.creators.enabled,
    }),
    clans: clanRules(),
    creators: creatorRules(),
    // The overlays are drawn entirely by the client out of things it already
    // has, so all the server has to say about them is whether they are allowed
    // and from what level. The panel list itself is a shared constant.
    devMode: {
      enabled: config.devMode.enabled,
      level: config.devMode.level,
      panels: K.DEV_PANELS,
      proPanels: K.DEV_PRO_PANEL_IDS,
    },
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
    logger.info('registered a new account', {
      player: user.username, userId: user.id, ip: ctx.ip, email: email ?? null,
    });
    event('signup', {
      userId: user.id, name: user.username, value: K.SIGNUP_REWARD.gr,
      detail: { email: !!email, verified: !!user.email_verified, mail: mail.transport },
    });

    json(ctx.res, 201, {
      ok: true,
      token,
      user: selfUser(db.users.byId(user.id)),
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
    if (!user || !okPass) {
      /*
       * A refused sign-in, kept.
       *
       * One is noise. Forty from one address in a minute is a credential run,
       * and it is invisible unless somebody wrote them down — so they are
       * written down, with the address and the name that was tried, and never
       * with the password that was tried with it.
       */
      logger.as('moderation').warn('sign-in refused — wrong username or password', {
        tried: String(username).slice(0, 32), ip: ctx.ip, knownAccount: !!user,
      });
      throw new ApiError(401, 'bad_credentials', 'wrong username or password');
    }
    if (db.users.isBanned(user)) {
      logger.as('moderation').info('sign-in refused — the account is banned', {
        player: user.username, userId: user.id, ip: ctx.ip,
        until: user.banned_until || null, reason: user.ban_reason || null,
      });
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
        logger.as('moderation').warn('second factor refused', {
          player: user.username, userId: user.id, ip: ctx.ip,
        });
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

    logger.info('signed in', {
      player: user.username, userId: user.id, ip: ctx.ip, level: user.level,
      twoFactor: !!user.totp_secret,
      awaySec: wasSeen ? Math.max(0, Math.floor(Date.now() / 1000) - wasSeen) : null,
    });

    json(ctx.res, 200, {
      ok: true,
      token,
      user: selfUser(user),
      verification: verificationState(user),
    }, { 'set-cookie': cookieHeader(COOKIE, token) });
  });

  r.post('/auth/logout', (ctx) => {
    limit(ctx, 'auth', config.rateMaxAuth * 4);
    if (ctx.token) {
      const who = ctx.auth?.user ?? null;
      logger.info('signed out', { player: who?.username ?? null, userId: who?.id ?? null, ip: ctx.ip });
      db.sessions.destroy(hashToken(ctx.token));
    }
    json(ctx.res, 200, { ok: true }, { 'set-cookie': cookieHeader(COOKIE, '', { clear: true }) });
  });

  r.get('/auth/me', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, {
      user: selfUser(user),
      verification: verificationState(user),
      mastery: masteryPayload(db, user.id),
      challenges: challengePayload(db, user.id),
      // The wardrobe rides along on the session restore rather than being a
      // second round trip: the loadout screen is one click from the menu and
      // the renderer needs it before the first frame either way.
      wardrobe: wardrobeOf(user),
      /*
       * Developer access, for the same reason and at the same cost: it decides
       * whether the DEVELOPER rail entry exists at all, and this is the request
       * that restores a session. Reading it off the join handshake instead
       * meant the tab only appeared once somebody had played a match — which is
       * a strange thing to have to do to reach a settings page.
       */
      dev: K.devModeAccess(
        { level: user.level, creator: db.creators.standing(user.id) },
        { devLevel: config.devMode.level, enabled: config.devMode.enabled },
      ),
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
    logger.info('confirmed their email address', {
      player: user.username, userId: user.id, email: row.email, ip: ctx.ip,
    });
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
    logger.info(`renamed to ${wanted}`, {
      player: user.username, userId: user.id, to: wanted,
      restyle: !!restyle, cost: restyle ? 0 : cost,
    });
    ok(ctx.res, {
      user: selfUser(fresh),
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
    logger.info('switched two-factor on', { player: user.username, userId: user.id, ip: ctx.ip });
    event('totp.enable', { userId: user.id, name: user.username, value: codes.length });
    ok(ctx.res, {
      enabled: true,
      // Shown once and never again — there is nowhere to look them up, which is
      // the entire point of storing only their hashes.
      recovery: codes,
      user: selfUser(db.users.byId(user.id)),
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
    logger.info('switched two-factor off', { player: user.username, userId: user.id, ip: ctx.ip });
    event('totp.disable', { userId: user.id, name: user.username });
    ok(ctx.res, {
      enabled: false,
      user: selfUser(db.users.byId(user.id)),
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
    logger.info('regenerated their recovery codes', { player: user.username, userId: user.id });
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
      user: selfUser(fresh),
    });
  });

  r.delete('/avatar', async (ctx) => {
    limit(ctx, 'avatar', 12);
    const user = requireAuth(ctx);
    const removed = await avatars.remove(user.id);
    const fresh = db.users.setAvatar(user.id, null);
    ok(ctx.res, {
      removed,
      user: selfUser(fresh),
    });
  });

  /* ── Creators ──────────────────────────────────────────────────────────────
   *
   * An application, a decision somebody else makes, and the perks that follow
   * it. Nothing in here grants anything: `creatorCan()` in shared/constants.js
   * is the single gate, it is asked on every route below, and it answers no for
   * anything that is not an *approved* row of the right kind — so a pending
   * application cannot upload an anthem however the request is shaped.
   * ────────────────────────────────────────────────────────────────────────── */

  /** The rules this server runs, as the panel needs to draw them. */
  const creatorRules = () => ({
    enabled: config.creators.enabled,
    minLevel: config.creators.minLevel,
    // Only ever true where an address is really confirmed: a gate on a server
    // that never sends a verification mail is a gate with nothing behind it.
    needEmail: config.creators.needEmail && config.emailVerification.enabled,
    reapplyDays: K.CREATOR_REAPPLY_DAYS,
    pitchMin: K.CREATOR_PITCH_MIN,
    pitchMax: K.CREATOR_PITCH_MAX,
    linksMax: K.CREATOR_LINKS_MAX,
    kinds: K.CREATOR_KINDS,
    platforms: K.CREATOR_PLATFORMS.map((p) => ({
      id: p.id, name: p.name, prefix: p.prefix ?? null, suffix: p.suffix ?? null,
      placeholder: p.placeholder,
    })),
    anthem: {
      maxSeconds: K.ANTHEM_MAX_SECONDS,
      minSeconds: K.ANTHEM_MIN_SECONDS,
      sampleRate: K.ANTHEM_SAMPLE_RATE,
      maxBytes: config.creators.anthemMaxBytes,
      titleMax: K.ANTHEM_TITLE_MAX,
      targetDb: K.ANTHEM_TARGET_RMS_DB,
    },
    skinRequest: {
      nameMax: K.SKIN_REQUEST_NAME_MAX,
      briefMin: K.SKIN_REQUEST_BRIEF_MIN,
      briefMax: K.SKIN_REQUEST_BRIEF_MAX,
      paletteMax: K.SKIN_REQUEST_PALETTE_MAX,
      openMax: K.SKIN_REQUEST_OPEN_MAX,
      slots: Object.values(COS.SLOT_META).map((s) => ({ id: s.id, name: s.name })),
    },
  });
  r.creatorRules = creatorRules;

  /**
   * Refuses everything when the operator has closed the programme.
   *
   * Always called *after* `requireAuth`, so an anonymous caller gets the same
   * 401 here as everywhere else in this file rather than being told something
   * about how this server is configured. Which of the two answers is more
   * useful is not really the point: one shape of answer for one shape of
   * caller is.
   */
  const requireCreatorsOn = () => {
    if (!config.creators.enabled) {
      throw new ApiError(403, 'creators_disabled', 'creator status is switched off on this server');
    }
  };

  /**
   * The approved row behind a request, or a 403 naming what is missing.
   *
   * `grant` is the one thing the caller wants to do, checked here rather than
   * by the caller, so no route can accidentally be reachable by the wrong
   * discipline — a musician cannot file a skin brief and an artist cannot
   * upload an anthem, and neither needs its route to remember that.
   */
  const requireCreator = (user, grant) => {
    requireCreatorsOn();
    const creator = db.creators.get(user.id);
    if (!creator || creator.status !== 'approved') {
      throw new ApiError(403, 'not_a_creator', 'that is a creator feature — apply under CREATOR');
    }
    if (!K.creatorCan(creator, grant)) {
      const kind = K.getCreatorKind(creator.kind);
      throw new ApiError(403, 'wrong_creator_kind',
        `that is not part of ${kind?.name ?? creator.kind} creator status`);
    }
    return creator;
  };

  /**
   * Everything this account's CREATOR tab draws, in one request.
   *
   * The catalogue travels with it rather than being imported by the browser,
   * because the *rules* half of it is this server's and not the constants'
   * defaults — an operator who moved the level in .env has moved it for the
   * panel that promises it too.
   */
  r.get('/creator', (ctx) => {
    const user = requireAuth(ctx);
    const creator = db.creators.get(user.id);
    const rules = creatorRules();
    ok(ctx.res, {
      rules,
      creator: creator ? publicCreator(creator, { self: true }) : null,
      apply: K.creatorApplyState(
        { level: user.level, emailVerified: !!user.email_verified },
        creator,
        { minLevel: rules.minLevel, needEmail: rules.needEmail },
      ),
      dev: K.devModeAccess(
        { level: user.level, creator: db.creators.standing(user.id) },
        { devLevel: config.devMode.level, enabled: config.devMode.enabled },
      ),
      skinRequests: K.creatorCan(creator, 'skinRequest')
        ? db.creators.skinRequests.forUser(user.id, 20)
        : [],
    });
  });

  /**
   * Files an application, or replaces the one this account already sent.
   *
   * Rate-limited hard. This is a queue a human reads, and the failure mode is
   * not a security one — it is thirty applications from one person that the
   * person reading them has to work through before finding a real one.
   */
  r.post('/creator/apply', async (ctx) => {
    const user = requireAuth(ctx);
    requireCreatorsOn();
    /*
     * Twelve a window rather than a handful, because a *refused* attempt costs
     * one too: somebody rewriting a pitch that came back "say a little more",
     * fixing a dead link and sending it again is three, and a person doing the
     * ordinary thing must not run into a ceiling built for somebody doing the
     * bad one. What this is really protecting is the queue a human reads, and
     * twelve is still far below the rate at which that becomes a nuisance.
     */
    limit(ctx, 'creator', 12);
    const body = await readJson(ctx.req);
    const rules = creatorRules();

    const state = K.creatorApplyState(
      { level: user.level, emailVerified: !!user.email_verified },
      db.creators.get(user.id),
      { minLevel: rules.minLevel, needEmail: rules.needEmail },
    );
    if (!state.can) throw new ApiError(403, 'cannot_apply', state.why);

    const kind = String(body.kind ?? '');
    if (!K.CREATOR_KIND_IDS.includes(kind)) {
      throw new ApiError(400, 'unknown_kind', 'pick one of the four disciplines');
    }
    // `cleanCardText` rather than a raw slice: this string is read by a
    // moderator inside the admin panel, and the invisible direction marks are
    // exactly what turns a pitch into something that reads as another one.
    const pitch = K.cleanCardText(body.pitch, K.CREATOR_PITCH_MAX);
    if (pitch.length < K.CREATOR_PITCH_MIN) {
      throw new ApiError(400, 'pitch_too_short',
        `say a little more — at least ${K.CREATOR_PITCH_MIN} characters about what you make`);
    }
    const linkError = K.creatorLinksError(body.links ?? []);
    if (linkError) throw new ApiError(400, 'bad_links', linkError);
    // A pitch with nowhere to look is not one anybody can act on.
    const links = K.normaliseCreatorLinks(body.links ?? []);
    if (!links.length) {
      throw new ApiError(400, 'no_links', 'add at least one link to something you have made');
    }

    const creator = db.creators.apply({
      userId: user.id, username: user.username, kind, pitch, links,
    });
    db.events.add({ kind: 'creator.apply', userId: user.id, name: user.username, detail: kind });
    logger.info(`${user.username} applied as a ${kind} creator`);
    ok(ctx.res, { creator: publicCreator(creator, { self: true }) });
  });

  /**
   * Withdraws a pending application, or resigns an approved status.
   *
   * The two are one route because they are one gesture — "take me off this
   * list" — but they are not one write. A pending row is deleted, because
   * nobody read it and there is nothing to record. An approved one is *revoked*
   * through the same path a moderator's decision takes, so the history says
   * what happened and the re-apply wait applies to it like any other ending.
   */
  r.delete('/creator', async (ctx) => {
    const user = requireAuth(ctx);
    requireCreatorsOn();
    const creator = db.creators.get(user.id);
    if (!creator) throw new ApiError(404, 'no_application', 'you have not applied');

    if (creator.status === 'approved') {
      // The file goes with the status: an anthem is a perk, and a perk that
      // outlives the status it came from is a perk nobody took away.
      await anthems.remove(user.id);
      db.creators.setAnthem(user.id, null, null);
      db.creators.decide({
        userId: user.id, status: 'revoked', actor: user.username,
        verdict: 'Resigned by the creator.',
      });
      logger.info(`${user.username} resigned their ${creator.kind} creator status`);
      ok(ctx.res, { creator: publicCreator(db.creators.get(user.id), { self: true }) });
      return;
    }

    const removed = db.creators.withdraw(user.id);
    if (removed?.anthem) await anthems.remove(user.id);
    ok(ctx.res, { creator: null, withdrawn: !!removed });
  });

  /** Replaces the link set on an approved creator's card. */
  r.put('/creator/links', async (ctx) => {
    const user = requireAuth(ctx);
    requireCreatorsOn();
    const creator = db.creators.get(user.id);
    if (!creator) throw new ApiError(404, 'no_application', 'you have not applied');
    // Deliberately not `requireCreator`: links belong to the *application* as
    // much as to the status, and somebody fixing a dead link on a pitch that is
    // still in the queue is doing the person who has to read it a favour.
    if (creator.status !== 'approved' && creator.status !== 'pending') {
      throw new ApiError(403, 'not_a_creator', 'that is a creator feature');
    }
    limit(ctx, 'creatorLinks', 20);
    const body = await readJson(ctx.req);
    const error = K.creatorLinksError(body.links ?? []);
    if (error) throw new ApiError(400, 'bad_links', error);
    const fresh = db.creators.setLinks(user.id, body.links ?? []);
    ok(ctx.res, { creator: publicCreator(fresh, { self: true }) });
  });

  /* ── The music creator's anthem ─────────────────────────────────────────── */

  /**
   * Stores ten seconds of somebody's music, levelled.
   *
   * The body is raw PCM in a WAVE wrapper — see the block comment on anthems in
   * shared/constants.js for why it is that and not an MP3 — and it is never
   * stored as it arrives. `level()` measures it, rewrites every sample to the
   * house loudness and re-emits a canonical file, and *that* is what is written
   * to disk. There is no threshold here to sit underneath: a track is not
   * checked for being too loud, it is made to be the right loudness.
   */
  r.post('/creator/anthem', async (ctx) => {
    const user = requireAuth(ctx);
    requireCreator(user, 'anthem');
    limit(ctx, 'anthem', 10);

    // Read past the ceiling on purpose. A file one second too long is over the
    // byte limit too, and refusing it at the socket would answer "too large"
    // to somebody whose actual problem is that it is eleven seconds — see the
    // ordering note in util/audio.js.
    let buf;
    try {
      buf = await readBody(ctx.req, config.creators.anthemMaxBytes + 256 * 1024);
    } catch (err) {
      if (err.status === 413) {
        throw new ApiError(413, 'anthem_too_large',
          `keep it under ${K.ANTHEM_MAX_SECONDS} seconds`);
      }
      throw err;
    }

    const verdict = validateAnthem(buf);
    if (!verdict.ok) throw new ApiError(400, verdict.code, verdict.message);

    const levelled = level(buf, verdict.info);
    if (!levelled.ok) throw new ApiError(400, levelled.code, levelled.message);

    const title = K.cleanCardText(ctx.query.get('title') ?? '', K.ANTHEM_TITLE_MAX);
    const file = await anthems.save(user.id, levelled.buffer, 'wav');
    const fresh = db.creators.setAnthem(user.id, file, title || null);
    logger.info(`${user.username} set an anthem (${levelled.report.seconds}s, `
      + `${levelled.report.gainDb > 0 ? '+' : ''}${levelled.report.gainDb} dB to `
      + `${levelled.report.after.loudDb} LUFS-ish, ${Math.ceil(levelled.buffer.length / 1024)} KB)`);
    ok(ctx.res, {
      creator: publicCreator(fresh, { self: true }),
      // The whole measurement, because the uploader draws it: "we turned your
      // track down 19 dB" is the one piece of feedback that stops the next
      // upload from being the same track, louder.
      levelling: levelled.report,
    });
  });

  /** Drops the anthem. The kill cam simply plays nothing after this. */
  r.delete('/creator/anthem', async (ctx) => {
    const user = requireAuth(ctx);
    requireCreator(user, 'anthem');
    const removed = await anthems.remove(user.id);
    const fresh = db.creators.setAnthem(user.id, null, null);
    ok(ctx.res, { removed, creator: publicCreator(fresh, { self: true }) });
  });

  /** Renames the track without re-uploading it. */
  r.put('/creator/anthem', async (ctx) => {
    const user = requireAuth(ctx);
    const creator = requireCreator(user, 'anthem');
    if (!creator.anthem) throw new ApiError(404, 'no_anthem', 'upload a track first');
    const body = await readJson(ctx.req);
    const fresh = db.creators.setAnthemTitle(user.id, K.cleanCardText(body.title, K.ANTHEM_TITLE_MAX));
    ok(ctx.res, { creator: publicCreator(fresh, { self: true }) });
  });

  /* ── The art creator's commissions ─────────────────────────────────────── */

  r.get('/creator/skin-requests', (ctx) => {
    const user = requireAuth(ctx);
    requireCreator(user, 'skinRequest');
    ok(ctx.res, {
      requests: db.creators.skinRequests.forUser(user.id, 30),
      open: db.creators.skinRequests.countOpenFor(user.id),
      max: K.SKIN_REQUEST_OPEN_MAX,
    });
  });

  /**
   * Files a brief for a finish.
   *
   * Nothing here mints a cosmetic and nothing here is automatic — the row is a
   * conversation with whoever reads the queue, and shared/cosmetics.js stays
   * the only thing that decides what exists in the game. The open-request
   * ceiling is what keeps it a queue rather than a wishlist.
   */
  r.post('/creator/skin-requests', async (ctx) => {
    const user = requireAuth(ctx);
    requireCreator(user, 'skinRequest');
    // Its own bucket. Filing a brief and applying for the status are different
    // acts by different people at different rates, and one counter for both
    // meant a burst of one locked the other out — which is not a ceiling, it is
    // a side effect.
    limit(ctx, 'skinRequest', 12);

    if (db.creators.skinRequests.countOpenFor(user.id) >= K.SKIN_REQUEST_OPEN_MAX) {
      throw new ApiError(409, 'too_many_open',
        `you already have ${K.SKIN_REQUEST_OPEN_MAX} briefs in the queue — wait for one to be answered`);
    }

    const body = await readJson(ctx.req);
    const name = K.cleanCardText(body.name, K.SKIN_REQUEST_NAME_MAX);
    if (name.length < 3) throw new ApiError(400, 'bad_name', 'give the finish a name');
    const slot = String(body.slot ?? '');
    if (!COS.SLOT_META[slot]) throw new ApiError(400, 'bad_slot', 'pick a slot for it');
    const brief = K.cleanCardText(body.brief, K.SKIN_REQUEST_BRIEF_MAX);
    if (brief.length < K.SKIN_REQUEST_BRIEF_MIN) {
      throw new ApiError(400, 'brief_too_short',
        `describe it properly — at least ${K.SKIN_REQUEST_BRIEF_MIN} characters`);
    }
    // The reference is one of this creator's own links, chosen by platform id,
    // not a URL they typed. Same rule as everywhere else: nothing a player
    // types ever becomes a host.
    const creator = db.creators.get(user.id);
    const reference = creator.links.some((l) => l.platform === body.reference)
      ? String(body.reference) : null;

    const request = db.creators.skinRequests.add({
      userId: user.id, username: user.username, name, slot, brief,
      palette: body.palette ?? [], reference,
    });
    db.events.add({ kind: 'creator.skin', userId: user.id, name: user.username, detail: name });
    logger.info(`${user.username} filed a skin brief: ${name} (${slot})`);
    ok(ctx.res, { request });
  });

  /** Takes back a brief nobody has answered yet. */
  r.delete('/creator/skin-requests/:id', (ctx) => {
    const user = requireAuth(ctx);
    requireCreator(user, 'skinRequest');
    const gone = db.creators.skinRequests.withdraw(ctx.params.id, user.id);
    if (!gone) throw new ApiError(404, 'not_found', 'no open brief of yours by that id');
    ok(ctx.res, { withdrawn: true });
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
    room: where?.playing && !where?.full && where?.joinable !== false ? where.room : null,
    map: where?.playing ? where.map : null,
    mode: where?.playing ? where.mode : null,
    full: !!where?.full,
    // Why there is no room code, when there is no room code. "Full" and "they
    // have closed their matches" are different sentences, and a row that says
    // the wrong one reads as the server being wrong about a friend.
    closed: where?.joinable === false,
  });

  /**
   * Everything the friends panel draws, in one request.
   *
   * Presence is filtered per row rather than in one sweep: "show when I am
   * online" is each friend's own answer, and somebody who set it to *no one*
   * means their friends too. A row whose owner said no comes back looking
   * exactly like a row whose owner is offline, which is the point.
   */
  const friendsPayload = (user) => {
    const list = db.friends.list(user.id);
    const incoming = db.friends.incoming(user.id);
    const outgoing = db.friends.outgoing(user.id);
    const raw = hub.presence([...list, ...incoming, ...outgoing].map((f) => f.id));
    const where = new Map();
    for (const [id, at] of raw) {
      // 'friend' for the list, and for a queue: somebody you have asked, or who
      // has asked you, is not on your list yet — so they get the stranger's
      // answer unless they opened it to everyone.
      const them = db.users.byId(id);
      if (!them) continue;
      const privacy = db.users.privacy(them);
      const relation = db.friends.are(user.id, id) ? 'friend' : 'none';
      if (!K.canSee(privacy.showPresence, relation)) continue;
      where.set(id, { ...at, joinable: K.canSee(privacy.allowJoin, relation) });
    }
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
    // Their setting, not ours. Deliberately the same sentence for "no one" and
    // "friends of friends only": the alternative tells a stranger which of the
    // two it is, which is a fact about an account they were told not to have.
    // A standing request *from* them is honoured either way — somebody who
    // asked you first has already opted in.
    if (!db.friends.requested(target.id, user.id)) {
      const theirs = db.users.privacy(target);
      const openToUs = theirs.whoCanAdd === 'everyone'
        || (theirs.whoCanAdd === 'mutuals' && db.friends.share(user.id, target.id));
      if (!openToUs) {
        throw new ApiError(403, 'not_accepting',
          `${target.username} is not taking friend requests right now`);
      }
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

  /* ── The card, and who it is for ───────────────────────────────────────
   *
   * Two routes because they are two decisions: how the card looks is a matter
   * of taste, and who may see what on it is not. Both are stored whole, both
   * are normalised by shared/constants.js before they are written, and neither
   * can fail on a value it does not recognise — an unknown pattern becomes the
   * default pattern rather than a 400 that loses the rest of the edit.
   * ──────────────────────────────────────────────────────────────────────── */

  /** This account's own card and privacy answers, plus what may be picked. */
  r.get('/profile/social', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, {
      card: db.users.card(user),
      privacy: db.users.privacy(user),
      catalogue: cardCatalogue(),
    });
  });

  r.put('/profile/card', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'profile', 60);
    const body = await readJson(ctx.req);
    const card = db.users.saveCard(user.id, body.card ?? body);
    ok(ctx.res, { card });
  });

  r.put('/profile/privacy', async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'profile', 60);
    const body = await readJson(ctx.req);
    const privacy = db.users.savePrivacy(user.id, body.privacy ?? body);
    ok(ctx.res, { privacy });
  });

  /* ── Players & leaderboard ─────────────────────────────────────────────── */

  /**
   * One public profile — the card, in one request.
   *
   * Signed in or not: a guest gets the card, just never the half of it whose
   * owner limited it to friends. `relation` and `can` are what let the card
   * draw ADD FRIEND, JOIN or neither without a second round trip.
   */
  r.get('/players/:name', (ctx) => {
    const user = db.users.byName(ctx.params.name);
    if (!user) throw new ApiError(404, 'not_found', 'no such player');
    const viewer = ctx.auth?.user ?? null;
    const payload = visibleProfile(db, user, viewer, {
      stats: db.stats.get(user.id),
      recent: db.matches.recentFor(user.id, 8),
    });

    // Where they are this second, when they let this viewer see it. Same shape
    // and the same "a full room is not an invitation" rule as the friend list.
    if (payload.can.seePresence) {
      const where = hub.presence([user.id]).get(user.id);
      payload.presence = {
        online: !!where?.online,
        playing: !!where?.playing,
        room: where?.playing && !where?.full && payload.can.join ? where.room : null,
        map: where?.playing ? where.map : null,
        mode: where?.playing ? where.mode : null,
        full: !!where?.full,
        lastLogin: user.last_login ?? null,
      };
    } else {
      payload.presence = null;
    }

    // Whether an ask is already in flight, so the button says CANCEL or
    // ACCEPT rather than offering to send a second one.
    payload.pending = viewer
      ? {
        outgoing: db.friends.requested(viewer.id, user.id),
        incoming: db.friends.requested(user.id, viewer.id),
      }
      : { outgoing: false, incoming: false };

    ok(ctx.res, payload);
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

  /* ── Loadout, wardrobe, cases, market & trades ─────────────────────────── */

  /**
   * The cosmetics catalogue itself is not served from here.
   *
   * It is a static module the browser imports directly (`/shared/cosmetics.js`),
   * which means the client and the server are reading the same 227 definitions
   * out of the same file rather than a copy of them serialised over HTTP. What
   * these routes carry is only what the server actually knows and the client
   * cannot: who owns what, what it is selling for, and who is offering what to
   * whom.
   */

  /**
   * What an account may equip, in the form `canEquip` wants.
   *
   * The mastery tier is per weapon, so it has to be resolved against the slot
   * being filled: the Masterwork finish on a sniper is earned by mastering the
   * sniper, and putting it on the knife is earned by mastering the knife.
   */
  const equipCtx = (user, weaponId) => ({
    authed: true,
    level: user.level ?? 0,
    masteryTier: weaponId
      ? K.masteryFor(db.mastery.forUser(user.id)[weaponId]?.kills ?? 0).tier
      : 0,
  });

  /** The weapon a gun slot is finishing, for one class. */
  const weaponForSlot = (slot, classId) => {
    const [primary, secondary, knife] = loadoutFor(classId);
    return slot === COS.SLOT.PRIMARY ? primary.id
      : slot === COS.SLOT.SECONDARY ? secondary.id
        : slot === COS.SLOT.KNIFE ? knife.id : null;
  };

  /**
   * Reads one account's whole wardrobe: what it holds, what it has on, and
   * what it may put on.
   *
   * `equippable` is computed here rather than left to the browser because it
   * is the same answer the save path enforces — a card the client draws as
   * available always is, and a card it greys out could not have been saved
   * anyway. One rule, one place.
   */
  function wardrobeOf(user) {
    const l = db.loadouts.get(user.id);
    const classId = CLASSES[l.class_id] ? l.class_id : DEFAULT_CLASS;
    const owned = db.inventory.ownedIds(user.id);
    const primaries = sanitisePrimaries(safeJson(l.primaries, {}), owned, user);
    const stored = safeJson(l.equip, {});
    // The per-class primary wins over the flat one: the flat slot is what the
    // renderer reads, and it has to agree with the class actually selected.
    const equip = COS.sanitiseEquip(
      { ...stored, [COS.SLOT.PRIMARY]: primaries[classId] ?? stored[COS.SLOT.PRIMARY] },
      owned,
      equipCtx(user, weaponForSlot(COS.SLOT.PRIMARY, classId)),
    );
    const equippable = [];
    for (const slot of COS.SLOT_IDS) {
      const ctx = equipCtx(user, weaponForSlot(slot, classId));
      for (const item of COS.itemsInSlot(slot)) {
        if (COS.canEquip(item.id, owned, ctx)) equippable.push(item.id);
      }
    }
    return {
      classId, equip, primaries, owned, equippable,
      units: db.inventory.list(user.id),
      gr: user.gr,
      tradeBannedUntil: Number(user.trade_banned_until ?? 0),
    };
  }

  /** Per-class primaries, cleaned against what the account owns and has earned. */
  function sanitisePrimaries(raw, owned, user) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [classId, id] of Object.entries(raw)) {
      if (!CLASSES[classId]) continue;
      const item = COS.getItem(id);
      if (!item || item.slot !== COS.SLOT.PRIMARY) continue;
      if (!COS.canEquip(id, owned, equipCtx(user, CLASSES[classId].primary.id))) continue;
      out[classId] = id;
    }
    return out;
  }

  /**
   * Turns an EconomyError into the 400 it deserves, and anything else into a 500.
   *
   * `await fn(ctx)` rather than `return fn(ctx)`: every route this wraps is
   * async, and a synchronous try/catch around a call that only *returns* a
   * promise catches nothing at all — every "you do not own that" would have
   * reached the client as a 500 with no message.
   */
  const economic = (fn) => async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      if (err?.name === 'EconomyError') throw new ApiError(400, err.code ?? 'economy', err.message);
      throw err;
    }
  };

  r.get('/loadout', (ctx) => {
    const user = requireAuth(ctx);
    const l = db.loadouts.get(user.id);
    ok(ctx.res, {
      loadout: {
        classId: l.class_id, settings: safeJson(l.settings, {}), keybinds: safeJson(l.keybinds, {}),
        // Kept for a client that has not reloaded across the V2 boundary yet.
        skins: safeJson(l.skins, {}), owned: safeJson(l.owned, []),
      },
      wardrobe: wardrobeOf(user),
    });
  });

  r.put('/loadout', async (ctx) => {
    const user = requireAuth(ctx);
    // The client saves on every settings change, so this is deliberately loose
    // — it is a write ceiling, not a gameplay one.
    limit(ctx, 'loadout', 120);
    const body = await readJson(ctx.req);
    const cur = db.loadouts.get(user.id);
    const owned = db.inventory.ownedIds(user.id);

    const classId = typeof body.classId === 'string' && CLASSES[body.classId] ? body.classId : cur.class_id;

    // The per-class primary map is merged rather than replaced: a client that
    // only ever sends the class it is looking at must not wipe the eight it is
    // not.
    const primaries = sanitisePrimaries(
      { ...safeJson(cur.primaries, {}), ...(body.primaries ?? {}) }, owned, user);

    const equip = COS.sanitiseEquip(
      { ...safeJson(cur.equip, {}), ...(body.equip ?? {}) },
      owned,
      equipCtx(user, weaponForSlot(COS.SLOT.PRIMARY, classId)),
    );
    // Equipping a primary is the same act as choosing it for this class.
    if (body.equip?.[COS.SLOT.PRIMARY] && equip[COS.SLOT.PRIMARY]) {
      primaries[classId] = equip[COS.SLOT.PRIMARY];
    } else if (primaries[classId]) {
      equip[COS.SLOT.PRIMARY] = primaries[classId];
    }

    const clip = (value, fallback, max) => {
      if (!value || typeof value !== 'object') return fallback;
      const text = JSON.stringify(value);
      return text.length > max ? fallback : JSON.parse(text);
    };
    const settings = clip(body.settings, safeJson(cur.settings, {}), 8000);
    const keybinds = clip(body.keybinds, safeJson(cur.keybinds, {}), 4000);

    db.loadouts.save(user.id, {
      classId, equip, primaries, settings, keybinds,
      skins: safeJson(cur.skins, {}), owned: safeJson(cur.owned, []),
    });
    ok(ctx.res, { loadout: { classId, settings, keybinds }, wardrobe: wardrobeOf(user) });
  });

  /* ── The wardrobe ──────────────────────────────────────────────────────── */

  r.get('/wardrobe', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, { wardrobe: wardrobeOf(user) });
  });

  /**
   * Buys one item outright, at catalogue price.
   *
   * The shop is deliberately the *expensive* way to get anything: a case is
   * cheaper per item and the market is cheaper still, and this exists so that
   * somebody who wants one specific finish can simply have it rather than
   * grinding a drop table for it. It is also the price anchor the whole market
   * floats under — nothing sensibly sells above catalogue when catalogue is
   * always in stock.
   */
  r.post('/shop/buy', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'shop', 60);
    const body = await readJson(ctx.req);
    // `skinId` is what a pre-V2 client sends; it names a finish rather than an
    // item, and the primary is the slot it always meant.
    const id = typeof body.itemId === 'string' ? body.itemId
      : typeof body.skinId === 'string' ? COS.itemId(COS.SLOT.PRIMARY, body.skinId) : null;
    const item = COS.getItem(id);
    if (!item) throw new ApiError(404, 'no_such_item', 'unknown item');
    if (item.default) throw new ApiError(409, 'already_owned', 'that one is free');
    if (item.earned) throw new ApiError(403, 'not_for_sale', item.hint ?? 'that one has to be earned');
    if (user.gr < item.price) {
      throw new ApiError(402, 'insufficient_gr', `costs ${item.price} GR, you have ${user.gr}`);
    }
    db.users.addProgress(user.id, 0, -item.price);
    const unit = db.inventory.mint(user.id, item.id, { source: 'shop', origin: 'catalogue' });
    const fresh = db.users.byId(user.id);
    event('shop.buy', {
      userId: user.id, name: user.username, value: item.price,
      detail: { item: item.id, rarity: item.rarity, balance: fresh.gr },
    });
    ok(ctx.res, { unitId: unit.id, itemId: item.id, gr: fresh.gr, wardrobe: wardrobeOf(fresh) });
  }));

  /** Hands a duplicate back to the game for a fifth of what it is worth. */
  r.post('/wardrobe/scrap', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'scrap', 60);
    const { unitId } = await readJson(ctx.req);
    const res = db.inventory.scrap(user.id, String(unitId ?? ''));
    const fresh = db.users.byId(user.id);
    event('cosmetics.scrap', {
      userId: user.id, name: user.username, value: res.gr, detail: { item: res.itemId },
    });
    ok(ctx.res, { ...res, gr: fresh.gr, wardrobe: wardrobeOf(fresh) });
  }));

  /* ── Cases ─────────────────────────────────────────────────────────────── */

  /**
   * Opens a case.
   *
   * The roll uses `randomInt` from node:crypto rather than Math.random, which
   * is not superstition: Math.random is seeded per process and its state is
   * recoverable from a long enough run of outputs, and this is the one call in
   * the game where knowing the next number is worth real money.
   */
  r.post('/cases/open', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'case', 40);
    const { caseId } = await readJson(ctx.req);
    const box = COS.CASES[caseId];
    if (!box) throw new ApiError(404, 'no_such_case', 'unknown case');
    const res = db.cases.open(user.id, box.id, cryptoRandom);
    const fresh = db.users.byId(user.id);
    const item = COS.getItem(res.itemId);
    event('cosmetics.case', {
      userId: user.id, name: user.username, value: box.price,
      detail: { case: box.id, item: res.itemId, rarity: item?.rarity, balance: fresh.gr },
    });
    ok(ctx.res, { ...res, rarity: item?.rarity, gr: fresh.gr, wardrobe: wardrobeOf(fresh) });
  }));

  /** The live drop feed: what everybody has just pulled. */
  r.get('/cases/recent', (ctx) => {
    ok(ctx.res, { drops: db.cases.recent(Number(ctx.query.get('limit')) || 24) });
  });

  /** One account's own opening history. */
  r.get('/cases/history', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, { openings: db.cases.forUser(user.id, Number(ctx.query.get('limit')) || 50) });
  });

  /* ── The market ────────────────────────────────────────────────────────── */

  r.get('/market', (ctx) => {
    const q = ctx.query;
    ok(ctx.res, {
      board: db.market.board({
        slot: q.get('slot') || null,
        rarity: q.get('rarity') || null,
        q: q.get('q') || '',
        sort: q.get('sort') || 'price',
        limit: Number(q.get('limit')) || 120,
      }),
      fee: COS.MARKET_FEE,
    });
  });

  /** Every standing listing for one item, plus what it has actually sold for. */
  r.get('/market/item', (ctx) => {
    const id = ctx.query.get('id') ?? '';
    if (!COS.getItem(id)) throw new ApiError(404, 'no_such_item', 'unknown item');
    ok(ctx.res, { itemId: id, listings: db.market.forItem(id), history: db.market.history(id) });
  });

  r.get('/market/mine', (ctx) => {
    const user = requireAuth(ctx);
    ok(ctx.res, { listings: db.market.mine(user.id) });
  });

  r.post('/market/list', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'market', 60);
    const { unitId, price } = await readJson(ctx.req);
    const res = db.market.list(user.id, String(unitId ?? ''), price);
    event('market.list', {
      userId: user.id, name: user.username, value: res.price, detail: { item: res.itemId },
    });
    ok(ctx.res, { ...res, wardrobe: wardrobeOf(db.users.byId(user.id)) });
  }));

  r.post('/market/cancel', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'market', 60);
    const { listingId } = await readJson(ctx.req);
    const res = db.market.cancel(user.id, String(listingId ?? ''));
    ok(ctx.res, { ...res, wardrobe: wardrobeOf(db.users.byId(user.id)) });
  }));

  r.post('/market/buy', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'market', 60);
    const { listingId } = await readJson(ctx.req);
    const res = db.market.buy(user.id, String(listingId ?? ''));
    const fresh = db.users.byId(user.id);
    event('market.buy', {
      userId: user.id, name: user.username, value: res.price,
      detail: { item: res.itemId, seller: res.sellerId, net: res.net },
    });
    ok(ctx.res, { ...res, gr: fresh.gr, wardrobe: wardrobeOf(fresh) });
  }));

  /* ── Trades ────────────────────────────────────────────────────────────── */

  /**
   * A trade is between friends only.
   *
   * Not a limitation — a defence. Every scam an item economy has ever had
   * starts with an offer from a stranger, and the friend list is a barrier the
   * player already controls and already understands. Anybody who wants to deal
   * with a stranger has the market, where nobody can be talked into anything.
   */
  r.get('/trades', (ctx) => {
    const user = requireAuth(ctx);
    const decorate = (t) => ({
      ...t,
      from: db.users.byId(t.fromId)?.username ?? null,
      to: db.users.byId(t.toId)?.username ?? null,
      incoming: t.toId === user.id,
    });
    ok(ctx.res, {
      open: db.trades.openFor(user.id).map(decorate),
      history: db.trades.historyFor(user.id).map(decorate),
    });
  });

  r.post('/trades', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'trade', 30);
    const body = await readJson(ctx.req);
    const target = db.users.byId(String(body.to ?? '')) ?? db.users.byName(String(body.to ?? ''));
    if (!target) throw new ApiError(404, 'no_such_user', 'no account by that name');
    if (!db.friends.are(user.id, target.id)) {
      throw new ApiError(403, 'not_friends', 'you can only trade with friends — use the market otherwise');
    }
    const t = db.trades.create(user.id, target.id, {
      fromUnits: Array.isArray(body.give) ? body.give.map(String).slice(0, COS.TRADE_MAX_ITEMS) : [],
      toUnits: Array.isArray(body.want) ? body.want.map(String).slice(0, COS.TRADE_MAX_ITEMS) : [],
      fromGr: body.giveGr, toGr: body.wantGr, note: body.note,
    });
    event('trade.offer', {
      userId: user.id, name: user.username,
      detail: { to: target.username, items: t.fromItems.length + t.toItems.length },
    });
    ok(ctx.res, { trade: t });
  }));

  r.post('/trades/accept', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'trade', 30);
    const { id } = await readJson(ctx.req);
    const t = db.trades.accept(String(id ?? ''), user.id);
    event('trade.accept', {
      userId: user.id, name: user.username,
      detail: { trade: t.id, items: t.fromItems.length + t.toItems.length },
    });
    ok(ctx.res, { trade: t, wardrobe: wardrobeOf(db.users.byId(user.id)) });
  }));

  r.post('/trades/close', economic(async (ctx) => {
    const user = requireAuth(ctx);
    limit(ctx, 'trade', 30);
    const { id } = await readJson(ctx.req);
    const t = db.trades.get(String(id ?? ''));
    if (!t) throw new ApiError(404, 'no_such_trade', 'no such offer');
    // The sender withdraws, the recipient declines. Same door, different word,
    // and the history says which happened.
    if (t.fromId !== user.id && t.toId !== user.id) {
      throw new ApiError(403, 'not_yours', 'that offer is not yours');
    }
    const closed = db.trades.close(t.id, t.fromId === user.id ? 'cancelled' : 'declined');
    ok(ctx.res, { trade: closed, wardrobe: wardrobeOf(db.users.byId(user.id)) });
  }));

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
