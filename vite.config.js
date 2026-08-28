/**
 * Open Grunker — client build.
 *
 * The client is written as plain ES modules and still runs that way with no
 * bundler in the loop, which is what `CLIENT_DIR=client` serves. This config is
 * the shipping path on top of that: it teaches Vite the two specifiers only a
 * browser resolves — `three` from the import map and `/shared/…` from the site
 * root — tree-shakes three.js down to the parts the game actually touches, and
 * emits every chunk under a content-hashed name so nginx can cache them for a
 * year and a patch invalidates only what changed.
 *
 * ── Commands ──────────────────────────────────────────────────────────────
 *
 *   npm run build        both builds, in the only order that works
 *   npm run dev:client   Vite dev server on :7500, HMR, no build
 *
 * `npm run build` is `vite build && vite build --mode admin`, and the two
 * halves can be run alone when only one of them changed:
 *
 *   vite build                 game        -> client/dist
 *   vite build --mode admin    admin panel -> client/dist/admin
 *
 * They are separate runs rather than two inputs to one build because the panel
 * must not share a chunk directory with the game: everything under
 * `client/dist/assets/` is public, and nginx answers `/admin` with a flat 404.
 * The game build empties client/dist and the panel's build empties nothing, so
 * the order is not a style preference — running the panel first and the game
 * second deletes the panel.
 *
 * `npm run dev:client` serves the sources straight out of `client/` and proxies
 * `/api`, `/avatars` and `/ws` to a game server on :7420, so it needs
 * `npm start` (or `npm run dev`) running beside it; everything stateful — the
 * database, sessions, live matches — stays with that server. It never writes
 * client/dist, so it cannot be what puts a change on the site.
 *
 * What the deployed server actually serves is `client/dist` if that directory
 * exists and `client/` if it does not (server/config.js). Two consequences
 * worth knowing before wondering why an edit did nothing: once anyone has run a
 * build, `npm start` serves the bundle and editing `client/js/*.js` changes
 * nothing until the next build; and to go back to reading the sources, either
 * delete client/dist or start the server with `CLIENT_DIR=client`.
 */
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(ROOT, 'client');
const OUT = resolve(CLIENT, 'dist');

/**
 * Two files have to keep the exact URL they have today, because client code
 * writes those URLs as strings at runtime rather than importing them:
 * `/check.png` is built into HUD, menu and admin markup, and
 * `/assets/favicon.svg` is what the admin listener serves by name. Everything
 * else gets a hash.
 */
const PINNED = new Map([
  ['check.png', 'check.png'],
  ['favicon.svg', 'assets/favicon.svg'],
]);

const assetName = (prefix) => (asset) =>
  PINNED.get(asset.names?.[0] ?? '') ?? `${prefix}assets/[hash][extname]`;

/**
 * Trims the shipped HTML.
 *
 * The import map is dead weight once three.js is part of a chunk — nothing in
 * the bundle imports a bare specifier any more — and the source's block
 * comments are notes for whoever edits the file, not for whoever downloads it.
 * The alternation eats `<script>` and `<style>` bodies first, so a comment
 * inside one is never mistaken for markup.
 */
const trimHtml = () => ({
  name: 'open-grunker:trim-html',
  apply: 'build',
  enforce: 'post',
  transformIndexHtml: (html) => html
    .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/g, '')
    .replace(
      /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g,
      (m) => (m.startsWith('<!--') ? '' : m),
    )
    .replace(/\n{3,}/g, '\n\n'),
});

/** Everything both builds agree on. */
const common = {
  root: CLIENT,
  base: '/',
  // No public/ directory: the files that need a stable name are pinned above.
  publicDir: false,
  // Explicit so that the server's own .env — which sits at the project root and
  // holds the SMTP and admin secrets — is never in a directory Vite reads.
  envDir: CLIENT,
  plugins: [trimHtml()],
  resolve: {
    // The browser serves the code shared with the server from the site root.
    alias: [{ find: /^\/shared\//, replacement: `${resolve(ROOT, 'shared')}/` }],
  },
  build: {
    outDir: OUT,
    // three.js alone is ~540 kB minified; below that there is nothing to warn about.
    chunkSizeWarningLimit: 700,
  },
};

export default defineConfig(({ mode }) => (mode === 'admin' ? {
  ...common,
  build: {
    ...common.build,
    emptyOutDir: false,               // the game build already cleared client/dist
    rollupOptions: {
      input: resolve(CLIENT, 'admin/index.html'),
      output: {
        entryFileNames: 'admin/assets/[hash].js',
        chunkFileNames: 'admin/assets/[hash].js',
        assetFileNames: assetName('admin/'),
      },
    },
  },
} : {
  ...common,
  build: {
    ...common.build,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[hash].js',
        chunkFileNames: 'assets/[hash].js',
        assetFileNames: assetName(''),
        // three.js changes with a dependency bump, the game changes with every
        // patch. Splitting them means a patch costs returning players the game
        // chunk alone instead of the whole download again.
        codeSplitting: { groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }] },
      },
    },
  },
  server: {
    // `npm run dev:client` — HMR for the client against a game server already
    // running on PORT. Everything stateful stays with that server.
    port: 7500,
    proxy: {
      '/api': 'http://127.0.0.1:7420',
      '/avatars': 'http://127.0.0.1:7420',
      '/ws': { target: 'ws://127.0.0.1:7420', ws: true },
    },
  },
}));
