/**
 * Open Grunker — the log's copy on disk.
 *
 * The ring in memory holds a few thousand lines and dies with the process,
 * which is the right default for a game server: logging is not free, and most
 * of the time nobody is going to read yesterday's. But "most of the time" is
 * not "never" — a crash at three in the morning, a player disputing a ban, a
 * frame-rate collapse that only one person can reproduce — and for those the
 * answer has to still be there tomorrow.
 *
 * So this exists, and it is off until somebody switches it on. The switch is in
 * the admin panel, it is remembered per instance, and while it is off this file
 * does nothing at all beyond one boolean test per line.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 *
 * One JSON object per line — the same record the panel shows — into
 * `data/logs/og-YYYY-MM-DD.log`, rolled to `og-YYYY-MM-DD.2.log` and so on when
 * a day's file passes the size cap. JSONL because it is the one format that is
 * both greppable by a human and parseable by a machine without a schema, and
 * because a truncated write costs you one line rather than the file.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * Block. Every write lands in an array and a timer flushes it; a match must
 * never wait on a disk. Grow without limit: files past `keepDays` are deleted,
 * and the whole directory is held under `maxTotalMb` by dropping the oldest.
 * And it never throws — a logger that can take the server down with it is worse
 * than no logger, so a failed write disables the sink and says so through the
 * one channel that is guaranteed to still work, the console.
 */
