/** Open Grunker — in-memory sliding-window rate limiter keyed by IP + bucket. */
import config from '../config.js';

const buckets = new Map();

/**
 * @returns {{allowed:boolean, remaining:number, retryAfter:number}}
 */
export function take(key, max = config.rateMaxRequests, windowMs = config.rateWindowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  const allowed = b.count <= max;
  return {
    allowed,
    remaining: Math.max(0, max - b.count),
    retryAfter: allowed ? 0 : Math.ceil((b.reset - now) / 1000),
  };
}

/** Drops expired buckets so the map cannot grow without bound. */
export function sweep() {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}

setInterval(sweep, 60_000).unref();

export default { take, sweep };
