/**
 * Open Grunker — the log.
 *
 * One stream, three destinations, and every line in it is a record rather than
 * a sentence:
 *
 *   • the console, filtered by LOG_LEVEL, for whoever is watching the process
 *   • a ring in memory, unfiltered, for the admin panel's LOGS tab
 *   • a file on disk, when the operator switches it on — see logsink.js
 *
 * The reason a line is a record is that the panel has to be able to *ask*
 * things of it. "Everything that happened to this player", "every warning from
 * the anti-cheat in the last hour", "who was in this room when it emptied" —
 * none of those are answerable by grepping prose, and all of them are one field
 * comparison away once the line carries its own structure.
 *
 * ── Writing a line ──────────────────────────────────────────────────────────
 *
 *     logger.info('joined the match');                      // plain
 *     logger.info('joined the match', { room, map });       // with fields
 *     logger.warn('kicked', { reason: 'flood', ip });
 *
 * If the last argument is a plain object it becomes the record's fields; a
 * string, a number or an Error is part of the message, exactly as before. Some
 * field names mean something to the panel rather than only to the reader:
 *
 *     player, userId, ip   who the line is about — the panel indexes on these
 *     room, map, mode      where it happened
 *     cat                  overrides the logger's category for this one line
 *
 * ── Attaching a line to somebody ────────────────────────────────────────────
 *
 *     const plog = logger.for(player, room);
 *     plog.info('spawned', { x, y, z });
 *
 * `for()` returns a logger carrying that player's identity, so every line
 * written through it is findable from the player's own page in the panel
 * without the call site having to remember to say who it was about.
 */
import { join } from 'node:path';
import config, { ROOT } from '../config.js';
import { LogSink } from './logsink.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
export const LEVEL_NAMES = Object.keys(LEVELS);
const active = LEVELS[config.logLevel] ?? 2;
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

const TAGS = {
  error: paint('31', 'ERROR'),
  warn: paint('33', ' WARN'),
  info: paint('36', ' INFO'),
  debug: paint('90', 'DEBUG'),
};

/**
 * What a line is *about*, as opposed to how loud it is.
 *
 * Level answers "should this wake somebody up". Category answers "which part of
 * the server is talking", which is the question anyone reading a log actually
 * has. They are independent — an error can be economic and an info line can be
 * moderation — so the panel filters on both.
 */
export const CAT = {
  system: 'system',           // boot, shutdown, config, maintenance
  net: 'net',                 // sockets, handshakes, HTTP, refusals
  account: 'account',         // register, sign-in, email, 2FA, profile
  match: 'match',             // rooms, matches, joins, maps, votes
  combat: 'combat',           // spawns, kills, damage, shots
  chat: 'chat',               // what players said
  moderation: 'moderation',   // bans, mutes, reports, anti-cheat
  economy: 'economy',         // cases, market, trades, currency
  admin: 'admin',             // the panel's own writes
  client: 'client',           // diagnostics sent up by a player's browser
  db: 'db',                   // the database and its maintenance
  mail: 'mail',               // outbound email
};
export const CAT_NAMES = Object.keys(CAT);

/** Fields the panel treats as identity rather than as detail. */
const LIFTED = ['player', 'userId', 'ip', 'room', 'map', 'mode', 'cat'];

/**
 * The verbose game trace.
 *
 * Every shot, every hit, every reconciliation: the lines that answer "what
 * exactly happened in that fight" and that nobody wants on for a week. They are
 * written through `logger.trace`, which returns without allocating anything at
 * all while this is off, so leaving the calls in the hot path costs a boolean
 * test. The switch is on the panel's LOGS page and is remembered per instance.
 */
export const verbose = { trace: !!config.logs?.trace };

/* ── The ring ────────────────────────────────────────────────────────────── */

const RING = Math.max(200, Math.min(50_000, config.logs?.ring ?? 5000));
const ring = new Array(RING);
let ringHead = 0, ringCount = 0;
let seq = 0;
/** Lines written since boot, per level — the panel's "since restart" counters. */
const totals = { error: 0, warn: 0, info: 0, debug: 0 };
const startedAt = Date.now();

