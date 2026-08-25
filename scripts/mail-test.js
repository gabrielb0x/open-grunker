#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Open Grunker — send one test message with the current .env settings.
 *
 *   npm run mail:test -- you@example.com
 *
 * Prints exactly what the server would use, then tries to deliver. A failure
 * here is the same failure a player would hit at sign-up, with the SMTP
 * server's own words attached — which is the part a log line usually loses.
 */
import config from '../server/config.js';
import mailer from '../server/util/mailer.js';
import { verifyLink } from '../server/util/verify.js';

const to = process.argv[2];
if (!to) {
  console.error('usage: npm run mail:test -- you@example.com');
  process.exit(2);
}
if (!mailer.looksLikeEmail(to)) {
  console.error(`"${to}" does not look like an address`);
  process.exit(2);
}

const m = config.mail;
console.log('transport   ', m.transport === 'smtp' ? 'smtp' : 'log (nothing will be sent — set MAIL_TRANSPORT=smtp)');
if (m.transport === 'smtp') {
  console.log('server      ', `${m.host || '(SMTP_HOST is empty)'}:${m.port}`);
  console.log('encryption  ', m.secure ? 'implicit TLS' : (m.startTls ? 'STARTTLS' : 'none — plaintext'));
  console.log('user        ', m.user || '(none — no AUTH will be attempted)');
  console.log('password    ', m.pass ? `set, ${m.pass.length} chars` : '(empty)');
}
console.log('from        ', `${m.fromName} <${m.from}>`);
console.log('to          ', to);
console.log('');

const started = Date.now();
const res = await mailer.send({
  to,
  subject: 'Open Grunker — mail test',
  text: [
    'This is the test message from `npm run mail:test`.',
    '',
    'If you are reading it in an inbox, address verification will work: the',
    'confirmation links players receive are sent exactly this way. They look',
    'like this one, which is not a real token:',
    '',
    verifyLink('example-token-not-a-real-one'),
    '',
    '— Open Grunker',
    config.publicUrl,
  ].join('\n'),
});

const ms = Date.now() - started;
if (res.ok && res.transport === 'smtp') {
  console.log(`delivered in ${ms} ms — check the inbox, and the spam folder if it is not there.`);
  console.log('If it landed in spam, the sending domain\'s SPF/DKIM/DMARC need a look: docs/EMAIL.md.');
} else if (res.ok) {
  console.log('The message was written to the log instead of being sent (MAIL_TRANSPORT=log).');
} else {
  console.error(`failed after ${ms} ms: ${res.error}`);
  console.error('\nCommon causes:');
  console.error('  · SMTP_HOST/SMTP_PORT wrong, or the port is firewalled outbound (587, 465)');
  console.error('  · SMTP_USER/SMTP_PASS wrong — most providers want an API key, not your password');
  console.error('  · sending from an address the provider has not verified (MAIL_FROM)');
  console.error('  · Proton Bridge not running, or listening on a different port than SMTP_PORT');
  process.exit(1);
}
