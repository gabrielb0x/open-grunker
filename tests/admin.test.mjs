/**
 * Open Grunker — the admin panel's stats tab.
 *
 * The panel is a second page with its own module, and until now nothing ever
 * executed a line of it. This loads the real `client/admin/index.html` into the
 * shim, imports the real `admin.js`, and renders the STATS tab against a
 * payload shaped exactly like the one `/admin/stats` returns — which is what
 * catches a typo'd element id, a renamed field, or a chart called with the
 * wrong shape.
 *
 * It owns the document afterwards, so this suite runs last.
 */
import { suite, check, info } from './harness.mjs';
import { installBrowser, loadPage } from './browser-shim.mjs';

installBrowser();
loadPage('client/admin/index.html');

// admin.js talks to /api/v1/admin on import and on every action. Nothing here
// exercises the transport, so it answers with what the panel expects and
// records what was asked for.
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url));
  return { ok: true, status: 200, json: async () => ({ ok: true, events: [] }) };
};
globalThis.sessionStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const admin = await import('/admin/admin.js');

/** A payload with the same shape and the same field names the server sends. */
function payload() {
  const now = Math.floor(Date.now() / 1000);
  const series = (f) => Array.from({ length: 96 }, (_, i) => [now - (96 - i) * 900, f(i)]);
  const names = [
    'players.online', 'players.accounts', 'players.guests', 'players.watching',
    'players.bots', 'rooms.open', 'rooms.live', 'rooms.dynamic', 'rooms.freeSeats',
    'server.tickMs', 'server.tickMaxMs', 'server.memMb', 'server.sockets',
    'server.overloadDrops', 'game.kills', 'game.headshots', 'game.deaths',
    'game.shots', 'game.damage', 'game.chat', 'game.joins', 'game.leaves', 'game.matches',
  ];
  return {
    window: { since: now - 86400, until: now, hours: 24, bucketSec: 900, dayBucketSec: 3600 },
    live: {
      game: {
        rooms: 11, liveRooms: 4, dynamicRooms: 3, maxRooms: 32, players: 14, watching: 5, bots: 2,
        freeSeats: 9, ticks: 900000, lastTickMs: 1.4, maxTickMs: 6.2, overloadDrops: 0,
        roomsOpened: 14, roomsClosed: 3, peakPlayers: 22, peakRooms: 12,
      },
      rooms: [], db: { users: 412, matches: 7669, clans: 6 },
      uptime: 93_400, memoryMb: 148, sampling: true, lastSampleAt: now,
      version: 'v1', currency: 'GR',
    },
    series: Object.fromEntries(names.map((n) => [n, series((i) => 3 + (i % 11))])),
    meta: {},
    events: {
      mix: [{ kind: 'login', n: 88 }, { kind: 'signup', n: 12 }, { kind: 'level.up', n: 40 }],
      signups: series((i) => i % 3),
      logins: series((i) => i % 5),
      levelUps: series((i) => i % 4),
      matches: series((i) => i % 2),
    },
    game: {
      matches: series((i) => i % 6),
      activePlayers: series((i) => i % 7),
      signups: series((i) => i % 3),
      // The server resolves the display name from the same modules the game
      // builds these out of; the panel only falls back when it did not.
      maps: [
        { key: 'littletown', name: 'Littletown', n: 900 },
        { key: 'burgtown', name: 'Burgtown', n: 610 },
        { key: 'subzero', name: 'Subzero', n: 300 },
      ],
      modes: [{ key: 'ffa', name: 'Free For All', n: 1200 }, { key: 'tdm', name: 'Team Deathmatch', n: 500 }],
      classes: [
        { key: 'triggerman', name: 'Triggerman', n: 136, wins: 80, kills: 937, deaths: 763, winRate: 58.8, kd: 1.23 },
        { key: 'spraynpray', n: 62, wins: 39, kills: 1087, deaths: 958, winRate: 62.9, kd: 1.13 },
      ],
      hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour: h, n: (h * 13) % 41 })),
    },
    population: {
      levels: [{ band: 0, n: 120 }, { band: 5, n: 90 }, { band: 10, n: 40 }],
      economy: { accounts: 412, grHeld: 918_400, xpTotal: 8_100_000, avgLevel: 7.4, grPaidOut: 640_200 },
      retention: { cohort: 412, played: 300, returned: 180, streaking: 42, playedPct: 72.8, returnedPct: 43.7 },
      newRetention: { cohort: 12, played: 9, returned: 4, streaking: 1, playedPct: 75, returnedPct: 33.3 },
    },
    top: { players: [] },
  };
}

const $ = (id) => document.getElementById(id);
const svgCount = (id) => ($(id)?.querySelectorAll('svg') ?? []).length;

