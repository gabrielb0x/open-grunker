/**
 * Friends: the list, the two request queues, and the presence that is the whole
 * reason anybody opens the panel.
 *
 * Driven over HTTP against a real server, because every rule that matters here
 * is one a route enforces rather than a function computes: a friendship that
 * cannot exist in only one direction, a request that cannot be filed twice, an
 * accept that clears both sides' queues, and the fact that two people who
 * happen to ask each other at the same moment end up friends instead of each
 * waiting on the other.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as K from '../shared/constants.js';
import { suite, check, info, sleep } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const freePort = () => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function startServer({ port, dbPath, dir }) {
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', join(ROOT, 'server/index.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        DB_PATH: dbPath,
        AVATAR_DIR: join(dir, 'avatars'),
        CLAN_AVATAR_DIR: join(dir, 'clans'),
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        LOG_LEVEL: 'warn',
        SERVE_STATIC: 'false',
        ADMIN_ENABLED: 'false',
        BOTS_ENABLED: 'false',
        PRACTICE_BOTS: '0',
        ROOMS: 'burgtown:ffa',
        RATE_MAX_REQUESTS: '5000',
        RATE_MAX_AUTH: '500',
        SCRYPT_COST: '1024',
        TURNSTILE_ENABLED: 'false',
        EMAIL_VERIFICATION: 'false',
        VPN_BLOCK: 'false',
        SINGLE_SESSION: 'false',
        // The gap between two requests is a real rule; a test that had to sleep
        // through it five times would be five seconds of nothing.
        FRIEND_REQUEST_COOLDOWN_SEC: '0',
      },
    });

  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { child, base, log: () => out };
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error(`server did not start:\n${out}`);
}

/** Returns `{ status, body }` rather than throwing on a 4xx. */
async function call(base, method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export default async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'og-friends-'));
  const dbPath = join(dir, 'friends.db');
  const port = await freePort();
  let server;
  try {
    server = await startServer({ port, dbPath, dir });
  } catch (err) {
    suite('Friends — end to end');
    check('the server boots', false, err.message);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const { base } = server;

  /** Levels are earned by playing, so the test grants them directly. */
  const grant = (name, level) => {
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE users SET level = ?, xp = ? WHERE username_lower = ?')
      .run(level, K.xpForLevel(level), name.toLowerCase());
    db.close();
  };
  const register = async (username) => {
    const r = await call(base, 'POST', '/api/v1/auth/register',
      { body: { username, password: 'a-good-password' } });
    grant(username, K.FRIEND_MIN_LEVEL);
    return r.body.token;
  };
  const list = (token) => call(base, 'GET', '/api/v1/friends', { token });
  const ask = (token, username) =>
    call(base, 'POST', '/api/v1/friends/requests', { token, body: { username } });

  try {
    suite('Friends — asking');

    const ana = await register('Ana');
    const bo = await register('Bex');
    const cy = await register('Cyd');

    const empty = await list(ana);
    check('a new account has an empty list and two empty queues',
      empty.status === 200 && !empty.body.friends.length
      && !empty.body.incoming.length && !empty.body.outgoing.length);
    check('and is told what the ceilings are',
      empty.body.limits.max === K.FRIENDS_MAX
      && empty.body.limits.minLevel === K.FRIEND_MIN_LEVEL);

    const sent = await ask(ana, 'Bex');
    check('a request is filed', sent.status === 200 && sent.body.outcome === 'sent',
      sent.body.message ?? sent.body.outcome);
    check('and shows in the asker’s outbox, not their list',
      sent.body.outgoing.length === 1 && !sent.body.friends.length,
      sent.body.outgoing[0]?.username);

    const boSees = await list(bo);
    check('the other side sees it waiting for them',
      boSees.body.incoming.length === 1 && boSees.body.incoming[0].username === 'Ana');
    check('and it is not a friendship yet', !boSees.body.friends.length);

    const again = await ask(ana, 'Bex');
    check('the same name cannot be asked twice',
      again.status === 409 && again.body.error === 'already_asked', again.body.message);
    const self = await ask(ana, 'Ana');
    check('and nobody can add themselves', self.status === 400, self.body.message);
    const ghost = await ask(ana, 'Nobody');
    check('a name nobody plays under is a 404', ghost.status === 404, ghost.body.message);

    suite('Friends — accepting');

    const accepted = await call(base, 'POST',
      `/api/v1/friends/requests/${sent.body.outgoing[0].id}/accept`, { token: bo });
    check('accepting is refused from the wrong end',
      accepted.status === 404, accepted.body.message ?? String(accepted.status));

    const anaId = (await call(base, 'GET', '/api/v1/auth/me', { token: ana })).body.user.id;
    const took = await call(base, 'POST', `/api/v1/friends/requests/${anaId}/accept`, { token: bo });
    check('accepting the standing request makes the friendship',
      took.status === 200 && took.body.friends.length === 1
      && took.body.friends[0].username === 'Ana');
    check('and clears it out of the inbox', !took.body.incoming.length);

    const anaAfter = await list(ana);
    check('a friendship exists in both directions at once',
      anaAfter.body.friends.length === 1 && anaAfter.body.friends[0].username === 'Bex');
    check('and leaves nothing behind in the outbox', !anaAfter.body.outgoing.length);

    const dup = await ask(ana, 'Bex');
    check('an existing friend cannot be asked again',
      dup.status === 409 && dup.body.error === 'already_friends', dup.body.message);

    suite('Friends — both sides asking at once');

    await ask(cy, 'Ana');
    const crossed = await ask(ana, 'Cyd');
    check('the second request is taken as an answer to the first',
      crossed.body.outcome === 'accepted', crossed.body.outcome);
    check('so both end up on each other’s list rather than in each other’s inbox',
      crossed.body.friends.some((f) => f.username === 'Cyd')
      && !crossed.body.incoming.length && !crossed.body.outgoing.length);
    const cySees = await list(cy);
    check('and the other side agrees', cySees.body.friends.some((f) => f.username === 'Ana'));

    suite('Friends — declining, cancelling and leaving');

    const dee = await register('Dee');
    const deeId = (await call(base, 'GET', '/api/v1/auth/me', { token: dee })).body.user.id;
    await ask(dee, 'Ana');
    const declined = await call(base, 'DELETE', `/api/v1/friends/requests/${deeId}`, { token: ana });
    check('a request can be declined', declined.status === 200 && !declined.body.incoming.length);
    const deeAfter = await list(dee);
    check('and it leaves the asker’s outbox too', !deeAfter.body.outgoing.length);
    check('with nothing said to them about it', !deeAfter.body.friends.length);

    await ask(dee, 'Ana');
    const cancelled = await call(base, 'DELETE', `/api/v1/friends/requests/${anaId}`, { token: dee });
    check('the asker can cancel their own', cancelled.status === 200 && !cancelled.body.outgoing.length);

    const boId = (await call(base, 'GET', '/api/v1/auth/me', { token: bo })).body.user.id;
    const gone = await call(base, 'DELETE', `/api/v1/friends/${boId}`, { token: ana });
    check('a friendship can be ended', gone.status === 200 && gone.body.removed === 'Bex');
    const boNow = await list(bo);
    check('and it ends for both, because there was only ever one row',
      !boNow.body.friends.length);
    const twice = await call(base, 'DELETE', `/api/v1/friends/${boId}`, { token: ana });
    check('ending it again is a 404 rather than a silent success', twice.status === 404);

    suite('Friends — the ceilings');

    const rookie = await register('Rookie');
    grant('Rookie', 1);
    const tooNew = await ask(rookie, 'Ana');
    check('a fresh throwaway account cannot send invitations',
      tooNew.status === 403 && tooNew.body.error === 'level_too_low', tooNew.body.message);

    const anon = await call(base, 'GET', '/api/v1/friends');
    check('and none of this is reachable signed out', anon.status === 401);

    suite('Friends — presence');

    const seen = await list(ana);
    const cyRow = seen.body.friends.find((f) => f.username === 'Cyd');
    check('a friend who is not connected reads as offline and unjoinable',
      cyRow && cyRow.online === false && cyRow.room === null);
    info(`${seen.body.online} of ${seen.body.friends.length} online`);
    check('and the panel is told how many of them are on',
      typeof seen.body.online === 'number');

    /* ── The card, and who it is for ───────────────────────────────────────
     *
     * Every check here is about a *refusal*: what a viewer is not shown, and
     * what a route will not do. A privacy switch the client honours and the
     * server does not is decoration, so all of it runs over HTTP and none of
     * it trusts a flag in the payload.
     *
     * The cast is the one the suites above left behind: Ana and Cyd are
     * friends, Ana and Bex are not (they were, and it was ended), and nobody
     * has anybody else in common.
     * ────────────────────────────────────────────────────────────────────── */

    suite('Profiles — the card');

    const social = (token) => call(base, 'GET', '/api/v1/profile/social', { token });
    const saveCard = (token, card) =>
      call(base, 'PUT', '/api/v1/profile/card', { token, body: { card } });
    const savePrivacy = (token, privacy) =>
      call(base, 'PUT', '/api/v1/profile/privacy', { token, body: { privacy } });
    const profileOf = (name, token) =>
      call(base, 'GET', `/api/v1/players/${name}`, { token });
    const idOf = async (token) =>
      (await call(base, 'GET', '/api/v1/auth/me', { token })).body.user.id;
    const accept = async (token, otherToken) =>
      call(base, 'POST', `/api/v1/friends/requests/${await idOf(otherToken)}/accept`, { token });

    const mine = await social(ana);
    check('an account that has never styled its card still has a whole one',
      mine.status === 200
      && mine.body.card.pattern === K.CARD_DEFAULTS.pattern
      && mine.body.card.featured.length === K.CARD_DEFAULTS.featured.length
      && mine.body.privacy.whoCanAdd === K.PRIVACY_DEFAULTS.whoCanAdd,
      `${mine.body.card?.pattern} · ${mine.body.privacy?.whoCanAdd}`);
    check('and is told everything it may pick from',
      mine.body.catalogue.patterns.length === K.CARD_PATTERNS.length
      && mine.body.catalogue.stats.length === K.CARD_STATS.length
      && mine.body.catalogue.privacy.fields.length === K.PRIVACY_FIELDS.length);

    const saved = await saveCard(ana, {
      accentMode: 'custom', accent: '#4D9BFF', pattern: 'hex', layout: 'showcase',
      frame: 'glow', intensity: 'loud', glow: false,
      title: 'Quickscoper', bio: 'Season one.', featured: ['headshots', 'accuracy'],
    });
    check('a card is stored as it was sent, once it has been checked',
      saved.status === 200 && saved.body.card.accent === '#4d9bff'
      && saved.body.card.pattern === 'hex' && saved.body.card.layout === 'showcase'
      && saved.body.card.glow === false && saved.body.card.featured.length === 2,
      JSON.stringify(saved.body.card?.featured));

    const junk = await saveCard(ana, {
      pattern: 'DROP TABLE', layout: 42, frame: null, accent: 'red',
      intensity: 'deafening', featured: ['kills', 'nope', 'wins', 'score', 'kd'],
      title: `  ${'z'.repeat(500)}`,
    });
    check('a card the server does not recognise is corrected, never stored',
      junk.status === 200 && junk.body.card.pattern === K.CARD_DEFAULTS.pattern
      && junk.body.card.layout === K.CARD_DEFAULTS.layout
      && junk.body.card.accent === K.CARD_DEFAULTS.accent
      && junk.body.card.featured.length === K.CARD_FEATURED_MAX
      && !junk.body.card.featured.includes('nope')
      && junk.body.card.title.length === K.CARD_TITLE_MAX,
      `${junk.body.card?.pattern} · ${junk.body.card?.accent}`);

    await saveCard(ana, { accentMode: 'custom', accent: '#4d9bff', pattern: 'hex' });
    const asStranger = await profileOf('Ana', bo);
    check('the card travels with the profile, so a stranger sees it too',
      asStranger.body.user.card.accent === '#4d9bff'
      && asStranger.body.user.card.pattern === 'hex');

    check('and none of these routes are reachable signed out',
      (await call(base, 'GET', '/api/v1/profile/social')).status === 401
      && (await call(base, 'PUT', '/api/v1/profile/card', { body: { card: {} } })).status === 401);

    suite('Profiles — who may see what');

    check('a stranger is told what they are to this account',
      asStranger.body.relation === 'none' && asStranger.body.user.stats !== null);
    check('your own card shows you everything on it',
      (await profileOf('Ana', ana)).body.relation === 'self');
    check('a friend is named as one',
      (await profileOf('Ana', cy)).body.relation === 'friend');
    check('and a guest reading it is nobody in particular',
      (await profileOf('Ana', null)).body.relation === 'none');

    await savePrivacy(ana, { showStats: 'friends', showMatches: 'nobody', showJoined: 'nobody' });

    const hiddenFromBex = await profileOf('Ana', bo);
    check('a section closed to strangers does not reach one',
      hiddenFromBex.body.user.stats === null
      && hiddenFromBex.body.recent.length === 0
      && hiddenFromBex.body.user.createdAt === null,
      `hidden: ${hiddenFromBex.body.hidden.join(', ')}`);
    check('and the card is told which sections those were, so it can say so',
      hiddenFromBex.body.hidden.includes('showStats')
      && hiddenFromBex.body.hidden.includes('showMatches'));

    const shownToCyd = await profileOf('Ana', cy);
    check('"friends only" really does mean friends see it',
      shownToCyd.body.user.stats !== null,
      `hidden from a friend: ${shownToCyd.body.hidden.join(', ')}`);
    check('"no one" means no one — a friend included',
      shownToCyd.body.recent.length === 0 && shownToCyd.body.hidden.includes('showMatches'));

    const own = await profileOf('Ana', ana);
    check('your own card is never hidden from you',
      own.body.user.stats !== null && own.body.hidden.length === 0);

    // Put it back, so the rest of the suite reads an ordinary account.
    await savePrivacy(ana, K.PRIVACY_DEFAULTS);

    suite('Profiles — who may ask');

    const fay = await register('Fay');
    const gus = await register('Gus');

    check('by default anybody may ask',
      (await profileOf('Fay', gus)).body.can.add === true);

    await savePrivacy(fay, { whoCanAdd: 'nobody' });
    const shut = await ask(gus, 'Fay');
    check('an account that has closed itself is not askable',
      shut.status === 403 && shut.body.error === 'not_accepting', shut.body.message);
    check('and the card does not offer a button the route would refuse',
      (await profileOf('Fay', gus)).body.can.add === false);
    check('the refusal does not give away which setting it was',
      !/nobody|mutual|friends of friends/i.test(shut.body.message ?? ''), shut.body.message);

    await savePrivacy(fay, { whoCanAdd: 'mutuals' });
    const noMutual = await ask(gus, 'Fay');
    check('"friends of friends" refuses somebody with nobody in common',
      noMutual.status === 403 && noMutual.body.error === 'not_accepting');
    check('and the card agrees with the route',
      (await profileOf('Fay', gus)).body.can.add === false);

    // Ana takes both of them, which makes Gus a friend of a friend of Fay.
    await ask(fay, 'Ana');
    await accept(ana, fay);
    await ask(gus, 'Ana');
    await accept(ana, gus);

    check('…and allows one who now has somebody in common',
      (await profileOf('Fay', gus)).body.can.add === true);
    const viaMutual = await ask(gus, 'Fay');
    check('so the request goes through', viaMutual.status === 200, viaMutual.body.message);
    check('an ask already in flight is reported rather than offered again',
      (await profileOf('Fay', gus)).body.pending.outgoing === true
      && (await profileOf('Gus', fay)).body.pending.incoming === true
      && (await profileOf('Fay', gus)).body.can.add === false);

    // A closed account can still answer somebody who asked it first.
    await savePrivacy(fay, { whoCanAdd: 'nobody' });
    const stillAnswerable = await accept(fay, gus);
    check('closing the door does not trap a request already inside it',
      stillAnswerable.status === 200, stillAnswerable.body.message);

    suite('Profiles — presence and the leaderboard');

    const offToStrangers = await profileOf('Ana', bo);
    check('presence is closed to strangers by default',
      offToStrangers.body.presence === null && offToStrangers.body.can.seePresence === false);
    check('and open to friends',
      (await profileOf('Ana', cy)).body.presence !== null);

    await savePrivacy(ana, { showPresence: 'nobody' });
    check('an account that hides entirely hides from its friends too',
      (await profileOf('Ana', cy)).body.presence === null);

    const before = await call(base, 'GET', '/api/v1/leaderboard?limit=100');
    const listedBefore = before.body.entries.some((e) => e.username === 'Ana');
    await savePrivacy(ana, { showPresence: 'nobody', listed: false });
    const after = await call(base, 'GET', '/api/v1/leaderboard?limit=100');
    check('taking yourself off the board actually takes you off it',
      listedBefore && !after.body.entries.some((e) => e.username === 'Ana'),
      `${before.body.entries.length} → ${after.body.entries.length} entries`);

    await savePrivacy(ana, K.PRIVACY_DEFAULTS);
    check('and putting yourself back puts you back',
      (await call(base, 'GET', '/api/v1/leaderboard?limit=100'))
        .body.entries.some((e) => e.username === 'Ana'));

  } finally {
    server.child.kill('SIGTERM');
    await sleep(120);
    rmSync(dir, { recursive: true, force: true });
  }
}
