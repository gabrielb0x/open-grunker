/**
 * Open Grunker — static file serving.
 *
 * nginx serves these files in production; this exists so `npm start` alone
 * gives you a fully playable game on http://localhost:PORT with no web server
 * in front of it.
 */
import { createReadStream, promises as fs } from 'node:fs';
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

  // Code revalidates every time (cheap 304s); only binary assets sit in cache.
  const cache = ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css'
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

export default serveStatic;
