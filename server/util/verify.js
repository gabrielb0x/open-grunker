/**
 * Open Grunker — address verification: the token, the link and the message.
 *
 * The link points at the game itself (`/?verify=<token>`) rather than at an
 * API route, so clicking it lands the player in the menu they already know,
 * signed-in state and all. The client hands the token straight back to
 * `POST /auth/verify`.
 */
import config from '../config.js';
import log from './log.js';
import { newToken, hashToken } from './auth.js';
import mailer from './mailer.js';

const logger = log.child('verify');

export const verifyLink = (token) =>
  `${config.publicUrl.replace(/\/+$/, '')}/?verify=${encodeURIComponent(token)}`;

function template(username, link, hours) {
  const text = [
    `Hi ${username},`,
    '',
    'Confirm this address to finish setting up your Open Grunker account:',
    '',
    link,
    '',
    `The link works for ${hours} hours. If you did not create an account, ignore this message —`,
    'nothing happens until the link is opened.',
    '',
    '— Open Grunker',
    config.publicUrl,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;background:#0b0e14;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#dfe6f2">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <h1 style="margin:0 0 8px;font-size:20px;letter-spacing:.06em;color:#f0a010">OPEN GRUNKER</h1>
    <p style="margin:0 0 24px;color:#8d99ad">Confirm your email address</p>
    <p style="margin:0 0 16px">Hi <b>${escapeHtml(username)}</b>, confirm this address to finish setting up your account.</p>
    <p style="margin:0 0 24px">
      <a href="${escapeHtml(link)}"
         style="display:inline-block;padding:12px 22px;background:#f0a010;color:#0b0e14;
                text-decoration:none;font-weight:700;letter-spacing:.04em;border-radius:4px">
        CONFIRM MY ADDRESS
      </a>
    </p>
    <p style="margin:0 0 8px;color:#8d99ad;font-size:13px">Or paste this into your browser:</p>
    <p style="margin:0 0 24px;word-break:break-all;font-size:13px;color:#6f7c92">${escapeHtml(link)}</p>
    <p style="margin:0;color:#6f7c92;font-size:13px">
      The link works for ${hours} hours. If you did not create an account, ignore this message.
    </p>
  </div>
</body></html>`;

  return { text, html };
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Issues a fresh link and mails it. Any previous link for the account stops
 * working, so a resend never leaves two valid tokens in someone's inbox.
 *
 * @returns {Promise<{ok:boolean, transport:string, link:string, error?:string}>}
 */
export async function sendVerification(db, { user, email, ip = null }) {
  const address = String(email ?? user.email ?? '').trim();
  if (!address) return { ok: false, transport: 'none', link: '', error: 'no address on file' };

  const token = newToken();
  const hours = config.emailVerification.ttlHours;
  db.emailTokens.create({
    tokenHash: hashToken(token), userId: user.id, email: address, ttlHours: hours, ip,
  });

  const link = verifyLink(token);
  const { text, html } = template(user.username, link, hours);
  const res = await mailer.send({
    to: address,
    subject: 'Confirm your Open Grunker account',
    text,
    html,
  });

  if (res.ok) logger.info(`verification link sent to ${address} for ${user.username}`);
  else logger.warn(`verification link for ${user.username} could not be sent: ${res.error}`);

  return { ...res, link };
}

export default { sendVerification, verifyLink };
