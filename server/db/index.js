/**
 * Open Grunker — database layer.
 *
 * Uses Node's built-in `node:sqlite`, so there is no native module to compile
 * and no external database process to run: the whole account system lives in
 * one WAL-mode file under data/.
 */
// node:sqlite is still flagged experimental; every entry point runs Node with
// --disable-warning=ExperimentalWarning so the notice doesn't spam the logs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import config, { ROOT } from '../config.js';
import log from '../util/log.js';
import {
  levelFromXp, xpForLevel, REPORT_STATUSES, CLAN_ROLES, streakReward, FIRST_WIN_BONUS,
  SIGNUP_REWARD, levelUpReward,
} from '../../shared/constants.js';

const logger = log.child('db');

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
const SCHEMA_SQL = readFileSync(join(ROOT, 'server/db/schema.sql'), 'utf8');
db.exec(SCHEMA_SQL);

const now = () => Math.floor(Date.now() / 1000);
const int = (v) => (typeof v === 'bigint' ? Number(v) : v);

/**
 * A fresh entity id.
 *
 * Every account, clan, match, match row and report is keyed by one of these
 * rather than by a counter, so an id gives away nothing about how many exist
 * or what order they were made in, and two instances' data can be put side by
 * side without a single collision.
 */
export const newId = () => randomUUID();

/* ── Migrations ──────────────────────────────────────────────────────────── */

/**
 * Brings an older database file up to the current schema. Every step is
 * idempotent, so this can run on every boot.
 */
