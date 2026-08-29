/**
 * Open Grunker — content-addressed storage for one file per owner.
 *
 * Every store built here holds files named `<ownerId>-<hash>.<ext>` — the
 * owner's UUID and twelve hex digits of the file's own sha256 — and holds at
 * most one of them per owner.
 *
 * The hash is of the bytes, which buys two things at once: a new file is a new
 * URL, so a browser can cache one for a year and still never be shown a stale
 * one, and re-uploading the same file is a no-op rather than a second copy.
 * Replacing a file deletes the one it replaced, so an owner can never hold more
 * than a single file — that, plus the ceilings each upload route enforces, is
 * the whole storage policy.
 *
 * ── Why this is a factory rather than three modules ─────────────────────────
 *
 * Account pictures, clan pictures and player anthems are the same problem three
 * times: user-submitted bytes, owned by one id, served back to strangers under
 * a public URL. They differ only in where they live, what they are served as,
 * and which extensions are theirs. Everything else — the strict filename
 * pattern, the traversal guard, the sweep on replace, the disk usage report —
 * is identical, and three subtly different copies of a security-relevant
 * filename check is exactly the shape of bug nobody finds until it matters.
 */
import { createHash } from 'node:crypto';
import { promises as fs, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import log from './log.js';

const logger = log.child('filestore');

/** `<uuid>-<12 hex>` — every byte fixed-width hex or a hyphen. */
const STEM = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{12}';

/**
 * One store: a directory on disk, the URL prefix it is served under, and the
 * extensions that belong to it.
 *
 * `dir` is a function rather than a captured string, so a test that points
 * config at a temporary directory still gets the store it asked for.
 *
 * @param {() => string} dir
 * @param {string} prefix e.g. '/avatars'
 * @param {Record<string,string>} types extension -> content type
 */
export function createStore(dir, prefix, types) {
  const exts = Object.keys(types);
  /**
   * The strictest pattern that can still name a real file in this store. No
   * name that reaches the filesystem can contain a separator, a dot-dot, or
   * anything at all that came out of a request.
   */
  const FILE_RE = new RegExp(`^${STEM}\\.(${exts.join('|')})$`);

  let ready = false;

  /** The directory is made on first write, not at import: tests never upload. */
  const ensureDir = () => {
    if (ready) return;
    mkdirSync(dir(), { recursive: true });
    ready = true;
  };

  /** The content type a stored file is served as — from its name, not the sender. */
  const mimeFor = (file) => types[String(file).split('.').pop()] ?? 'application/octet-stream';

  /** Absolute path of a stored file, or null when the name is not one of ours. */
  const pathFor = (file) => {
    if (!file || !FILE_RE.test(file)) return null;
    const full = resolve(dir(), file);
    // Belt and braces: FILE_RE already forbids a separator, so this can only
    // fail if the pattern is ever loosened.
    if (!full.startsWith(resolve(dir()) + sep)) return null;
    return full;
  };

  /** The URL the client renders, or null when this owner has no file. */
  const urlFor = (file) => (file && FILE_RE.test(file) ? `${prefix}/${file}` : null);

  /** Deletes every file this owner has except `keep`. */
  const sweep = async (ownerId, keep = null) => {
    let names = [];
    try {
      names = await fs.readdir(dir());
    } catch {
      return 0;                                   // nothing stored yet
    }
    const start = `${ownerId}-`;
    let removed = 0;
    for (const name of names) {
      if (name === keep || !name.startsWith(start) || !FILE_RE.test(name)) continue;
      try {
        await fs.unlink(join(dir(), name));
        removed++;
      } catch { /* already gone, or someone else's to worry about */ }
    }
    return removed;
  };

  /**
   * Writes a file and returns the name to record on the row.
   *
   * @param {string} ownerId
   * @param {Buffer} buf validated bytes — see util/image.js, util/audio.js
   * @param {string} ext one of this store's extensions
   * @returns {Promise<string>} the stored filename
   */
  const save = async (ownerId, buf, ext) => {
    ensureDir();
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const file = `${ownerId}-${hash}.${ext}`;
    await fs.writeFile(join(dir(), file), buf);
    // Only after the new one is safely on disk: a failed write must never be
    // the reason somebody loses the file they already had.
    const swept = await sweep(ownerId, file);
    if (swept) logger.debug(`replaced ${swept} old file(s) under ${prefix} for #${ownerId}`);
    return file;
  };

  /** Drops an owner's file entirely. @returns {Promise<number>} files removed */
  const remove = (ownerId) => sweep(ownerId, null);

  /** Bytes this store takes up. Only used by the admin overview. */
  const usage = async () => {
    let names = [];
    try {
      names = await fs.readdir(dir());
    } catch {
      return { files: 0, bytes: 0 };
    }
    let bytes = 0;
    let files = 0;
    for (const name of names) {
      if (!FILE_RE.test(name)) continue;
      try {
        const stat = await fs.stat(join(dir(), name));
        bytes += stat.size;
        files++;
      } catch { /* raced with a replacement */ }
    }
    return { files, bytes };
  };

  return { save, remove, pathFor, urlFor, mimeFor, usage, FILE_RE };
}

export default createStore;
