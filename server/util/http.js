/** Open Grunker — small HTTP helpers (no framework). */
import config from '../config.js';

const MAX_BODY = 64 * 1024;

/**
 * Real client IP, honouring reverse-proxy headers when trusted.
 *
 * `CF-Connecting-IP` is only read when CF_PROXY says the site really is behind
 * Cloudflare's proxy. nginx forwards whatever headers a client sends, so
 * trusting that one unconditionally would let anybody hand us the address of
 * their choice — and the address is what bans, rate limits and the VPN check
 * are all keyed on. Our own nginx overwrites X-Real-IP and appends to
 * X-Forwarded-For, so those two are only as trustworthy as TRUST_PROXY says.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    if (config.cfProxy) {
      const cf = req.headers['cf-connecting-ip'];
      if (cf) return String(cf).trim();
    }
    const xr = req.headers['x-real-ip'];
    if (xr) return String(xr).trim();
    const xff = req.headers['x-forwarded-for'];
    // The left-most entry is the original client, but every hop can append —
    // only the right-most are ones our proxy wrote. With one proxy in front,
    // the last entry is the address it saw.
    if (xff) {
      const hops = String(xff).split(',').map((h) => h.trim()).filter(Boolean);
      if (hops.length) return config.cfProxy ? hops[0] : hops[hops.length - 1];
    }
  }
  return req.socket?.remoteAddress ?? '0.0.0.0';
}

/** Reads and JSON-parses a request body, rejecting anything oversized. */
export function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * Reads a request body as raw bytes, rejecting anything past `limit`.
 *
 * The upload route needs the bytes themselves — an image is not JSON, and
 * base64 in a JSON envelope would cost a third more bandwidth for nothing.
 * The limit is checked as the body arrives rather than from Content-Length,
 * which is a claim rather than a measurement.
 */
export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413, code: 'too_large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export const ok = (res, body = {}) => json(res, 200, { ok: true, ...body });
export const fail = (res, status, error, extra = {}) => json(res, status, { ok: false, error, ...extra });

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, clear = false } = {}) {
  const secure = config.publicUrl.startsWith('https');
  const bits = [
    `${name}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
    clear ? 'Max-Age=0' : `Max-Age=${maxAge ?? config.sessionTtlDays * 86400}`,
  ].filter(Boolean);
  return bits.join('; ');
}

/** Applies CORS headers for allowed origins; returns true if it was a preflight. */
export function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*'))) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization');
    res.setHeader('access-control-max-age', '86400');
    res.writeHead(204).end();
    return true;
  }
  return false;
}
