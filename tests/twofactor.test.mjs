/**
 * Open Grunker — two-factor authentication.
 *
 * Three things are on trial here and they are not the same thing:
 *
 *   • The arithmetic. TOTP is a published algorithm with published test
 *     vectors, and an implementation that does not reproduce them exactly is
 *     one that will disagree with every authenticator app on the planet.
 *   • The bookkeeping. A code that works twice, or a recovery code that can be
 *     spent by two people at once, is the whole feature defeated.
 *   • The QR code, which is the difference between a player switching this on
 *     and a player retyping thirty-two characters into a phone and giving up.
 */
import { suite, check, info } from './harness.mjs';
import db from '../server/db/index.js';
import {
  totp, verifyTotp, newSecret, otpauthUri, newRecoveryCodes, hashRecoveryCode,
  base32Encode, base32Decode, normaliseRecoveryCode, PERIOD,
} from '../server/util/totp.js';
import { encodeQr, qrSvg } from '../client/js/qr.js';

export default function run() {
  /* ── The algorithm ─────────────────────────────────────────────────────── */

  suite('TOTP — RFC 6238');

  // The published SHA-1 vectors, against the standard's own test secret.
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  const VECTORS = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'],
  ];
  const wrong = VECTORS.filter(([t, want]) => totp(rfcSecret, t * 1000) !== want);
  check('every published test vector comes out exactly right', wrong.length === 0,
    wrong.length ? wrong.map(([t]) => t).join(', ') : `${VECTORS.length} vectors`);

  check('base32 survives a round trip',
    base32Decode(base32Encode(Buffer.from('open grunker'))).toString() === 'open grunker');

  const secret = newSecret();
  check('a fresh secret is 160 bits of base32',
    secret.length === 32 && base32Decode(secret).length === 20, `${secret.length} chars`);

  check('a code checks out against the clock that made it',
    verifyTotp(secret, totp(secret)) !== null);
  check('…and one from a different secret does not',
    verifyTotp(secret, totp(newSecret(), Date.now() + 90_000)) === null);
  check('a code from one step ago is still accepted',
    verifyTotp(secret, totp(secret, Date.now() - PERIOD * 1000)) !== null);
  check('one from four steps ago is not',
    verifyTotp(secret, totp(secret, Date.now() - PERIOD * 4000)) === null);
  check('anything that is not six digits is refused outright',
    ['', '12345', '1234567', 'abcdef', '12 34 56', null, undefined]
      .every((v) => verifyTotp(secret, v) === null));

  const uri = otpauthUri({ secret, account: 'Tester' });
  check('the otpauth URI names the issuer, the digits and the period',
    uri.startsWith('otpauth://totp/Open%20Grunker%3ATester?')
    && uri.includes(`secret=${secret}`) && uri.includes('digits=6') && uri.includes('period=30'),
    uri.slice(0, 46) + '…');

  /* ── Recovery codes ────────────────────────────────────────────────────── */

  suite('TOTP — recovery codes');

  const { codes, hashes } = newRecoveryCodes();
  check('ten codes, all different', codes.length === 10 && new Set(codes).size === 10);
  check('each one is readable off paper — no ambiguous letters',
    codes.every((c) => /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/.test(c)),
    codes[0]);
  check('only the hashes are ever stored',
    hashes.length === 10 && hashes.every((h) => /^[0-9a-f]{64}$/.test(h))
    && !hashes.some((h) => codes.some((c) => h.includes(c))));
  check('typing one back in any case, with or without the dash, still matches',
    hashRecoveryCode(codes[0].toLowerCase().replace('-', ' ')) === hashes[0]
    && normaliseRecoveryCode('ab-cd ef') === 'ABCDEF');

  /* ── What the database enforces ────────────────────────────────────────── */

  suite('TOTP — one code, one use');

  const user = db.users.create({
    username: `Tfa${Math.floor(Math.random() * 1e6)}`,
    email: null,
    passwordHash: 'scrypt$16384$8$1$AAAA$AAAA',
    ip: '127.0.0.1',
  });

  check('an account starts with no second factor', !db.users.byId(user.id).totp_secret);

  db.totp.enable(user.id, secret, hashes);
  const armed = db.users.byId(user.id);
  check('enabling stores the secret and stamps the time',
    armed.totp_secret === secret && armed.totp_enabled_at > 0);
  check('and files all ten recovery codes', db.totp.recoveryLeft(user.id) === 10);

  const step = Math.floor(Date.now() / 1000 / PERIOD);
  check('a step can be spent once', db.totp.spendStep(user.id, step) === true);
  check('…and not twice — the replay a bare TOTP check would allow',
    db.totp.spendStep(user.id, step) === false);
  check('nor can an older step be replayed after it',
    db.totp.spendStep(user.id, step - 1) === false);
  check('the next step still works', db.totp.spendStep(user.id, step + 1) === true);

  check('a recovery code can be spent once',
    db.totp.spendRecovery(user.id, hashes[0]) === true);
  check('…and not twice', db.totp.spendRecovery(user.id, hashes[0]) === false);
  check('a code that was never issued is refused',
    db.totp.spendRecovery(user.id, hashRecoveryCode('AAAAA-BBBBB')) === false);
  check('nine left', db.totp.recoveryLeft(user.id) === 9);

  const fresh = newRecoveryCodes();
  db.totp.resetRecovery(user.id, fresh.hashes);
  check('reissuing replaces the whole set rather than adding to it',
    db.totp.recoveryLeft(user.id) === 10 && db.totp.spendRecovery(user.id, hashes[1]) === false);
  check('and the new ones work', db.totp.spendRecovery(user.id, fresh.hashes[0]) === true);

  db.totp.disable(user.id);
  const off = db.users.byId(user.id);
  check('turning it off clears the secret and every code left',
    !off.totp_secret && !off.totp_enabled_at && db.totp.recoveryLeft(user.id) === 0);

  /* ── The QR code ───────────────────────────────────────────────────────── */

  suite('QR — the setup code');

  // Byte-mode capacities at level M, from the standard's own tables. If the
  // encoder picks a version that cannot hold the payload, nothing scans.
  const CAP = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };
  const sized = [8, 20, 40, 60, 84, 106, 122, 152, 180, 213].map((len) => {
    const q = encodeQr('x'.repeat(len));
    return { len, version: q.version, fits: len <= CAP[q.version], size: q.size };
  });
  check('every payload lands in a version that can hold it',
    sized.every((r) => r.fits), sized.map((r) => `${r.len}B→v${r.version}`).join(' '));
  check('and the grid is the size that version defines',
    sized.every((r) => r.size === r.version * 4 + 17));

  const q = encodeQr(uri);
  const at = (r, c) => q.modules[r * q.size + c];
  check('the three finder patterns are where a scanner looks for them',
    [[0, 0], [0, q.size - 7], [q.size - 7, 0]].every(([top, left]) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6
            || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          if (at(top + r, left + c) !== (ring ? 1 : 0)) return false;
        }
      }
      return true;
    }), `v${q.version}, ${q.size}×${q.size}`);

  check('the timing patterns alternate the whole way across',
    (() => {
      for (let i = 8; i < q.size - 8; i++) {
        if (at(6, i) !== (i % 2 === 0 ? 1 : 0)) return false;
        if (at(i, 6) !== (i % 2 === 0 ? 1 : 0)) return false;
      }
      return true;
    })());

  check('the always-dark module is dark', at(q.size - 8, 8) === 1);

  // The format string is BCH-protected: read it back and it must decode to a
  // real error-correction level and a real mask, or no scanner will get past it.
  const formatOf = (layout) => {
    let bits = 0;
    layout.forEach(([r, c], i) => { bits |= (at(r, c) === 1 ? 1 : 0) << i; });
    for (let d = 0; d < 32; d++) {
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      if ((((d << 10) | rem) ^ 0x5412) === bits) return { ec: d >> 3, mask: d & 7 };
    }
    return null;
  };
  const copy1 = formatOf([
    ...Array.from({ length: 6 }, (_, i) => [i, 8]),
    [7, 8], [8, 8], [8, 7],
    ...[9, 10, 11, 12, 13, 14].map((i) => [8, 14 - i]),
  ]);
  const copy2 = formatOf([
    ...Array.from({ length: 8 }, (_, i) => [8, q.size - 1 - i]),
    ...[8, 9, 10, 11, 12, 13, 14].map((i) => [q.size - 15 + i, 8]),
  ]);
  check('both copies of the format string decode, and agree',
    !!copy1 && !!copy2 && copy1.ec === copy2.ec && copy1.mask === copy2.mask,
    copy1 ? `level M (${copy1.ec === 0 ? 'ok' : 'wrong'}), mask ${copy1.mask}` : 'unreadable');
  check('it says error-correction level M, which is what the encoder writes',
    copy1?.ec === 0);

  const svg = qrSvg(uri);
  check('the SVG is one self-contained element with a four-module quiet zone',
    svg.startsWith('<svg') && svg.endsWith('</svg>')
    && svg.includes(`viewBox="0 0 ${q.size + 8} ${q.size + 8}"`),
    `${svg.length} bytes`);
  // The only URL in it may be the SVG namespace, which is an identifier rather
  // than something the browser fetches. A setup QR that reached out to anybody
  // would be handing them the secret it draws.
  check('and it fetches nothing and runs nothing',
    !/<script/i.test(svg) && !/\b(href|src)\s*=/i.test(svg)
    && (svg.match(/https?:\/\//g) ?? []).every((_, i, all) =>
      all.length === 1 && svg.includes('xmlns="http://www.w3.org/2000/svg"')));

  check('a payload no version 10 could hold is refused rather than truncated',
    (() => {
      try { encodeQr('x'.repeat(400)); return false; } catch { return true; }
    })());

  info(`a real otpauth URI is ${uri.length} bytes — version ${q.version} of 10`);
}
