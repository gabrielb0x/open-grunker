/**
 * Accounts: the anti-bot check, address verification, VPN refusal, the paid
 * rename, guest naming and "one player, one game".
 *
 * Half of this is unit-level. The other half boots the real server as a child
 * process and drives it over HTTP and WebSocket, because the parts that matter
 * most here — a captcha the route actually enforces, a confirmation link that
 * really arrives, a second connection that really loses its seat — only exist
 * once all the pieces are wired together.
 *
 * Cloudflare and the address-lookup provider are replaced by a local stub, so
 * the suite never touches the network and never depends on somebody else's
 * uptime.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

import * as K from '../shared/constants.js';
import { suite, check, info, sleep } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ── The stub Cloudflare + address-lookup service ────────────────────────── */

const GOOD_CAPTCHA = 'solved-by-a-human';
/** Addresses the stub reports as a VPN exit, and ones it calls clean. */
const PROXY_IP = '203.0.113.9';
const CLEAN_IP = '198.51.100.5';

function startStub() {
  const seen = { siteverify: [], lookups: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    res.setHeader('content-type', 'application/json');

    if (url.pathname === '/siteverify') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        seen.siteverify.push({ secret: form.get('secret'), response: form.get('response') });
        const ok = form.get('response') === GOOD_CAPTCHA;
        res.end(JSON.stringify(ok
          ? { success: true, action: 'test' }
          : { success: false, 'error-codes': ['invalid-input-response'] }));
      });
      return;
    }

    if (url.pathname.startsWith('/ipapi/')) {
      const ip = decodeURIComponent(url.pathname.slice('/ipapi/'.length));
      seen.lookups.push(ip);
      res.end(JSON.stringify(ip === PROXY_IP
        ? { status: 'success', countryCode: 'NL', proxy: true, hosting: true, as: 'AS9009 M247' }
        : { status: 'success', countryCode: 'FR', proxy: false, hosting: false, as: 'AS3215 Orange' }));
      return;
    }

    res.writeHead(404).end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

/* ── The server under test ───────────────────────────────────────────────── */

const freePort = () => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function startServer({ port, dbPath, stubPort }) {
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', join(ROOT, 'server/index.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        DB_PATH: dbPath,
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        LOG_LEVEL: 'info',
        SERVE_STATIC: 'false',
        ADMIN_ENABLED: 'false',
        BOTS_ENABLED: 'false',
        PRACTICE_BOTS: '0',
        ROOMS: 'burgtown:ffa',
        // Every account route is exercised many times over in one minute.
        RATE_MAX_REQUESTS: '5000',
        RATE_MAX_AUTH: '500',
        SCRYPT_COST: '1024',                       // a test is not a threat model

        TURNSTILE_ENABLED: 'true',
        TURNSTILE_SITEKEY_REGISTER: 'site-register',
        TURNSTILE_SECRET_REGISTER: 'secret-register',
        TURNSTILE_SITEKEY_LOGIN: 'site-login',
        TURNSTILE_SECRET_LOGIN: 'secret-login',
        TURNSTILE_VERIFY_URL: `http://127.0.0.1:${stubPort}/siteverify`,

        EMAIL_VERIFICATION: 'true',
        EMAIL_REQUIRED: 'true',
        EMAIL_VERIFY_ENFORCE: 'true',
        EMAIL_RESEND_COOLDOWN_SEC: '0',
        MAIL_TRANSPORT: 'log',

        VPN_BLOCK: 'true',
        VPN_PROVIDER: 'ipapi',
        VPN_IPAPI_URL: `http://127.0.0.1:${stubPort}/ipapi/`,
        VPN_FAIL_OPEN: 'false',

        SINGLE_SESSION: 'true',
        SINGLE_SESSION_POLICY: 'takeover',
        RENAME_COST: '100',
      },
    });

  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { child, base, log: () => out };
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  throw new Error(`server did not start:\n${out}`);
}

/* ── Small clients ───────────────────────────────────────────────────────── */

