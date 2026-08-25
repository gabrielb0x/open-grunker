/**
 * Open Grunker — minimal path router.
 *
 * Supports `/a/:param` segments and a trailing `*` wildcard. Deliberately tiny:
 * the whole API is a dozen endpoints and pulling in a framework for that would
 * add more surface than it saves.
 */
import { fail } from '../util/http.js';
import log from '../util/log.js';

const logger = log.child('api');

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ method, parts, handler, pattern });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, path) {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;

    for (const route of this.routes) {
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const rp = route.parts[i];
        if (rp === '*') { params.rest = segs.slice(i).join('/'); ok = true; break; }
        const sp = segs[i];
        if (sp === undefined) { ok = false; break; }
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(sp);
        else if (rp !== sp) { ok = false; break; }
      }
      if (ok && !route.parts.includes('*') && segs.length !== route.parts.length) ok = false;
      if (!ok) continue;
      if (route.method !== method) { methodMismatch = true; continue; }
      return { route, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }

  /** @returns {Promise<boolean>} true when a route handled the request */
  async handle(ctx) {
    const hit = this.match(ctx.method, ctx.path);
    if (!hit) return false;
    if (hit.methodMismatch) { fail(ctx.res, 405, 'method_not_allowed'); return true; }

    ctx.params = hit.params;
    try {
      await hit.route.handler(ctx);
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) logger.error(`${ctx.method} ${ctx.path}:`, err.stack ?? err.message);
      else logger.debug(`${ctx.method} ${ctx.path}: ${err.message}`);
      // Keep the human-readable message: the client shows it verbatim.
      if (!ctx.res.headersSent) {
        const code = err.code ?? (status >= 500 ? 'internal_error' : 'error');
        const message = status >= 500 ? undefined : err.message;
        fail(ctx.res, status, code, message && message !== code ? { message } : {});
      }
    }
    return true;
  }
}

/** Throwable HTTP error with a machine-readable code. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export default Router;
