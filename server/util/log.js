/** Tiny levelled logger — timestamps, colours when attached to a TTY. */
import config from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
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
 * Recent lines, kept in memory so the admin panel can show them without
 * shelling out to journalctl. Plain text, no colour codes.
 */
const RING = 800;
const ring = new Array(RING);
let ringHead = 0, ringCount = 0;
let seq = 0;

const plain = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
};

function record(level, ns, args) {
  ring[ringHead] = {
    id: ++seq,
    at: Date.now(),
    level,
    ns: ns ?? '',
    message: args.map(plain).join(' ').slice(0, 2000),
  };
  ringHead = (ringHead + 1) % RING;
  if (ringCount < RING) ringCount++;
}

/** Newest first. `sinceId` returns only entries after that id. */
export function recent({ limit = 200, level = null, sinceId = 0 } = {}) {
  const out = [];
  for (let i = 1; i <= ringCount && out.length < Math.min(limit, RING); i++) {
    const e = ring[(ringHead - i + RING) % RING];
    if (!e || e.id <= sinceId) continue;
    if (level && e.level !== level) continue;
    out.push(e);
  }
  return out;
}

function emit(level, args, ns = '') {
  record(level, ns, args);
  if ((LEVELS[level] ?? 9) > active) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = [paint('90', ts), TAGS[level], ...(ns ? [paint('35', `[${ns}]`)] : []), ...args];
  (level === 'error' ? console.error : console.log)(...line);
}

export const log = {
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
  recent,
  /** Namespaced child logger. */
  child: (ns) => ({
    error: (...a) => emit('error', a, ns),
    warn: (...a) => emit('warn', a, ns),
    info: (...a) => emit('info', a, ns),
    debug: (...a) => emit('debug', a, ns),
  }),
};

export default log;
