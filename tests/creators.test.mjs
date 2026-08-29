/**
 * Open Grunker — creator status, anthems and the kill cam.
 *
 * What is on trial here is not that the feature exists. It is the three ways a
 * feature shaped like this goes wrong, none of which a type checker catches:
 *
 *   1. **A perk that is not gated.** Creator status is four disciplines with
 *      four different grants, and every one of them is a route. A musician who
 *      can file a skin brief, an artist who can upload an anthem, or — worst —
 *      a *pending* application that can do either, is the whole feature
 *      failing quietly. `creatorCan` is the single gate and this suite pushes
 *      on every side of it.
 *   2. **A loudness rule that can be got round.** An anthem is a stranger's
 *      audio played into somebody's ears on a screen they did not choose to
 *      be looking at. The rule is not "refuse loud files", it is "there is no
 *      such thing as a loud file" — the server rewrites the samples. So the
 *      test is not that a scream is rejected; it is that a scream, a
 *      brickwalled square wave and a nine-second silence with an air horn on
 *      the end all come out at the same level, and that a quiet piano comes
 *      out louder than it went in.
 *   3. **A link that lies.** These are the only outbound links in the game and
 *      one player puts them on a page another player opens. Nothing typed may
 *      ever become a scheme, a host, a port or a path — so the sanitiser is
 *      pushed at with the shapes that would matter: userinfo, a port, a path
 *      after a host, punycode, an IP.
 *
 * The arithmetic runs in process. Everything that is a *rule a route enforces*
 * runs over HTTP against a real server, the way cosmetics.test.mjs does,
 * because a rule tested against the function it lives in is a rule tested
 * against itself.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as K from '../shared/constants.js';
import { identifyWav, measure, validateAnthem, level } from '../server/util/audio.js';
import { Room } from '../server/game/room.js';
import { Player } from '../server/game/player.js';
import { suite, check, info, sleep } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SR = K.ANTHEM_SAMPLE_RATE;

const freePort = () => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/* ── Making audio to push at the server ──────────────────────────────────── */

/** Mono 16-bit PCM in a canonical RIFF wrapper — what the client uploads. */
function wav(samples, rate = SR) {
  const n = samples.length;
  const head = Buffer.alloc(44);
  const body = Buffer.alloc(n * 2);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + n * 2, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    body.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return Buffer.concat([head, body]);
}

const gen = (secs, fn, rate = SR) => {
  const n = Math.round(secs * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / rate, i, n);
  return out;
};

/** The loudness of a stored file, measured back off the disk. */
function loudnessOf(buf) {
  const info2 = identifyWav(buf);
  const samples = new Float64Array(info2.frames);
  for (let i = 0; i < info2.frames; i++) samples[i] = buf.readInt16LE(info2.dataAt + i * 2) / 32768;
  return { ...measure(samples, info2.sampleRate), info: info2 };
}

/* ── The levelling, in process ───────────────────────────────────────────── */