/** POST/GET returning `{ status, body }` rather than throwing on a 4xx. */
async function call(base, method, path, { body, token, ip } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  // TRUST_PROXY is on, so this is how a test wears a different address.
  if (ip) headers['x-real-ip'] = ip;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Opens a socket, sends HELLO and resolves with the first frame that settles
 * it — a welcome or a refusal — plus anything that arrives afterwards.
 */
function hello(port, msg, { keepOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const later = [];
    let settled = null;
    const timer = setTimeout(() => { ws.close(); reject(new Error('handshake timed out')); }, 8000);

    ws.on('open', () => ws.send(JSON.stringify({ o: K.C2S.HELLO, protocol: K.PROTOCOL_VERSION, ...msg })));
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw);
      if (settled) { later.push(frame); return; }
      if (frame.o !== K.S2C.WELCOME && frame.o !== K.S2C.ERROR) return;
      settled = frame;
      clearTimeout(timer);
      if (!keepOpen) ws.close();
      resolve({ frame, ws, later, closed: () => closeInfo });
    });
    let closeInfo = null;
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: String(reason) };
      if (!settled) { clearTimeout(timer); reject(new Error(`closed before HELLO answered: ${code}`)); }
    });
    ws.on('error', () => { /* a refusal closes the socket; that is the answer */ });
  });
}

/** Waits for one socket to be closed by the server, returning why. */
const waitForClose = (ws, ms = 5000) => new Promise((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 1006, reason: '' });
  const timer = setTimeout(() => resolve(null), ms);
  ws.on('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: String(reason) }); });
});

/* ── Unit checks ─────────────────────────────────────────────────────────── */

async function unitChecks() {
  suite('Match payout — a blank scoreboard');

  check('100 points is still 1 GR', K.grFromScore(100) === 1);
  check('a zero-score loss pays nothing', K.grFromScore(0, false) === 0);
  check('a zero-score *win* pays nothing either — not even the win bonus',
    K.grFromScore(0, true) === 0, `win bonus is ${K.GR_PER_WIN} GR`);
  check('a negative score cannot pay', K.grFromScore(-300, true) === 0);
  check('one point on the board restores the win bonus',
    K.grFromScore(1, true) === K.GR_PER_WIN);
  check('a real match still pays what it did', K.grFromScore(613.6, true) === 6 + K.GR_PER_WIN,
    `${K.grFromScore(613.6, true)} GR for 613 points and the win`);

  suite('Guest names');

  const { guestName } = await import('../server/util/auth.js');
  check('a guest name has the shape the client expects',
    /^Guest\d{4}$/.test(guestName()), guestName());
  check('a name somebody has registered is never handed out', (() => {
    // Every short name is taken, so the fallback is the only way out.
    const only = guestName((name) => /^Guest\d{4}$/.test(name));
    return !K.NAME_RE.test(only) && only.startsWith('Guest-');
  })(), guestName((n) => /^Guest\d{4}$/.test(n)));
  check('and the fallback is too long to be registered and lain in wait for',
    !K.NAME_RE.test(guestName(() => true)));

  suite('Address classification');

  const ipintel = await import('../server/util/ipintel.js');
  check('loopback is never suspicious', ipintel.isPrivate('127.0.0.1') && ipintel.isPrivate('::1'));
  check('a LAN address is never suspicious',
    ipintel.isPrivate('192.168.1.20') && ipintel.isPrivate('10.4.4.4') && ipintel.isPrivate('172.20.1.1'));
  check('an IPv4-mapped loopback is recognised', ipintel.isPrivate('::ffff:127.0.0.1'));
  check('a public address is not private', !ipintel.isPrivate('203.0.113.9'));
  check('an allow-list rule matches a bare address', ipintel.matchesRule('203.0.113.9', '203.0.113.9'));
  check('an allow-list rule matches a CIDR', ipintel.matchesRule('203.0.113.9', '203.0.113.0/24')
    && !ipintel.matchesRule('203.0.114.9', '203.0.113.0/24'));
  check('a /32 rule matches exactly one address',
    ipintel.matchesRule('8.8.8.8', '8.8.8.8/32') && !ipintel.matchesRule('8.8.8.9', '8.8.8.8/32'));

  suite('Outgoing mail');

  const mailer = await import('../server/util/mailer.js');
  check('an address that looks real passes', mailer.looksLikeEmail('player@g0x.dev'));
  check('an address that does not is refused',
    !mailer.looksLikeEmail('player@localhost') && !mailer.looksLikeEmail('nope')
    && !mailer.looksLikeEmail('a b@c.dev'));

  const msg = mailer.buildMessage({
    to: 'player@g0x.dev', subject: 'Confirm your Open Grunker account',
    text: 'plain body\n.a line starting with a dot', html: '<p>rich body</p>',
    from: 'no-reply@g0x.dev', fromName: 'Open Grunker',
  });
  // Only the *first* blank line separates the headers; every part below has
  // one of its own.
  const sep = msg.indexOf('\r\n\r\n');
  const headers = msg.slice(0, sep);
  const body = msg.slice(sep + 4);
  check('the message carries the headers a mail server expects',
    headers.includes('From: Open Grunker <no-reply@g0x.dev>')
    && headers.includes('To: player@g0x.dev')
    && headers.includes('MIME-Version: 1.0')
    && /Message-ID: <[^>]+>/.test(headers));
  check('both a text and an HTML part are offered',
    headers.includes('multipart/alternative')
    && body.split('Content-Transfer-Encoding: base64').length === 3);
  check('the body is base64, so no line can be mistaken for the terminator',
    !msg.split('\r\n').some((line) => line === '.'),
    'a bare "." ends DATA — a plain-text body has to be escaped, base64 cannot contain one');
  const decoded = Buffer.from(body.split('\r\n\r\n')[1].split('\r\n--')[0], 'base64').toString('utf8');
  check('the text part survives the encoding round trip',
    decoded.includes('plain body') && decoded.includes('.a line starting with a dot'));

  suite('The anti-bot check, on its own');

  const turnstile = await import('../server/util/turnstile.js');
  const { default: config } = await import('../server/config.js');
  const saved = JSON.parse(JSON.stringify(config.turnstile));

  config.turnstile.register.secret = '';
  check('a form with no secret is not challenged', !turnstile.isProtected('register'));
  check('and its verification is skipped rather than failed',
    (await turnstile.verify('register', undefined)).skipped === true);

  config.turnstile.register.secret = 'secret-register';
  config.turnstile.register.siteKey = 'site-register';
  check('a form with a secret is challenged', turnstile.isProtected('register'));
  const missing = await turnstile.verify('register', undefined);
  check('an empty token fails without asking Cloudflare',
    !missing.ok && missing.reason === 'missing');

  config.turnstile.verifyUrl = 'http://127.0.0.1:1/nope';        // nothing listens there
  const down = await turnstile.verify('register', 'anything');
  check('an unreachable Cloudflare fails shut, so the widget is never decorative',
    !down.ok && down.reason === 'unreachable');
  check('and the player is told something they can act on',
    turnstile.humanError(down).includes('try again'));

  Object.assign(config.turnstile, saved);
}

