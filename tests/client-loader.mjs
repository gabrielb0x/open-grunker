/**
 * Open Grunker — module resolution hook for the client tests.
 *
 * The browser resolves `three` through an import map and `/shared/…` from the
 * site root. Node knows neither, so this hook teaches it both, letting the test
 * suite import the client's real modules — and the real three.js — unmodified.
 */
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return { url: pathToFileURL(`${ROOT}/client/vendor/three.module.js`).href, shortCircuit: true };
  }
  // `/js/…` and `/admin/…` are the two roots the browser serves client code
  // from; `/shared/…` is served from the project root itself.
  if (specifier.startsWith('/shared/')) {
    return { url: pathToFileURL(ROOT + specifier).href, shortCircuit: true };
  }
  if (specifier.startsWith('/js/') || specifier.startsWith('/admin/')) {
    return { url: pathToFileURL(`${ROOT}/client${specifier}`).href, shortCircuit: true };
  }
  return next(specifier, context);
}
