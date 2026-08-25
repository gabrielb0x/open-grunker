#!/usr/bin/env node
/**
 * Copies the browser build of three.js out of node_modules into client/vendor/
 * so the client can be served as plain ES modules with no bundler in the loop.
 */
import { copyFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR = join(ROOT, 'client', 'vendor');

const FILES = [
  ['node_modules/three/build/three.module.js', 'three.module.js'],
  ['node_modules/three/build/three.core.js', 'three.core.js'],
];

const exists = (p) => access(p).then(() => true, () => false);

await mkdir(VENDOR, { recursive: true });
let copied = 0;
for (const [src, dest] of FILES) {
  const from = join(ROOT, src);
  if (!(await exists(from))) continue;      // three.core.js only exists on newer builds
  await copyFile(from, join(VENDOR, dest));
  copied++;
  console.log(`vendor: ${dest}`);
}
if (copied === 0) console.warn('vendor: nothing copied — run `npm install` first');
