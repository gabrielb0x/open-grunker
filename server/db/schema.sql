-- Open Grunker — account & progression schema (SQLite / node:sqlite).
-- Columns added after the first release are applied by migrate() in index.js.
--
-- ── Why the ids are text ───────────────────────────────────────────────────
-- Every entity here — account, clan, match, report — is keyed by a UUID held
-- as TEXT, not by an autoincrementing counter. A counter leaks how many
-- accounts exist and in what order they signed up, makes one instance's ids
-- collide with another's the moment two databases are ever merged or a match
-- log is exported, and invites anything downstream to guess the next one.
-- `migrateToUuids()` in index.js converts an older counter-keyed database in
-- place, rewriting every foreign key as it goes.
--
-- `admin_log` is the deliberate exception: it is an append-only journal read
-- newest-first by id, and it names nothing outside itself.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS users (
  id             TEXT    PRIMARY KEY,
  username       TEXT    NOT NULL,
  username_lower TEXT    NOT NULL UNIQUE,
  email          TEXT,
  password_hash  TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  last_login     INTEGER,
  last_ip        TEXT,
  xp             INTEGER NOT NULL DEFAULT 0,
  level          INTEGER NOT NULL DEFAULT 1,
  gr             INTEGER NOT NULL DEFAULT 0,      -- in-game currency
  verified       INTEGER NOT NULL DEFAULT 0,      -- shows the check badge
  clan           TEXT,                            -- clan tag, denormalised from clans.tag
  clan_id        TEXT,                            -- REFERENCES clans(id), null when unclanned
  clan_verified  INTEGER NOT NULL DEFAULT 0,      -- denormalised from clans.verified
  role           TEXT    NOT NULL DEFAULT 'player',   -- player | mod | admin
  banned_until   INTEGER NOT NULL DEFAULT 0,      -- 0 none, -1 permanent, else unix ts
  ban_reason     TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,      -- has the address been confirmed
  verified_at    INTEGER,                         -- when it was confirmed
  renamed_at     INTEGER,                         -- last paid nickname change
  name_changes   INTEGER NOT NULL DEFAULT 0,
  avatar         TEXT,                            -- profile picture: "<hash>.<ext>", file lives under data/avatars
  avatar_at      INTEGER,                         -- when it was last replaced
  last_play_day  INTEGER NOT NULL DEFAULT 0,      -- UTC day of the last finished match
  play_streak    INTEGER NOT NULL DEFAULT 0,      -- consecutive days with a finished match
  best_streak_days INTEGER NOT NULL DEFAULT 0,    -- the longest one they have ever held
  last_win_day   INTEGER NOT NULL DEFAULT 0,      -- UTC day the first-win bonus was last paid
  -- Has this account been through regradeLevels()? The level curve got steeper
  -- above LEVEL_RAMP_FROM, and a level is derived from XP rather than stored,
  -- so accounts that predate the change are topped up once and marked here.
  -- It lives in the schema as well as in migrate() because the UUID rebuild
  -- recreates this table from this file and then re-inserts the old rows.
  level_graded   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stats (
  user_id       TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kills         INTEGER NOT NULL DEFAULT 0,
  deaths        INTEGER NOT NULL DEFAULT 0,
  assists       INTEGER NOT NULL DEFAULT 0,
  headshots     INTEGER NOT NULL DEFAULT 0,
  shots_fired   INTEGER NOT NULL DEFAULT 0,
  shots_hit     INTEGER NOT NULL DEFAULT 0,
  damage_dealt  INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  matches       INTEGER NOT NULL DEFAULT 0,
  best_streak   INTEGER NOT NULL DEFAULT 0,
  score         INTEGER NOT NULL DEFAULT 0,
  playtime_sec  INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS loadouts (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  class_id   TEXT    NOT NULL DEFAULT 'triggerman',
  skins      TEXT    NOT NULL DEFAULT '{}',   -- JSON: { <classId>: <skinId> }
  owned      TEXT    NOT NULL DEFAULT '[]',   -- JSON: [ <skinId>, ... ]
  settings   TEXT    NOT NULL DEFAULT '{}',   -- JSON: client settings blob
  keybinds   TEXT    NOT NULL DEFAULT '{}',   -- JSON: { <action>: <KeyboardEvent.code> }
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS matches (
  id         TEXT    PRIMARY KEY,
  room       TEXT    NOT NULL,
  mode       TEXT    NOT NULL,
  map        TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  winner     TEXT
);

CREATE TABLE IF NOT EXISTS match_players (
  id       TEXT    PRIMARY KEY,
  match_id TEXT    NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  name     TEXT    NOT NULL,
  team     INTEGER NOT NULL DEFAULT 0,
  class_id TEXT,
  kills    INTEGER NOT NULL DEFAULT 0,
  deaths   INTEGER NOT NULL DEFAULT 0,
  score    INTEGER NOT NULL DEFAULT 0,
  gr       INTEGER NOT NULL DEFAULT 0,
  won      INTEGER NOT NULL DEFAULT 0
);

-- Per-weapon kill counts, which drive the mastery tiers.
CREATE TABLE IF NOT EXISTS mastery (
  user_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weapon_id TEXT    NOT NULL,
  kills     INTEGER NOT NULL DEFAULT 0,
  headshots INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, weapon_id)
);

-- Daily challenge progress. One row per player per challenge per UTC day.
CREATE TABLE IF NOT EXISTS challenges (
  user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          INTEGER NOT NULL,
  challenge_id TEXT    NOT NULL,
  progress     INTEGER NOT NULL DEFAULT 0,
  claimed      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, challenge_id)
);

-- IP bans. Independent of accounts: a ban on an address keeps a banned player
-- out even when they make a fresh account or play as a guest.
CREATE TABLE IF NOT EXISTS ip_bans (
  ip         TEXT    PRIMARY KEY,
  reason     TEXT,
  until      INTEGER NOT NULL DEFAULT -1,   -- -1 permanent, else unix ts
  created_at INTEGER NOT NULL,
  user_id    TEXT,                          -- account the ban was issued from
  username   TEXT                           -- denormalised, so it survives a delete
);

-- Chat bans (mutes). Deliberately separate from an account ban: a muted player
-- keeps playing, they simply cannot write into a match's chat.
CREATE TABLE IF NOT EXISTS chat_bans (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  until      INTEGER NOT NULL DEFAULT -1,   -- -1 permanent, else unix ts
  reason     TEXT,
  created_at INTEGER NOT NULL,
  actor      TEXT,                          -- who issued it
  username   TEXT                           -- denormalised, so it survives a delete
);

-- Report bans. The mirror image of a chat ban: a player who abuses the REPORT
-- button keeps playing and keeps talking, they simply cannot file any more.
--
-- This is deliberately not a ban and not a mute. The ceilings in util/reports.js
-- clear themselves and answer the ordinary ways of overusing the button; this
-- row is what a moderator reaches for when someone is using it as a weapon, and
-- like every other sanction here the reason travels with it so the player is
-- told what they did rather than finding a dead button.
CREATE TABLE IF NOT EXISTS report_bans (
  user_id    TEXT    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  until      INTEGER NOT NULL DEFAULT -1,   -- -1 permanent, else unix ts
  reason     TEXT,
  created_at INTEGER NOT NULL,
  actor      TEXT,                          -- who issued it
  username   TEXT                           -- denormalised, so it survives a delete
);

-- Address-verification tokens. One row per link sent; the token itself is only
-- ever stored as a hash, exactly like a session.
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0,
  sent_to_ip TEXT
);

