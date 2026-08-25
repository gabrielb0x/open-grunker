/**
 * Open Grunker — picture storage for accounts and for clans.
 *
 * One file per owner, named `<ownerId>-<hash>.<ext>` — the owner's UUID and
 * twelve hex digits of the picture's own sha256.
 *
 * The hash is of the file's own bytes, which buys two things at once: a new
 * picture is a new URL, so the browser can cache one for a year and still never
 * show a stale one, and re-uploading the same picture is a no-op rather than a
 * second copy. Replacing a picture deletes the one it replaced, so an owner can
 * never hold more than a single file — that, plus the ceilings the upload route
 * enforces, is the whole storage policy.
 *
 * Accounts and clans get their own directory and their own URL prefix from the
 * same machinery: a clan picture is user content with exactly the same shape and
 * exactly the same risks, so it gets exactly the same handling rather than a
 * second, subtly different implementation of it.
 */
import { createHash } from 'node:crypto';
import { promises as fs, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import config from '../config.js';
import log from './log.js';

const logger = log.child('avatar');

/**
 * Only ever these three extensions, and only ever this shape:
 * `<owner-uuid>-<12 hex of the file's own sha256>.<ext>`.
 *
 * It is deliberately the strictest thing that can still name a real file. Every
 * byte of it is fixed-width hex or a hyphen, so no name that reaches the
 * filesystem can contain a separator, a dot-dot, or anything at all that came
 * from a request.
 */
export const FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{12}\.(png|jpg|webp)$/;

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/** The content type a stored file is served as — from its name, not the sender. */
export const mimeFor = (file) => MIME[String(file).split('.').pop()] ?? 'application/octet-stream';

/**
 * One store: a directory on disk and the URL prefix it is served under.
 *
 * `dir` is read lazily rather than captured, so a test that points config at a
 * temporary directory still gets the store it asked for.
 *
 * @param {() => string} dir
 * @param {string} prefix e.g. '/avatars'
 */
function createStore(dir, prefix) {
  let ready = false;

  /** The directory is made on first write, not at import: tests never upload. */
  const ensureDir = () => {
    if (ready) return;
    mkdirSync(dir(), { recursive: true });
    ready = true;
  };

  /** Absolute path of a stored file, or null when the name is not one of ours. */
  const pathFor = (file) => {
    if (!file || !FILE_RE.test(file)) return null;
    const full = resolve(dir(), file);
    // Belt and braces: FILE_RE already forbids a separator, so this can only
    // fail if the regex is ever loosened.
    if (!full.startsWith(resolve(dir()) + sep)) return null;
    return full;
  };

  /** The URL the client renders, or null when this owner has no picture. */
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
   * Writes a picture and returns the filename to record on the row.
   *
   * @param {string} ownerId
   * @param {Buffer} buf validated bytes — see util/image.js
   * @param {string} ext one of png | jpg | webp
   * @returns {Promise<string>} the stored filename
   */
  const save = async (ownerId, buf, ext) => {
    ensureDir();
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const file = `${ownerId}-${hash}.${ext}`;
    await fs.writeFile(join(dir(), file), buf);
    // Only after the new one is safely on disk: a failed write must never be
    // the reason somebody loses the picture they already had.
    const swept = await sweep(ownerId, file);
    if (swept) logger.debug(`replaced ${swept} old file(s) under ${prefix} for #${ownerId}`);
    return file;
  };

  /** Drops an owner's picture entirely. @returns {Promise<number>} files removed */
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

/* ── The two stores ──────────────────────────────────────────────────────── */

/**
 * Clan pictures: `/avatars/clans/<file>`, stored under data/clans.
 *
 * A *sub-path* of the account prefix rather than a prefix of its own, and that
 * is deliberate. The nginx vhost proxies `^~ /avatars/`, and `^~` tells nginx
 * to stop before its regex locations — so everything under that prefix reaches
 * this server, including a path it has never heard of. A separate
 * `/clan-avatars/` prefix instead fell straight through to the static-image
 * regex, which looked for the file under the client root and 404'd every clan
 * picture on any deployment whose nginx config had not been reinstalled.
 *
 * Serving a new kind of user content must not require an nginx change.
 */
export const clanAvatars = createStore(() => config.clanAvatarDir, '/avatars/clans');

const accounts = createStore(() => config.avatarDir, '/avatars');

/*
 * Account pictures keep their flat exports: they are `avatars.save(...)` in a
 * dozen callers, and renaming those would be churn for nothing.
 */
export const { save, remove, pathFor, urlFor, usage } = accounts;

export default { save, remove, pathFor, urlFor, mimeFor, usage, FILE_RE, clanAvatars };
