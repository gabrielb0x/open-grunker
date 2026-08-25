/**
 * Open Grunker — address intelligence: is this connection a VPN, a proxy, a
 * Tor exit or a datacenter?
 *
 * Two providers, both optional:
 *   • `ipapi`      — ip-api.com. No key, no signup, 45 lookups a minute, HTTP
 *                    only on the free tier. The default.
 *   • `proxycheck` — proxycheck.io. Needs a key, speaks HTTPS, far better on
 *                    residential proxies. Set PROXYCHECK_KEY to use it.
 *
 * Every verdict is cached in SQLite (and in memory), so a player reconnecting
 * between matches costs nothing. Lookups that fail decide nothing: by default
 * the connection is let through (`VPN_FAIL_OPEN`), because an unreachable
 * third party is not evidence of cheating.
 */
import config from '../config.js';
import log from './log.js';
import { ipIntel as store, normaliseIp } from '../db/index.js';

const logger = log.child('ipintel');

/** Recently seen verdicts, so a burst of joins never touches SQLite either. */
const memo = new Map();
const MEMO_MAX = 2000;
/** Lookups already in flight, keyed by address — never ask twice at once. */
const inflight = new Map();

/* ── Address shapes ──────────────────────────────────────────────────────── */

const v4 = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
};

/**
 * Loopback, RFC1918, CGNAT, link-local and unique-local addresses. Nobody
 * reaches a public server from one of these unless they are on the same LAN or
 * behind our own reverse proxy, so they are never treated as suspicious.
 */
export function isPrivate(ip) {
  const addr = normaliseIp(ip);
  if (!addr || addr === '0.0.0.0') return true;
  if (addr === '::1' || addr === '::') return true;
  if (addr.startsWith('fc') || addr.startsWith('fd') || addr.startsWith('fe80')) return true;
  const p = v4(addr);
  if (!p) return false;
  const [a, b] = p;
  return a === 10 || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

/** Matches an address against `1.2.3.4`, `1.2.3.0/24` or an IPv6 prefix. */
export function matchesRule(ip, rule) {
  const addr = normaliseIp(ip);
  const r = normaliseIp(rule);
  if (!r) return false;
  if (!r.includes('/')) return addr === r;

  const [net, bitsRaw] = r.split('/');
  const bits = Number(bitsRaw);
  const a = v4(addr), n = v4(net);
  if (a && n && Number.isFinite(bits) && bits >= 0 && bits <= 32) {
    const toInt = (q) => ((q[0] << 24) | (q[1] << 16) | (q[2] << 8) | q[3]) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(a) & mask) === (toInt(n) & mask);
  }
  // IPv6: a textual prefix match is coarse but honest, and this is an
  // allow-list — being slightly generous costs nothing.
  return addr.startsWith(net.replace(/:+$/, ''));
}

const allowListed = (ip) => config.vpn.allow.some((rule) => matchesRule(ip, rule));

/* ── Providers ───────────────────────────────────────────────────────────── */

async function askIpApi(ip, signal) {
  // The free endpoint is HTTP-only; the paid one is https://pro.ip-api.com.
  const url = `${config.vpn.ipapiUrl}${encodeURIComponent(ip)}`
    + '?fields=status,message,countryCode,proxy,hosting,as';
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  const data = await res.json();
  if (data?.status !== 'success') throw new Error(data?.message || 'lookup failed');
  return {
    proxy: !!data.proxy,
    hosting: !!data.hosting,
    // ip-api folds Tor into `proxy`; it has no separate flag.
    tor: false,
    country: data.countryCode ?? null,
    asn: data.as ?? null,
    detail: data.proxy ? 'proxy' : (data.hosting ? 'hosting' : 'clean'),
    provider: 'ip-api',
  };
}