function levelling() {
  suite('Creators — anthem levelling');

  const run = (samples) => {
    const buf = wav(samples);
    const verdict = validateAnthem(buf);
    if (!verdict.ok) return { refused: verdict.code, message: verdict.message };
    const out = level(buf, verdict.info);
    if (!out.ok) return { refused: out.code, message: out.message };
    return { ...loudnessOf(out.buffer), report: out.report, bytes: out.buffer.length };
  };

  // A polite track, a brickwalled one, a trick one and a quiet one. The whole
  // point is that the first column below is wildly different and the last is
  // not — that is what "levelled" means.
  const polite = run(gen(8, (t) => 0.25 * Math.sin(2 * Math.PI * 220 * t)));
  const brick = run(gen(10, (t) => Math.sign(Math.sin(2 * Math.PI * 180 * t)) * 0.999));
  const horn = run(gen(10, (t) => (t < 9 ? 0 : Math.sign(Math.sin(2 * Math.PI * 440 * t)) * 0.999)));
  const quiet = run(gen(6, (t) => 0.004 * Math.sin(2 * Math.PI * 440 * t)));

  info(`polite ${polite.report.before.loudDb} → ${polite.loudDb.toFixed(1)} dB · `
    + `brickwalled ${brick.report.before.loudDb} → ${brick.loudDb.toFixed(1)} dB · `
    + `air horn ${horn.report.before.loudDb} → ${horn.loudDb.toFixed(1)} dB · `
    + `quiet ${quiet.report.before.loudDb} → ${quiet.loudDb.toFixed(1)} dB`);

  const target = K.ANTHEM_TARGET_RMS_DB;
  const near = (v, want, tol = 1.2) => Math.abs(v - want) <= tol;

  check('a brickwalled upload is turned down, not refused',
    brick.report.gainDb < -12 && near(brick.loudDb, target),
    `${brick.report.gainDb} dB applied`);

  check('nine seconds of silence and one air horn is measured as an air horn',
    near(horn.loudDb, target) && horn.report.gainDb < -12,
    'the short-term window is what makes this work');

  check('a quiet track is levelled up rather than left inaudible',
    quiet.report.gainDb > 20 && near(quiet.loudDb, target),
    `${quiet.report.gainDb} dB applied`);

  check('everything comes out at the same loudness, whatever went in', (() => {
    const all = [polite, brick, horn, quiet].map((r) => r.loudDb);
    const spread = Math.max(...all) - Math.min(...all);
    info(`spread across four very different uploads: ${spread.toFixed(2)} dB`);
    return spread < 1.5;
  })());

  check('and nothing ever comes out above the peak ceiling',
    [polite, brick, horn, quiet].every((r) => r.peakDb <= K.ANTHEM_PEAK_CEILING_DB + 0.2),
    `ceiling ${K.ANTHEM_PEAK_CEILING_DB} dB`);

  check('the stored file is exactly a canonical header and samples', (() => {
    // Re-emitted rather than patched, so whatever chunks the upload carried —
    // metadata, cue points, an appended payload — are gone rather than served.
    const carrier = wav(gen(3, (t) => 0.3 * Math.sin(2 * Math.PI * 300 * t)));
    const junk = Buffer.concat([
      carrier.subarray(0, 36),
      Buffer.from('LIST'), Buffer.from([8, 0, 0, 0]), Buffer.from('INFOxxxx'),
      carrier.subarray(36),
    ]);
    // Fix up the RIFF size so the extra chunk is well formed rather than
    // truncated: the point is that a *valid* extra chunk is dropped.
    junk.writeUInt32LE(junk.length - 8, 4);
    const verdict = validateAnthem(junk);
    if (!verdict.ok) return false;
    const out = level(junk, verdict.info);
    return out.ok && out.buffer.length === 44 + verdict.info.frames * 2
      && !out.buffer.includes(Buffer.from('LIST'));
  })());

  check('digital silence is refused rather than amplified into hiss',
    run(gen(4, () => 0)).refused === 'anthem_silent');

  check('a file that is not a WAVE at all is refused',
    validateAnthem(Buffer.from('ID3\x04and then some mp3 frames')).ok === false);

  check('the wrong sample rate is refused with a sentence that says so', (() => {
    const r = validateAnthem(wav(gen(3, (t) => 0.3 * Math.sin(t * 900)), 44100));
    return !r.ok && r.code === 'unsupported_audio' && r.message.includes(String(SR));
  })());

  check('a track over the limit is told it is too long, not too large', (() => {
    // Ordering matters: every way of being too big is really a way of being
    // too long, and "751 KB" is a riddle about sample rates.
    const r = validateAnthem(wav(gen(12, (t) => 0.3 * Math.sin(2 * Math.PI * 300 * t))));
    return !r.ok && r.code === 'anthem_too_long';
  })());

  check('and one under it is told it is too short',
    validateAnthem(wav(gen(0.4, (t) => 0.3 * Math.sin(t * 900)))).code === 'anthem_too_short');

  check('a truncated download is read as far as it goes rather than refused', (() => {
    // A `data` chunk claiming more than the file holds is a cut-short
    // transfer, not an attack — what arrived is still measurable.
    const full = wav(gen(4, (t) => 0.3 * Math.sin(2 * Math.PI * 300 * t)));
    const cut = full.subarray(0, full.length - 40000);
    const got = identifyWav(cut);
    return got !== null && got.frames * 2 <= cut.length - 44 && got.seconds > 3;
  })());
}

/* ── The catalogue and the sanitisers, in process ────────────────────────── */

