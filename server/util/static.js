/**
 * Open Grunker — static file serving.
 *
 * nginx serves these files in production; this exists so `npm start` alone
 * gives you a fully playable game on http://localhost:PORT with no web server
 * in front of it.
 */
import { createReadStream, readdirSync, statSync, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = new Set(['.woff2', '.woff', '.ttf', '.png', '.jpg', '.jpeg', '.webp', '.ico']);

/**
 * A chunk out of the client build, named after a hash of its own contents.
 *
 * Those can be cached forever — the URL changes the moment the file does —
 * which is what the nginx vhost does with the same prefix. The shape is
 * deliberately narrow: `assets/` holds nothing else, so serving the unbundled
 * sources can never trip it and hand someone a permanent copy of hud.js.
 */
const HASHED = /(?:^|\/)assets\/[A-Za-z0-9_-]{8,}\.(?:js|css)$/;

/**
 * Serves `urlPath` from `root`.
 * @returns {Promise<boolean>} false when nothing matched (caller sends 404)
 */
export async function serveStatic(req, res, root, urlPath, { spa = null } = {}) {
  let rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel === '' || rel === '.') rel = 'index.html';

  let file = resolve(root, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (!file.startsWith(root + sep) && file !== root) return false;   // traversal attempt

  let stat;
  try {
    stat = await fs.stat(file);
    if (stat.isDirectory()) {
      file = join(file, 'index.html');
      stat = await fs.stat(file);
    }
  } catch {
    if (!spa) return false;
    file = join(root, spa);
    try { stat = await fs.stat(file); } catch { return false; }
  }

  const ext = extname(file).toLowerCase();
  const etag = `W/"${createHash('sha1').update(`${stat.size}-${stat.mtimeMs}`).digest('base64url').slice(0, 20)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end();
    return true;
  }

  // Unversioned code revalidates every time (cheap 304s); a build's chunks
  // carry their hash in the name and never have to be asked about twice; only
  // binary assets otherwise sit in cache.
  const cache = HASHED.test(rel)
    ? 'public, max-age=31536000, immutable'
    : ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css'
      ? 'no-cache'
      : IMMUTABLE.has(ext) ? 'public, max-age=604800' : 'public, max-age=300, must-revalidate';

  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cache,
    etag,
    'x-content-type-options': 'nosniff',
  });

  if (req.method === 'HEAD') { res.end(); return true; }

  await new Promise((done) => {
    const stream = createReadStream(file);
    stream.on('error', () => { res.destroy(); done(); });
    stream.on('end', done);
    stream.pipe(res);
  });
  return true;
}

// Neither goes into a bundle: `dist` is the build itself, and `vendor` is the
// unbundled copy of three.js, restamped by every `npm install`.
const NOT_SOURCE = new Set(['dist', 'vendor', 'node_modules']);

/**
 * Names the source file that outdates a built client, if there is one.
 *
 * Bundling freezes a copy of `shared/` into the client, and the whole design
 * rests on that copy matching the server's: a client running last week's
 * movement.js against this week's server disagrees about where everyone is.
 * Editing and forgetting to rebuild is the only way to get there, so the boot
 * banner says so out loud rather than letting it surface as a desync.
 *
 * A source tree serves itself and can never be stale, so it is skipped — the
 * tell is `js/`, which the sources have and a build does not.
 *
 * Synchronous on purpose: it runs once, at boot, over a few dozen files.
 *
 * @returns {string|null} the newest file the build predates, or null when the
 *   build is current, absent, or is really the sources.
 */
export function staleBuild(clientDir, sourceDirs) {
  let built;
  try {
    if (statSync(join(clientDir, 'js')).isDirectory()) return null;   // the sources
  } catch { /* not a source tree — carry on */ }
  try { built = statSync(join(clientDir, 'index.html')).mtimeMs; } catch { return null; }

  let newest = null;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (!NOT_SOURCE.has(entry.name)) walk(full); continue; }
      if (!entry.isFile()) continue;
      const { mtimeMs } = statSync(full);
      if (mtimeMs > built && (!newest || mtimeMs > newest.mtimeMs)) newest = { full, mtimeMs };
    }
  };
  for (const dir of sourceDirs) walk(dir);
  return newest?.full ?? null;
}

export default serveStatic;