-- What an address intelligence provider said about an IP. Cached so a player
-- reconnecting between matches costs one lookup a day, not one per join.
CREATE TABLE IF NOT EXISTS ip_intel (
  ip         TEXT    PRIMARY KEY,
  proxy      INTEGER NOT NULL DEFAULT 0,   -- flagged proxy / VPN exit
  hosting    INTEGER NOT NULL DEFAULT 0,   -- datacenter range
  tor        INTEGER NOT NULL DEFAULT 0,
  country    TEXT,
  asn        TEXT,
  provider   TEXT,                         -- which service answered
  detail     TEXT,                         -- provider's own label, e.g. "VPN"
  checked_at INTEGER NOT NULL
);

-- Player reports. One row per report filed from a match's scoreboard.
--
-- Both sides are denormalised on purpose: the name is what the reporter saw and
-- has to keep reading back, and a report has to survive the account it names
-- being renamed or deleted. `target_id` is null when a guest was reported —
-- which is exactly why `target_ip` is kept: it is the only handle a moderator
-- has on someone with no account.
CREATE TABLE IF NOT EXISTS reports (
  id            TEXT    PRIMARY KEY,
  reporter_id   TEXT    REFERENCES users(id) ON DELETE SET NULL,
  reporter_name TEXT    NOT NULL,
  target_id     TEXT    REFERENCES users(id) ON DELETE SET NULL,
  target_name   TEXT    NOT NULL,
  target_ip     TEXT,
  reason        TEXT    NOT NULL,               -- cheat | chat | name | grief | other
  detail        TEXT,                           -- the reporter's own words
  room          TEXT,                           -- match code it happened in
  mode          TEXT,
  map           TEXT,
  chat_log      TEXT,                           -- the room's chat as it stood, JSON
  created_at    INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open',  -- open | actioned | rejected
  action        TEXT,                           -- none | warned | muted | banned
  outcome       TEXT,                           -- what the reporter is told
  resolver      TEXT,                           -- who closed it
  resolved_at   INTEGER
);