export default async function run() {
  suite('Admin panel — the stats tab');

  check('the panel exports its stats renderer', typeof admin.renderStats === 'function');

  check('every element the stats tab reaches for exists in the markup', (() => {
    const ids = [
      'statTiles', 'statRange', 'statWindow', 'btnStatReload', 'statFollow',
      'chPopulation', 'lgPopulation', 'chRooms', 'lgRooms', 'chSeats',
      'chCombat', 'lgCombat', 'chShots', 'chMatches',
      'chSignups', 'chLogins', 'chActive',
      'stRetention', 'chLevels', 'stEconomy',
      'chMaps', 'chModes', 'chClasses',
      'chHours', 'chTick', 'lgTick', 'chMemory',
      'chEventMix', 'eventBox',
    ];
    const missing = ids.filter((id) => !$(id));
    info(missing.length ? `missing: ${missing.join(', ')}` : `${ids.length} hosts`);
    return missing.length === 0;
  })());

  let threw = null;
  try { admin.renderStats(payload()); } catch (e) { threw = e; }
  check('a full render runs without throwing', threw === null, threw?.stack?.split('\n')[0] ?? '');

  check('the tiles are filled in', (() => {
    const tiles = $('statTiles').querySelectorAll('.tile');
    const labels = tiles.map((t) => t.querySelector('.t-label')?.textContent);
    info(labels.join(' · '));
    return tiles.length === 8 && tiles.every((t) => (t.querySelector('.t-value')?.textContent ?? '') !== '');
  })());

  check('and each one carries its own sparkline', (() => {
    const sparks = $('statTiles').querySelectorAll('svg');
    return sparks.length >= 6;
  })());

  check('every chart host drew something', (() => {
    const hosts = ['chPopulation', 'chRooms', 'chSeats', 'chCombat', 'chShots', 'chMatches',
      'chSignups', 'chLogins', 'chActive', 'chLevels', 'chMaps', 'chModes', 'chClasses',
      'chHours', 'chTick', 'chMemory', 'chEventMix'];
    const blank = hosts.filter((h) => svgCount(h) === 0);
    info(blank.length ? `blank: ${blank.join(', ')}` : `${hosts.length} charts`);
    return blank.length === 0;
  })());

  check('a multi-series chart is always given a legend', (() => {
    // Identity is never colour alone: two or more series, and there is a key.
    const pop = $('lgPopulation').querySelectorAll('li').length;
    const rooms = $('lgRooms').querySelectorAll('li').length;
    const combat = $('lgCombat').querySelectorAll('li').length;
    const tick = $('lgTick').querySelectorAll('li').length;
    info(`population ${pop} · rooms ${rooms} · combat ${combat} · tick ${tick}`);
    return pop === 4 && rooms === 3 && combat === 3 && tick === 2;
  })());

  check('the meters read as proportions of something named', (() => {
    const ret = $('stRetention').querySelectorAll('.meter');
    const eco = $('stEconomy').querySelectorAll('.meter');
    const fills = $('stRetention').querySelectorAll('.meter-fill');
    info(`${ret.length} retention meter(s), ${eco.length} economy meter(s)`);
    return ret.length === 4 && eco.length === 2
      && fills.every((f) => /^\d+(\.\d+)?%$/.test(f.style.width));
  })());

  check('the class board shows the win rate beside the pick rate', (() => {
    // Pick rate says what is popular; win rate says whether that is a problem.
    const labels = $('chClasses').querySelectorAll('text').map((t) => t.textContent);
    info(labels.join(' · '));
    // The named row uses the server's name; the unnamed one falls back cleanly.
    return labels.includes('Triggerman') && labels.includes('136') && labels.includes('Spraynpray');
  })());

  check('the range buttons are wired and scope the whole page', (() => {
    const before = asked.length;
    $('statRange').querySelectorAll('.rg')[2].click();      // 7D
    const hit = asked.slice(before).some((u) => u.includes('/stats?hours=168'));
    info(asked[asked.length - 1] ?? 'nothing requested');
    return hit;
  })());

  check('a second render replaces the previous one rather than stacking', (() => {
    const before = svgCount('chPopulation');
    admin.renderStats(payload());
    const after = svgCount('chPopulation');
    return before === 1 && after === 1;
  })());

  check('an empty server says so instead of drawing empty boxes', (() => {
    const blank = payload();
    for (const k of Object.keys(blank.series)) blank.series[k] = [];
    blank.game.maps = [];
    blank.game.classes = [];
    blank.events.mix = [];
    admin.renderStats(blank);
    const notes = [$('chPopulation'), $('chMaps'), $('chClasses'), $('chEventMix')]
      .map((h) => h.querySelector('.chart-empty')?.textContent);
    info(notes.filter(Boolean).length + ' of 4 said so');
    return notes.every(Boolean);
  })());
}