import {
  createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { join, basename } from 'node:path';

/** Only files this sink could have written are ever listed or deleted. */
const NAME_RE = /^og-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class LogSink {
  /**
   * @param {object} o
   * @param {string} o.dir          where the files live
   * @param {number} o.maxFileMb    roll to a new part past this
   * @param {number} o.keepDays     delete files older than this
   * @param {number} o.maxTotalMb   and keep the whole directory under this
   */
  constructor({ dir, maxFileMb = 32, keepDays = 14, maxTotalMb = 512 }) {
    this.dir = dir;
    this.maxFileMb = maxFileMb;
    this.keepDays = keepDays;
    this.maxTotalMb = maxTotalMb;

    this.enabled = false;
    this.stream = null;
    this.file = null;
    this.day = '';
    this.part = 1;
    this.bytes = 0;
    /** Lines waiting for the next flush. */
    this.queue = [];
    this.timer = null;
    /** Counters the admin panel reads back. */
    this.written = 0;
    this.dropped = 0;
    this.lastError = null;
    this.enabledAt = 0;
  }

  /* ── The switch ────────────────────────────────────────────────────────── */

  /** Starts writing. Returns the sink's state, whether or not it worked. */
  enable(opts = {}) {
    if (opts.keepDays !== undefined) this.keepDays = Math.max(1, Math.min(365, opts.keepDays | 0));
    if (opts.maxFileMb !== undefined) this.maxFileMb = Math.max(1, Math.min(512, opts.maxFileMb | 0));
    if (opts.maxTotalMb !== undefined) this.maxTotalMb = Math.max(8, Math.min(20_000, opts.maxTotalMb | 0));
    if (this.enabled) return this.state();
    try {
      mkdirSync(this.dir, { recursive: true });
      this.enabled = true;
      this.enabledAt = Date.now();
      this.lastError = null;
      this._open();
      this.sweep();
    } catch (err) {
      this.enabled = false;
      this.lastError = err.message;
    }
    return this.state();
  }

  /** Stops writing and flushes whatever is still queued. */
  disable() {
    if (!this.enabled) return this.state();
    this.enabled = false;
    this._flush();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.stream) { try { this.stream.end(); } catch { /* already gone */ } }
    this.stream = null;
    this.file = null;
    return this.state();
  }

  /* ── Writing ───────────────────────────────────────────────────────────── */

  /**
   * Queues one record. Cheap and non-blocking by construction.
   *
   * The queue is capped: a server that has lost its disk should drop lines and
   * carry on, not fill its heap with the ones it cannot write.
   */
  write(entry) {
    if (!this.enabled) return;
    if (this.queue.length >= 20_000) { this.dropped++; return; }
    try { this.queue.push(`${JSON.stringify(entry)}\n`); } catch { this.dropped++; }
  }

  _open() {
    const today = day();
    if (this.day !== today) { this.day = today; this.part = 1; }
    // Carry on from wherever the day left off — a restart must not overwrite
    // the morning's log with the afternoon's.
    while (true) {
      const name = this.part === 1 ? `og-${this.day}.log` : `og-${this.day}.${this.part}.log`;
      const path = join(this.dir, name);
      const size = existsSync(path) ? statSync(path).size : 0;
      if (size < this.maxFileMb * 1048576) {
        this.file = path;
        this.bytes = size;
        break;
      }
      this.part++;
    }
    this.stream = createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', (err) => this._fail(err));
    if (!this.timer) {
      // Quarter of a second: fast enough that a crash loses almost nothing,
      // slow enough that a busy match is one write rather than four hundred.
      this.timer = setInterval(() => this._flush(), 250);
      this.timer.unref?.();
    }
  }

  _flush() {
    if (!this.queue.length || !this.stream) return;
    const chunk = this.queue.join('');
    this.queue.length = 0;
    try {
      this.stream.write(chunk);
      this.written += chunk.length ? chunk.split('\n').length - 1 : 0;
      this.bytes += Buffer.byteLength(chunk);
    } catch (err) {
      this._fail(err);
      return;
    }
    // A new day, or a full file: roll.
    if (this.day !== day() || this.bytes >= this.maxFileMb * 1048576) {
      const rolledDay = this.day !== day();
      try { this.stream.end(); } catch { /* already gone */ }
      this.stream = null;
      if (rolledDay) this.day = day();
      else this.part++;
      this._open();
      if (rolledDay) this.sweep();
    }
  }

  /**
   * Something went wrong with the disk.
   *
   * The sink switches itself off rather than retrying into a full or read-only
   * volume every quarter second. The reason is kept so the panel can show it,
   * and the console gets it directly — routing this through the logger would be
   * asking the broken thing to report its own breakage.
   */
  _fail(err) {
    this.lastError = err?.message ?? String(err);
    this.enabled = false;
    this.queue.length = 0;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.stream?.end(); } catch { /* already gone */ }
    this.stream = null;
    console.error(`log sink disabled — ${this.lastError}`);
  }

  /* ── Housekeeping ──────────────────────────────────────────────────────── */

  /** Every log file on disk, newest first. */
  list() {
    if (!existsSync(this.dir)) return [];
    const out = [];
    for (const name of readdirSync(this.dir)) {
      const m = NAME_RE.exec(name);
      if (!m) continue;
      try {
        const st = statSync(join(this.dir, name));
        out.push({
          name, day: m[1], part: m[2] ? Number(m[2]) : 1,
          bytes: st.size, at: Math.floor(st.mtimeMs), current: join(this.dir, name) === this.file,
        });
      } catch { /* vanished between readdir and stat */ }
    }
    return out.sort((a, b) => (b.day === a.day ? b.part - a.part : b.day.localeCompare(a.day)));
  }

  /** Drops what is too old, then what is over budget, oldest first. */
  sweep() {
    const files = this.list();
    const cutoff = day(Date.now() - this.keepDays * 86400_000);
    let removed = 0, freed = 0;
    const keep = [];
    for (const f of files) {
      if (!f.current && f.day < cutoff) {
        if (this._remove(f.name)) { removed++; freed += f.bytes; }
      } else keep.push(f);
    }
    // Oldest first for the size sweep: the newest log is the one being read.
    let total = keep.reduce((n, f) => n + f.bytes, 0);
    const budget = this.maxTotalMb * 1048576;
    for (const f of keep.slice().reverse()) {
      if (total <= budget) break;
      if (f.current) continue;
      if (this._remove(f.name)) { removed++; freed += f.bytes; total -= f.bytes; }
    }
    return { removed, freed };
  }

  /** Deletes every log file except the one being written. */
  purge() {
    let removed = 0, freed = 0;
    for (const f of this.list()) {
      if (f.current) continue;
      if (this._remove(f.name)) { removed++; freed += f.bytes; }
    }
    return { removed, freed };
  }

  _remove(name) {
    try { unlinkSync(join(this.dir, name)); return true; } catch { return false; }
  }

  /**
   * Resolves a file name to a path, or null.
   *
   * The name has to match the pattern this sink writes, and it is reduced to
   * its basename first — the panel passes it straight through from a query
   * string, so this is the boundary that has to refuse `../../.env`.
   */
  resolve(name) {
    const base = basename(String(name ?? ''));
    if (!NAME_RE.test(base)) return null;
    const path = join(this.dir, base);
    return existsSync(path) ? path : null;
  }

  /** Everything the panel needs to draw the storage card. */
  state() {
    const files = this.list();
    return {
      enabled: this.enabled,
      dir: this.dir,
      file: this.file ? basename(this.file) : null,
      keepDays: this.keepDays,
      maxFileMb: this.maxFileMb,
      maxTotalMb: this.maxTotalMb,
      written: this.written,
      dropped: this.dropped,
      queued: this.queue.length,
      lastError: this.lastError,
      enabledAt: this.enabledAt,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    };
  }
}

export default LogSink;
