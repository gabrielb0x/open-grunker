/**
 * Open Grunker — the shipped build.
 *
 * `npm run build` rewrites the client into content-hashed chunks, and in
 * production every byte a browser is handed comes out of that rewrite rather
 * than out of the files every other suite reads. So this one checks the
 * artefact itself: that the page points at chunks that exist, that the handful
 * of URLs client code writes as plain strings still resolve, that nothing is
 * left asking the server for `/shared/` or `/js/` — and, the part no static
 * check can do, that the whole bundle evaluates. That last one is where a
 * three.js tree-shaken too far, or a module graph the bundler reordered, would
 * otherwise surface for the first time in someone's browser.
 *
 * Skipped when there is no build: a clone that has never run `npm run build`
 * serves the sources and has nothing here to check.
 *
 * It loads the built page into the shim, so this suite runs last.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suite, check, info } from './harness.mjs';
import { installBrowser, loadPage } from './browser-shim.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, 'client', 'dist');

/** `<script type="module" src="…">` — the one entry the page boots from. */
const entryOf = (html) => html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1] ?? null;
const hashed = (file) => /^[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(file);

export default async function run() {
  suite('build');

  if (!existsSync(join(DIST, 'index.html'))) {
    info('no client/dist — skipped (run `npm run build`)');
    return;
  }

  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const entry = entryOf(html);

  check('the page boots from one module under /assets/',
    !!entry && entry.startsWith('/assets/'), entry ?? '(none)');
  check('and that chunk was actually written', !!entry && existsSync(join(DIST, entry)));

  const css = html.match(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/)?.[1] ?? null;
  check('the stylesheet it links to was written too',
    !!css && existsSync(join(DIST, css)), css ?? '(none)');

  // The whole point of hashing: a chunk's URL changes when its contents do, so
  // nginx can hand it a year-long max-age. A name carried over from a source
  // file would strand players on a cached copy of it.
  const chunks = readdirSync(join(DIST, 'assets')).filter((f) => /\.(?:js|css)$/.test(f));
  check('every chunk is named after its contents, not after a source file',
    chunks.length > 0 && chunks.every(hashed), chunks.join(' · '));

  // three.js moves with a dependency bump; the game moves with every patch.
  // Preloading a second chunk is the tell that they are still separate, which
  // is what keeps a patch from costing returning players the whole download.
  check('three.js sits in its own chunk, so a patch does not re-send it',
    /<link[^>]+rel="modulepreload"[^>]+href="\/assets\//.test(html));

  // Bundled means bundled: nothing may still be reaching for the module tree.
  const js = chunks.filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(DIST, 'assets', f), 'utf8')).join('\n');
  for (const [what, needle] of [['the shared game code', '/shared/'], ['the client modules', '/js/'],
    ['the unbundled three.js', '/vendor/']]) {
    check(`${what} is inlined, not fetched`, !html.includes(needle) && !js.includes(needle), needle);
  }
  check('the import map is gone with it', !html.includes('importmap'));

  // Two files keep a fixed URL because HUD, menu and admin markup write those
  // URLs out as strings at runtime — a hash on either is a broken image.
  for (const pinned of ['check.png', 'assets/favicon.svg']) {
    check(`/${pinned} kept its name`, existsSync(join(DIST, pinned)));
  }
  const imgs = [...html.matchAll(/<img[^>]+src="(\/[^"]+)"/g)].map((m) => m[1]);
  check('and every image the page names resolves in the build',
    imgs.length > 0 && imgs.every((src) => existsSync(join(DIST, src.slice(1)))),
    [...new Set(imgs)].join(' · '));

  /* ── The admin panel ─────────────────────────────────────────────────── */

  const adminHtml = existsSync(join(DIST, 'admin', 'index.html'))
    ? readFileSync(join(DIST, 'admin', 'index.html'), 'utf8') : '';
  check('the admin panel was built as well', !!adminHtml);

  const adminEntry = entryOf(adminHtml);
  // nginx answers /admin with a flat 404 and the server refuses it from
  // anything but loopback, so the panel's code has to stay under that prefix —
  // a chunk of it in the public /assets/ pile would be downloadable by anyone.
  check('its code stays under /admin/, where nothing public can reach it',
    !!adminEntry && adminEntry.startsWith('/admin/assets/'), adminEntry ?? '(none)');
  check('and that chunk was written', !!adminEntry && existsSync(join(DIST, adminEntry)));

  /* ── The bundle runs ─────────────────────────────────────────────────── */

  installBrowser();
  loadPage('client/dist/index.html');

  // main.js does its work on DOMContentLoaded, which the shim never fires;
  // recording the registration is how we know the entry ran all the way down
  // rather than throwing somewhere in the middle.
  const registered = [];
  globalThis.window.addEventListener = (type) => { registered.push(type); };

  // three.js warns that it has been imported twice here; the sources loaded a
  // copy earlier in the run and the bundle carries its own. Both are the same
  // release, and nothing in this suite renders.
  let boom = null;
  try {
    await import(pathToFileURL(join(DIST, entry)).href);
  } catch (err) {
    boom = err;
  }
  check('the bundle evaluates against the built page', !boom, boom ? boom.message : '');
  check('and the entry reaches its boot handler',
    registered.includes('DOMContentLoaded'), registered.join(' · ') || '(none)');
}