/** Everything the console can print, flattened. Errors keep their stack. */
const plain = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
};

/** A plain object, and therefore a field bag rather than part of the message. */
const isFields = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && !(v instanceof Error) && (v.constructor === Object || v.constructor === undefined);

/**
 * Trims a field bag down to something safe to keep a few thousand of.
 *
 * A log line is not a place to hold a snapshot: values are stringified, capped,
 * and nested objects go in as JSON one level deep. The cap is generous enough
 * for a position, a weapon id and a reason, and mean enough that one careless
 * call site cannot put a megabyte in the ring.
 */
function clean(fields) {
  if (!fields) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || k === 'cat') continue;
    if (++n > 24) break;
    if (typeof v === 'number') out[k] = Number.isFinite(v) ? Math.round(v * 1000) / 1000 : String(v);
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    else if (v instanceof Error) out[k] = v.message;
    else {
      try { out[k] = JSON.stringify(v).slice(0, 300); } catch { out[k] = String(v).slice(0, 300); }
    }
  }
  return Object.keys(out).length ? out : null;
}

const sink = new LogSink({
  dir: config.logs?.dir ?? join(ROOT, 'data/logs'),
  maxFileMb: config.logs?.maxFileMb ?? 32,
  keepDays: config.logs?.keepDays ?? 14,
  maxTotalMb: config.logs?.maxTotalMb ?? 512,
});

/**
 * Extra streams that want every record as it is written.
 *
 * The admin panel's live tail uses one; nothing else does yet. A listener that
 * throws is dropped rather than allowed to take the caller down with it — a log
 * line must never be able to break the thing that logged it.
 */