function vocabulary() {
  suite('Creators — the catalogue');

  check('every discipline grants something, and no two grant the same thing', (() => {
    const seen = new Set();
    for (const kind of K.CREATOR_KINDS) {
      if (!kind.grants.length || !kind.perks.length) return false;
      for (const g of kind.grants) {
        if (seen.has(g)) return false;
        seen.add(g);
      }
    }
    info(K.CREATOR_KINDS.map((k) => `${k.id}: ${k.grants.join('+')}`).join(' · '));
    return seen.size >= 5;
  })());

  check('a pending application grants absolutely nothing', (() => {
    // The one rule nobody may forget, which is why the status is checked
    // inside `creatorCan` and not by its callers.
    const every = K.CREATOR_KINDS.flatMap((k) => k.grants);
    return every.every((g) => !K.creatorCan({ kind: 'music', status: 'pending' }, g))
      && every.every((g) => !K.creatorCan({ kind: 'music', status: 'revoked' }, g))
      && every.every((g) => !K.creatorCan(null, g));
  })());

  check('and an approved one grants only its own', (() => {
    const music = { kind: 'music', status: 'approved' };
    return K.creatorCan(music, 'anthem')
      && !K.creatorCan(music, 'skinRequest')
      && !K.creatorCan(music, 'director')
      && !K.creatorCan(music, 'devPro');
  })());

  suite('Creators — links');

  /** Every one of these is a way of making a label disagree with a destination. */
  const hostile = [
    ['user@evil.com', 'userinfo in front of a host'],
    ['evil.com:8080', 'a port'],
    ['xn--80ak6aa92e.com', 'punycode, which reads as another domain'],
    ['1.2.3.4', 'a bare address'],
    ['localhost', 'no public TLD'],
    ['javascript:alert(1)', 'a scheme'],
    ['data:text/html,<script>', 'a data URL'],
    ['', 'nothing at all'],
  ];
  check('nothing typed into a website field can become anything but a host', (() => {
    for (const [raw, why] of hostile) {
      const handle = K.normaliseCreatorHandle('site', raw);
      if (K.creatorLinkUrl({ platform: 'site', handle })) {
        info(`accepted ${JSON.stringify(raw)} — ${why}`);
        return false;
      }
    }
    return true;
  })());

  check('and a path is dropped rather than dragging the whole link down with it', (() => {
    /*
     * The other half of the same rule, and the one that is easy to get
     * backwards. `evil.com/@someone` must not be *refused* — the host in it is
     * perfectly ordinary — it must be *reduced* to that host, so the URL that
     * reaches another player's screen cannot carry a path somebody chose to
     * make it read as a profile that is not theirs.
     */
    const cases = [
      ['evil.com/@someone', 'https://evil.com'],
      ['ok.dev/a/b/c?d=e#f', 'https://ok.dev'],
      ['sub.example.co.uk/', 'https://sub.example.co.uk'],
    ];
    for (const [raw, want] of cases) {
      const url = K.creatorLinkUrl({ platform: 'site', handle: K.normaliseCreatorHandle('site', raw) });
      if (url !== want) { info(`${raw} → ${url}, wanted ${want}`); return false; }
    }
    return true;
  })());

  check('a pasted profile URL is folded back into the handle it contains', (() => {
    const cases = [
      ['twitch', 'https://twitch.tv/CoolPerson/', 'coolperson'],
      ['youtube', 'https://www.youtube.com/@MyChannel', 'MyChannel'],
      ['soundcloud', '@nova-sound', 'nova-sound'],
      ['bandcamp', 'someband.bandcamp.com', 'someband'],
      ['site', 'https://me.example.com/portfolio?x=1#y', 'me.example.com'],
    ];
    for (const [platform, raw, want] of cases) {
      const got = K.normaliseCreatorHandle(platform, raw);
      if (got !== want) { info(`${platform}: ${raw} → ${got}, wanted ${want}`); return false; }
    }
    return true;
  })());

  check('the URL is built from the pair, never taken from the sender', (() => {
    // A stored link is a platform id and a handle. There is no field in it
    // that could carry a URL, which is the whole design.
    const built = K.normaliseCreatorLinks([
      { platform: 'twitch', handle: 'coolperson', url: 'https://evil.example/' },
      { platform: 'site', handle: 'ok.dev' },
    ]);
    return built.length === 2
      && !('url' in built[0])
      && K.creatorLinkUrl(built[0]) === 'https://www.twitch.tv/coolperson'
      && K.creatorLinkUrl(built[1]) === 'https://ok.dev';
  })());

  check('one platform per card, and never more than the cap', (() => {
    const many = K.normaliseCreatorLinks([
      ...Array.from({ length: 4 }, () => ({ platform: 'twitch', handle: 'aaaa' })),
      ...K.CREATOR_PLATFORM_IDS.slice(0, 9).map((p) => ({ platform: p, handle: 'abcdefghij' })),
    ]);
    const platforms = new Set(many.map((l) => l.platform));
    return many.length <= K.CREATOR_LINKS_MAX && platforms.size === many.length;
  })());

  check('a broken link is dropped rather than dropping the whole set', (() => {
    const kept = K.normaliseCreatorLinks([
      { platform: 'nope', handle: 'x' },
      { platform: 'twitch', handle: 'realchannel' },
      { platform: 'x', handle: 'way_too_long_for_this_platform' },
      null,
    ]);
    return kept.length === 1 && kept[0].handle === 'realchannel';
  })());

  suite('Creators — developer mode');

  check('the level is what opens it, and the server switch beats everything', (() => {
    const low = K.devModeAccess({ level: K.DEV_MODE_LEVEL - 1 });
    const ok = K.devModeAccess({ level: K.DEV_MODE_LEVEL });
    const coder = K.devModeAccess({ level: 1, creator: { kind: 'code', status: 'approved' } });
    const off = K.devModeAccess({ level: 99, creator: { kind: 'code', status: 'approved' } },
      { enabled: false });
    info(`level ${K.DEV_MODE_LEVEL - 1}: ${low.allowed} · ${K.DEV_MODE_LEVEL}: ${ok.allowed} `
      + `· code creator at level 1: ${coder.allowed} (${coder.panels.length} panels) `
      + `· switched off: ${off.allowed}`);
    return !low.allowed && ok.allowed && coder.allowed && coder.pro && !off.allowed
      && off.panels.length === 0;
  })());

  check('the level gate opens the plain panels and never the pro ones', (() => {
    const plain = K.devModeAccess({ level: 99 });
    return !plain.pro
      && K.DEV_PRO_PANEL_IDS.every((id) => !plain.panels.includes(id))
      && plain.panels.length === K.DEV_PANELS.length - K.DEV_PRO_PANEL_IDS.length;
  })());

  suite('Creators — the kill cam');

  check('the skip lands inside the cam and after the respawn', (() => {
    // Three seconds is the whole shape of it: long enough that the cam has
    // said who, with what and from where, short enough that nobody is held —
    // and past RESPAWN_TIME, so pressing skip really does put you back in
    // rather than into a wait the cam was hiding.
    info(`respawn ${K.RESPAWN_TIME}s · skip at ${K.KILLCAM_SKIP_AFTER}s · cam ${K.KILLCAM_SECONDS}s`);
    return K.KILLCAM_SKIP_AFTER > K.RESPAWN_TIME
      && K.KILLCAM_SKIP_AFTER < K.KILLCAM_SECONDS
      && K.KILLCAM_DIRECTOR_SECONDS > K.KILLCAM_SECONDS;
  })());

  check('an anthem is never longer than the cam that plays it',
    K.ANTHEM_MAX_SECONDS <= K.KILLCAM_SECONDS);
}

