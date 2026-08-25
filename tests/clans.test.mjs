/**
 * Clans: the tag rules, the level and GR gates, invite-only joining, and the
 * denormalised tag that every scoreboard, killfeed and nametag reads.
 *
 * The tag validation is unit-level — it is shared code, and the browser greys
 * the button out with the same function the server refuses with. Everything
 * else boots the real server as a child process and drives it over HTTP,
 * because the rules that matter here are the ones a route actually enforces:
 * an owner who cannot walk out on their own clan, two people who cannot take
 * the same four characters, a tag that really does disappear off a member's
 * account the moment they are removed.
 */
import { createServer } from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as K from '../shared/constants.js';
import { suite, check, info, sleep } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** A real PNG, built byte by byte rather than checked in. */
function png(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                       // 8-bit, truecolour
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.alloc(1 + w * 3, 0));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
        SCRYPT_COST: '1024',                       // a test is not a threat model
        TURNSTILE_ENABLED: 'false',
        EMAIL_VERIFICATION: 'false',
        VPN_BLOCK: 'false',
        SINGLE_SESSION: 'false',
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

/** POST/GET returning `{ status, body }` rather than throwing on a 4xx. */
async function call(base, method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/* ── Unit: the tag rules ─────────────────────────────────────────────────── */

function unitChecks() {
  suite('Clans — what a tag may be');

  check('a plain tag is fine', K.clanTagError('NUKE') === null);
  check('it is stored uppercase', K.normaliseClanTag('  nuke ') === 'NUKE');
  check('two characters is the floor', K.clanTagError('OG7') === null && K.clanTagError('X') !== null);
  check('four is the ceiling', K.clanTagError('NUKES') !== null,
    K.clanTagError('NUKES') ?? '');
  check('digits are allowed', K.clanTagError('42') === null);

  // The point of the whole rule: a tag is drawn next to a nickname, so anything
  // that could paint over the name beside it or impersonate the server is out.
  const nasty = [
    ['a space', 'NU K'], ['a symbol', 'NU!K'], ['an accent', 'NUKÉ'],
    ['a zero-width joiner', 'NU‍K'], ['a right-to-left mark', 'NU‮K'],
    ['a combining accent', 'NÚK'], ['a bracket', '[OG]'], ['an emoji', 'N\u{1f600}'],
    ['a newline', 'NU\nK'], ['full-width letters', 'ＮＵＫＥ'],
  ];
  let refused = 0;
  for (const [why, tag] of nasty) {
    if (K.clanTagError(tag) !== null) { refused++; continue; }
    check(`a tag with ${why} is refused`, false, JSON.stringify(tag));
  }
  check('every kind of character that is not a letter or a digit is refused',
    refused === nasty.length, `${refused}/${nasty.length}`);

  check('a tag that would read as the server is reserved',
    K.clanTagError('MOD') !== null && K.clanTagError('DEV') !== null && K.clanTagError('ADMN') !== null);
  check('and so is the one word that is a route', K.clanTagError('MINE') !== null);
  check('an empty tag is refused', K.clanTagError('') !== null && K.clanTagError(null) !== null);
}

/* ── Migrating a database that predates clans ────────────────────────────── */

/**
 * Opening the database layer against an older file, in a child process.
 *
 * This is its own check because it is the one failure that takes the whole
 * server down at boot rather than breaking a feature: `schema.sql` runs before
 * `migrate()`, so anything in it that names a column a migration adds — an
 * index over `users.clan_id`, say — throws before a single route exists.
 */
async function migrationCheck() {
  suite('Clans — opening a database that predates them');

  const dir = mkdtempSync(join(tmpdir(), 'og-clanmig-'));
  const dbPath = join(dir, 'old.db');
  try {
    // A users table as it looked before clans, with a free-text tag on it —
    // the column existed as something an administrator typed in by hand.
    const seed = new DatabaseSync(dbPath);
    seed.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE,
      email TEXT, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_login INTEGER, last_ip TEXT, xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1, kr INTEGER NOT NULL DEFAULT 0,
      clan TEXT, role TEXT NOT NULL DEFAULT 'player',
      banned_until INTEGER NOT NULL DEFAULT 0, ban_reason TEXT)`);
    seed.exec("INSERT INTO users (username, username_lower, password_hash, created_at, clan) "
      + "VALUES ('Ancient', 'ancient', 'x', 1, 'FREE')");
    seed.close();

    const child = spawn(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--input-type=module',
      '-e', `import('${join(ROOT, 'server/db/index.js').replace(/\\/g, '/')}')`,
    ], { cwd: ROOT, env: { ...process.env, DB_PATH: dbPath, LOG_LEVEL: 'error' } });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    check('the layer opens rather than throwing at import', code === 0, err.split('\n')[0] ?? '');

    const after = new DatabaseSync(dbPath);
    const cols = new Set(after.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
    const tables = new Set(after.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((t) => t.name));
    const row = after.prepare('SELECT clan, clan_id, clan_verified FROM users').get();
    after.close();

    check('the clan columns and tables are there afterwards',
      cols.has('clan_id') && cols.has('clan_verified')
      && tables.has('clans') && tables.has('clan_members') && tables.has('clan_invites'));
    check('and a tag that belongs to no clan is cleared rather than left dangling',
      row.clan === null && row.clan_id === null && row.clan_verified === 0,
      JSON.stringify(row));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── End-to-end ──────────────────────────────────────────────────────────── */

async function integration() {
  const dir = mkdtempSync(join(tmpdir(), 'og-clans-'));
  const dbPath = join(dir, 'clans.db');
  const port = await freePort();
  let server;
  try {
    server = await startServer({ port, dbPath, dir });
  } catch (err) {
    suite('Clans — end to end');
    check('the server boots', false, err.message);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const { base } = server;

  /** Levels and GR are earned by playing, so the test grants them directly. */
  const grant = (name, level, gr) => {
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE users SET level = ?, xp = ?, gr = ? WHERE username_lower = ?')
      .run(level, K.xpForLevel(level), gr, name.toLowerCase());
    db.close();
  };
  const register = async (username) => {
    const r = await call(base, 'POST', '/api/v1/auth/register',
      { body: { username, password: 'a-good-password' } });
    return r.body.token;
  };

  try {
    suite('Clans — founding one');

    const owner = await register('Chief');
    const buddy = await register('Second');
    const rookie = await register('Rookie');
    grant('Chief', 20, 2500);
    grant('Second', 8, 50);
    grant('Rookie', 3, 5000);

    const rules = (await call(base, 'GET', '/api/v1/meta')).body.clans;
    check('the client is told the rules rather than guessing them',
      rules.createLevel === K.CLAN_CREATE_LEVEL && rules.joinLevel === K.CLAN_JOIN_LEVEL
      && rules.createCost === K.CLAN_CREATE_COST && rules.tagMax === K.CLAN_TAG_MAX);

    const bad = await call(base, 'POST', '/api/v1/clans', { token: owner, body: { tag: 'NU!K' } });
    check('the server refuses a tag the browser would have too',
      bad.status === 400 && bad.body.error === 'invalid_tag', bad.body.message ?? '');

    const rich = await call(base, 'POST', '/api/v1/clans', { token: rookie, body: { tag: 'CULT' } });
    check(`GR alone does not found a clan — level ${K.CLAN_CREATE_LEVEL} does`,
      rich.status === 403 && rich.body.error === 'level_too_low', rich.body.message ?? '');

    const poor = await call(base, 'POST', '/api/v1/clans', { token: buddy, body: { tag: 'CULT' } });
    check('nor does a level without the GR',
      poor.status === 403 || poor.body.error === 'insufficient_gr', poor.body.message ?? '');

    const made = await call(base, 'POST', '/api/v1/clans', { token: owner, body: { tag: 'nuke' } });
    check('a level-15 account with the GR founds one', made.status === 201, made.body.message ?? '');
    check('and the tag is stored uppercase', made.body.clan?.tag === 'NUKE');
    check(`founding it cost ${K.CLAN_CREATE_COST} GR`,
      made.body.spent === K.CLAN_CREATE_COST && made.body.gr === 2500 - K.CLAN_CREATE_COST,
      `${made.body.gr} GR left`);
    check('the founder is its owner',
      made.body.clan?.you?.role === 'owner' && made.body.clan?.members === 1);

    const again = await call(base, 'POST', '/api/v1/clans', { token: owner, body: { tag: 'CULT' } });
    check('one player, one clan — even for the founder',
      again.status === 409 && again.body.error === 'already_in_clan');

    grant('Rookie', 20, 5000);
    const clash = await call(base, 'POST', '/api/v1/clans', { token: rookie, body: { tag: 'NUKE' } });
    check('a tag can only be taken once', clash.status === 409 && clash.body.error === 'tag_taken');

    const wallet = new DatabaseSync(dbPath);
    const rookieGr = wallet.prepare('SELECT gr FROM users WHERE username_lower = ?').get('rookie').gr;
    wallet.close();
    check('and losing the race costs nothing', rookieGr === 5000, `${rookieGr} GR`);

    /* ── Invitations ────────────────────────────────────────────────────── */

    suite('Clans — invite only');

    const uninvited = await call(base, 'POST', '/api/v1/clans/NUKE/join', { token: buddy });
    check('there is no way to let yourself in',
      uninvited.status === 403 && uninvited.body.error === 'not_invited');

    const notOwner = await call(base, 'POST', '/api/v1/clans/NUKE/invites',
      { token: buddy, body: { username: 'Second' } });
    check('only the owner invites', notOwner.status === 403 && notOwner.body.error === 'not_owner');

    grant('Second', 3, 50);
    const tooYoung = await call(base, 'POST', '/api/v1/clans/NUKE/invites',
      { token: owner, body: { username: 'Second' } });
    check(`an account below level ${K.CLAN_JOIN_LEVEL} cannot be invited`,
      tooYoung.status === 403 && tooYoung.body.error === 'level_too_low', tooYoung.body.message ?? '');

    grant('Second', 8, 50);
    const invited = await call(base, 'POST', '/api/v1/clans/NUKE/invites',
      { token: owner, body: { username: 'Second' } });
    check('a level-5 account can be', invited.status === 200, invited.body.message ?? '');

    const seen = await call(base, 'GET', '/api/v1/clans/mine', { token: buddy });
    check('and reads the invitation back from their own panel',
      seen.body.invites?.length === 1 && seen.body.invites[0].tag === 'NUKE'
      && seen.body.invites[0].invitedBy === 'Chief');

    const joined = await call(base, 'POST', '/api/v1/clans/NUKE/join', { token: buddy });
    check('accepting it seats them', joined.status === 200 && joined.body.clan?.members === 2);

    const profile = await call(base, 'GET', '/api/v1/players/Second');
    check('the tag lands on the account every scoreboard reads',
      profile.body.user?.clan === 'NUKE' && profile.body.user?.clanVerified === false);

    /* ── The clan picture ───────────────────────────────────────────────── */

    const shot = png(64, 64);
    const byMember = await fetch(`${base}/api/v1/clans/NUKE/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', authorization: `Bearer ${buddy}` },
      body: shot,
    });
    check('a member cannot change the clan picture', byMember.status === 403);

    const upload = await fetch(`${base}/api/v1/clans/NUKE/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', authorization: `Bearer ${owner}` },
      body: shot,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    check('the owner can', upload.status === 200, upload.body.message ?? '');

    const picture = upload.body.clan?.avatar ?? '';
    // Not cosmetic: nginx proxies `^~ /avatars/` and stops before its regex
    // locations, so a clan picture served from any *other* prefix falls through
    // to the static-image rule and 404s on a deployment whose vhost predates
    // it. The URL living under /avatars/ is what makes it need no nginx change.
    check('and it is served from under the /avatars/ prefix nginx already proxies',
      picture.startsWith('/avatars/clans/'), picture);

    const fetched = await fetch(base + picture);
    check('the file itself comes back as the image it was accepted as',
      fetched.status === 200 && fetched.headers.get('content-type') === 'image/png',
      `${fetched.status} ${fetched.headers.get('content-type')}`);

    const junk = await fetch(`${base}/api/v1/clans/NUKE/avatar`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', authorization: `Bearer ${owner}` },
      body: Buffer.from('<script>alert(1)</script>'),
    });
    check('a file that only claims to be an image is refused', junk.status === 400);

    const dropped = await call(base, 'DELETE', '/api/v1/clans/NUKE/avatar', { token: owner });
    check('and the owner can take it away again',
      dropped.status === 200 && dropped.body.clan?.avatar === null);

    /* ── Verification: the gold tag ─────────────────────────────────────── */

    suite('Clans — the gold tag');

    const gild = new DatabaseSync(dbPath);
    gild.prepare('UPDATE clans SET verified = 1 WHERE tag_lower = ?').run('nuke');
    // The denormalised copy is what everything actually reads, so verifying a
    // clan without syncing it would leave every member's tag grey.
    gild.prepare(`UPDATE users SET clan_verified = 1
      WHERE id IN (SELECT user_id FROM clan_members WHERE clan_id =
        (SELECT id FROM clans WHERE tag_lower = 'nuke'))`).run();
    gild.close();

    const gold = await call(base, 'GET', '/api/v1/players/Second');
    check('a verified clan is verified on every member',
      gold.body.user?.clanVerified === true);
    const board = await call(base, 'GET', '/api/v1/leaderboard');
    const row = board.body.entries?.find((e) => e.username === 'Second');
    check('including on the leaderboard, which never joins to find out',
      row?.clan === 'NUKE' && row?.clanVerified === true, JSON.stringify(row?.clanVerified));

    /* ── Leaving, removing, handing over ────────────────────────────────── */

    suite('Clans — who can do what');

    const walkout = await call(base, 'POST', '/api/v1/clans/NUKE/leave', { token: owner });
    check('an owner cannot walk out and leave nobody in charge',
      walkout.status === 409 && walkout.body.error === 'owner_cannot_leave');

    const stranger = await call(base, 'DELETE', '/api/v1/clans/NUKE/members/Second', { token: buddy });
    check('a member cannot remove anybody', stranger.status === 403);

    const handed = await call(base, 'POST', '/api/v1/clans/NUKE/transfer',
      { token: owner, body: { username: 'Second' } });
    check('the owner can hand it over', handed.status === 200 && handed.body.owner === 'Second');

    const now = await call(base, 'GET', '/api/v1/clans/mine', { token: owner });
    check('and stays on as a plain member', now.body.clan?.you?.role === 'member');

    const evicted = await call(base, 'DELETE', '/api/v1/clans/NUKE/members/Chief', { token: buddy });
    check('the new owner can remove the old one', evicted.status === 200);

    const stripped = await call(base, 'GET', '/api/v1/players/Chief');
    check('being removed takes the tag with it',
      stripped.body.user?.clan === null && stripped.body.user?.clanVerified === false);

    const gone = await call(base, 'DELETE', '/api/v1/clans/NUKE', { token: buddy });
    check('the owner can disband it', gone.status === 200 && gone.body.disbanded === 'NUKE');

    const missing = await call(base, 'GET', '/api/v1/clans/NUKE');
    check('after which the clan is not there', missing.status === 404);

    const orphan = await call(base, 'GET', '/api/v1/players/Second');
    check('and the last member is wearing nothing', orphan.body.user?.clan === null);

    const reborn = await call(base, 'POST', '/api/v1/clans', { token: rookie, body: { tag: 'NUKE' } });
    check('a disbanded tag is free again', reborn.status === 201);

    const browse = await call(base, 'GET', '/api/v1/clans');
    info(`${browse.body.total} clan(s) listed`);
    check('the browse list ranks what is left', browse.status === 200 && browse.body.total === 1
      && browse.body.clans[0].tag === 'NUKE' && browse.body.clans[0].rank === 1);
  } finally {
    server.child.kill('SIGTERM');
    await sleep(300);
    if (!server.child.killed) server.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async function run() {
  unitChecks();
  await migrationCheck();
  await integration();
}