const listeners = new Set();
export function onRecord(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function record(level, ns, cat, args, bound) {
  const last = args.length ? args[args.length - 1] : null;
  const fields = isFields(last) ? last : null;
  const words = fields ? args.slice(0, -1) : args;
  const merged = bound || fields ? { ...bound, ...fields } : null;

  const entry = {
    id: ++seq,
    at: Date.now(),
    level,
    ns: ns || '',
    cat: (merged && CAT[merged.cat]) || cat || CAT.system,
    msg: words.map(plain).join(' ').slice(0, 2000),
  };
  if (merged) {
    for (const key of LIFTED) {
      if (key === 'cat') continue;
      if (merged[key] !== undefined && merged[key] !== null) entry[key] = merged[key];
    }
    const rest = { ...merged };
    for (const key of LIFTED) delete rest[key];
    const kept = clean(rest);
    if (kept) entry.fields = kept;
  }

  ring[ringHead] = entry;
  ringHead = (ringHead + 1) % RING;
  if (ringCount < RING) ringCount++;
  totals[level] = (totals[level] ?? 0) + 1;

  sink.write(entry);
  for (const fn of listeners) {
    try { fn(entry); } catch { /* a listener never breaks the caller */ }
  }
  return entry;
}

/* ── Reading it back ─────────────────────────────────────────────────────── */

/**
 * Newest first, narrowed by whatever was asked for.
 *
 * A linear walk of a few thousand entries, deliberately: an index would have to
 * be invalidated every time the ring wraps, and at this size the scan costs
 * less than keeping one honest would.
 *
 * @param {object} [q]
 * @param {number} [q.limit]     how many to return
 * @param {string} [q.level]     one level, or a comma list of them
 * @param {string} [q.cat]       one category, or a comma list
 * @param {string} [q.ns]        one namespace
 * @param {string} [q.q]         free text, matched against the message and fields
 * @param {string} [q.player]    a player name, matched loosely
 * @param {string} [q.userId]    an account id, matched exactly
 * @param {string} [q.room]      a room code
 * @param {number} [q.sinceId]   only entries newer than this id
 * @param {number} [q.since]     only entries at or after this timestamp (ms)
 */
export function recent({
  limit = 200, level = null, cat = null, ns = null, q = null,
  player = null, userId = null, room = null, sinceId = 0, since = 0,
} = {}) {
  const levels = level ? new Set(String(level).split(',').filter(Boolean)) : null;
  const cats = cat ? new Set(String(cat).split(',').filter(Boolean)) : null;
  const text = q ? String(q).toLowerCase() : null;
  const who = player ? String(player).toLowerCase() : null;
  const out = [];
  const want = Math.min(limit, RING);

  for (let i = 1; i <= ringCount && out.length < want; i++) {
    const e = ring[(ringHead - i + RING) % RING];
    if (!e || e.id <= sinceId || e.at < since) continue;
    if (levels && !levels.has(e.level)) continue;
    if (cats && !cats.has(e.cat)) continue;
    if (ns && e.ns !== ns) continue;
    if (userId && String(e.userId ?? '') !== String(userId)) continue;
    if (room && String(e.room ?? '').toLowerCase() !== String(room).toLowerCase()) continue;
    if (who && !String(e.player ?? '').toLowerCase().includes(who)) continue;
    if (text && !matches(e, text)) continue;
    out.push(e);
  }
  return out;
}

/** Free-text search across the parts of a record a person would read. */
function matches(e, text) {
  if (e.msg.toLowerCase().includes(text)) return true;
  if (e.ns.toLowerCase().includes(text)) return true;
  if (String(e.player ?? '').toLowerCase().includes(text)) return true;
  if (String(e.room ?? '').toLowerCase().includes(text)) return true;
  if (!e.fields) return false;
  for (const [k, v] of Object.entries(e.fields)) {
    if (k.toLowerCase().includes(text) || String(v).toLowerCase().includes(text)) return true;
  }
  return false;
}

/**
 * What is in the buffer right now, by level and by category.
 *
 * Counted over the ring rather than since boot, because the panel draws it next
 * to the lines it is showing and the two have to agree.
 */
export function stats() {
  const byLevel = { error: 0, warn: 0, info: 0, debug: 0 };
  const byCat = {};
  const byNs = {};
  let oldest = 0, newest = 0;
  for (let i = 0; i < ringCount; i++) {
    const e = ring[(ringHead - 1 - i + RING) % RING];
    if (!e) continue;
    byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
    byCat[e.cat] = (byCat[e.cat] ?? 0) + 1;
    if (e.ns) byNs[e.ns] = (byNs[e.ns] ?? 0) + 1;
    if (!newest) newest = e.at;
    oldest = e.at;
  }
  return {
    buffered: ringCount,
    capacity: RING,
    byLevel,
    byCat,
    namespaces: Object.entries(byNs).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ ns: k, n })),
    oldest,
    newest,
    lastId: seq,
    sinceBoot: { ...totals },
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    consoleLevel: config.logLevel,
  };
}

/** Throws the buffer away. The disk copy, if there is one, is untouched. */
export function clear() {
  ring.fill(undefined);
  ringHead = 0;
  ringCount = 0;
}

/* ── Writing it ──────────────────────────────────────────────────────────── */

function emit(level, args, ns = '', cat = CAT.system, bound = null) {
  const entry = record(level, ns, cat, args, bound);
  if ((LEVELS[level] ?? 9) > active) return;
  const ts = new Date().toISOString().slice(11, 23);
  const trailer = consoleFields(entry);
  const tail = trailer ? [paint('90', trailer)] : [];
  const line = [
    paint('90', ts), TAGS[level],
    ...(ns ? [paint('35', `[${ns}]`)] : []),
    ...args.filter((a) => !isFields(a)),
    ...tail,
  ];
  (level === 'error' ? console.error : console.log)(...line);
}

/** The structured half of a record, as one readable trailer for the console. */
function consoleFields(entry) {
  const bits = [];
  for (const key of ['player', 'room', 'map', 'mode']) {
    if (entry[key]) bits.push(`${key}=${entry[key]}`);
  }
  for (const [k, v] of Object.entries(entry.fields ?? {})) bits.push(`${k}=${v}`);
  return bits.length ? `· ${bits.join(' ')}` : '';
}

/**
 * A logger with a namespace, a default category and, optionally, an identity.
 *
 * `for(player, room)` is the one that matters: it is what makes a line findable
 * from a player's page in the panel, and it costs the call site nothing to use.
 */
