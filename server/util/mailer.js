/**
 * Open Grunker — outbound email.
 *
 * A small SMTP client rather than a dependency: the server sends exactly one
 * kind of message (an address-verification link), and that needs EHLO,
 * STARTTLS, AUTH and DATA — a few hundred lines, not a supply chain.
 *
 * Two transports:
 *   • `smtp` — a real server (Proton Bridge on localhost, Proton's business
 *     SMTP submission, or any provider that speaks submission on 587/465).
 *   • `log`  — writes the link to the server log. What a machine with no mail
 *     credentials should do, so sign-up still works while you set the rest up.
 *
 * Bodies are base64-encoded, which sidesteps line-length limits and SMTP's
 * leading-dot rule entirely.
 */
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import config from '../config.js';
import log from './log.js';

const logger = log.child('mail');

/* ── MIME ────────────────────────────────────────────────────────────────── */

/** RFC 2047 encoded-word, for a header that carries anything but plain ASCII. */
function encodeHeader(value) {
  const text = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/** `Name <addr@host>`, with the display part encoded when it needs to be. */
function address(addr, name = '') {
  return name ? `${encodeHeader(name)} <${addr}>` : addr;
}

const base64Body = (text) =>
  Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

/** Builds the full RFC 5322 message, headers and all. */
export function buildMessage({ to, subject, text, html, from, fromName, replyTo, messageId }) {
  const boundary = `og-${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${address(from, fromName)}`,
    `To: ${address(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId ?? `<${randomBytes(16).toString('hex')}@${from.split('@')[1] ?? 'localhost'}>`}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  if (replyTo) headers.push(`Reply-To: ${address(replyTo)}`);

  if (!html) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${base64Body(text)}`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html),
    `--${boundary}--`,
    '',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

/* ── SMTP conversation ───────────────────────────────────────────────────── */

/**
 * One SMTP session, driven as a sequence of awaited commands.
 *
 * The socket is line-buffered here rather than by a stream transform: SMTP
 * replies are short, and a multi-line reply (`250-SIZE` … `250 HELP`) is only
 * complete once a line arrives whose fourth character is a space.
 */
class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.buffer = '';
    this.pending = null;         // { resolve, reject, lines }
    this.closed = false;
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('timeout', () => this.fail(new Error('SMTP timeout')));
    socket.on('close', () => {
      this.closed = true;
      if (this.pending) this.fail(new Error('SMTP connection closed early'));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!this.pending) continue;                   // unsolicited chatter
      this.pending.lines.push(line);
      // A space in the fourth column ends a reply; a hyphen continues it.
      if (line.length >= 4 && line[3] === '-') continue;
      const { resolve, lines } = this.pending;
      this.pending = null;
      resolve({ code: Number(lines[0].slice(0, 3)), lines });
    }
  }

  fail(err) {
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
    else if (!this.closed) logger.debug('smtp socket error:', err.message);
  }

  /** Waits for one complete reply. */
  read() {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('SMTP connection closed'));
      this.pending = { resolve, reject, lines: [] };
    });
  }

  /** Sends a command and returns its reply. `expect` codes reject otherwise. */
  async cmd(line, expect = [250], { secret = false } = {}) {
    logger.debug(`> ${secret ? '***' : line}`);
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    logger.debug(`< ${reply.lines.join(' | ')}`);
    if (expect.length && !expect.includes(reply.code)) {
      throw new Error(`SMTP ${reply.code}: ${reply.lines.join(' ')}`);
    }
    return reply;
  }

  end() {
    try { this.socket.end(); } catch { /* already gone */ }
  }
}

const openSocket = (opts) => new Promise((resolve, reject) => {
  const socket = opts.tls
    ? tlsConnect({
      host: opts.host, port: opts.port, servername: opts.host,
      rejectUnauthorized: opts.rejectUnauthorized,
    }, () => resolve(socket))
    : createConnection({ host: opts.host, port: opts.port }, () => resolve(socket));
  socket.once('error', reject);
});

