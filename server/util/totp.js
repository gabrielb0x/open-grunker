/**
 * Open Grunker — time-based one-time passwords (RFC 6238).
 *
 * Everything an authenticator app needs and nothing it does not: a base32
 * secret, the six digits derived from it, and the `otpauth://` URI a QR code
 * encodes. No dependency — this is HMAC-SHA1 over a counter, which `node:crypto`
 * already does, plus two paragraphs of base32.
 *
 * Two rules the rest of the server relies on:
 *
 *   • Verification is constant-time and window-tolerant. A clock a step out is
 *     the normal case, not an attack, so `WINDOW` steps either side are taken —
 *     and the step that matched is handed back, because a code that has already
 *     been spent must not be spendable a second time (see `db.users.totpUsed`).
 *   • Recovery codes are hashed the same way session tokens are. A database
 *     leak is not a login for either of them.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';

/** RFC 4226/6238 defaults. Every authenticator app assumes all three. */
export const DIGITS = 6;
export const PERIOD = 30;                       // seconds per step
export const ALGORITHM = 'sha1';
/**
 * How far out of step a clock may be. One step either way is ±30s and covers a
 * phone that has not synced today; more than that starts widening the window an
 * attacker gets for a stolen code.
 */
export const WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648, no padding) — the only encoding authenticator apps read. */
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The other direction. Spaces and lower case are accepted: people retype these. */
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A fresh shared secret.
 *
 * 20 bytes is the SHA-1 block size RFC 4226 recommends and what every app
 * expects; it comes back as the base32 string, because that is the only form
 * anything else ever handles it in.
 */
export const newSecret = () => base32Encode(randomBytes(20));

/** The code for one counter value. */
function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(ALGORITHM, key).update(buf).digest();
  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks
  // which four bytes of the digest the code comes out of.
  const offset = digest[digest.length - 1] & 0x0f;
  const bin = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code an app is showing right now. */
export const totp = (secret, atMs = Date.now()) =>
  hotp(secret, Math.floor(atMs / 1000 / PERIOD));

/**
 * Checks a code against the clock.
 *
 * @returns {number|null} the step it matched, or null. The step matters: the
 *   caller records it so the same code cannot be replayed inside its own
 *   thirty-second life, which is the one real weakness of a bare TOTP check.
 */
export function verifyTotp(secret, code, { atMs = Date.now(), window = WINDOW } = {}) {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = Math.floor(atMs / 1000 / PERIOD);
  const wanted = Buffer.from(given);
  for (let d = -window; d <= window; d++) {
    let expected;
    try { expected = Buffer.from(hotp(secret, now + d)); }
    catch { return null; }                       // malformed secret
    if (expected.length === wanted.length && timingSafeEqual(expected, wanted)) return now + d;
  }
  return null;
}

/**
 * The URI behind the QR code.
 *
 * The label carries the issuer as well as the account, because that is what
 * shows in the app's list and "Open Grunker: Nickname" is the only form that
 * reads correctly when somebody has forty of these.
 */
export function otpauthUri({ secret, account, issuer = 'Open Grunker' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: ALGORITHM.toUpperCase(),
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params}`;
}

/* ── Recovery codes ───────────────────────────────────────────────────────── */

export const RECOVERY_CODES = 10;
/** Crockford-ish: no I, L, O, U, so nothing is ambiguous written down. */
const RC_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** One code, in the `XXXXX-XXXXX` shape people can read off paper. */
function oneRecoveryCode() {
  let out = '';
  for (let i = 0; i < 10; i++) {
    if (i === 5) out += '-';
    out += RC_ALPHABET[randomInt(RC_ALPHABET.length)];
  }
  return out;
}

/**
 * A fresh set, plus the hashes to store.
 *
 * The plaintext is shown once and never again — there is nowhere to look it up,
 * which is the point. `hashes` is what goes in the database.
 */
export function newRecoveryCodes(n = RECOVERY_CODES) {
  const codes = Array.from({ length: n }, oneRecoveryCode);
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** Same treatment session tokens get: a leak of the table is not a login. */
export const hashRecoveryCode = (code) =>
  createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');

/** People type these with or without the dash, in either case. */
export const normaliseRecoveryCode = (code) =>
  String(code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

export default {
  DIGITS, PERIOD, WINDOW, RECOVERY_CODES,
  newSecret, totp, verifyTotp, otpauthUri,
  newRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode,
  base32Encode, base32Decode,
};