function makeLogger(ns, cat, bound) {
  const self = {
    error: (...a) => emit('error', a, ns, cat, bound),
    warn: (...a) => emit('warn', a, ns, cat, bound),
    info: (...a) => emit('info', a, ns, cat, bound),
    debug: (...a) => emit('debug', a, ns, cat, bound),

    /** A logger that carries these fields on every line it writes. */
    with: (fields) => makeLogger(ns, cat, { ...bound, ...fields }),

    /**
     * A logger attached to a player.
     *
     * Accepts a room-side Player, an account row, or a bare `{ id, name }` —
     * whatever the call site happens to be holding — and pulls the three fields
     * the panel indexes on out of it.
     */
    for: (player, room = null) => {
      if (!player) return room ? self.with({ room: room.code ?? room }) : self;
      return self.with({
        player: player.name ?? player.username ?? null,
        userId: player.userId ?? player.user_id ?? (player.username ? player.id : null) ?? null,
        ip: player.ip ?? null,
        room: room ? (room.code ?? room) : null,
      });
    },

    /**
     * A line that only exists while the verbose trace is on.
     *
     * Recorded at debug level when it is, and skipped before the arguments are
     * even looked at when it is not — so a per-shot call in the middle of a
     * firefight costs one property read.
     */
    trace: (...a) => { if (verbose.trace) emit('debug', a, ns, cat, bound); },

    /** The same namespace under a different category. */
    as: (nextCat) => makeLogger(ns, CAT[nextCat] ?? cat, bound),
  };
  return self;
}

/**
 * Applies the switches the operator set from the panel.
 *
 * Handed the settings store rather than importing it: the database module logs,
 * so a logger that imported the database would be a cycle. Called once at boot
 * and again whenever the panel changes something.
 *
 * @param {{get: function, set: function}} store `db.settings`
 */
export function applyStored(store) {
  if (!store) return settingsState();
  const saved = store.get('logs', null);
  const want = {
    toDisk: saved?.toDisk ?? config.logs?.toDisk ?? false,
    trace: saved?.trace ?? config.logs?.trace ?? false,
    keepDays: saved?.keepDays ?? config.logs?.keepDays ?? 14,
    maxFileMb: saved?.maxFileMb ?? config.logs?.maxFileMb ?? 32,
    maxTotalMb: saved?.maxTotalMb ?? config.logs?.maxTotalMb ?? 512,
  };
  verbose.trace = !!want.trace;
  if (want.toDisk) sink.enable(want);
  else sink.disable();
  return settingsState();
}

/**
 * Changes one or more switches and remembers the result.
 *
 * The stored shape is the *asked for* state, not the achieved one: a disk that
 * refuses to be written to should not quietly turn the operator's choice off
 * for the next restart as well.
 */
export function updateStored(store, patch = {}) {
  const current = store?.get('logs', null) ?? {};
  const next = { ...current };
  if (patch.toDisk !== undefined) next.toDisk = !!patch.toDisk;
  if (patch.trace !== undefined) next.trace = !!patch.trace;
  if (patch.keepDays !== undefined) next.keepDays = Math.max(1, Math.min(365, patch.keepDays | 0));
  if (patch.maxFileMb !== undefined) next.maxFileMb = Math.max(1, Math.min(512, patch.maxFileMb | 0));
  if (patch.maxTotalMb !== undefined) next.maxTotalMb = Math.max(8, Math.min(20_000, patch.maxTotalMb | 0));
  store?.set('logs', next);
  return applyStored(store);
}

/** The state of both switches, for the panel. */
export function settingsState() {
  return { trace: verbose.trace, disk: sink.state() };
}

export const log = {
  ...makeLogger('', CAT.system, null),
  recent,
  stats,
  clear,
  onRecord,
  sink,
  verbose,
  applyStored,
  updateStored,
  settingsState,
  CAT,
  /**
   * A namespaced child logger.
   *
   * The category is the default for everything it writes; a single line can
   * still say otherwise by putting `cat` in its fields.
   */
  child: (ns, cat = CAT.system) => makeLogger(ns, CAT[cat] ?? CAT.system, null),
};

export default log;