function migrate() {
  const u = cols('users');

  // KR became GR when the currency was renamed.
  if (u.has('kr') && !u.has('gr')) {
    db.exec('ALTER TABLE users RENAME COLUMN kr TO gr');
    logger.info('migrated: users.kr -> users.gr');
  } else if (!u.has('gr')) {
    db.exec('ALTER TABLE users ADD COLUMN gr INTEGER NOT NULL DEFAULT 0');
  }
  if (!u.has('verified')) db.exec('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
  if (!u.has('clan')) db.exec('ALTER TABLE users ADD COLUMN clan TEXT');

  const s = cols('stats');
  if (!s.has('score')) db.exec('ALTER TABLE stats ADD COLUMN score INTEGER NOT NULL DEFAULT 0');

  const l = cols('loadouts');
  if (!l.has('keybinds')) db.exec("ALTER TABLE loadouts ADD COLUMN keybinds TEXT NOT NULL DEFAULT '{}'");

  const mp = cols('match_players');
  if (!mp.has('gr')) db.exec('ALTER TABLE match_players ADD COLUMN gr INTEGER NOT NULL DEFAULT 0');

  // Email verification and paid renames landed after the first release.
  if (!u.has('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    // Accounts that existed before verification are grandfathered in: they
    // signed up under rules that never asked them for an address.
    db.exec("UPDATE users SET email_verified = 1 WHERE email IS NOT NULL AND email <> ''");
    logger.info('migrated: users.email_verified (existing addresses grandfathered)');
  }
  if (!u.has('verified_at')) db.exec('ALTER TABLE users ADD COLUMN verified_at INTEGER');
  if (!u.has('renamed_at')) db.exec('ALTER TABLE users ADD COLUMN renamed_at INTEGER');
  if (!u.has('name_changes')) db.exec('ALTER TABLE users ADD COLUMN name_changes INTEGER NOT NULL DEFAULT 0');

  // The daily play streak. Four counters rather than a table of its own: there
  // is exactly one row per account by construction, and every read of it
  // already has the user row in hand.
  if (!u.has('last_play_day')) db.exec('ALTER TABLE users ADD COLUMN last_play_day INTEGER NOT NULL DEFAULT 0');
  if (!u.has('play_streak')) db.exec('ALTER TABLE users ADD COLUMN play_streak INTEGER NOT NULL DEFAULT 0');
  if (!u.has('best_streak_days')) db.exec('ALTER TABLE users ADD COLUMN best_streak_days INTEGER NOT NULL DEFAULT 0');
  if (!u.has('last_win_day')) db.exec('ALTER TABLE users ADD COLUMN last_win_day INTEGER NOT NULL DEFAULT 0');

  // Profile pictures. The column holds a filename, never the bytes: the image
  // itself lives under data/avatars so it can be served straight off disk.
  if (!u.has('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  if (!u.has('avatar_at')) db.exec('ALTER TABLE users ADD COLUMN avatar_at INTEGER');

  // Clans. `users.clan` predates them as a free-text tag an administrator could
  // type in; these two columns are what turn it into a cache of a real row.
  // Any tag left over from before belongs to no clan, so it is dropped rather
  // than left pointing at nothing — it would render gold-less and unjoinable.
  // One `if` per column: `u` is the column list as it was when migrate() began,
  // so a block that adds two columns and is then re-checked against that same
  // stale set tries to add the second one twice.
  if (!u.has('clan_verified')) db.exec('ALTER TABLE users ADD COLUMN clan_verified INTEGER NOT NULL DEFAULT 0');
  if (!u.has('clan_id')) {
    db.exec('ALTER TABLE users ADD COLUMN clan_id INTEGER');
    const orphans = int(db.prepare("UPDATE users SET clan = NULL WHERE clan IS NOT NULL").run().changes);
    if (orphans) logger.info(`migrated: cleared ${orphans} free-text clan tag(s) with no clan behind them`);
  }
  // Indexed here rather than in schema.sql, which runs before this function and
  // would fail outright on a database whose users table has no clan_id yet.
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_clan ON users(clan_id)');

  regradeLevels();
  grantSignupSkins();
}

/**
 * Nobody loses a level the old curve had already given them.
 *
 * The ladder got steeper above `LEVEL_RAMP_FROM`, and levels are derived from
 * XP rather than stored — so on the first boot after that change every account
 * past the ramp would silently drop several levels, taking the chat, the report
 * button and a clan membership down with them. That is not a balance decision,
 * it is a bug with a plausible excuse.
 *
 * So the accounts that were already up there are topped up to exactly what
 * their level now costs. They keep the level, they keep a coherent XP figure
 * behind it, and the new curve applies to everything they earn from here on.
 * `level_graded` is the marker that stops it running twice; the top-up itself
 * is idempotent anyway, but a second pass on a player who legitimately lost XP
 * would not be.
 */
function regradeLevels() {
  if (!cols('users').has('level_graded')) {
    db.exec('ALTER TABLE users ADD COLUMN level_graded INTEGER NOT NULL DEFAULT 0');
  }
  const pending = db.prepare('SELECT id, username, xp, level FROM users WHERE level_graded = 0').all();
  if (!pending.length) return;

  const bump = db.prepare('UPDATE users SET xp = ?, level_graded = 1 WHERE id = ?');
  const mark = db.prepare('UPDATE users SET level = ?, level_graded = 1 WHERE id = ?');
  let topped = 0;
  for (const u of pending) {
    const held = Math.max(1, int(u.level) || 1);
    const need = xpForLevel(held);
    if (int(u.xp) < need) { bump.run(need, u.id); topped++; }
    else mark.run(levelFromXp(int(u.xp)), u.id);
  }
  if (topped) logger.info(`migrated: topped up ${topped} account(s) so the steeper level curve costs nobody a level`);
}

/**
 * The Enlisted finish is what an account is handed for existing, and every
 * account that predates it existed. Granting it on the way past is cheaper and
 * far less surprising than a shop that shows older players a locked card whose
 * unlock condition they met a year ago.
 */
function grantSignupSkins() {
  const wanted = SIGNUP_REWARD.skins ?? [];
  if (!wanted.length) return;
  const rows = db.prepare('SELECT user_id, owned FROM loadouts').all();
  const save = db.prepare('UPDATE loadouts SET owned = ? WHERE user_id = ?');
  let granted = 0;
  for (const row of rows) {
    let owned;
    try { owned = JSON.parse(row.owned ?? '[]'); } catch { owned = []; }
    if (!Array.isArray(owned)) owned = [];
    const missing = wanted.filter((id) => !owned.includes(id));
    if (!missing.length) continue;
    save.run(JSON.stringify([...owned, ...missing]), row.user_id);
    granted++;
  }
  if (granted) logger.info(`migrated: granted the sign-up finish to ${granted} existing account(s)`);
}

/** Column names of one table, as a set. */
function cols(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}
migrate();

/* ── UUID migration ──────────────────────────────────────────────────────── */

/**
 * Every table whose rows have to be rewritten when integer ids become UUIDs,
 * with the columns that hold a reference to something. Order matters only for
 * readability — foreign keys are off while this runs.
 *
 * `admin_log` and `ip_intel` are absent on purpose: neither holds a reference
 * to an account, a clan or a match, and admin_log is ordered by its own
 * counter, which is exactly what a journal wants.
 */
const UUID_TABLES = {
  users: { self: 'user', refs: { clan_id: 'clan' }, avatarOf: 'user' },
  stats: { refs: { user_id: 'user' } },
  loadouts: { refs: { user_id: 'user' } },
  sessions: { refs: { user_id: 'user' } },
  matches: { self: 'match' },
  match_players: { self: 'matchPlayer', refs: { match_id: 'match', user_id: 'user' } },
  mastery: { refs: { user_id: 'user' } },
  challenges: { refs: { user_id: 'user' } },
  ip_bans: { refs: { user_id: 'user' } },
  chat_bans: { refs: { user_id: 'user' } },
  report_bans: { refs: { user_id: 'user' } },
  email_tokens: { refs: { user_id: 'user' } },
  reports: { self: 'report', refs: { reporter_id: 'user', target_id: 'user' } },
  clans: { self: 'clan', refs: { owner_id: 'user' }, avatarOf: 'clan' },
  clan_members: { refs: { clan_id: 'clan', user_id: 'user' } },
  clan_invites: { refs: { clan_id: 'clan', user_id: 'user' } },
};

/**
 * Turns a counter-keyed database into a UUID-keyed one, in place.
 *
 * The whole thing is one transaction over a table set small enough to hold in
 * memory — a self-hosted instance's accounts, matches and reports — which is
 * what lets it sidestep the usual SQLite key-change dance entirely: read every
 * row out, drop every table, recreate them from the current schema, and write
 * the rows back with each id swapped for the UUID minted for it.
 *
 * A consistent snapshot is written next to the database first, because the one
 * failure mode that matters here is a half-migrated account table, and
 * `VACUUM INTO` gives a real backup rather than a copy of a live WAL.
 *
 * Doing nothing is the normal case: a database created by the current schema
 * already has a TEXT `users.id`, and this returns before touching anything.
 */
/**
 * Renames the picture files whose names carry an owner id that just changed.
 *
 * Best effort by design: the rows already point at the new names, and a picture
 * that fails to move is a broken thumbnail its owner can replace in one click —
 * not a reason to refuse to start, and certainly not a reason to have rolled
 * back an otherwise complete migration.
 */
function moveAvatarFiles(moves) {
  if (!moves.length) return;
  const dirs = { users: config.avatarDir, clans: config.clanAvatarDir };
  let moved = 0, missing = 0;
  for (const [table, from, to] of moves) {
    const dir = dirs[table];
    if (!dir || from === to) continue;
    try {
      renameSync(join(dir, from), join(dir, to));
      moved++;
    } catch {
      missing++;
    }
  }
  logger.info(`migrated ${moved} picture file(s)${missing ? `, ${missing} already gone` : ''}`);
}

function migrateToUuids() {
  const idCol = db.prepare("SELECT type FROM pragma_table_info('users') WHERE name = 'id'").get();
  if (!idCol || !/^INT/i.test(String(idCol.type))) return false;   // already migrated

  const backup = `${config.dbPath}.pre-uuid-${new Date().toISOString().slice(0, 10)}`;
  try {
    if (existsSync(backup)) unlinkSync(backup);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    logger.info(`migrating to UUID ids — snapshot written to ${backup}`);
  } catch (err) {
    logger.warn(`could not write a pre-migration snapshot: ${err.message}`);
  }

  // Read everything out first: nothing is dropped until every row is in hand.
  const dump = new Map();
  for (const table of Object.keys(UUID_TABLES)) {
    dump.set(table, db.prepare(`SELECT * FROM ${table}`).all());
  }

  // One UUID per old id, per kind of thing. `key()` is what every foreign key
  // is then looked up through, so a reference can never drift from its row.
  const maps = { user: new Map(), clan: new Map(), match: new Map(), report: new Map(), matchPlayer: new Map() };
  const key = (kind, old) => {
    if (old === null || old === undefined) return null;
    const k = String(int(old));
    let id = maps[kind].get(k);
    if (!id) maps[kind].set(k, (id = randomUUID()));
    return id;
  };
  for (const [table, spec] of Object.entries(UUID_TABLES)) {
    if (!spec.self) continue;
    for (const row of dump.get(table)) key(spec.self, row.id);
  }

  // The schema without its PRAGMAs: `journal_mode` cannot be set inside a
  // transaction, and the other two are already in force on this connection.
  // Filtered by line rather than by statement on purpose — splitting the file
  // on semicolons cuts straight through the ones inside its comments.
  const ddl = SCHEMA_SQL.split('\n').filter((line) => !/^\s*PRAGMA\b/i.test(line)).join('\n');

  /** [table, oldFilename, newFilename] — applied on disk after the commit. */
  const avatarMoves = [];

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const table of Object.keys(UUID_TABLES)) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(ddl);

    let rows = 0;
    for (const [table, spec] of Object.entries(UUID_TABLES)) {
      const list = dump.get(table);
      if (!list.length) continue;
      const cols = Object.keys(list[0]);
      const stmt = db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const row of list) {
        stmt.run(...cols.map((c) => {
          if (c === 'id' && spec.self) return key(spec.self, row.id);
          // A picture's filename starts with its owner's id, so it moves too.
          // The file on disk is renamed to match once the transaction lands.
          if (c === 'avatar' && spec.avatarOf && row[c]) {
            const renamed = String(row[c]).replace(/^[^-]+-/, `${key(spec.avatarOf, row.id)}-`);
            avatarMoves.push([table, String(row[c]), renamed]);
            return renamed;
          }
          const kind = spec.refs?.[c];
          return kind ? key(kind, row[c]) : row[c];
        }));
        rows++;
      }
    }
    db.exec('COMMIT');
    moveAvatarFiles(avatarMoves);
    logger.info(`migrated to UUID ids — ${maps.user.size} account(s), ${maps.clan.size} clan(s), `
      + `${maps.match.size} match(es), ${rows} row(s) rewritten`);
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    logger.error(`UUID migration failed, database left untouched: ${err.message}`);
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
// Order matters: migrate() first, so an old file's columns already carry their
// current names and the rebuild below can insert straight into the new schema —
// then again afterwards, because rebuilding the tables from schema.sql drops
// the one index migrate() owns.
if (migrateToUuids()) migrate();
logger.info('opened', config.dbPath);

/* Prepared statements are created once and reused for the process lifetime. */
const S = {
  userByLower: db.prepare('SELECT * FROM users WHERE username_lower = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(
    `INSERT INTO users (id, username, username_lower, email, password_hash, created_at, last_ip)
     VALUES (?,?,?,?,?,?,?)`),
  insertStats: db.prepare('INSERT OR IGNORE INTO stats (user_id, updated_at) VALUES (?,?)'),
  insertLoadout: db.prepare('INSERT OR IGNORE INTO loadouts (user_id, updated_at) VALUES (?,?)'),
  touchLogin: db.prepare('UPDATE users SET last_login = ?, last_ip = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  setBan: db.prepare('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?'),
  addProgress: db.prepare('UPDATE users SET xp = xp + ?, gr = gr + ? WHERE id = ?'),
  setStreak: db.prepare(
    `UPDATE users SET last_play_day = ?, play_streak = ?, best_streak_days = MAX(best_streak_days, ?)
     WHERE id = ?`),
  setWinDay: db.prepare('UPDATE users SET last_win_day = ? WHERE id = ?'),
  setLevel: db.prepare('UPDATE users SET level = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),

  statsByUser: db.prepare('SELECT * FROM stats WHERE user_id = ?'),
  bumpStats: db.prepare(`UPDATE stats SET
      kills = kills + ?, deaths = deaths + ?, assists = assists + ?, headshots = headshots + ?,
      shots_fired = shots_fired + ?, shots_hit = shots_hit + ?, damage_dealt = damage_dealt + ?,
      wins = wins + ?, losses = losses + ?, matches = matches + ?,
      best_streak = MAX(best_streak, ?), score = score + ?, playtime_sec = playtime_sec + ?, updated_at = ?
    WHERE user_id = ?`),

  loadoutByUser: db.prepare('SELECT * FROM loadouts WHERE user_id = ?'),
  saveLoadout: db.prepare(
    `UPDATE loadouts SET class_id = ?, skins = ?, owned = ?, settings = ?, keybinds = ?, updated_at = ?
     WHERE user_id = ?`),

  insertSession: db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)'),
  sessionByHash: db.prepare(`SELECT s.*, u.username, u.role, u.banned_until FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  insertMatch: db.prepare('INSERT INTO matches (id, room, mode, map, started_at) VALUES (?,?,?,?,?)'),
  endMatch: db.prepare('UPDATE matches SET ended_at = ?, winner = ? WHERE id = ?'),
  insertMatchPlayer: db.prepare(
    `INSERT INTO match_players (id, match_id, user_id, name, team, class_id, kills, deaths, score, gr, won)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`),

  insertAdminLog: db.prepare('INSERT INTO admin_log (at, actor, action, target, detail) VALUES (?,?,?,?,?)'),
  recentAdminLog: db.prepare('SELECT * FROM admin_log ORDER BY id DESC LIMIT ?'),

  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countMatches: db.prepare('SELECT COUNT(*) AS n FROM matches'),

  bumpMastery: db.prepare(`INSERT INTO mastery (user_id, weapon_id, kills, headshots, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, weapon_id) DO UPDATE SET
        kills = kills + excluded.kills,
        headshots = headshots + excluded.headshots,
        updated_at = excluded.updated_at`),
  masteryFor: db.prepare('SELECT weapon_id, kills, headshots FROM mastery WHERE user_id = ?'),

  insertIpBan: db.prepare(`INSERT INTO ip_bans (ip, reason, until, created_at, user_id, username)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(ip) DO UPDATE SET
        reason = excluded.reason, until = excluded.until,
        created_at = excluded.created_at, user_id = excluded.user_id, username = excluded.username`),
  ipBanByIp: db.prepare('SELECT * FROM ip_bans WHERE ip = ?'),
  deleteIpBan: db.prepare('DELETE FROM ip_bans WHERE ip = ?'),
  ipBansForUser: db.prepare('SELECT * FROM ip_bans WHERE user_id = ?'),
  listIpBans: db.prepare('SELECT * FROM ip_bans ORDER BY created_at DESC LIMIT ?'),
  pruneIpBans: db.prepare('DELETE FROM ip_bans WHERE until > 0 AND until <= ?'),

  insertChatBan: db.prepare(`INSERT INTO chat_bans (user_id, until, reason, created_at, actor, username)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        until = excluded.until, reason = excluded.reason,
        created_at = excluded.created_at, actor = excluded.actor, username = excluded.username`),
  chatBanByUser: db.prepare('SELECT * FROM chat_bans WHERE user_id = ?'),
  deleteChatBan: db.prepare('DELETE FROM chat_bans WHERE user_id = ?'),
  listChatBans: db.prepare(`SELECT c.*, u.username AS account FROM chat_bans c
      LEFT JOIN users u ON u.id = c.user_id ORDER BY c.created_at DESC LIMIT ?`),
  pruneChatBans: db.prepare('DELETE FROM chat_bans WHERE until > 0 AND until <= ?'),

  insertReportBan: db.prepare(`INSERT INTO report_bans (user_id, until, reason, created_at, actor, username)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        until = excluded.until, reason = excluded.reason,
        created_at = excluded.created_at, actor = excluded.actor, username = excluded.username`),
  reportBanByUser: db.prepare('SELECT * FROM report_bans WHERE user_id = ?'),
  deleteReportBan: db.prepare('DELETE FROM report_bans WHERE user_id = ?'),
  listReportBans: db.prepare(`SELECT b.*, u.username AS account FROM report_bans b
      LEFT JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC LIMIT ?`),
  pruneReportBans: db.prepare('DELETE FROM report_bans WHERE until > 0 AND until <= ?'),

  insertEmailToken: db.prepare(
    `INSERT INTO email_tokens (token_hash, user_id, email, created_at, expires_at, sent_to_ip)
     VALUES (?,?,?,?,?,?)`),
  emailTokenByHash: db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?'),
  useEmailToken: db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at = 0'),
  latestEmailToken: db.prepare(
    'SELECT * FROM email_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'),
  clearEmailTokens: db.prepare('DELETE FROM email_tokens WHERE user_id = ?'),
  pruneEmailTokens: db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?'),
  markVerified: db.prepare(
    'UPDATE users SET email_verified = 1, verified_at = ?, email = ? WHERE id = ?'),
  setEmail: db.prepare('UPDATE users SET email = ?, email_verified = 0, verified_at = NULL WHERE id = ?'),
  rename: db.prepare(
    'UPDATE users SET username = ?, username_lower = ?, renamed_at = ?, name_changes = name_changes + 1 WHERE id = ?'),

  putIpIntel: db.prepare(`INSERT INTO ip_intel (ip, proxy, hosting, tor, country, asn, provider, detail, checked_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ip) DO UPDATE SET
        proxy = excluded.proxy, hosting = excluded.hosting, tor = excluded.tor,
        country = excluded.country, asn = excluded.asn, provider = excluded.provider,
        detail = excluded.detail, checked_at = excluded.checked_at`),
  ipIntelByIp: db.prepare('SELECT * FROM ip_intel WHERE ip = ?'),
  pruneIpIntel: db.prepare('DELETE FROM ip_intel WHERE checked_at <= ?'),
  recentIpIntel: db.prepare('SELECT * FROM ip_intel ORDER BY checked_at DESC LIMIT ?'),

  setAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_at = ? WHERE id = ?'),

  insertReport: db.prepare(`INSERT INTO reports
      (id, reporter_id, reporter_name, target_id, target_name, target_ip, reason, detail,
       room, mode, map, chat_log, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  reportById: db.prepare('SELECT * FROM reports WHERE id = ?'),
  reportsByReporter: db.prepare(
    'SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT ?'),
  reportsAgainst: db.prepare(`SELECT * FROM reports
      WHERE (target_id IS NOT NULL AND target_id = ?) OR LOWER(target_name) = ?
      ORDER BY created_at DESC LIMIT ?`),
  countReportsSince: db.prepare(
    'SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?'),
  countOpenReportsBy: db.prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND status = 'open'"),
  lastReportBy: db.prepare(
    'SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 1'),
  lastDismissedFor: db.prepare(`SELECT * FROM reports
      WHERE reporter_id = ? AND status = 'rejected' AND resolved_at > ?
      ORDER BY resolved_at DESC LIMIT 1`),
  countDismissedSince: db.prepare(`SELECT COUNT(*) AS n FROM reports
      WHERE reporter_id = ? AND status = 'rejected' AND resolved_at > ?`),
  lastReportOn: db.prepare(`SELECT * FROM reports
      WHERE reporter_id = ? AND LOWER(target_name) = ? ORDER BY created_at DESC LIMIT 1`),
  resolveReport: db.prepare(`UPDATE reports
      SET status = ?, action = ?, outcome = ?, resolver = ?, resolved_at = ? WHERE id = ?`),
  reopenReport: db.prepare(`UPDATE reports
      SET status = 'open', action = NULL, outcome = NULL, resolver = NULL, resolved_at = NULL
      WHERE id = ?`),
  deleteReport: db.prepare('DELETE FROM reports WHERE id = ?'),
  countOpenReports: db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
  countReports: db.prepare('SELECT COUNT(*) AS n FROM reports'),
  pruneReports: db.prepare("DELETE FROM reports WHERE status <> 'open' AND resolved_at > 0 AND resolved_at <= ?"),

  insertClan: db.prepare(
    'INSERT INTO clans (id, tag, tag_lower, owner_id, created_at, created_by) VALUES (?,?,?,?,?,?)'),
  clanById: db.prepare('SELECT * FROM clans WHERE id = ?'),
  clanByTag: db.prepare('SELECT * FROM clans WHERE tag_lower = ?'),
  clanByMember: db.prepare(`SELECT c.* FROM clans c
      JOIN clan_members m ON m.clan_id = c.id WHERE m.user_id = ?`),
  setClanOwner: db.prepare('UPDATE clans SET owner_id = ? WHERE id = ?'),
  setClanAvatar: db.prepare('UPDATE clans SET avatar = ?, avatar_at = ? WHERE id = ?'),
  setClanVerified: db.prepare('UPDATE clans SET verified = ? WHERE id = ?'),
  deleteClan: db.prepare('DELETE FROM clans WHERE id = ?'),
  countClans: db.prepare('SELECT COUNT(*) AS n FROM clans'),

  insertMember: db.prepare(
    'INSERT INTO clan_members (clan_id, user_id, role, joined_at) VALUES (?,?,?,?)'),
  memberOf: db.prepare('SELECT * FROM clan_members WHERE user_id = ?'),
  memberIn: db.prepare('SELECT * FROM clan_members WHERE clan_id = ? AND user_id = ?'),
  setMemberRole: db.prepare('UPDATE clan_members SET role = ? WHERE clan_id = ? AND user_id = ?'),
  deleteMember: db.prepare('DELETE FROM clan_members WHERE clan_id = ? AND user_id = ?'),
  countMembers: db.prepare('SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?'),
  memberIds: db.prepare('SELECT user_id FROM clan_members WHERE clan_id = ?'),
  membersOf: db.prepare(`SELECT m.role, m.joined_at, u.id, u.username, u.level, u.xp, u.verified,
             u.avatar, u.last_login, s.kills, s.deaths, s.score
      FROM clan_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN stats s ON s.user_id = u.id
      WHERE m.clan_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, u.level DESC, u.username`),
  syncMemberTags: db.prepare(`UPDATE users
      SET clan = ?, clan_id = ?, clan_verified = ?
      WHERE id IN (SELECT user_id FROM clan_members WHERE clan_id = ?)`),
  clearMemberTag: db.prepare('UPDATE users SET clan = NULL, clan_id = NULL, clan_verified = 0 WHERE id = ?'),
  clearClanTags: db.prepare('UPDATE users SET clan = NULL, clan_id = NULL, clan_verified = 0 WHERE clan_id = ?'),

  insertInvite: db.prepare(`INSERT INTO clan_invites (clan_id, user_id, invited_by, created_at, expires_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(clan_id, user_id) DO UPDATE SET
        invited_by = excluded.invited_by, created_at = excluded.created_at,
        expires_at = excluded.expires_at`),
  inviteFor: db.prepare('SELECT * FROM clan_invites WHERE clan_id = ? AND user_id = ? AND expires_at > ?'),
  invitesForUser: db.prepare(`SELECT i.*, c.tag, c.verified, c.avatar FROM clan_invites i
      JOIN clans c ON c.id = i.clan_id
      WHERE i.user_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC`),
  invitesForClan: db.prepare(`SELECT i.*, u.username, u.level FROM clan_invites i
      JOIN users u ON u.id = i.user_id
      WHERE i.clan_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC`),
  countInvites: db.prepare('SELECT COUNT(*) AS n FROM clan_invites WHERE clan_id = ? AND expires_at > ?'),
  deleteInvite: db.prepare('DELETE FROM clan_invites WHERE clan_id = ? AND user_id = ?'),
  deleteUserInvites: db.prepare('DELETE FROM clan_invites WHERE user_id = ?'),
  pruneInvites: db.prepare('DELETE FROM clan_invites WHERE expires_at <= ?'),

  bumpChallenge: db.prepare(`INSERT INTO challenges (user_id, day, challenge_id, progress, claimed)
      VALUES (?,?,?,?,0)
      ON CONFLICT(user_id, day, challenge_id) DO UPDATE SET
        progress = progress + excluded.progress`),
  challengesFor: db.prepare('SELECT challenge_id, progress, claimed FROM challenges WHERE user_id = ? AND day = ?'),
  claimChallenge: db.prepare(
    'UPDATE challenges SET claimed = 1 WHERE user_id = ? AND day = ? AND challenge_id = ? AND claimed = 0'),
  pruneChallenges: db.prepare('DELETE FROM challenges WHERE day < ?'),
};

/* ── Users ───────────────────────────────────────────────────────────────── */

export const users = {
  byName: (name) => S.userByLower.get(String(name).toLowerCase()),
  byId: (id) => S.userById.get(id),

  /** Creates the user row plus its stats and loadout rows in one transaction. */
  /**
   * Makes an account, and pays it what signing up is worth.
   *
   * The grant is inside the same transaction as the row itself: an account that
   * exists without the balance the sign-up screen just promised it would be a
   * broken promise nobody would ever notice was a bug rather than a lie.
   */
  create({ username, email, passwordHash, ip }) {
    const ts = now();
    const id = newId();
    db.exec('BEGIN');
    try {
      S.insertUser.run(id, username, username.toLowerCase(), email ?? null, passwordHash, ts, ip ?? null);
      S.insertStats.run(id, ts);
      S.insertLoadout.run(id, ts);
      if (SIGNUP_REWARD.gr > 0 || SIGNUP_REWARD.xp > 0) {
        S.addProgress.run(Math.round(SIGNUP_REWARD.xp || 0), Math.round(SIGNUP_REWARD.gr || 0), id);
      }
      if (SIGNUP_REWARD.skins?.length) {
        db.prepare('UPDATE loadouts SET owned = ? WHERE user_id = ?')
          .run(JSON.stringify(SIGNUP_REWARD.skins), id);
      }
      // level_graded: this account was born on the current curve, so the
      // regrade migration has nothing to do to it.
      db.prepare('UPDATE users SET level_graded = 1 WHERE id = ?').run(id);
      db.exec('COMMIT');
      return S.userById.get(id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },

  touchLogin: (id, ip) => S.touchLogin.run(now(), ip ?? null, id),
  setPassword: (id, hash) => S.setPassword.run(hash, id),

  /**
   * Renames an account. The unique index on `username_lower` is what actually
   * settles a race between two people buying the same name; the caller is
   * expected to catch the constraint error and refund nothing, since the GR is
   * only spent once the rename lands.
   */
  rename(id, username) {
    S.rename.run(username, String(username).toLowerCase(), now(), id);
    return S.userById.get(id);
  },

  /** Marks the address confirmed. `email` is written back so a corrected
   *  address on the token (rather than on the row) is the one that sticks. */
  markVerified(id, email) {
    S.markVerified.run(now(), email, id);
    return S.userById.get(id);
  },

  /** Points the account at a new, unconfirmed address. */
  setEmail(id, email) {
    S.setEmail.run(email, id);
    return S.userById.get(id);
  },

  /** Is this account allowed into a match, verification-wise? */
  isEmailVerified: (u) => !!u && !!u.email_verified,

  setRole: (id, role) => S.setRole.run(role, id),

  /**
   * Points the account at a stored picture, or at none when `file` is null.
   * The name carries its own content hash, which is what lets the browser cache
   * an avatar hard and still see a new one the moment it is uploaded.
   */
  setAvatar(id, file) {
    S.setAvatar.run(file ?? null, file ? now() : null, id);
    return S.userById.get(id);
  },

  ban: (id, untilTs, reason) => S.setBan.run(untilTs, reason ?? null, id),
  remove: (id) => int(S.deleteUser.run(id).changes),

  /**
   * Adds XP/GR, recomputes the cached level, and pays for any level crossed.
   *
   * The level payout is settled here rather than by the caller because this is
   * the only place that knows how many levels one payout crossed — a big match
   * can cross two, and paying for one of them would be the kind of quiet
   * shortchanging nobody ever notices and everybody resents.
   *
   * `bonusGr` comes back separately from the running total so the end-of-match
   * card can print it as its own line instead of folding it into the match
   * figure the player watched all game.
   */
  addProgress(id, xp, gr) {
    S.addProgress.run(Math.round(xp), Math.round(gr), id);
    const u = S.userById.get(id);
    if (!u) return null;
    const lvl = levelFromXp(u.xp);
    const was = int(u.level) || 1;
    let bonusGr = 0;
    if (lvl !== was) {
      S.setLevel.run(lvl, id);
      for (let l = was + 1; l <= lvl; l++) bonusGr += levelUpReward(l).gr;
      if (bonusGr > 0) S.addProgress.run(0, bonusGr, id);
    }
    return {
      xp: u.xp,
      gr: int(u.gr) + bonusGr,
      level: lvl,
      leveledUp: lvl > was,
      levelsGained: Math.max(0, lvl - was),
      bonusGr,
    };
  },

  /**
   * Records that this account finished a match today, and returns what that is
   * worth.
   *
   * Called once per finished match; every call after the first on a given day
   * is a no-op that reports `fresh: false`, so the bonus cannot be farmed by
   * queueing repeatedly. A day skipped resets the run to one — the streak is a
   * promise about tomorrow, and it has to be losable for that to mean anything.
   *
   * @param {string} id
   * @param {number} day UTC day index
   * @returns {{streak:number, best:number, fresh:boolean, xp:number, gr:number}|null}
   */
  checkInDay(id, day) {
    const u = S.userById.get(id);
    if (!u) return null;
    const last = int(u.last_play_day) || 0;
    const held = int(u.play_streak) || 0;
    const best = int(u.best_streak_days) || 0;
    if (last === day) return { streak: held, best, fresh: false, xp: 0, gr: 0 };

    const streak = last === day - 1 ? held + 1 : 1;
    S.setStreak.run(day, streak, streak, id);
    const reward = streakReward(streak);
    return { streak, best: Math.max(best, streak), fresh: true, ...reward };
  },

  /**
   * Claims the first-win-of-the-day bonus, or reports that it is already gone.
   * @returns {{xp:number, gr:number, fresh:boolean}}
   */
  claimFirstWin(id, day) {
    const u = S.userById.get(id);
    if (!u || int(u.last_win_day) === day) return { xp: 0, gr: 0, fresh: false };
    S.setWinDay.run(day, id);
    return { ...FIRST_WIN_BONUS, fresh: true };
  },

  isBanned(u) {
    if (!u) return false;
    return u.banned_until === -1 || (u.banned_until > 0 && u.banned_until > now());
  },

  /** Everything the client needs to render a ban screen, or null when clean. */
  banInfo(u) {
    if (!users.isBanned(u)) return null;
    return {
      scope: 'account',
      reason: u.ban_reason || 'no reason given',
      until: u.banned_until,          // -1 permanent, else unix seconds
      permanent: u.banned_until === -1,
      userId: u.id,
      username: u.username,
    };
  },

  /**
   * Admin write. Only the listed columns can be set, each one validated by the
   * caller; anything else in `patch` is ignored.
   * @returns {object|null} the refreshed row
   */
  adminUpdate(id, patch) {
    // `clan` is deliberately absent: it is a cache of a clan_members row now,
    // and the only writer allowed near it is clans.syncMembers(). The admin
    // routes move an account between clans through that module instead.
    const allowed = {
      username: 'text', email: 'text', xp: 'int', level: 'int', gr: 'int',
      verified: 'int', email_verified: 'int', role: 'text',
      banned_until: 'int', ban_reason: 'text',
    };
    const sets = [];
    const args = [];
    for (const [key, kind] of Object.entries(allowed)) {
      if (!(key in patch)) continue;
      let v = patch[key];
      if (v === null) { sets.push(`${key} = NULL`); continue; }
      v = kind === 'int' ? Math.trunc(Number(v)) || 0 : String(v);
      sets.push(`${key} = ?`);
      args.push(v);
      if (key === 'username') { sets.push('username_lower = ?'); args.push(String(v).toLowerCase()); }
    }
    if (!sets.length) return S.userById.get(id);
    args.push(id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    // XP is authoritative for the level unless the level itself was set.
    const u = S.userById.get(id);
    if (u && patch.level === undefined) {
      const lvl = levelFromXp(u.xp);
      if (lvl !== u.level) S.setLevel.run(lvl, id);
    }
    return S.userById.get(id);
  },

  /** Paged listing with an optional name/clan search, for the admin panel. */
  list({ q = '', limit = 50, offset = 0, sort = 'id' } = {}) {
    const cols = {
      id: 'u.id', name: 'u.username_lower', level: 'u.level', gr: 'u.gr',
      kills: 's.kills', created: 'u.created_at', seen: 'u.last_login',
    };
    const col = cols[sort] ?? cols.id;
    const dir = sort === 'name' || sort === 'id' ? 'ASC' : 'DESC';
    const where = q ? 'WHERE u.username_lower LIKE ? OR IFNULL(u.clan, \'\') LIKE ?' : '';
    const args = q ? [`%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`] : [];
    const rows = db.prepare(`
      SELECT u.*, s.kills, s.deaths, s.headshots, s.wins, s.losses, s.matches,
             s.damage_dealt, s.best_streak, s.playtime_sec, s.score, s.shots_fired, s.shots_hit, s.assists
      FROM users u LEFT JOIN stats s ON s.user_id = u.id
      ${where}
      ORDER BY ${col} ${dir}
      LIMIT ? OFFSET ?`).all(...args, Math.min(limit, 200), offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`).get(...args).n;
    return { rows, total };
  },
};

/* ── Stats ───────────────────────────────────────────────────────────────── */

const ZERO = {
  kills: 0, deaths: 0, assists: 0, headshots: 0, shotsFired: 0, shotsHit: 0,
  damage: 0, wins: 0, losses: 0, matches: 0, bestStreak: 0, score: 0, playtime: 0,
};

export const stats = {
  get: (userId) => S.statsByUser.get(userId),

  /** Applies a delta produced by a finished match. */
  bump(userId, d) {
    const x = { ...ZERO, ...d };
    S.bumpStats.run(
      x.kills, x.deaths, x.assists, x.headshots, x.shotsFired, x.shotsHit, x.damage,
      x.wins, x.losses, x.matches, x.bestStreak, Math.round(x.score), Math.round(x.playtime), now(), userId,
    );
  },

  /** Absolute set, used by the admin panel. */
  set(userId, patch) {
    const allowed = ['kills', 'deaths', 'assists', 'headshots', 'shots_fired', 'shots_hit',
      'damage_dealt', 'wins', 'losses', 'matches', 'best_streak', 'score', 'playtime_sec'];
    const sets = [], args = [];
    for (const key of allowed) {
      if (!(key in patch)) continue;
      sets.push(`${key} = ?`);
      args.push(Math.max(0, Math.trunc(Number(patch[key])) || 0));
    }
    if (!sets.length) return S.statsByUser.get(userId);
    S.insertStats.run(userId, now());
    args.push(now(), userId);
    db.prepare(`UPDATE stats SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`).run(...args);
    return S.statsByUser.get(userId);
  },

  /** Leaderboard rows, sorted by one of a fixed set of columns. */
  leaderboard({ sort = 'kills', limit = 50, offset = 0 } = {}) {
    const cols = {
      kills: 's.kills', level: 'u.level', xp: 'u.xp', wins: 's.wins', score: 's.score',
      kd: 'CAST(s.kills AS REAL) / MAX(s.deaths, 1)', headshots: 's.headshots',
      damage: 's.damage_dealt', gr: 'u.gr',
    };
    const col = cols[sort] ?? cols.kills;
    const rows = db.prepare(`
      SELECT u.id, u.username, u.level, u.xp, u.gr, u.verified, u.clan, u.clan_verified, u.avatar, u.created_at,
             s.kills, s.deaths, s.assists, s.headshots, s.wins, s.losses, s.matches,
             s.damage_dealt, s.best_streak, s.playtime_sec, s.shots_fired, s.shots_hit, s.score
      FROM users u JOIN stats s ON s.user_id = u.id
      WHERE u.banned_until = 0
      ORDER BY ${col} DESC, s.kills DESC
      LIMIT ? OFFSET ?`).all(Math.min(limit, 200), offset);
    return rows.map((r, i) => ({ rank: offset + i + 1, ...r }));
  },
};

/* ── Loadouts ────────────────────────────────────────────────────────────── */

export const loadouts = {
  get(userId) {
    let row = S.loadoutByUser.get(userId);
    if (!row) { S.insertLoadout.run(userId, now()); row = S.loadoutByUser.get(userId); }
    return row;
  },
  save(userId, { classId, skins, owned, settings, keybinds }) {
    S.saveLoadout.run(
      classId, JSON.stringify(skins ?? {}), JSON.stringify(owned ?? []),
      JSON.stringify(settings ?? {}), JSON.stringify(keybinds ?? {}), now(), userId,
    );
  },
};

/* ── Sessions ────────────────────────────────────────────────────────────── */

export const sessions = {
  create({ tokenHash, userId, ip, userAgent, ttlDays = config.sessionTtlDays }) {
    const ts = now();
    S.insertSession.run(tokenHash, userId, ts, ts + ttlDays * 86400, ip ?? null, (userAgent ?? '').slice(0, 200));
  },
  get: (tokenHash) => S.sessionByHash.get(tokenHash, now()),
  destroy: (tokenHash) => S.deleteSession.run(tokenHash),
  destroyAllFor: (userId) => S.deleteUserSessions.run(userId),
  prune: () => int(S.pruneSessions.run(now()).changes),
  countFor: (userId) => db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?')
    .get(userId, now()).n,
};

/* ── Matches ─────────────────────────────────────────────────────────────── */

export const matches = {
  start: (room, mode, map) => {
    const id = newId();
    S.insertMatch.run(id, room, mode, map, now());
    return id;
  },
  finish: (id, winner) => S.endMatch.run(now(), winner ?? null, id),
  addPlayer: (matchId, p) =>
    S.insertMatchPlayer.run(newId(), matchId, p.userId ?? null, p.name, p.team | 0, p.classId ?? null,
      p.kills | 0, p.deaths | 0, p.score | 0, p.gr | 0, p.won ? 1 : 0),
  recentFor: (userId, limit = 20) => db.prepare(`
      SELECT m.id, m.mode, m.map, m.started_at, m.ended_at, m.winner,
             mp.kills, mp.deaths, mp.score, mp.gr, mp.team, mp.class_id, mp.won
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id = ? ORDER BY m.started_at DESC LIMIT ?`).all(userId, Math.min(limit, 100)),
};

/* ── Weapon mastery ──────────────────────────────────────────────────────── */

export const mastery = {
  /** @param {Map<string,number>|object} kills weaponId -> kills this match */
  bump(userId, kills, headshots = {}) {
    const ts = now();
    const entries = kills instanceof Map ? [...kills.entries()] : Object.entries(kills ?? {});
    for (const [weaponId, n] of entries) {
      if (!n) continue;
      S.bumpMastery.run(userId, String(weaponId).slice(0, 24), n | 0, (headshots[weaponId] ?? 0) | 0, ts);
    }
  },
  /** @returns {Record<string, {kills:number, headshots:number}>} */
  forUser(userId) {
    const out = {};
    for (const r of S.masteryFor.all(userId)) {
      out[r.weapon_id] = { kills: int(r.kills), headshots: int(r.headshots) };
    }
    return out;
  },
};

/* ── Daily challenges ────────────────────────────────────────────────────── */

export const challenges = {
  /** @param {Record<string, number>} deltas challengeId -> progress to add */
  bump(userId, day, deltas) {
    for (const [id, n] of Object.entries(deltas ?? {})) {
      if (!n) continue;
      S.bumpChallenge.run(userId, day, String(id).slice(0, 32), Math.max(0, n | 0));
    }
  },
  forUser: (userId, day) => S.challengesFor.all(userId, day)
    .map((r) => ({ id: r.challenge_id, progress: int(r.progress), claimed: !!r.claimed })),
  /** @returns {boolean} true when this call was the one that claimed it */
  claim: (userId, day, id) => int(S.claimChallenge.run(userId, day, id).changes) > 0,
  prune: (beforeDay) => int(S.pruneChallenges.run(beforeDay).changes),
};

/* ── IP bans ─────────────────────────────────────────────────────────────── */

/**
 * Node reports IPv4 sockets as `::ffff:1.2.3.4`. Every ban is stored and looked
 * up in the bare form so the two spellings can never disagree.
 */
export const normaliseIp = (ip) => String(ip ?? '').trim().replace(/^::ffff:/i, '').toLowerCase();

export const ipBans = {
  /** @param {{ip:string, reason?:string, days?:number, userId?:number, username?:string}} o */
  add({ ip, reason = null, days = 0, userId = null, username = null }) {
    const addr = normaliseIp(ip);
    if (!addr) return null;
    const until = Number.isFinite(days) && days > 0 ? now() + Math.round(days * 86400) : -1;
    S.insertIpBan.run(addr, reason ? String(reason).slice(0, 200) : null, until, now(),
      userId ?? null, username ? String(username).slice(0, 32) : null);
    return S.ipBanByIp.get(addr);
  },

  remove(ip) { return int(S.deleteIpBan.run(normaliseIp(ip)).changes); },

  get(ip) { return S.ipBanByIp.get(normaliseIp(ip)) ?? null; },

  /** The live ban on an address, or null. Expired rows are cleaned up in passing. */
  active(ip) {
    const row = S.ipBanByIp.get(normaliseIp(ip));
    if (!row) return null;
    if (row.until > 0 && row.until <= now()) { S.deleteIpBan.run(row.ip); return null; }
    return row;
  },

  forUser: (userId) => S.ipBansForUser.all(userId),
  list: (limit = 100) => S.listIpBans.all(Math.min(limit, 500)),
  prune: () => int(S.pruneIpBans.run(now()).changes),
};

/* ── Chat bans (mutes) ───────────────────────────────────────────────────── */

/**
 * A mute is an account-only measure. Guests cannot write into a chat at all
 * (see CHAT_MIN_LEVEL), so there is nothing to key an address mute on.
 */
export const chatBans = {
  /**
   * Mutes an account. `minutes <= 0` (or missing) is permanent.
   * @param {{userId:number, reason?:string, minutes?:number, actor?:string, username?:string}} o
   */
  add({ userId, reason = null, minutes = 0, actor = null, username = null }) {
    if (!userId) return null;
    const until = Number.isFinite(minutes) && minutes > 0 ? now() + Math.round(minutes * 60) : -1;
    return chatBans.set({ userId, until, reason, actor, username });
  },

  /** Writes an exact expiry — what the in-game moderation menu has already computed. */
  set({ userId, until = -1, reason = null, actor = null, username = null }) {
    if (!userId) return null;
    if (until === 0) { chatBans.remove(userId); return null; }
    S.insertChatBan.run(userId, until, reason ? String(reason).slice(0, 200) : null, now(),
      actor ? String(actor).slice(0, 64) : null, username ? String(username).slice(0, 32) : null);
    return S.chatBanByUser.get(userId);
  },

  remove(userId) { return int(S.deleteChatBan.run(userId).changes); },

  get(userId) { return S.chatBanByUser.get(userId) ?? null; },

  /** The live mute on an account, or null. Expired rows are cleaned up in passing. */
  active(userId) {
    if (!userId) return null;
    const row = S.chatBanByUser.get(userId);
    if (!row) return null;
    if (row.until > 0 && row.until <= now()) { S.deleteChatBan.run(userId); return null; }
    return row;
  },

  list: (limit = 100) => S.listChatBans.all(Math.min(limit, 500)),
  prune: () => int(S.pruneChatBans.run(now()).changes),
};

/* ── Report bans ─────────────────────────────────────────────────────────── */

/**
 * The mirror of a mute, for the REPORT button.
 *
 * Everything in util/reports.js is a ceiling that clears itself, because the
 * ordinary failure mode is someone reporting too eagerly rather than someone
 * acting in bad faith. This is the other case: a moderator deciding one account
 * may not file at all. Like a mute it is account-only — a guest cannot report
 * in the first place — and like a mute it can expire on its own.
 */
export const reportBans = {
  /** `minutes <= 0` (or missing) is permanent. */
  add({ userId, reason = null, minutes = 0, actor = null, username = null }) {
    if (!userId) return null;
    const until = Number.isFinite(minutes) && minutes > 0 ? now() + Math.round(minutes * 60) : -1;
    return reportBans.set({ userId, until, reason, actor, username });
  },

  set({ userId, until = -1, reason = null, actor = null, username = null }) {
    if (!userId) return null;
    if (until === 0) { reportBans.remove(userId); return null; }
    S.insertReportBan.run(userId, until, reason ? String(reason).slice(0, 200) : null, now(),
      actor ? String(actor).slice(0, 64) : null, username ? String(username).slice(0, 32) : null);
    return S.reportBanByUser.get(userId);
  },

  remove(userId) { return int(S.deleteReportBan.run(userId).changes); },

  get(userId) { return S.reportBanByUser.get(userId) ?? null; },

  /** The live block on an account, or null. Expired rows are cleaned up in passing. */
  active(userId) {
    if (!userId) return null;
    const row = S.reportBanByUser.get(userId);
    if (!row) return null;
    if (row.until > 0 && row.until <= now()) { S.deleteReportBan.run(userId); return null; }
    return row;
  },

  list: (limit = 100) => S.listReportBans.all(Math.min(limit, 500)),
  prune: () => int(S.pruneReportBans.run(now()).changes),
};

/* ── Email verification tokens ───────────────────────────────────────────── */

/**
 * Like a session token: the browser holds the secret, the database holds only
 * a hash of it. A token is single-use — `consume` is the write that both proves
 * it was unused and marks it spent, so a link cannot be replayed.
 */
export const emailTokens = {
  create({ tokenHash, userId, email, ttlHours = 48, ip = null }) {
    const ts = now();
    S.clearEmailTokens.run(userId);            // one live link per account
    S.insertEmailToken.run(tokenHash, userId, String(email).slice(0, 190), ts,
      ts + Math.round(ttlHours * 3600), ip ?? null);
    return S.emailTokenByHash.get(tokenHash);
  },

  get: (tokenHash) => S.emailTokenByHash.get(tokenHash) ?? null,

  /** @returns {object|null} the row when this call spent it, else null */
  consume(tokenHash) {
    const row = S.emailTokenByHash.get(tokenHash);
    if (!row || row.used_at !== 0 || row.expires_at <= now()) return null;
    return int(S.useEmailToken.run(now(), tokenHash).changes) > 0 ? row : null;
  },

  /** The most recent link sent to an account, for the resend cooldown. */
  latestFor: (userId) => S.latestEmailToken.get(userId) ?? null,
  clearFor: (userId) => int(S.clearEmailTokens.run(userId).changes),
  prune: () => int(S.pruneEmailTokens.run(now()).changes),
};

/* ── Address intelligence cache ──────────────────────────────────────────── */

/**
 * What a proxy/VPN lookup said about an address, kept so the same player
 * reconnecting between matches does not cost a lookup every time.
 */
export const ipIntel = {
  /** @param {{ip:string, proxy?:boolean, hosting?:boolean, tor?:boolean,
   *            country?:string, asn?:string, provider?:string, detail?:string}} o */
  put(o) {
    const addr = normaliseIp(o.ip);
    if (!addr) return null;
    S.putIpIntel.run(addr, o.proxy ? 1 : 0, o.hosting ? 1 : 0, o.tor ? 1 : 0,
      o.country ?? null, o.asn ? String(o.asn).slice(0, 120) : null,
      o.provider ?? null, o.detail ? String(o.detail).slice(0, 60) : null, now());
    return S.ipIntelByIp.get(addr);
  },

  /** A cached verdict that is still inside `maxAgeSec`, or null. */
  get(ip, maxAgeSec = Infinity) {
    const row = S.ipIntelByIp.get(normaliseIp(ip));
    if (!row) return null;
    if (Number.isFinite(maxAgeSec) && row.checked_at + maxAgeSec <= now()) return null;
    return row;
  },

  recent: (limit = 100) => S.recentIpIntel.all(Math.min(limit, 500)),
  prune: (maxAgeSec) => int(S.pruneIpIntel.run(now() - Math.max(0, maxAgeSec)).changes),
};

/* ── Player reports ──────────────────────────────────────────────────────── */

/** How a stored row reads once it leaves the database. */
const reportRow = (r) => (r ? {
  id: r.id,
  reporterId: r.reporter_id ?? null,
  reporterName: r.reporter_name,
  targetId: r.target_id ?? null,
  targetName: r.target_name,
  targetIp: r.target_ip ?? null,
  reason: r.reason,
  detail: r.detail ?? null,
  room: r.room ?? null,
  mode: r.mode ?? null,
  map: r.map ?? null,
  chatLog: (() => { try { return JSON.parse(r.chat_log ?? '[]'); } catch { return []; } })(),
  createdAt: int(r.created_at),
  status: r.status,
  action: r.action ?? null,
  outcome: r.outcome ?? null,
  resolver: r.resolver ?? null,
  resolvedAt: r.resolved_at ?? null,
} : null);

export const reports = {
  /**
   * Files one report. Everything is clipped here rather than at the caller, so
   * a route, the realtime handler and a test all get the same ceilings.
   * @param {object} o { reporterId, reporterName, targetId, targetName, targetIp,
   *                     reason, detail, room, mode, map, chatLog }
   */
  add(o) {
    const id = newId();
    S.insertReport.run(
      id,
      o.reporterId ?? null,
      String(o.reporterName ?? 'unknown').slice(0, 32),
      o.targetId ?? null,
      String(o.targetName ?? 'unknown').slice(0, 32),
      o.targetIp ? normaliseIp(o.targetIp) : null,
      String(o.reason ?? 'other').slice(0, 24),
      o.detail ? String(o.detail).slice(0, 400) : null,
      o.room ? String(o.room).slice(0, 40) : null,
      o.mode ? String(o.mode).slice(0, 24) : null,
      o.map ? String(o.map).slice(0, 40) : null,
      // A snapshot of what was said, so a chat-abuse report can still be judged
      // once the match it happened in is over and its own log has been dropped.
      o.chatLog?.length ? JSON.stringify(o.chatLog).slice(0, 8000) : null,
      now(),
    );
    return reportRow(S.reportById.get(id));
  },

  get: (id) => reportRow(S.reportById.get(id)),

  /** This account's own reports, newest first — what the reporter reads back. */
  forReporter: (userId, limit = 50) =>
    S.reportsByReporter.all(userId, Math.min(limit, 200)).map(reportRow),

  /** Every report filed against a player, by account or by the name they wore. */
  against: (userId, name, limit = 50) =>
    S.reportsAgainst.all(userId ?? -1, String(name ?? '').toLowerCase(), Math.min(limit, 200))
      .map(reportRow),

  /** How many this account has filed since `sinceTs` — the hourly/daily ceiling. */
  countSince: (userId, sinceTs) => int(S.countReportsSince.get(userId, sinceTs).n),

  /** How many of this account's reports a moderator has still not settled. */
  countOpenFor: (userId) => int(S.countOpenReportsBy.get(userId).n),

  /** The most recent report this account filed, for the flat cooldown. */
  lastBy: (userId) => reportRow(S.lastReportBy.get(userId)),

  /**
   * How often this account's reports have been thrown out lately, and when the
   * last one was — the two numbers the "crying wolf" lockout is built from.
   * @returns {{count:number, lastAt:number}}
   */
  dismissedSince(userId, sinceTs) {
    const count = int(S.countDismissedSince.get(userId, sinceTs).n);
    const last = count ? S.lastDismissedFor.get(userId, sinceTs) : null;
    return { count, lastAt: last ? int(last.resolved_at) : 0 };
  },

  /** The last report this account filed against that name, for the repeat gap. */
  lastOn: (userId, name) =>
    reportRow(S.lastReportOn.get(userId, String(name ?? '').toLowerCase())),

  /**
   * Paged listing for the admin panel. `status` filters, `q` searches either
   * side of the report plus the reporter's own words.
   */
  list({ status = '', q = '', limit = 50, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (REPORT_STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
    if (q) {
      const like = `%${String(q).toLowerCase()}%`;
      where.push('(LOWER(target_name) LIKE ? OR LOWER(reporter_name) LIKE ? OR LOWER(IFNULL(detail, \'\')) LIKE ?)');
      args.push(like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM reports ${clause} ORDER BY
         CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC
       LIMIT ? OFFSET ?`).all(...args, Math.min(limit, 200), Math.max(0, offset));
    const total = db.prepare(`SELECT COUNT(*) AS n FROM reports ${clause}`).get(...args).n;
    return { rows: rows.map(reportRow), total, open: reports.countOpen() };
  },

  /**
   * Closes a report. `status` is 'actioned' or 'rejected'; `outcome` is the one
   * line the reporter will read, which is the whole reason a report is worth
   * filing at all.
   */
  resolve(id, { status = 'actioned', action = null, outcome = null, resolver = null } = {}) {
    const state = REPORT_STATUSES.includes(status) && status !== 'open' ? status : 'actioned';
    S.resolveReport.run(state, action ? String(action).slice(0, 24) : null,
      outcome ? String(outcome).slice(0, 400) : null,
      resolver ? String(resolver).slice(0, 64) : null, now(), id);
    return reportRow(S.reportById.get(id));
  },

  /** Puts a closed report back in the queue — a verdict a moderator wants back. */
  reopen(id) {
    S.reopenReport.run(id);
    return reportRow(S.reportById.get(id));
  },

  remove: (id) => int(S.deleteReport.run(id).changes),
  countOpen: () => int(S.countOpenReports.get().n),
  count: () => int(S.countReports.get().n),
  /** Drops settled reports older than `maxAgeSec`. Open ones are never pruned. */
  prune: (maxAgeSec) => int(S.pruneReports.run(now() - Math.max(0, maxAgeSec)).changes),
};

/* ── Clans ───────────────────────────────────────────────────────────────── */

/**
 * How a stored clan reads once it leaves the database. `members` is filled in
 * by the caller that asked for it; the count is always cheap enough to include.
 */
const clanRow = (c) => (c ? {
  id: c.id,
  tag: c.tag,
  ownerId: c.owner_id ?? null,
  avatar: c.avatar ?? null,
  avatarAt: c.avatar_at ?? null,
  verified: !!c.verified,
  createdAt: int(c.created_at),
  createdBy: c.created_by ?? null,
  members: int(S.countMembers.get(c.id).n),
} : null);

export const clans = {
  byId: (id) => clanRow(S.clanById.get(id)),
  byTag: (tag) => clanRow(S.clanByTag.get(String(tag ?? '').toLowerCase())),
  /** The clan this account belongs to, or null. */
  forUser: (userId) => (userId ? clanRow(S.clanByMember.get(userId)) : null),

  /**
   * Rewrites the denormalised tag on every member of a clan.
   *
   * `users.clan` / `users.clan_verified` are read by the leaderboard, the join
   * handshake and every nametag, none of which can afford a join. This is the
   * only function allowed to write them, so "the cache is stale" is a bug with
   * exactly one place to look.
   */
  syncMembers(clanId) {
    const c = S.clanById.get(clanId);
    if (!c) { S.clearClanTags.run(clanId); return 0; }
    return int(S.syncMemberTags.run(c.tag, c.id, c.verified ? 1 : 0, c.id).changes);
  },

  /**
   * Founds a clan and seats its owner, in one transaction.
   *
   * The unique index on `tag_lower` — not a prior SELECT — is what settles a
   * race between two people founding the same tag in the same second, so the
   * caller is expected to catch the constraint error and refund the fee.
   * @returns {object} the new clan
   */
  create({ tag, ownerId, ownerName = null }) {
    const ts = now();
    const id = newId();
    db.exec('BEGIN');
    try {
      S.insertClan.run(id, tag, String(tag).toLowerCase(), ownerId, ts,
        ownerName ? String(ownerName).slice(0, 32) : null);
      S.insertMember.run(id, ownerId, 'owner', ts);
      S.deleteUserInvites.run(ownerId);          // founding settles every invite
      db.exec('COMMIT');
      clans.syncMembers(id);
      return clanRow(S.clanById.get(id));
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },

  /** Everyone in a clan, owner first, with the stats a roster wants to show. */
  members: (clanId) => S.membersOf.all(clanId).map((m) => ({
    id: m.id,
    username: m.username,
    level: int(m.level),
    xp: int(m.xp),
    verified: !!m.verified,
    avatar: m.avatar ?? null,
    role: m.role,
    joinedAt: int(m.joined_at),
    lastLogin: m.last_login ?? null,
    kills: int(m.kills ?? 0),
    deaths: int(m.deaths ?? 0),
    score: int(m.score ?? 0),
  })),

  memberCount: (clanId) => int(S.countMembers.get(clanId).n),
  /** This account's membership row, or null. */
  membership: (userId) => S.memberOf.get(userId) ?? null,
  isOwner: (clanId, userId) => S.memberIn.get(clanId, userId)?.role === 'owner',

  /** Seats an account. The unique index on user_id enforces one clan per player. */
  addMember(clanId, userId, role = 'member') {
    S.insertMember.run(clanId, userId, CLAN_ROLES.includes(role) ? role : 'member', now());
    S.deleteUserInvites.run(userId);             // joining settles every other invite
    clans.syncMembers(clanId);
    return clans.members(clanId);
  },

  /** Removes an account — leaving, or being removed. @returns {boolean} */
  removeMember(clanId, userId) {
    const gone = int(S.deleteMember.run(clanId, userId).changes) > 0;
    if (gone) S.clearMemberTag.run(userId);
    return gone;
  },

  /**
   * Puts a clan back in somebody's hands when its owner's account is gone.
   *
   * Deleting an account cascades its membership row away and leaves `owner_id`
   * null, which would strand every remaining member: nobody could invite,
   * remove, hand over or disband. The longest-serving member inherits it, and a
   * clan with nobody left in it is disbanded rather than kept as an empty tag
   * nobody can ever claim again.
   *
   * @returns {{disbanded: boolean, owner: object|null}}
   */
  reseat(clanId) {
    const row = S.clanById.get(clanId);
    if (!row) return { disbanded: false, owner: null };
    const members = clans.members(clanId);
    if (!members.length) {
      clans.disband(clanId);
      return { disbanded: true, owner: null };
    }
    if (members.some((m) => m.role === 'owner')) return { disbanded: false, owner: null };
    const heir = [...members].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    S.setMemberRole.run('owner', clanId, heir.id);
    S.setClanOwner.run(heir.id, clanId);
    return { disbanded: false, owner: heir };
  },

  /** Hands the clan to another member; the old owner stays on as a member. */
  transfer(clanId, fromUserId, toUserId) {
    db.exec('BEGIN');
    try {
      S.setMemberRole.run('member', clanId, fromUserId);
      S.setMemberRole.run('owner', clanId, toUserId);
      S.setClanOwner.run(toUserId, clanId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return clanRow(S.clanById.get(clanId));
  },

  setAvatar(clanId, file) {
    S.setClanAvatar.run(file ?? null, file ? now() : null, clanId);
    return clanRow(S.clanById.get(clanId));
  },

  /** The developers' stamp. Verified clans wear a gold tag; that is all it does. */
  setVerified(clanId, on) {
    S.setClanVerified.run(on ? 1 : 0, clanId);
    clans.syncMembers(clanId);
    return clanRow(S.clanById.get(clanId));
  },

  /** Disbands. Every member loses the tag; the rows go with the clan. */
  disband(clanId) {
    S.clearClanTags.run(clanId);
    return int(S.deleteClan.run(clanId).changes) > 0;
  },

  /* ── Invitations ───────────────────────────────────────────────────────── */

  invite({ clanId, userId, by = null, ttlHours = 72 }) {
    const ts = now();
    S.insertInvite.run(clanId, userId, by ? String(by).slice(0, 32) : null,
      ts, ts + Math.round(ttlHours * 3600));
    return S.inviteFor.get(clanId, userId, ts - 1) ?? null;
  },

  /** A live invitation, or null when there is none (or it has lapsed). */
  inviteFor: (clanId, userId) => S.inviteFor.get(clanId, userId, now()) ?? null,
  cancelInvite: (clanId, userId) => int(S.deleteInvite.run(clanId, userId).changes) > 0,

  /** Every clan currently asking for this account. */
  invitesForUser: (userId) => S.invitesForUser.all(userId, now()).map((i) => ({
    clanId: int(i.clan_id),
    tag: i.tag,
    verified: !!i.verified,
    avatar: i.avatar ?? null,
    invitedBy: i.invited_by ?? null,
    createdAt: int(i.created_at),
    expiresAt: int(i.expires_at),
  })),

  /** Everyone a clan is currently waiting on. */
  invitesForClan: (clanId) => S.invitesForClan.all(clanId, now()).map((i) => ({
    userId: int(i.user_id),
    username: i.username,
    level: int(i.level),
    invitedBy: i.invited_by ?? null,
    createdAt: int(i.created_at),
    expiresAt: int(i.expires_at),
  })),

  countInvites: (clanId) => int(S.countInvites.get(clanId, now()).n),
  pruneInvites: () => int(S.pruneInvites.run(now()).changes),

  /**
   * Paged listing, ranked by the members' combined match score.
   *
   * A clan's standing is its members' — there is nothing else to rank one on —
   * so the board is a plain aggregate rather than a number kept on the row,
   * which would only ever be a second copy that could go wrong.
   */
  list({ q = '', limit = 50, offset = 0 } = {}) {
    const where = q ? 'WHERE c.tag_lower LIKE ?' : '';
    const args = q ? [`%${String(q).toLowerCase()}%`] : [];
    const rows = db.prepare(`
      SELECT c.*, o.username AS owner_name,
             COUNT(m.user_id) AS member_count,
             IFNULL(SUM(s.score), 0) AS score,
             IFNULL(SUM(s.kills), 0) AS kills
      FROM clans c
      LEFT JOIN users o ON o.id = c.owner_id
      LEFT JOIN clan_members m ON m.clan_id = c.id
      LEFT JOIN stats s ON s.user_id = m.user_id
      ${where}
      GROUP BY c.id
      ORDER BY c.verified DESC, score DESC, member_count DESC, c.created_at
      LIMIT ? OFFSET ?`).all(...args, Math.min(limit, 200), Math.max(0, offset));
    const total = db.prepare(`SELECT COUNT(*) AS n FROM clans c ${where}`).get(...args).n;
    return {
      total,
      rows: rows.map((r, i) => ({
        ...clanRow(r),
        rank: offset + i + 1,
        members: int(r.member_count),
        ownerName: r.owner_name ?? r.created_by ?? null,
        score: int(r.score),
        kills: int(r.kills),
      })),
    };
  },
};

/* ── Admin audit trail ───────────────────────────────────────────────────── */

export const audit = {
  add: (actor, action, target, detail) =>
    S.insertAdminLog.run(now(), String(actor).slice(0, 64), String(action).slice(0, 64),
      target === null || target === undefined ? null : String(target).slice(0, 120),
      detail === null || detail === undefined ? null : String(detail).slice(0, 2000)),
  recent: (limit = 200) => S.recentAdminLog.all(Math.min(limit, 1000)),
};

/* ── Telemetry ───────────────────────────────────────────────────────────── */

/**
 * How long samples and events are kept.
 *
 * A graph nobody will ever scroll back to is a table nobody should be paying
 * for. Ninety days of five-minute samples is about 26 000 rows a series, which
 * is a couple of megabytes for the whole panel and answers every question the
 * STATS tab actually asks.
 */
export const METRICS_KEEP_DAYS = 90;
export const EVENTS_KEEP_DAYS = 90;

const M = {
  put: db.prepare('INSERT INTO metrics (at, name, value) VALUES (?,?,?) '
    + 'ON CONFLICT(at, name) DO UPDATE SET value = excluded.value'),
  pruneMetrics: db.prepare('DELETE FROM metrics WHERE at < ?'),
  addEvent: db.prepare(
    'INSERT INTO events (at, kind, user_id, name, room, map, mode, value, detail) VALUES (?,?,?,?,?,?,?,?,?)'),
  pruneEvents: db.prepare('DELETE FROM events WHERE at < ?'),
};

const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

/**
 * Regular samples of what is true right now.
 *
 * Written by one timer in the server process, never by gameplay: a match that
 * is going badly must never also be the thing making the database slow.
 */
export const metrics = {
  /**
   * Writes one bucket's worth of series in a single transaction.
   * @param {number} at bucket start, unix seconds
   * @param {Record<string, number>} values
   */
  write(at, values) {
    const rows = Object.entries(values).filter(([, v]) => Number.isFinite(v));
    if (!rows.length) return 0;
    db.exec('BEGIN');
    try {
      for (const [name, value] of rows) M.put.run(at, String(name).slice(0, 48), Number(value));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  },

  /**
   * One series, oldest first, downsampled into `bucketSec` buckets.
   *
   * The bucket is what keeps a chart honest at every range: a day of
   * five-minute samples is 288 points and draws beautifully, a quarter of them
   * is 26 000 and draws as a smear. `agg` picks how a bucket collapses — an
   * average for a gauge (players online), a sum for a counter (kills).
   */
  series(name, { since, until = now(), bucketSec = 300, agg = 'avg' } = {}) {
    const fn = agg === 'sum' ? 'SUM' : agg === 'max' ? 'MAX' : 'AVG';
    const b = Math.max(60, Math.floor(bucketSec));
    // The cast is not decoration: node:sqlite binds every JavaScript number as
    // REAL, so `at / ?` is *float* division and every sample lands in a bucket
    // of its own — a "downsampled" series with one point per raw sample.
    return db.prepare(`
      SELECT CAST(at / ? AS INTEGER) * ? AS t, ${fn}(value) AS v
      FROM metrics WHERE name = ? AND at >= ? AND at <= ?
      GROUP BY CAST(at / ? AS INTEGER) ORDER BY t`).all(b, b, name, since, until, b)
      .map((r) => [int(r.t), Math.round(Number(r.v) * 1000) / 1000]);
  },

  /** Every series name that has a sample in the window — what the panel can draw. */
  names(since = 0) {
    return db.prepare('SELECT DISTINCT name FROM metrics WHERE at >= ? ORDER BY name').all(since)
      .map((r) => r.name);
  },

  /** The newest value of one series, or null when it has never been written. */
  latest(name) {
    const row = db.prepare('SELECT at, value FROM metrics WHERE name = ? ORDER BY at DESC LIMIT 1').get(name);
    return row ? { at: int(row.at), value: Number(row.value) } : null;
  },

  prune: (olderThanSec = METRICS_KEEP_DAYS * 86400) => int(M.pruneMetrics.run(now() - olderThanSec).changes),
};

/**
 * Things that happened once.
 *
 * Deliberately schema-light: `kind` is the only field every row has to mean
 * something by, and the rest are there so a chart can group without a join.
 * Nothing at kill rate belongs here — see the note on the table itself.
 */
export const events = {
  add({ kind, userId = null, name = null, room = null, map = null, mode = null, value = null, detail = null, at = now() }) {
    M.addEvent.run(
      at, String(kind).slice(0, 40), userId ?? null, clip(name, 64), clip(room, 32),
      clip(map, 32), clip(mode, 16),
      value === null || value === undefined ? null : Number(value),
      detail && typeof detail === 'object' ? JSON.stringify(detail).slice(0, 1000) : clip(detail, 1000),
    );
  },

  /** Newest first, optionally filtered by kind (or a comma list of them). */
  recent({ limit = 100, kind = null, userId = null, since = 0 } = {}) {
    const where = ['at >= ?'];
    const args = [since];
    if (kind) {
      const kinds = String(kind).split(',').map((k) => k.trim()).filter(Boolean);
      if (kinds.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
    }
    if (userId) { where.push('user_id = ?'); args.push(userId); }
    return db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(limit, 500))
      .map((r) => ({ ...r, id: int(r.id), at: int(r.at) }));
  },

  /** How many of each kind, in the window. The STATS tab's activity mix. */
  countByKind({ since = 0, until = now() } = {}) {
    return db.prepare('SELECT kind, COUNT(*) AS n FROM events WHERE at >= ? AND at <= ? GROUP BY kind ORDER BY n DESC')
      .all(since, until).map((r) => ({ kind: r.kind, n: int(r.n) }));
  },

  /** One kind as a time series of counts — the shape a bar chart wants. */
  countSeries(kind, { since, until = now(), bucketSec = 3600 } = {}) {
    const b = Math.max(60, Math.floor(bucketSec));
    const kinds = String(kind).split(',').map((k) => k.trim()).filter(Boolean);
    if (!kinds.length) return [];
    return db.prepare(`
      SELECT CAST(at / ? AS INTEGER) * ? AS t, COUNT(*) AS n
      FROM events WHERE kind IN (${kinds.map(() => '?').join(',')}) AND at >= ? AND at <= ?
      GROUP BY CAST(at / ? AS INTEGER) ORDER BY t`).all(b, b, ...kinds, since, until, b)
      .map((r) => [int(r.t), int(r.n)]);
  },

  prune: (olderThanSec = EVENTS_KEEP_DAYS * 86400) => int(M.pruneEvents.run(now() - olderThanSec).changes),
};

/**
 * The questions the STATS tab asks of the tables that were already there.
 *
 * None of this is sampled or logged: matches, accounts and stats rows have
 * always held the answers, and the only thing missing was somebody asking. Kept
 * next to the telemetry because the panel reads them side by side.
 */
export const analytics = {
  /** New accounts per bucket, and how many of them ever finished a match. */
  signups({ since, until = now(), bucketSec = 86400 } = {}) {
    const b = Math.max(3600, Math.floor(bucketSec));
    return db.prepare(`
      SELECT CAST(created_at / ? AS INTEGER) * ? AS t, COUNT(*) AS n
      FROM users WHERE created_at >= ? AND created_at <= ?
      GROUP BY CAST(created_at / ? AS INTEGER) ORDER BY t`).all(b, b, since, until, b)
      .map((r) => [int(r.t), int(r.n)]);
  },

  /** Matches finished per bucket. */
  matchesPlayed({ since, until = now(), bucketSec = 3600 } = {}) {
    const b = Math.max(60, Math.floor(bucketSec));
    return db.prepare(`
      SELECT CAST(started_at / ? AS INTEGER) * ? AS t, COUNT(*) AS n
      FROM matches WHERE started_at >= ? AND started_at <= ?
      GROUP BY CAST(started_at / ? AS INTEGER) ORDER BY t`).all(b, b, since, until, b)
      .map((r) => [int(r.t), int(r.n)]);
  },

  /** Which maps and modes actually get played, newest window first. */
  mapMix({ since = 0, until = now() } = {}) {
    return db.prepare(`
      SELECT map, COUNT(*) AS n FROM matches
      WHERE started_at >= ? AND started_at <= ? GROUP BY map ORDER BY n DESC`)
      .all(since, until).map((r) => ({ key: r.map, n: int(r.n) }));
  },
  modeMix({ since = 0, until = now() } = {}) {
    return db.prepare(`
      SELECT mode, COUNT(*) AS n FROM matches
      WHERE started_at >= ? AND started_at <= ? GROUP BY mode ORDER BY n DESC`)
      .all(since, until).map((r) => ({ key: r.mode, n: int(r.n) }));
  },

  /**
   * Which classes people actually pick, weighted by how they did with them.
   * Pick rate answers "what is popular"; win rate answers "and is it fair".
   */
  classMix({ since = 0, until = now(), limit = 12 } = {}) {
    return db.prepare(`
      SELECT mp.class_id AS key, COUNT(*) AS n,
             SUM(mp.won) AS wins, SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE m.started_at >= ? AND m.started_at <= ? AND mp.class_id IS NOT NULL
      GROUP BY mp.class_id ORDER BY n DESC LIMIT ?`)
      .all(since, until, limit)
      .map((r) => ({
        key: r.key, n: int(r.n), wins: int(r.wins ?? 0),
        kills: int(r.kills ?? 0), deaths: int(r.deaths ?? 0),
        winRate: int(r.n) ? Math.round((int(r.wins ?? 0) / int(r.n)) * 1000) / 10 : 0,
        kd: int(r.deaths ?? 0) ? Math.round((int(r.kills ?? 0) / int(r.deaths)) * 100) / 100 : int(r.kills ?? 0),
      }));
  },

  /** Distinct accounts that finished a match in each bucket — DAU, honestly counted. */
  activePlayers({ since, until = now(), bucketSec = 86400 } = {}) {
    const b = Math.max(3600, Math.floor(bucketSec));
    return db.prepare(`
      SELECT CAST(m.started_at / ? AS INTEGER) * ? AS t, COUNT(DISTINCT mp.user_id) AS n
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id IS NOT NULL AND m.started_at >= ? AND m.started_at <= ?
      GROUP BY CAST(m.started_at / ? AS INTEGER) ORDER BY t`).all(b, b, since, until, b)
      .map((r) => [int(r.t), int(r.n)]);
  },

  /** How the population is spread across the ladder — the level curve, observed. */
  levelHistogram({ bucket = 5 } = {}) {
    const b = Math.max(1, Math.floor(bucket));
    return db.prepare('SELECT CAST(level / ? AS INTEGER) * ? AS band, COUNT(*) AS n '
      + 'FROM users GROUP BY CAST(level / ? AS INTEGER) ORDER BY band')
      .all(b, b, b).map((r) => ({ band: int(r.band), n: int(r.n) }));
  },

  /** GR held across every account, and what it is doing. */
  economy() {
    const row = db.prepare('SELECT SUM(gr) AS gr, SUM(xp) AS xp, AVG(level) AS level, COUNT(*) AS n FROM users').get();
    const paid = db.prepare('SELECT SUM(gr) AS gr FROM match_players').get();
    return {
      accounts: int(row.n ?? 0),
      grHeld: int(row.gr ?? 0),
      xpTotal: int(row.xp ?? 0),
      avgLevel: Math.round(Number(row.level ?? 1) * 10) / 10,
      grPaidOut: int(paid?.gr ?? 0),
    };
  },

  /**
   * Retention, the only way it can honestly be measured here: of the accounts
   * created in a window, how many came back and played on a *later* day.
   */
  retention({ since = 0, until = now() } = {}) {
    const row = db.prepare(`
      SELECT COUNT(*) AS cohort,
             SUM(CASE WHEN last_play_day > 0 THEN 1 ELSE 0 END) AS played,
             SUM(CASE WHEN last_play_day > created_at / 86400 THEN 1 ELSE 0 END) AS returned,
             SUM(CASE WHEN play_streak >= 2 THEN 1 ELSE 0 END) AS streaking
      FROM users WHERE created_at >= ? AND created_at <= ?`).get(since, until);
    const cohort = int(row?.cohort ?? 0);
    const pct = (n) => (cohort ? Math.round((n / cohort) * 1000) / 10 : 0);
    return {
      cohort,
      played: int(row?.played ?? 0),
      returned: int(row?.returned ?? 0),
      streaking: int(row?.streaking ?? 0),
      playedPct: pct(int(row?.played ?? 0)),
      returnedPct: pct(int(row?.returned ?? 0)),
    };
  },

  /** The busiest hours of the day, UTC — when a server actually needs rooms. */
  hourOfDay({ since = 0, until = now() } = {}) {
    const rows = db.prepare(`
      SELECT CAST(strftime('%H', started_at, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n
      FROM matches WHERE started_at >= ? AND started_at <= ? GROUP BY h ORDER BY h`).all(since, until);
    const out = Array.from({ length: 24 }, (_, h) => ({ hour: h, n: 0 }));
    for (const r of rows) out[int(r.h)] = { hour: int(r.h), n: int(r.n) };
    return out;
  },
};

/* ── Housekeeping ────────────────────────────────────────────────────────── */

export function summary() {
  return {
    users: S.countUsers.get().n,
    matches: S.countMatches.get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    ipBans: db.prepare('SELECT COUNT(*) AS n FROM ip_bans').get().n,
    chatBans: db.prepare('SELECT COUNT(*) AS n FROM chat_bans').get().n,
    reportBans: db.prepare('SELECT COUNT(*) AS n FROM report_bans').get().n,
    unverified: db.prepare("SELECT COUNT(*) AS n FROM users WHERE email_verified = 0").get().n,
    reports: reports.count(),
    openReports: reports.countOpen(),
    clans: int(S.countClans.get().n),
    path: config.dbPath,
  };
}

/** Periodic maintenance; called on boot and hourly. */
export function maintain() {
  const pruned = sessions.prune();
  if (pruned) logger.info(`pruned ${pruned} expired session(s)`);
  // Yesterday's challenges are settled; anything older is dead weight.
  const dropped = challenges.prune(Math.floor(Date.now() / 86400000) - 3);
  if (dropped) logger.info(`pruned ${dropped} stale challenge row(s)`);
  const lifted = ipBans.prune();
  if (lifted) logger.info(`lifted ${lifted} expired IP ban(s)`);
  const unmuted = chatBans.prune();
  if (unmuted) logger.info(`lifted ${unmuted} expired chat ban(s)`);
  const unblocked = reportBans.prune();
  if (unblocked) logger.info(`lifted ${unblocked} expired report ban(s)`);
  const links = emailTokens.prune();
  if (links) logger.info(`pruned ${links} expired verification link(s)`);
  // Address verdicts go stale: a residential range that a VPN rented last week
  // is somebody's home connection this week.
  const forgotten = ipIntel.prune(Math.max(3600, config.vpn.cacheHours * 3600) * 4);
  if (forgotten) logger.info(`forgot ${forgotten} stale address lookup(s)`);
  // Settled reports age out; an open one is never dropped from under a queue.
  const closed = reports.prune(config.reports.keepResolvedDays * 86400);
  if (closed) logger.info(`pruned ${closed} settled report(s)`);
  // An invitation nobody accepted is not a standing offer.
  const lapsed = clans.pruneInvites();
  if (lapsed) logger.info(`dropped ${lapsed} lapsed clan invite(s)`);
  // Telemetry is the one table that grows without anybody doing anything, so it
  // is also the one with a hard horizon — and the operator's, not this file's.
  const keep = Math.max(1, config.metrics?.keepDays ?? METRICS_KEEP_DAYS) * 86400;
  const samples = metrics.prune(keep);
  const olds = events.prune(keep);
  if (samples || olds) logger.info(`pruned ${samples} metric sample(s) and ${olds} event(s)`);
}

export function close() {
  try { db.close(); } catch { /* already closed */ }
}

export default {
  db, users, stats, loadouts, sessions, matches, mastery, challenges, ipBans, chatBans, audit,
  reportBans, emailTokens, ipIntel, reports, clans, normaliseIp, summary, maintain, close,
  metrics, events, analytics,
};
