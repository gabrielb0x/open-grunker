/**
 * Open Grunker — clans.
 *
 * A clan is a tag, an owner and a member list. The tag is the whole visible
 * product: four characters drawn in front of a nickname everywhere a nickname
 * appears, grey normally and gold once the developers have verified the clan.
 *
 * Three rules shape everything here:
 *
 *   • **One player, one clan.** Enforced by a unique index on `clan_members`,
 *     not by a check — two invites accepted in the same second cannot both win.
 *   • **Invite only.** There is no "request to join", so a clan is never
 *     something that happens to you, and the owner is the only door.
 *   • **The tag is a cache.** `users.clan` / `users.clan_verified` are written
 *     by `db.clans.syncMembers()` alone, so the leaderboard, the join handshake
 *     and every nametag read a column instead of running a join.
 *
 * Founding costs level and GR, joining costs level. Both are checked here and
 * only here — the browser hides a button it knows would be refused, which is a
 * courtesy and never a permission.
 */
import * as K from '../../shared/constants.js';
import { ApiError } from './router.js';
import { ok, json, readJson, readBody } from '../util/http.js';
import { validateAvatar } from '../util/image.js';
import { clanAvatars } from '../util/avatar.js';
import config from '../config.js';
import log from '../util/log.js';

const logger = log.child('clans');

/**
 * One clan, as JSON.
 *
 * `members` is a count here and a list only where a caller asked for the
 * roster, so the browse list stays one query per page rather than one per row.
 */
export const clanPayload = (c, extra = {}) => (c ? {
  id: c.id,
  tag: c.tag,
  verified: !!c.verified,
  avatar: clanAvatars.urlFor(c.avatar),
  ownerId: c.ownerId ?? null,
  ownerName: c.ownerName ?? c.createdBy ?? null,
  members: c.members ?? 0,
  maxMembers: config.clans.maxMembers,
  createdAt: c.createdAt,
  ...extra,
} : null);

/** One member of a roster, as the clan page draws them. */
const memberPayload = (m, avatarUrl) => ({
  id: m.id,
  username: m.username,
  level: m.level,
  verified: !!m.verified,
  avatar: avatarUrl(m.avatar),
  role: m.role,
  joinedAt: m.joinedAt,
  lastLogin: m.lastLogin,
  kills: m.kills,
  deaths: m.deaths,
  score: m.score,
});

/**
 * Registers every /clans route on an existing router.
 *
 * @param {object} deps { r, db, hub, requireAuth, limit, avatarUrl }
 *   `requireAuth` and `limit` are the helpers createApi already closes over, so
 *   a clan route is rate-limited and authenticated exactly like the rest.
 */