-- Clans.
--
-- The tag is the whole visible product — it is drawn in front of a nickname
-- everywhere one appears — so it carries the unique index, not the id, and it
-- is stored twice: here as the truth, and on every member's `users` row as a
-- cache. That cache is what keeps the leaderboard, the killfeed, the nametags
-- and the join handshake free of a join, and `syncMembers()` in index.js is the
-- single place allowed to write it.
CREATE TABLE IF NOT EXISTS clans (
  id         TEXT    PRIMARY KEY,
  tag        TEXT    NOT NULL,
  tag_lower  TEXT    NOT NULL UNIQUE,
  owner_id   TEXT    REFERENCES users(id) ON DELETE SET NULL,
  avatar     TEXT,                          -- "<clanId>-<hash>.<ext>" under data/clans
  avatar_at  INTEGER,
  verified   INTEGER NOT NULL DEFAULT 0,    -- set by the developers; the tag turns gold
  created_at INTEGER NOT NULL,
  created_by TEXT                           -- who founded it, kept past a delete
);

-- Membership. The unique index on user_id is the rule "one player, one clan".
CREATE TABLE IF NOT EXISTS clan_members (
  clan_id   TEXT    NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  user_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT 'member',   -- owner | member
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (clan_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clan_members_user ON clan_members(user_id);

-- Outstanding invitations. A clan is invite-only: this table is the only way in.
CREATE TABLE IF NOT EXISTS clan_invites (
  clan_id    TEXT    NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (clan_id, user_id)
);

-- ── Telemetry ──────────────────────────────────────────────────────────────
-- Two tables, and the split between them is the whole design.
--
-- `metrics` is a regular sample of things that are *true right now* — players
-- online, rooms up, tick cost, memory. One row every METRICS_INTERVAL_SEC per
-- series, which is what a line on a graph is made of. It is written by a timer
-- and never by gameplay, so a busy match costs it nothing.
--
-- `events` is the opposite: things that *happened once*. A sign-up, a level-up,
-- a match ending, a ban. They arrive at whatever rate the game produces them
-- and are counted per bucket when a chart needs a bar. Nothing at kill rate
-- goes in here — those are counters rolled into `metrics` instead, because a
-- row per kill is a row per second per player and buys no answer that a count
-- does not.
CREATE TABLE IF NOT EXISTS metrics (
  at     INTEGER NOT NULL,          -- unix seconds, bucket start
  name   TEXT    NOT NULL,          -- series id, e.g. 'players.online'
  value  REAL    NOT NULL,
  PRIMARY KEY (at, name)
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,         -- signup | login | match.end | level.up | ban | …
  user_id TEXT,                     -- no FK: an event outlives the account it names
  name    TEXT,
  room    TEXT,
  map     TEXT,
  mode    TEXT,
  value   REAL,                     -- the one number this kind of event is about
  detail  TEXT
);

-- Every write an administrator makes through the local admin panel.
CREATE TABLE IF NOT EXISTS admin_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  actor    TEXT    NOT NULL,
  action   TEXT    NOT NULL,
  target   TEXT,
  detail   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_stats_kills       ON stats(kills DESC);
CREATE INDEX IF NOT EXISTS idx_users_level       ON users(level DESC, xp DESC);
CREATE INDEX IF NOT EXISTS idx_mp_match          ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_mp_user           ON match_players(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_log_at      ON admin_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_mastery_user       ON mastery(user_id, kills DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_day     ON challenges(user_id, day);
CREATE INDEX IF NOT EXISTS idx_ip_bans_user       ON ip_bans(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_bans_until    ON chat_bans(until);
CREATE INDEX IF NOT EXISTS idx_report_bans_until  ON report_bans(until);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user   ON email_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_tokens_exp    ON email_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_ip_intel_checked    ON ip_intel(checked_at);
CREATE INDEX IF NOT EXISTS idx_reports_status     ON reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter   ON reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target     ON reports(target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clan_members_clan ON clan_members(clan_id);
CREATE INDEX IF NOT EXISTS idx_clan_invites_user ON clan_invites(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_clan_invites_exp  ON clan_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_metrics_name       ON metrics(name, at);
CREATE INDEX IF NOT EXISTS idx_metrics_at         ON metrics(at);
CREATE INDEX IF NOT EXISTS idx_events_at          ON events(at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind        ON events(kind, at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user        ON events(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_started    ON matches(started_at);
CREATE INDEX IF NOT EXISTS idx_users_created      ON users(created_at);
-- idx_users_clan is NOT here: this file runs before migrate(), and on a
-- database that predates clans the column it indexes does not exist yet. Any
-- index over a column added by a migration belongs in that migration.