async function askProxycheck(ip, signal) {
  const key = config.vpn.proxycheckKey;
  const url = `${config.vpn.proxycheckUrl}${encodeURIComponent(ip)}`
    + `?vpn=1&asn=1&risk=1${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  const data = await res.json();
  if (data?.status !== 'ok' && data?.status !== 'warning') {
    throw new Error(data?.message || `lookup ${data?.status ?? 'failed'}`);
  }
  const row = data[ip] ?? {};
  const type = String(row.type ?? '').toLowerCase();
  return {
    proxy: row.proxy === 'yes',
    hosting: type.includes('hosting') || type.includes('business')
      ? type.includes('hosting')
      : row.proxy === 'yes' && type.includes('vpn'),
    tor: type.includes('tor'),
    country: row.isocode ?? null,
    asn: row.asn ?? null,
    detail: row.type ?? (row.proxy === 'yes' ? 'proxy' : 'clean'),
    provider: 'proxycheck',
  };
}

/* ── Classification ──────────────────────────────────────────────────────── */

const remember = (ip, verdict) => {
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(ip, { verdict, at: Date.now() });
  return verdict;
};

/**
 * What do we know about this address?
 *
 * @returns {Promise<{ip:string, proxy:boolean, hosting:boolean, tor:boolean,
 *   country:string|null, asn:string|null, detail:string|null,
 *   source:'private'|'allowlist'|'disabled'|'memo'|'cache'|'live'|'error'}>}
 */
export async function classify(rawIp) {
  const ip = normaliseIp(rawIp);
  const clean = (source, extra = {}) => ({
    ip, proxy: false, hosting: false, tor: false,
    country: null, asn: null, detail: null, source, ...extra,
  });

  if (isPrivate(ip)) return clean('private');
  if (allowListed(ip)) return clean('allowlist');
  if (config.vpn.provider === 'none') return clean('disabled');

  const hit = memo.get(ip);
  const ttlMs = config.vpn.cacheHours * 3600_000;
  if (hit && Date.now() - hit.at < ttlMs) return { ...hit.verdict, source: 'memo' };

  const row = store.get(ip, config.vpn.cacheHours * 3600);
  if (row) {
    return remember(ip, {
      ip, proxy: !!row.proxy, hosting: !!row.hosting, tor: !!row.tor,
      country: row.country, asn: row.asn, detail: row.detail, source: 'cache',
    });
  }

  if (inflight.has(ip)) return inflight.get(ip);

  const job = (async () => {
    const signal = AbortSignal.timeout(config.vpn.timeoutMs);
    try {
      const ask = config.vpn.provider === 'proxycheck' ? askProxycheck : askIpApi;
      const found = await ask(ip, signal);
      store.put({ ip, ...found });
      logger.debug(`${ip}: ${found.detail} (${found.provider})`);
      return remember(ip, { ip, ...found, source: 'live' });
    } catch (err) {
      // Deliberately not cached: the next join should try again.
      logger.debug(`${ip}: lookup failed — ${err.message}`);
      return clean('error', { detail: err.message });
    } finally {
      inflight.delete(ip);
    }
  })();

  inflight.set(ip, job);
  return job;
}

/**
 * Should this connection be refused?
 *
 * @returns {Promise<{blocked:boolean, reason:string|null, info:object}>}
 */
export async function check(ip) {
  const info = await classify(ip);
  if (!config.vpn.block) return { blocked: false, reason: null, info };
  if (['private', 'allowlist', 'disabled'].includes(info.source)) {
    return { blocked: false, reason: null, info };
  }
  if (info.source === 'error') {
    return config.vpn.failOpen
      ? { blocked: false, reason: null, info }
      : { blocked: true, reason: 'could not verify your connection — try again', info };
  }

  if (info.tor && config.vpn.blockTor) {
    return { blocked: true, reason: 'Tor exit nodes cannot play here', info };
  }
  if (info.proxy) {
    return { blocked: true, reason: 'turn your VPN or proxy off to play', info };
  }
  if (info.hosting && config.vpn.blockHosting) {
    return { blocked: true, reason: 'this connection comes from a datacenter — turn your VPN or proxy off to play', info };
  }
  return { blocked: false, reason: null, info };
}

/** What a refused connection is told. Kept in one place so WS and REST agree. */
export function refusalPayload(reason, info = {}) {
  return {
    code: 'vpn_blocked',
    message: reason || 'turn your VPN or proxy off to play',
    detail: info.detail ?? null,
    appeal: config.banAppealContact,
  };
}

/** Drops the in-memory layer. Used by tests and after a config reload. */
export const forget = () => { memo.clear(); inflight.clear(); };

export default { classify, check, isPrivate, matchesRule, refusalPayload, forget };