/* ── What a death actually carries ───────────────────────────────────────────
 *
 * The last link in the chain, and the one nothing else covers: the routes above
 * prove a track can be stored and served, and the client tests prove a cam can
 * draw one — this is the room deciding which player's URL to put in front of
 * which player's eyes.
 *
 * It runs against a real Room rather than over HTTP because a kill is not
 * something the REST API can be asked for, and the interesting part is the
 * message, not the transport.
 * ────────────────────────────────────────────────────────────────────────── */

function theDeathMessage() {
  suite('Creators — what a death carries');

  const makeRoom = () => {
    const room = new Room({ id: 'test-creators', mapId: 'crossfire', modeId: 'ffa' });
    const out = [];
    room.broadcast = (m) => out.push(m);
    room.broadcastNear = (m) => out.push(m);
    room.sendTo = (p, m) => out.push({ ...m, _to: p.id });
    room.messages = out;
    return room;
  };
  const seat = (room, name, extra = {}) => {
    const p = new Player({ ws: null, name, userId: `u-${name}`, classId: 'triggerman', ...extra });
    room.add(p);
    room.respawn(p);
    return p;
  };
  const deathTo = (room, victim) => [...room.messages].reverse()
    .find((m) => m.o === K.S2C.DEATH && m._to === victim.id);

  {
    const room = makeRoom();
    const killer = seat(room, 'Composer', {
      level: 21,
      creator: { kind: 'music', status: 'approved' },
      anthem: '/avatars/anthems/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-0123456789ab.wav',
      anthemTitle: 'Overdrive',
      clan: 'GRUN', clanVerified: true,
    });
    const victim = seat(room, 'Victim');
    room.onKill(killer, victim, 'ar', true, null, { distance: 41.4 });
    const msg = deathTo(room, victim);

    check('a music creator\'s kill carries their track, their badge and the shot', (() => {
      info(`${msg?.by} · ${msg?.byCreator} · ${msg?.distance}m · cam ${msg?.cam?.seconds}s `
        + `· skip ${msg?.cam?.skipAfter}s · "${msg?.anthemTitle}"`);
      return msg?.anthem === killer.anthem && msg.anthemTitle === 'Overdrive'
        && msg.byCreator === 'music' && msg.byLevel === 21 && msg.byClan === 'GRUN'
        && msg.byClanVerified === true && msg.distance === 41 && msg.head === true
        && msg.cam.seconds === K.KILLCAM_SECONDS
        && msg.cam.skipAfter === K.KILLCAM_SKIP_AFTER;
    })());

    check('and the respawn timer is exactly what it always was',
      msg.respawnIn === K.RESPAWN_TIME,
      'the cam holds the respawn by not asking for one, never by moving it');
  }

  {
    // The ordinary case, and the one that has to look deliberate rather than
    // broken: no anthem, no sound, cam still runs.
    const room = makeRoom();
    const killer = seat(room, 'Ordinary', { level: 4 });
    const victim = seat(room, 'Victim');
    room.onKill(killer, victim, 'ar', false, null, { distance: 12 });
    const msg = deathTo(room, victim);
    check('a killer with no anthem sends null and the cam runs silent',
      msg.anthem === null && msg.anthemTitle === null && msg.byCreator === null
      && msg.cam.seconds === K.KILLCAM_SECONDS);
  }

  {
    // A *pending* application is not a badge and not a track, and the room is
    // the last place that could get this wrong.
    const room = makeRoom();
    const killer = seat(room, 'Hopeful', {
      creator: { kind: 'music', status: 'pending' },
      anthem: '/avatars/anthems/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-0123456789ab.wav',
      anthemTitle: 'Not Yet',
    });
    const victim = seat(room, 'Victim');
    room.onKill(killer, victim, 'ar', false, null, {});
    const msg = deathTo(room, victim);
    // The URL never reaches the player either, because the handshake refuses to
    // resolve one for an unapproved account — this is belt and braces on the
    // badge, which the room derives itself.
    check('a pending application is not a badge on the kill cam',
      msg.byCreator === null, 'creatorKind answers null for anything but approved');
  }

  {
    // Killing yourself, and being killed by the map. There is nobody to look
    // at, so `cam.seconds` is zero and the client falls back to the plain
    // death screen — which is the screen the game had before any of this.
    const room = makeRoom();
    const alone = seat(room, 'Faller');
    room.onKill(null, alone, 'fall', false, null, {});
    const world = deathTo(room, alone);
    room.respawn(alone);
    room.onKill(alone, alone, 'rocket', false, null, {});
    const self = deathTo(room, alone);
    check('the world killing you asks for no cam at all',
      world.cam.seconds === 0 && world.byId === 0 && self.cam.seconds === 0,
      'a fall and a suicide both fall back to the plain death screen');
  }

  {
    const room = makeRoom();
    const killer = seat(room, 'Anyone');
    const director = seat(room, 'Editor', { creator: { kind: 'video', status: 'approved' } });
    room.onKill(killer, director, 'ar', false, null, {});
    const msg = deathTo(room, director);
    check("the director's cut belongs to the *victim*, not the killer", (() => {
      // It is the person *watching* the cam whose status decides how long it
      // runs, which is the whole point of it being a capture tool.
      const room2 = makeRoom();
      const k2 = seat(room2, 'Anyone2', { creator: { kind: 'video', status: 'approved' } });
      const v2 = seat(room2, 'Plain');
      room2.onKill(k2, v2, 'ar', false, null, {});
      const other = [...room2.messages].reverse()
        .find((m) => m.o === K.S2C.DEATH && m._to === v2.id);
      info(`video creator dying: ${msg.cam.director}s offered · `
        + `killed *by* one: ${other.cam.director}s`);
      return msg.cam.director === K.KILLCAM_DIRECTOR_SECONDS && other.cam.director === 0;
    })());
  }
}