export function registerClanRoutes({ r, db, hub, requireAuth, limit, avatarUrl }) {
  const cfg = () => config.clans;

  const requireClans = () => {
    if (!cfg().enabled) {
      throw new ApiError(403, 'clans_disabled', 'clans are switched off on this server');
    }
  };

  /** The clan named in the path, or a 404. */
  const findClan = (ctx) => {
    const clan = db.clans.byTag(K.normaliseClanTag(ctx.params.tag));
    if (!clan) throw new ApiError(404, 'not_found', 'no such clan');
    return clan;
  };

  /** The clan named in the path, refusing anyone who is not its owner. */
  const requireOwner = (ctx, user) => {
    const clan = findClan(ctx);
    if (!db.clans.isOwner(clan.id, user.id)) {
      throw new ApiError(403, 'not_owner', `only the owner of [${clan.tag}] can do that`);
    }
    return clan;
  };

  /** The account named in a body/path field, or a 404. */
  const findMemberAccount = (name) => {
    const target = db.users.byName(String(name ?? '').trim());
    if (!target) throw new ApiError(404, 'no_such_player', 'no account by that name');
    return target;
  };

  /**
   * Pushes a membership change out to whatever that account is doing right now.
   *
   * Somebody sitting in a match when they are invited in, removed, or the clan
   * is verified would otherwise keep wearing the old tag until they reconnect,
   * which reads as the feature not having worked.
   */
  const rebadge = (userId) => {
    const fresh = db.users.byId(userId);
    if (!fresh) return;
    hub.rebadge?.(userId, { clan: fresh.clan ?? null, clanVerified: !!fresh.clan_verified });
  };

  const rebadgeAll = (clanId) => {
    for (const m of db.clans.members(clanId)) rebadge(m.id);
  };

  /** The clan plus its roster and (for a member) its outstanding invitations. */
  const fullClan = (clan, viewer = null) => {
    const members = db.clans.members(clan.id);
    const mine = viewer ? members.find((m) => m.id === viewer.id) ?? null : null;
    return clanPayload(clan, {
      members: members.length,
      ownerName: members.find((m) => m.role === 'owner')?.username ?? clan.createdBy ?? null,
      roster: members.map((m) => memberPayload(m, avatarUrl)),
      // Who a clan is waiting on is its own business: only its members see it.
      invites: mine ? db.clans.invitesForClan(clan.id) : null,
      you: mine ? { role: mine.role, joinedAt: mine.joinedAt } : null,
    });
  };

  /* ── Browse ────────────────────────────────────────────────────────────── */

  r.get('/clans', (ctx) => {
    const { rows, total } = db.clans.list({
      q: (ctx.query.get('q') ?? '').slice(0, 16),
      limit: Math.min(100, Number(ctx.query.get('limit')) || 40),
      offset: Math.max(0, Number(ctx.query.get('offset')) || 0),
    });
    ok(ctx.res, {
      total,
      clans: rows.map((c) => clanPayload(c, { rank: c.rank, score: c.score, kills: c.kills })),
      rules: clanRules(),
    });
  });

  /**
   * This account's own clan, its invitations, and whether it may found one.
   *
   * Deliberately one request: the clan panel needs all three to draw anything
   * at all, and an account with no clan still has to be told what it would cost
   * to make one.
   */
  r.get('/clans/mine', (ctx) => {
    const user = requireAuth(ctx);
    const clan = db.clans.forUser(user.id);
    ok(ctx.res, {
      clan: clan ? fullClan(clan, user) : null,
      invites: clan ? [] : db.clans.invitesForUser(user.id).map((i) => ({
        ...i, avatar: clanAvatars.urlFor(i.avatar),
      })),
      rules: clanRules(),
      // What this particular account can do right now, so the panel does not
      // have to re-derive the rules it was just handed.
      can: {
        create: !clan && user.level >= cfg().createLevel && user.gr >= cfg().createCost,
        join: user.level >= cfg().joinLevel,
      },
      level: user.level,
      gr: user.gr,
    });
  });

  r.get('/clans/:tag', (ctx) => {
    const clan = findClan(ctx);
    ok(ctx.res, { clan: fullClan(clan, ctx.auth?.user ?? null) });
  });

  /* ── Founding ──────────────────────────────────────────────────────────── */

  /**
   * Founds a clan. Costs level and GR, both checked here.
   *
   * The GR is taken first and refunded if the tag turns out to be gone: the
   * unique index on `tag_lower`, not the SELECT above it, is what settles a race
   * between two people founding the same tag in the same second.
   */
  r.post('/clans', async (ctx) => {
    const user = requireAuth(ctx);
    requireClans();
    limit(ctx, 'clan', 20);
    const { tag } = await readJson(ctx.req);

    if (db.clans.forUser(user.id)) {
      throw new ApiError(409, 'already_in_clan', 'leave your clan before founding another');
    }
    if (user.level < cfg().createLevel) {
      throw new ApiError(403, 'level_too_low',
        `founding a clan needs level ${cfg().createLevel} — you are level ${user.level}`);
    }
    const wanted = K.normaliseClanTag(tag);
    const bad = K.clanTagError(wanted);
    if (bad) throw new ApiError(400, 'invalid_tag', bad);
    if (db.clans.byTag(wanted)) throw new ApiError(409, 'tag_taken', `[${wanted}] is already taken`);

    const cost = cfg().createCost;
    if (user.gr < cost) {
      throw new ApiError(402, 'insufficient_gr', `founding a clan costs ${cost} GR, you have ${user.gr}`);
    }
    db.users.addProgress(user.id, 0, -cost);

    let clan;
    try {
      clan = db.clans.create({ tag: wanted, ownerId: user.id, ownerName: user.username });
    } catch (err) {
      db.users.addProgress(user.id, 0, cost);            // lost the race, keep the GR
      if (String(err.message).includes('UNIQUE')) {
        throw new ApiError(409, 'tag_taken', `[${wanted}] was taken a moment ago`);
      }
      throw err;
    }

    rebadge(user.id);
    logger.info(`${user.username} founded [${clan.tag}] for ${cost} GR`);
    json(ctx.res, 201, {
      ok: true,
      clan: fullClan(clan, user),
      spent: cost,
      gr: db.users.byId(user.id).gr,
    });
  });

  /* ── Invitations ───────────────────────────────────────────────────────── */

  r.post('/clans/:tag/invites', async (ctx) => {
    const user = requireAuth(ctx);
    requireClans();
    limit(ctx, 'clan', 60);
    const clan = requireOwner(ctx, user);
    const { username } = await readJson(ctx.req);
    const target = findMemberAccount(username);

    if (target.id === user.id) throw new ApiError(400, 'thats_you', 'you are already in it');
    if (db.clans.membership(target.id)) {
      throw new ApiError(409, 'already_in_clan', `${target.username} is already in a clan`);
    }
    // The level gate is checked at the invite as well as at the join: an owner
    // who cannot be told why an invite went nowhere sends it again tomorrow.
    if (target.level < cfg().joinLevel) {
      throw new ApiError(403, 'level_too_low',
        `${target.username} is level ${target.level} — joining a clan needs level ${cfg().joinLevel}`);
    }
    if (db.clans.memberCount(clan.id) >= cfg().maxMembers) {
      throw new ApiError(409, 'clan_full', `[${clan.tag}] is full (${cfg().maxMembers} members)`);
    }
    if (db.clans.countInvites(clan.id) >= cfg().maxInvites && !db.clans.inviteFor(clan.id, target.id)) {
      throw new ApiError(429, 'too_many_invites',
        `[${clan.tag}] already has ${cfg().maxInvites} invitations out — cancel one first`);
    }

    db.clans.invite({
      clanId: clan.id, userId: target.id, by: user.username, ttlHours: cfg().inviteTtlHours,
    });
    logger.info(`[${clan.tag}] invited ${target.username}`);
    ok(ctx.res, { clan: fullClan(db.clans.byId(clan.id), user), invited: target.username });
  });

  r.delete('/clans/:tag/invites/:name', (ctx) => {
    limit(ctx, 'clan', 60);
    const user = requireAuth(ctx);
    const clan = requireOwner(ctx, user);
    const target = findMemberAccount(ctx.params.name);
    const cancelled = db.clans.cancelInvite(clan.id, target.id);
    ok(ctx.res, { cancelled, clan: fullClan(db.clans.byId(clan.id), user) });
  });

  /** Turning an invitation down. Nobody is told; it simply stops existing. */
  r.post('/clans/:tag/decline', (ctx) => {
    limit(ctx, 'clan', 60);
    const user = requireAuth(ctx);
    const clan = findClan(ctx);
    ok(ctx.res, { declined: db.clans.cancelInvite(clan.id, user.id) });
  });

  /* ── Joining and leaving ───────────────────────────────────────────────── */

  r.post('/clans/:tag/join', (ctx) => {
    limit(ctx, 'clan', 60);
    const user = requireAuth(ctx);
    requireClans();
    limit(ctx, 'clan', 30);
    const clan = findClan(ctx);

    if (db.clans.membership(user.id)) {
      throw new ApiError(409, 'already_in_clan', 'leave your clan before joining another');
    }
    if (!db.clans.inviteFor(clan.id, user.id)) {
      throw new ApiError(403, 'not_invited', `[${clan.tag}] has not invited you`);
    }
    if (user.level < cfg().joinLevel) {
      throw new ApiError(403, 'level_too_low',
        `joining a clan needs level ${cfg().joinLevel} — you are level ${user.level}`);
    }
    if (db.clans.memberCount(clan.id) >= cfg().maxMembers) {
      throw new ApiError(409, 'clan_full', `[${clan.tag}] is full (${cfg().maxMembers} members)`);
    }

    try {
      db.clans.addMember(clan.id, user.id, 'member');
    } catch (err) {
      // The unique index is the real arbiter of "one player, one clan".
      if (String(err.message).includes('UNIQUE')) {
        throw new ApiError(409, 'already_in_clan', 'you joined a clan a moment ago');
      }
      throw err;
    }
    rebadge(user.id);
    logger.info(`${user.username} joined [${clan.tag}]`);
    ok(ctx.res, { clan: fullClan(db.clans.byId(clan.id), user) });
  });

  /**
   * Leaving. An owner cannot: the clan would be left with nobody who can invite,
   * remove or disband it, so they hand it over or disband it on purpose.
   */
  r.post('/clans/:tag/leave', (ctx) => {
    limit(ctx, 'clan', 30);
    const user = requireAuth(ctx);
    const clan = findClan(ctx);
    const seat = db.clans.membership(user.id);
    if (!seat || seat.clan_id !== clan.id) {
      throw new ApiError(409, 'not_a_member', `you are not in [${clan.tag}]`);
    }
    if (seat.role === 'owner') {
      throw new ApiError(409, 'owner_cannot_leave',
        'hand the clan to someone else first, or disband it');
    }
    db.clans.removeMember(clan.id, user.id);
    rebadge(user.id);
    logger.info(`${user.username} left [${clan.tag}]`);
    ok(ctx.res, { left: true });
  });

  /** Removing somebody. The owner's own seat is not removable this way. */
  r.delete('/clans/:tag/members/:name', (ctx) => {
    limit(ctx, 'clan', 60);
    const user = requireAuth(ctx);
    const clan = requireOwner(ctx, user);
    const target = findMemberAccount(ctx.params.name);
    if (target.id === user.id) {
      throw new ApiError(409, 'owner_cannot_leave', 'hand the clan over or disband it');
    }
    const seat = db.clans.membership(target.id);
    if (!seat || seat.clan_id !== clan.id) {
      throw new ApiError(404, 'not_a_member', `${target.username} is not in [${clan.tag}]`);
    }
    db.clans.removeMember(clan.id, target.id);
    rebadge(target.id);
    logger.info(`[${clan.tag}] removed ${target.username}`);
    ok(ctx.res, { removed: target.username, clan: fullClan(db.clans.byId(clan.id), user) });
  });

  /** Handing the clan over. The old owner stays on as a plain member. */
  r.post('/clans/:tag/transfer', async (ctx) => {
    limit(ctx, 'clan', 20);
    const user = requireAuth(ctx);
    const clan = requireOwner(ctx, user);
    const { username } = await readJson(ctx.req);
    const target = findMemberAccount(username);
    if (target.id === user.id) throw new ApiError(400, 'thats_you', 'you already own it');
    const seat = db.clans.membership(target.id);
    if (!seat || seat.clan_id !== clan.id) {
      throw new ApiError(404, 'not_a_member', `${target.username} is not in [${clan.tag}]`);
    }

    db.clans.transfer(clan.id, user.id, target.id);
    logger.info(`[${clan.tag}] handed from ${user.username} to ${target.username}`);
    ok(ctx.res, { owner: target.username, clan: fullClan(db.clans.byId(clan.id), user) });
  });

  /** Disbanding. Every member loses the tag and the rows go with the clan. */
  r.delete('/clans/:tag', (ctx) => {
    limit(ctx, 'clan', 20);
    const user = requireAuth(ctx);
    const clan = requireOwner(ctx, user);
    const members = db.clans.members(clan.id).map((m) => m.id);
    db.clans.disband(clan.id);
    clanAvatars.remove(clan.id).catch(() => { /* the row is already gone */ });
    for (const id of members) rebadge(id);
    logger.info(`[${clan.tag}] was disbanded by ${user.username}`);
    ok(ctx.res, { disbanded: clan.tag });
  });

  /* ── Clan picture ──────────────────────────────────────────────────────── */

  /**
   * Replaces the clan's picture. Owner only.
   *
   * The body is the image itself, exactly as for an account avatar: the client
   * has already squared it, scaled it and re-encoded it, and the server sniffs,
   * measures and refuses the bytes on their own merits regardless.
   */
  r.post('/clans/:tag/avatar', async (ctx) => {
    const user = requireAuth(ctx);
    requireClans();
    const clan = requireOwner(ctx, user);
    if (!config.avatars.enabled) {
      throw new ApiError(403, 'avatars_disabled', 'pictures are switched off on this server');
    }
    limit(ctx, 'avatar', 12);

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

    const file = await clanAvatars.save(clan.id, buf, verdict.ext);
    db.clans.setAvatar(clan.id, file);
    logger.info(`[${clan.tag}] set a new picture (${verdict.width}×${verdict.height} ${verdict.ext})`);
    ok(ctx.res, { clan: fullClan(db.clans.byId(clan.id), user) });
  });

  r.delete('/clans/:tag/avatar', async (ctx) => {
    limit(ctx, 'avatar', 12);
    const user = requireAuth(ctx);
    const clan = requireOwner(ctx, user);
    const removed = await clanAvatars.remove(clan.id);
    db.clans.setAvatar(clan.id, null);
    ok(ctx.res, { removed, clan: fullClan(db.clans.byId(clan.id), user) });
  });

  return r;
}

/** What the client is told the rules are, so it never has to hard-code them. */
export function clanRules() {
  return {
    enabled: config.clans.enabled,
    joinLevel: config.clans.joinLevel,
    createLevel: config.clans.createLevel,
    createCost: config.clans.createCost,
    maxMembers: config.clans.maxMembers,
    maxInvites: config.clans.maxInvites,
    inviteTtlHours: config.clans.inviteTtlHours,
    tagMin: K.CLAN_TAG_MIN,
    tagMax: K.CLAN_TAG_MAX,
    reserved: K.CLAN_RESERVED_TAGS,
  };
}

export default registerClanRoutes;
