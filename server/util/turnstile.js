/**
 * Open Grunker — Cloudflare Turnstile verification.
 *
 * Two independent widgets: one on the sign-up form, one on sign-in. Each has
 * its own key pair, so a leaked or rotated key on one form never touches the
 * other. The site key is public and shipped to the browser through `/meta`;
 * the secret never leaves this process.
 *
 * A form with no secret configured is simply not protected — that is the only
 * way to run the server without Cloudflare at all (tests, a LAN box). A form
 * *with* a secret always fails shut: no token, no account.
 */
import config from '../config.js';
import log from './log.js';

const logger = log.child('turnstile');

/** @typedef {'register'|'login'} Form */

/** The key pair for one form, or null when that form is unprotected. */
export function keysFor(form) {
  const t = config.turnstile;
  if (!t.enabled) return null;
  const pair = t[form];
  if (!pair?.secret) return null;
  return pair;
}

/** The public site key for a form, or null. Safe to hand to the browser. */
export const siteKeyFor = (form) => keysFor(form)?.siteKey || null;

/** Is this form actually challenging people right now? */
export const isProtected = (form) => !!keysFor(form);

/**
 * Verifies one solved challenge with Cloudflare.
 *
 * @param {Form} form which widget the token came from
 * @param {string} token the `cf-turnstile-response` value from the browser
 * @param {string} [ip] the player's address, so Cloudflare can cross-check it
 * @returns {Promise<{ok: boolean, skipped?: boolean, codes?: string[], reason?: string}>}
 */
export async function verify(form, token, ip = null) {
  const pair = keysFor(form);
  if (!pair) return { ok: true, skipped: true };
  if (typeof token !== 'string' || !token || token.length > 4096) {
    return { ok: false, reason: 'missing', codes: ['missing-input-response'] };
  }

  const body = new URLSearchParams({ secret: pair.secret, response: token });
  // Cloudflare rejects the field outright if it is not a plain address, and a
  // proxy header we half-trust is not worth failing a real player over.
  if (ip && !ip.startsWith('::ffff:') && ip !== '0.0.0.0') body.set('remoteip', ip);

  const signal = AbortSignal.timeout(config.turnstile.timeoutMs);
  let data;
  try {
    const res = await fetch(config.turnstile.verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
    data = await res.json();
  } catch (err) {
    // Cloudflare unreachable. Failing open here would make the widget
    // decorative, so this is a hard failure the player can retry.
    logger.warn(`siteverify unreachable (${form}): ${err.message}`);
    return { ok: false, reason: 'unreachable', codes: ['internal-error'] };
  }

  if (data?.success) return { ok: true };
  const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'] : [];
  logger.debug(`challenge refused (${form}): ${codes.join(', ') || 'no reason given'}`);
  return { ok: false, reason: 'refused', codes };
}

/** A message a player can act on, from Cloudflare's machine-readable codes. */
export function humanError(result) {
  const codes = result?.codes ?? [];
  if (result?.reason === 'unreachable') {
    return 'could not reach the anti-bot check — try again in a moment';
  }
  if (codes.includes('timeout-or-duplicate')) {
    return 'that anti-bot check expired — solve it again';
  }
  if (codes.includes('missing-input-response') || result?.reason === 'missing') {
    return 'complete the anti-bot check first';
  }
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
    // Server-side misconfiguration; say so plainly rather than blaming the player.
    return 'the anti-bot check is misconfigured on this server — tell the operator';
  }
  return 'the anti-bot check did not pass — try again';
}

export default { verify, keysFor, siteKeyFor, isProtected, humanError };