/* ── End-to-end ──────────────────────────────────────────────────────────── */

async function integration() {
  const stub = await startStub();
  const dir = mkdtempSync(join(tmpdir(), 'og-accounts-'));
  const port = await freePort();
  let server;
  try {
    server = await startServer({ port, dbPath: join(dir, 'accounts.db'), stubPort: stub.port });
  } catch (err) {
    suite('Accounts — end to end');
    check('the server boots', false, err.message);
    stub.server.close();
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const { base, log } = server;

  try {
    /* ── /meta ──────────────────────────────────────────────────────────── */

    suite('Accounts — what the client is told');

    const meta = (await call(base, 'GET', '/api/v1/meta')).body;
    check('both site keys reach the browser',
      meta.turnstile?.register === 'site-register' && meta.turnstile?.login === 'site-login');
    check('neither secret does', !JSON.stringify(meta).includes('secret-'));
    check('the rename price is published, not hard-coded in the client',
      meta.renameCost === 100);
    check('the client is told guests do not name themselves', meta.namedGuests === false);
    check('and that an address has to be confirmed',
      meta.emailVerification?.required === true && meta.emailVerification?.enforced === true);

    /* ── Turnstile on the real routes ───────────────────────────────────── */

    suite('Accounts — the anti-bot check on sign-up and sign-in');

    const creds = { username: 'Verified', password: 'a-good-password', email: 'player@g0x.dev' };

    const noToken = await call(base, 'POST', '/api/v1/auth/register', { body: creds });
    check('sign-up without a solved challenge is refused',
      noToken.status === 400 && noToken.body.error === 'captcha_failed', noToken.body.message);

    const badToken = await call(base, 'POST', '/api/v1/auth/register',
      { body: { ...creds, turnstileToken: 'i-made-this-up' } });
    check('so is one Cloudflare does not recognise',
      badToken.status === 400 && badToken.body.error === 'captcha_failed');

    const noEmail = await call(base, 'POST', '/api/v1/auth/register',
      { body: { username: 'Nameless', password: 'a-good-password', turnstileToken: GOOD_CAPTCHA } });
    check('an account cannot be made without an address when one is required',
      noEmail.status === 400 && noEmail.body.error === 'email_required');

    const made = await call(base, 'POST', '/api/v1/auth/register',
      { body: { ...creds, turnstileToken: GOOD_CAPTCHA } });
    check('a solved challenge creates the account', made.status === 201, made.body.message ?? '');
    check('the new account starts unverified',
      made.body.user?.emailVerified === false && made.body.verification?.verified === false);
    check('a link that only reached the log is not reported as sent',
      made.body.verification?.sent === false && made.body.verification?.transport === 'log',
      'telling a player to check an inbox nothing was sent to is worse than saying nothing');
    check('the sign-up widget was checked against its own secret',
      stub.seen.siteverify.at(-1)?.secret === 'secret-register');

    const token = made.body.token;

    const dupe = await call(base, 'POST', '/api/v1/auth/register',
      { body: { ...creds, username: 'verified', turnstileToken: GOOD_CAPTCHA } });
    check('the name cannot be taken twice, in any casing',
      dupe.status === 409 && dupe.body.error === 'username_taken');

    const loginNoToken = await call(base, 'POST', '/api/v1/auth/login',
      { body: { username: 'Verified', password: creds.password } });
    check('sign-in is challenged too',
      loginNoToken.status === 400 && loginNoToken.body.error === 'captcha_failed');

    const signedIn = await call(base, 'POST', '/api/v1/auth/login',
      { body: { username: 'Verified', password: creds.password, turnstileToken: GOOD_CAPTCHA } });
    check('a solved challenge signs in', signedIn.status === 200);
    check('sign-in used the *login* secret, not the sign-up one',
      stub.seen.siteverify.at(-1)?.secret === 'secret-login');

    /* ── Verification ───────────────────────────────────────────────────── */

    suite('Accounts — confirming an address');

    const refused = await hello(port, { token });
    check('an unconfirmed account cannot take a seat',
      refused.frame.o === K.S2C.ERROR && refused.frame.code === 'email_unverified',
      refused.frame.message ?? '');

    // MAIL_TRANSPORT=log puts the link in the server's own output, which is
    // exactly what a developer without mail credentials has to work from.
    const link = /\?verify=([A-Za-z0-9_-]+)/.exec(log())?.[1];
    check('the confirmation link was produced', !!link, link ? `${link.slice(0, 12)}…` : log().slice(-400));

    const wrong = await call(base, 'POST', '/api/v1/auth/verify', { body: { token: 'not-a-token' } });
    check('a token nobody issued is refused', wrong.status === 400 && wrong.body.error === 'bad_token');

    const confirmed = await call(base, 'POST', '/api/v1/auth/verify', { body: { token: link } });
    check('the link confirms the address', confirmed.status === 200 && confirmed.body.verified === true);

    const replay = await call(base, 'POST', '/api/v1/auth/verify', { body: { token: link } });
    check('and cannot be spent twice', replay.status === 400 && replay.body.error === 'bad_token');

    const seated = await hello(port, { token });
    check('a confirmed account is seated',
      seated.frame.o === K.S2C.WELCOME && seated.frame.authed === true);
    check('and plays under its own name', seated.frame.you?.name === 'Verified');

    const me = await call(base, 'GET', '/api/v1/auth/me', { token });
    check('the account reads back as verified', me.body.verification?.verified === true);
    check('and can see its own address', me.body.user?.email === 'player@g0x.dev');

    // The same shape answers a profile page, so this is one property away from
    // publishing every player's address.
    const profile = await call(base, 'GET', '/api/v1/players/Verified');
    check('but a stranger looking at the profile cannot',
      profile.status === 200 && profile.body.user?.email === undefined
      && profile.body.user?.emailVerified === undefined,
      JSON.stringify(Object.keys(profile.body.user ?? {})));

    /* ── Guest naming ───────────────────────────────────────────────────── */

    suite('Accounts — a guest does not choose a name');

    const guest = await hello(port, { name: 'Verified' });
    check('a guest impersonating an account is not seated under that name',
      guest.frame.you?.name !== 'Verified', `seated as ${guest.frame.you?.name}`);
    check('the server assigns the name instead',
      /^Guest\d{4}$/.test(guest.frame.you?.name ?? ''), guest.frame.you?.name);
    check('and tells the client which one it picked',
      guest.frame.assignedName === guest.frame.you?.name);

    const guest2 = await hello(port, { name: 'xX_Sniper_Xx' });
    check('a second guest gets a name of its own too',
      /^Guest\d{4}$/.test(guest2.frame.you?.name ?? ''));

    check('two guests are not handed the same name',
      guest.frame.you?.name !== guest2.frame.you?.name);

    /* ── One player, one game ───────────────────────────────────────────── */

    suite('Accounts — one player, one game');

    const first = await hello(port, { token }, { keepOpen: true });
    check('the account is in a match', first.frame.o === K.S2C.WELCOME);

    const second = await hello(port, { token }, { keepOpen: true });
    check('a second window is seated', second.frame.o === K.S2C.WELCOME);

    const displaced = first.later.find((m) => m.code === 'session_replaced')
      ?? await (async () => { await sleep(200); return first.later.find((m) => m.code === 'session_replaced'); })();
    check('and the first one is told it lost its seat', !!displaced, displaced?.message ?? 'no frame');

    const closed = await waitForClose(first.ws);
    check('the older socket is closed by the server', closed?.code === 4018,
      `code ${closed?.code} ${closed?.reason ?? ''}`);
    second.ws.close();

    /* ── VPN ────────────────────────────────────────────────────────────── */

    suite('Accounts — VPNs, proxies and datacenters');

    const fromVpn = await call(base, 'POST', '/api/v1/auth/login',
      { body: { username: 'Verified', password: creds.password, turnstileToken: GOOD_CAPTCHA },
        ip: PROXY_IP });
    check('signing in from a flagged address is refused',
      fromVpn.status === 403 && fromVpn.body.error === 'vpn_blocked', fromVpn.body.message);

    const fromHome = await call(base, 'POST', '/api/v1/auth/login',
      { body: { username: 'Verified', password: creds.password, turnstileToken: GOOD_CAPTCHA },
        ip: CLEAN_IP });
    check('an ordinary connection is not', fromHome.status === 200);

    const lookups = stub.seen.lookups.length;
    await call(base, 'POST', '/api/v1/auth/login',
      { body: { username: 'Verified', password: creds.password, turnstileToken: GOOD_CAPTCHA },
        ip: CLEAN_IP });
    check('a verdict is cached rather than looked up again',
      stub.seen.lookups.length === lookups, `${stub.seen.lookups.length} lookup(s) so far`);

    /* ── Paid rename ────────────────────────────────────────────────────── */

    suite('Accounts — a nickname costs GR');

    // Signing up pays a grant, so an account is never actually broke. Empty it
    // first: what is on trial here is the price, not the opening balance.
    const empty = new DatabaseSync(join(dir, 'accounts.db'));
    empty.prepare('UPDATE users SET gr = 0 WHERE username_lower = ?').run('verified');
    empty.close();

    const broke = await call(base, 'POST', '/api/v1/auth/username',
      { token, body: { username: 'Renamed' } });
    check('a new name is refused with an empty wallet',
      broke.status === 402 && broke.body.error === 'insufficient_gr', broke.body.message);

    // Pay the account, the way a match would.
    const wallet = new DatabaseSync(join(dir, 'accounts.db'));
    wallet.prepare('UPDATE users SET gr = 250 WHERE username_lower = ?').run('verified');
    wallet.close();

    const restyle = await call(base, 'POST', '/api/v1/auth/username',
      { token, body: { username: 'VERIFIED' } });
    check('changing only the spelling is free',
      restyle.status === 200 && restyle.body.spent === 0 && restyle.body.gr === 250,
      `${restyle.body.user?.username} · ${restyle.body.gr} GR`);

    const renamed = await call(base, 'POST', '/api/v1/auth/username',
      { token, body: { username: 'Renamed' } });
    check('a real rename goes through', renamed.status === 200 && renamed.body.user?.username === 'Renamed');
    check('and costs exactly the published price',
      renamed.body.spent === 100 && renamed.body.gr === 150, `${renamed.body.gr} GR left`);

    const bad = await call(base, 'POST', '/api/v1/auth/username', { token, body: { username: 'no' } });
    check('a name that breaks the rules is refused', bad.status === 400 && bad.body.error === 'invalid_username');

    // A second account, so the collision is real rather than hypothetical.
    const rival = await call(base, 'POST', '/api/v1/auth/register', {
      body: { username: 'Rival', password: 'a-good-password', email: 'rival@g0x.dev', turnstileToken: GOOD_CAPTCHA },
    });
    const taken = await call(base, 'POST', '/api/v1/auth/username',
      { token: rival.body.token, body: { username: 'Renamed' } });
    check('somebody else\'s name cannot be bought',
      taken.status === 409 && taken.body.error === 'username_taken');

    const rivalWallet = new DatabaseSync(join(dir, 'accounts.db'));
    const rivalGr = rivalWallet.prepare('SELECT gr FROM users WHERE username_lower = ?').get('rival').gr;
    rivalWallet.close();
    check('and a refused rename costs nothing', rivalGr === K.SIGNUP_REWARD.gr, `${rivalGr} GR`);

    /* ── What signing up is worth ───────────────────────────────────────── */

    suite('Accounts — the sign-up grant');

    check('a new account is handed the advertised balance',
      rival.body.user?.gr === K.SIGNUP_REWARD.gr,
      `${rival.body.user?.gr} GR · advertised ${K.SIGNUP_REWARD.gr}`);
    check('and the register call says so, so the client can show it',
      rival.body.reward?.gr === K.SIGNUP_REWARD.gr
      && Array.isArray(rival.body.reward?.lines) && rival.body.reward.lines.length > 0);
    check('the sign-up finish is owned rather than merely unlocked', (() => {
      const owned = rival.body.user?.loadout?.owned ?? [];
      info(owned.join(', ') || 'nothing');
      return (K.SIGNUP_REWARD.skins ?? []).every((id) => owned.includes(id));
    })());

    const anon = await call(base, 'POST', '/api/v1/auth/username', { body: { username: 'Ghost' } });
    check('a guest has no name to change', anon.status === 401);

    /* ── Who may read the server's own figures ──────────────────────────── */

    suite('Server figures — staff only');

    const openStats = await call(base, 'GET', '/api/v1/stats/global');
    check('a stranger is not told how many accounts or players there are',
      openStats.status === 403 && openStats.body.error === 'staff_only', openStats.body.message ?? '');

    const asPlayer = await call(base, 'GET', '/api/v1/stats/global', { token: rival.body.token });
    check('and neither is a signed-in player', asPlayer.status === 403);

    const openHealth = await call(base, 'GET', '/api/v1/health');
    check('the health check still answers, without the room internals',
      openHealth.status === 200 && openHealth.body.status === 'up' && openHealth.body.game === undefined);
    check('and it names the build, which is not a secret',
      typeof openHealth.body.build === 'string' && openHealth.body.build.length > 0,
      openHealth.body.build ?? '');
    check('nor is the database path handed to strangers any more',
      !JSON.stringify(openHealth.body).includes('.db'));

    const promote = new DatabaseSync(join(dir, 'accounts.db'));
    promote.prepare("UPDATE users SET role = 'mod' WHERE username_lower = ?").run('rival');
    promote.close();

    const asMod = await call(base, 'GET', '/api/v1/stats/global', { token: rival.body.token });
    check('a moderator gets the lot', asMod.status === 200
      && typeof asMod.body.users === 'number' && typeof asMod.body.online === 'number'
      && typeof asMod.body.clans === 'number',
      `${asMod.body.users} accounts · ${asMod.body.online} online`);

    const modHealth = await call(base, 'GET', '/api/v1/health', { token: rival.body.token });
    check('…and the room internals with it', typeof modHealth.body.game?.players === 'number');

    info(`server log: ${log().split('\n').filter(Boolean).length} lines, `
      + `${stub.seen.siteverify.length} challenge(s) checked, ${stub.seen.lookups.length} address lookup(s)`);
  } finally {
    server.child.kill('SIGTERM');
    await sleep(300);
    if (!server.child.killed) server.child.kill('SIGKILL');
    stub.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async function run() {
  await unitChecks();
  await integration();
}