/* ── The routes ──────────────────────────────────────────────────────────── */

async function startServer({ port, dbPath, dir }) {
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', join(ROOT, 'server/index.js')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        DB_PATH: dbPath,
        AVATAR_DIR: join(dir, 'avatars'),
        CLAN_AVATAR_DIR: join(dir, 'clans'),
        ANTHEM_DIR: join(dir, 'anthems'),
        PUBLIC_URL: `http://127.0.0.1:${port}`,
        LOG_LEVEL: 'warn',
        SERVE_STATIC: 'false',
        ADMIN_ENABLED: 'false',
        BOTS_ENABLED: 'false',
        PRACTICE_BOTS: '0',
        ROOMS: 'burgtown:ffa',
        RATE_MAX_REQUESTS: '20000',
        RATE_MAX_AUTH: '2000',
        SCRYPT_COST: '1024',
        TURNSTILE_ENABLED: 'false',
        EMAIL_VERIFICATION: 'false',
        CREATORS_NEED_EMAIL: 'false',
        VPN_BLOCK: 'false',
        SINGLE_SESSION: 'false',
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

async function call(base, method, path, { body, token, raw, type } = {}) {
  const headers = {};
  if (raw) headers['content-type'] = type ?? 'application/octet-stream';
  else headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export default async function run() {
  levelling();
  vocabulary();
  theDeathMessage();

  const dir = mkdtempSync(join(tmpdir(), 'og-creators-'));
  const dbPath = join(dir, 'creators.db');
  const port = await freePort();
  let server;
  try {
    server = await startServer({ port, dbPath, dir });
  } catch (err) {
    suite('Creators — end to end');
    check('the server boots', false, err.message);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const { base } = server;

  /** Applying is level-gated, and everything interesting is past that gate. */
  const promote = (name, lvl) => {
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE users SET level = ?, xp = ?, email_verified = 1 WHERE username_lower = ?')
      .run(lvl, K.xpForLevel(lvl), name.toLowerCase());
    db.close();
  };
  /** Approval is a human decision, and the admin API is off in this server. */
  const approve = (name, kind) => {
    const db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE creators SET status = 'approved', kind = ?, decided_at = ?
                WHERE user_id = (SELECT id FROM users WHERE username_lower = ?)`)
      .run(kind, Math.floor(Date.now() / 1000), name.toLowerCase());
    db.close();
  };
  const register = async (username) => {
    const r = await call(base, 'POST', '/api/v1/auth/register',
      { body: { username, password: 'correct-horse-battery' } });
    return r.body.token;
  };

  const goodPitch = 'I have written the soundtracks for four small games and release '
    + 'chiptune under my own name. Happy to send stems.';
  const links = [{ platform: 'soundcloud', handle: 'nova-sound' }];

  try {
    suite('Creators — applying');

    const nova = await register('CrNova');
    const pablo = await register('CrPablo');
    const guest = null;

    let r = await call(base, 'GET', '/api/v1/creator', { token: nova });
    check('the tab is one request: rules, standing, dev access and briefs',
      r.status === 200 && r.body.rules?.kinds?.length === K.CREATOR_KINDS.length
      && r.body.creator === null && typeof r.body.dev?.allowed === 'boolean',
      `minLevel ${r.body.rules?.minLevel}`);

    check('a level-1 account is told what it needs rather than shown a form',
      r.body.apply.can === false && /level/i.test(r.body.apply.why ?? ''),
      r.body.apply.why);

    r = await call(base, 'POST', '/api/v1/creator/apply',
      { token: nova, body: { kind: 'music', pitch: goodPitch, links } });
    check('and applying under the level is refused by the route too',
      r.status === 403 && r.body.error === 'cannot_apply');

    promote('CrNova', K.CREATOR_MIN_LEVEL);
    promote('CrPablo', K.CREATOR_MIN_LEVEL);

    r = await call(base, 'POST', '/api/v1/creator/apply',
      { token: nova, body: { kind: 'music', pitch: 'too short', links } });
    check('a pitch nobody could act on is refused', r.body.error === 'pitch_too_short');

    r = await call(base, 'POST', '/api/v1/creator/apply',
      { token: nova, body: { kind: 'music', pitch: goodPitch, links: [] } });
    check('and so is one with nowhere to look', r.body.error === 'no_links');

    r = await call(base, 'POST', '/api/v1/creator/apply',
      { token: nova, body: { kind: 'sculpture', pitch: goodPitch, links } });
    check('an invented discipline is refused', r.body.error === 'unknown_kind');

    r = await call(base, 'POST', '/api/v1/creator/apply', {
      token: nova,
      body: {
        kind: 'music',
        pitch: goodPitch,
        links: [{ platform: 'soundcloud', handle: 'https://soundcloud.com/Nova-Sound/' }],
      },
    });
    check('a good application lands, with its links folded into handles',
      r.status === 200 && r.body.creator.status === 'pending'
      && r.body.creator.links[0].handle === 'nova-sound'
      && r.body.creator.links[0].url === 'https://soundcloud.com/nova-sound',
      r.body.creator?.links?.[0]?.url);

    // Pablo applies as an artist, so the discipline gates below have two real
    // creators of different kinds to be pushed against.
    r = await call(base, 'POST', '/api/v1/creator/apply', {
      token: pablo,
      body: {
        kind: 'art',
        pitch: 'I paint weapon finishes and have done concept work for two shipped games. '
          + 'Portfolio and process shots are on ArtStation.',
        links: [{ platform: 'artstation', handle: 'pablo-paints' }],
      },
    });
    check('a second applicant lands in the same queue',
      r.status === 200 && r.body.creator.status === 'pending' && r.body.creator.kind === 'art');

    suite('Creators — the gates');

    const silence = wav(gen(3, (t) => 0.3 * Math.sin(2 * Math.PI * 300 * t)));
    r = await call(base, 'POST', '/api/v1/creator/anthem?title=Nope',
      { token: nova, raw: silence, type: 'audio/wav' });
    check('a pending application cannot upload an anthem',
      r.status === 403 && r.body.error === 'not_a_creator', r.body.message);

    approve('CrNova', 'music');
    approve('CrPablo', 'art');

    r = await call(base, 'POST', '/api/v1/creator/skin-requests', {
      token: nova,
      body: { name: 'Neon Drift', slot: 'primary', brief: 'x'.repeat(80), palette: ['#ff00aa'] },
    });
    check('a music creator cannot file a skin brief',
      r.status === 403 && r.body.error === 'wrong_creator_kind', r.body.message);

    r = await call(base, 'POST', '/api/v1/creator/anthem?title=Nope',
      { token: pablo, raw: silence, type: 'audio/wav' });
    check('and an art creator cannot upload an anthem',
      r.status === 403 && r.body.error === 'wrong_creator_kind', r.body.message);

    suite('Creators — the anthem, end to end');

    const troll = wav(gen(10, (t) => Math.sign(Math.sin(2 * Math.PI * 200 * t)) * 0.999));
    r = await call(base, 'POST', '/api/v1/creator/anthem?title=MAXIMUM%20VOLUME',
      { token: nova, raw: troll, type: 'audio/wav' });
    check('a full-scale square wave uploads — and is turned right down doing it',
      r.status === 200 && r.body.levelling.gainDb < -12
      && r.body.creator.anthemTitle === 'MAXIMUM VOLUME',
      `${r.body.levelling?.gainDb} dB · ${r.body.levelling?.before?.loudDb} → `
      + `${r.body.levelling?.after?.loudDb} dB`);

    const url = r.body.creator.anthem;
    check('the stored URL is one the server built, under the proxied prefix',
      // Under /avatars/ rather than a prefix of its own, so that a deployment
      // whose nginx config predates anthems serves them anyway — see the note
      // on `clanAvatars` in util/avatar.js, which is the same decision.
      typeof url === 'string' && url.startsWith('/avatars/anthems/') && url.endsWith('.wav'), url);

    const stored = await fetch(base + url);
    const bytes = Buffer.from(await stored.arrayBuffer());
    const back = loudnessOf(bytes);
    check('and what is served back is the levelled file, not what was sent',
      stored.headers.get('content-type') === 'audio/wav'
      && Math.abs(back.loudDb - K.ANTHEM_TARGET_RMS_DB) < 1.5
      && back.info.sampleRate === SR && back.info.channels === 1,
      `${back.loudDb.toFixed(1)} dB on disk`);

    check('it is cached hard, because the name is a content hash',
      /immutable/.test(stored.headers.get('cache-control') ?? ''),
      stored.headers.get('cache-control'));

    // One file per creator, whatever they upload.
    await call(base, 'POST', '/api/v1/creator/anthem?title=Second',
      { token: nova, raw: wav(gen(4, (t) => 0.2 * Math.sin(2 * Math.PI * 260 * t))), type: 'audio/wav' });
    check('replacing a track sweeps the one it replaced', (() => {
      const files = readdirSync(join(dir, 'anthems')).filter((f) => f.endsWith('.wav'));
      info(`${files.length} file(s) on disk after two uploads`);
      return files.length === 1;
    })());

    r = await call(base, 'DELETE', '/api/v1/creator/anthem', { token: nova });
    check('and deleting one takes the file with it',
      r.status === 200 && r.body.creator.anthem === null
      && readdirSync(join(dir, 'anthems')).filter((f) => f.endsWith('.wav')).length === 0);

    suite('Creators — briefs and the card');

    r = await call(base, 'POST', '/api/v1/creator/skin-requests', {
      token: pablo,
      body: {
        name: 'Neon Drift',
        slot: 'primary',
        brief: 'A cold magenta chrome with a scanline sheen down the receiver, '
          + 'reading almost black until the light catches it.',
        palette: ['#FF00AA', '#00ffcc', '#FF00AA'],
        reference: 'artstation',
      },
    });
    check('an art creator files a brief, palette deduplicated and folded',
      r.status === 200 && r.body.request.palette.length === 2
      && r.body.request.palette[0] === '#ff00aa',
      JSON.stringify(r.body.request?.palette));

    check('the reference is one of their own links, kept by platform id',
      r.body.request.reference === 'artstation');

    // Before the second good one: this has to be refused for its *name*, and a
    // creator already at the open-brief ceiling would be refused for that
    // instead — a check that passes for the wrong reason is not a check.
    r = await call(base, 'POST', '/api/v1/creator/skin-requests', {
      token: pablo, body: { name: 'x', slot: 'primary', brief: 'x'.repeat(80) },
    });
    check('a finish with no real name is refused', r.body.error === 'bad_name', r.body.message);

    r = await call(base, 'POST', '/api/v1/creator/skin-requests', {
      token: pablo, body: { name: 'No Slot', slot: 'nonsense', brief: 'x'.repeat(80) },
    });
    check('and one for a slot that does not exist', r.body.error === 'bad_slot');

    r = await call(base, 'POST', '/api/v1/creator/skin-requests', {
      token: pablo, body: { name: 'Too Vague', slot: 'primary', brief: 'make it cool' },
    });
    check('and one nobody could draw from', r.body.error === 'brief_too_short');

    r = await call(base, 'POST', '/api/v1/creator/skin-requests', {
      token: pablo,
      body: {
        name: 'Second Look', slot: 'primary', brief: 'z'.repeat(80),
        reference: 'https://evil.example/phish',
      },
    });
    check('and a reference that is not one of their links is dropped, never stored',
      r.status === 200 && r.body.request.reference === null,
      'nothing typed becomes a destination — the same rule as every link on a card');

    // The open-brief ceiling is what keeps this a queue rather than a wishlist.
    // Pablo already has SKIN_REQUEST_OPEN_MAX standing, so the next one is the
    // one that has to be refused — filing five more would test the rate limiter
    // instead, which is a different thing with a different message.
    r = await call(base, 'POST', '/api/v1/creator/skin-requests', {
      token: pablo,
      body: { name: 'One Too Many', slot: 'primary', brief: 'y'.repeat(80) },
    });
    check('and the queue has a ceiling on it',
      r.status === 409 && r.body.error === 'too_many_open', r.body.message);

    r = await call(base, 'GET', '/api/v1/players/CrNova');
    check('an approved creator wears the status on their public card',
      r.status === 200 && r.body.user.creator?.kind === 'music'
      && r.body.user.creator.status === 'approved',
      `${r.body.user?.creator?.kindName} creator`);

    check('but never the application behind it', (() => {
      // Own-account only: the pitch, the verdict and who read it are not
      // things a stranger opening a card gets to see.
      const c = r.body.user.creator;
      return !('pitch' in c) && !('verdict' in c) && !('decidedBy' in c) && !('asked' in c);
    })());

    await call(base, 'PUT', '/api/v1/creator/links', {
      token: nova,
      body: {
        links: [
          { platform: 'site', handle: 'https://nova.example.com/portfolio?x=1' },
          { platform: 'youtube', handle: '@NovaSound' },
        ],
      },
    });
    r = await call(base, 'GET', '/api/v1/players/CrNova');
    check('links on a card are built by the server, host only, no path', (() => {
      const urls = (r.body.user.creator?.links ?? []).map((l) => l.url);
      info(urls.join(' · '));
      return urls.includes('https://nova.example.com')
        && urls.includes('https://www.youtube.com/@NovaSound')
        && urls.every((u) => u.startsWith('https://'));
    })());

    r = await call(base, 'GET', '/api/v1/players/CrPablo');
    check('a card shows the handle beside every link, never the address',
      (r.body.user.creator?.links ?? []).every((l) => l.label && !l.label.includes('://')));

    suite('Creators — stepping down');

    await call(base, 'POST', '/api/v1/creator/anthem?title=Last',
      { token: nova, raw: wav(gen(3, (t) => 0.3 * Math.sin(2 * Math.PI * 300 * t))), type: 'audio/wav' });
    r = await call(base, 'DELETE', '/api/v1/creator', { token: nova });
    check('resigning is recorded as a decision rather than a deletion',
      r.status === 200 && r.body.creator?.status === 'revoked', r.body.creator?.status);

    check('and the anthem goes with the status',
      readdirSync(join(dir, 'anthems')).filter((f) => f.endsWith('.wav')).length === 0,
      'a perk that outlives the status it came from is a perk nobody took away');

    r = await call(base, 'GET', '/api/v1/players/CrNova');
    check('a revoked creator is no creator at all on a public card',
      r.body.user.creator === null);

    r = await call(base, 'POST', '/api/v1/creator/apply',
      { token: nova, body: { kind: 'music', pitch: goodPitch, links } });
    check('and re-applying waits out the cooldown',
      r.status === 403 && /apply again/.test(r.body.message ?? ''), r.body.message);

    suite('Creators — signed out');

    for (const [method, path] of [
      ['GET', '/api/v1/creator'],
      ['POST', '/api/v1/creator/apply'],
      ['PUT', '/api/v1/creator/links'],
      ['DELETE', '/api/v1/creator'],
      ['POST', '/api/v1/creator/anthem'],
      ['GET', '/api/v1/creator/skin-requests'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(base, method, path,
        { token: guest, body: method === 'GET' ? undefined : {} });
      if (res.status !== 401) {
        check(`none of this is reachable signed out (${method} ${path})`, false, `got ${res.status}`);
        break;
      }
    }
    check('none of this is reachable signed out', true, '6 routes, all 401');
  } finally {
    server?.child.kill('SIGTERM');
    await sleep(200);
    rmSync(dir, { recursive: true, force: true });
  }
}