/** Delivers one message over SMTP. Throws with a readable reason on failure. */
async function sendSmtp({ to, message, envelopeFrom }) {
  const m = config.mail;
  if (!m.host) throw new Error('SMTP_HOST is not set');

  let socket = await openSocket({
    host: m.host, port: m.port, tls: m.secure, rejectUnauthorized: m.tlsRejectUnauthorized,
  });
  let session = new SmtpSession(socket, m.timeoutMs);
  const ehloName = hostname() || 'open-grunker';

  try {
    const greeting = await session.read();
    if (greeting.code !== 220) throw new Error(`SMTP greeting ${greeting.code}: ${greeting.lines.join(' ')}`);

    let caps = (await session.cmd(`EHLO ${ehloName}`)).lines.join(' ').toUpperCase();

    // STARTTLS upgrade. The plain socket is handed to the TLS layer and the
    // whole conversation restarts, as the RFC requires.
    if (!m.secure && m.startTls && caps.includes('STARTTLS')) {
      await session.cmd('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      socket.removeAllListeners('timeout');
      socket = await new Promise((resolve, reject) => {
        const upgraded = tlsConnect({
          socket, servername: m.host, rejectUnauthorized: m.tlsRejectUnauthorized,
        }, () => resolve(upgraded));
        upgraded.once('error', reject);
      });
      session = new SmtpSession(socket, m.timeoutMs);
      caps = (await session.cmd(`EHLO ${ehloName}`)).lines.join(' ').toUpperCase();
    }

    if (m.user) {
      if (caps.includes('AUTH') && caps.includes('PLAIN')) {
        const token = Buffer.from(`\0${m.user}\0${m.pass}`, 'utf8').toString('base64');
        await session.cmd(`AUTH PLAIN ${token}`, [235], { secret: true });
      } else {
        await session.cmd('AUTH LOGIN', [334]);
        await session.cmd(Buffer.from(m.user, 'utf8').toString('base64'), [334], { secret: true });
        await session.cmd(Buffer.from(m.pass, 'utf8').toString('base64'), [235], { secret: true });
      }
    }

    await session.cmd(`MAIL FROM:<${envelopeFrom}>`, [250]);
    await session.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await session.cmd('DATA', [354]);
    // The body is base64, so no line can start with a dot; the terminator is
    // still written the way the protocol spells it.
    socket.write(`${message}\r\n.\r\n`);
    const stored = await session.read();
    if (stored.code !== 250) throw new Error(`SMTP ${stored.code}: ${stored.lines.join(' ')}`);
    await session.cmd('QUIT', []).catch(() => {});
  } finally {
    session.end();
  }
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/** Is a real transport configured, or are we just logging links? */
export const isLive = () => config.mail.transport === 'smtp' && !!config.mail.host;

/** A quick, non-authoritative sanity check on an address. */
export function looksLikeEmail(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s.length >= 5 && s.length <= 190 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}

/**
 * Sends one message. Never throws: a mail server that is down must not take
 * the sign-up down with it, so failures come back as `{ ok: false }` and the
 * caller decides what to tell the player.
 *
 * @returns {Promise<{ok: boolean, transport: string, error?: string}>}
 */
export async function send({ to, subject, text, html }) {
  const m = config.mail;
  const message = buildMessage({
    to, subject, text, html,
    from: m.from, fromName: m.fromName, replyTo: m.replyTo || null,
  });

  if (!isLive()) {
    // Everything a developer needs to finish the flow by hand.
    logger.info(`[mail:log] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    return { ok: true, transport: 'log' };
  }

  try {
    await sendSmtp({ to, message, envelopeFrom: m.from });
    logger.info(`sent "${subject}" to ${to}`);
    return { ok: true, transport: 'smtp' };
  } catch (err) {
    logger.error(`could not send to ${to}: ${err.message}`);
    return { ok: false, transport: 'smtp', error: err.message };
  }
}

export default { send, isLive, looksLikeEmail, buildMessage };
