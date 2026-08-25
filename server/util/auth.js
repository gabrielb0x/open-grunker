/**
 * Open Grunker — password hashing and session tokens.
 *
 * scrypt is run asynchronously on purpose: the game simulation shares this
 * event loop, so a synchronous KDF would stutter every match on every login.
 */
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import config from '../config.js';

const scryptAsync = promisify(scrypt);

const N = config.scryptCost, R = 8, P = 1, KEYLEN = 32;

/** @returns {Promise<string>} `scrypt$N$r$p$saltB64$hashB64` */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time verification; returns false on any malformed input. */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scryptAsync(password, salt, expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Opaque session token handed to the client (never stored server-side). */
export const newToken = () => randomBytes(32).toString('base64url');

/** What we actually store: a SHA-256 of the token, so a DB leak isn't a login. */
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

/** Short random id for guests and rooms. */
export const shortId = (n = 8) => randomBytes(n).toString('base64url').slice(0, n);

/**
 * A name for a player who has not earned the right to pick one.
 *
 * `isTaken` is asked before handing one out, because somebody could register
 * "Guest4417" and wait for the server to give a stranger their name — two of
 * them in the same killfeed, one of them wearing the other's history. After a
 * few collisions it falls back to a form nobody can register: it is longer
 * than `NAME_MAX`.
 *
 * @param {(name: string) => boolean} isTaken
 */
export function guestName(isTaken = () => false) {
  for (let tries = 0; tries < 8; tries++) {
    const name = `Guest${Math.floor(Math.random() * 9000 + 1000)}`;
    if (!isTaken(name)) return name;
  }
  // Longer than NAME_MAX, so this one is not a name anybody can register and
  // then lie in wait for.
  return `Guest-${Date.now().toString(36).toUpperCase()}-${shortId(4)}`;
}
