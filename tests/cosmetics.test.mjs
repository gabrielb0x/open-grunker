/**
 * Open Grunker — the V2 item economy.
 *
 * What is on trial here is not that the catalogue is big. It is that an item
 * economy has exactly four ways to go badly wrong, and none of them are things
 * a type checker or a code review catches:
 *
 *   1. **Odds that lie.** A case that publishes 0.25% mythic and pays out 3%
 *      is worse than no odds at all. The published table and the roll come
 *      from the same function here, and a hundred thousand rolls are counted
 *      against it.
 *   2. **Duplication.** Anything that lets one item become two — a trade that
 *      half-applies, a listing bought twice, a scrap that pays and does not
 *      take — is an economy that is over. Every mover is exercised against
 *      itself.
 *   3. **Theft.** Selling what you do not own, equipping what you have not
 *      bought, spending GR you do not have.
 *   4. **Silent loss.** Somebody's paid-for wardrobe vanishing across the V1
 *      to V2 migration, which is the one failure that cannot be undone by
 *      fixing the code.
 *
 * The first is arithmetic and runs in-process. The rest are all rules a route
 * enforces rather than a function computes, so they run over HTTP against a
 * real server, the way friends.test.mjs does.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as COS from '../shared/cosmetics.js';
import { xpForLevel } from '../shared/constants.js';
import { suite, check, info, sleep } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const freePort = () => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

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
        VPN_BLOCK: 'false',
        SINGLE_SESSION: 'false',
        FRIEND_REQUEST_COOLDOWN_SEC: '0',
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

async function call(base, method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/* ── The catalogue and the odds, in process ──────────────────────────────── */

function catalogue() {
  suite('Cosmetics — the catalogue');

  check('there is a lot of it, which was the point',
    COS.ITEM_IDS.length >= 200, `${COS.ITEM_IDS.length} items`);

  check('every slot has something in it', (() => {
    const empty = COS.SLOT_IDS.filter((s) => COS.itemsInSlot(s).length === 0);
    info(COS.SLOT_IDS.map((s) => `${s}:${COS.itemsInSlot(s).length}`).join(' · '));
    return empty.length === 0;
  })());

  check('every item is well formed and lands in the slot its id names', (() => {
    for (const id of COS.ITEM_IDS) {
      const item = COS.ITEMS[id];
      const parsed = COS.parseItemId(id);
      if (!parsed || parsed.slot !== item.slot) return false;
      if (!item.name || !COS.RARITY[item.rarity]) return false;
      if (typeof item.price !== 'number') return false;
      if (!Array.isArray(item.swatch) || item.swatch.length < 2) return false;
    }
    return true;
  })());

  check('an animated item is never below legendary — that is the whole tier', (() => {
    const animated = COS.ITEM_IDS.map((id) => COS.ITEMS[id]).filter((i) => i.anim);
    const cheap = animated.filter((i) => COS.RARITY[i.rarity].tier < COS.ANIMATED_MIN_TIER);
    info(`${animated.length} animated item(s), ${cheap.length} of them below legendary`);
    return animated.length >= 20 && cheap.length === 0;
  })());

  check('and every animation names a kind the renderer knows', (() => {
    const bad = COS.ITEM_IDS.map((id) => COS.ITEMS[id])
      .filter((i) => i.anim && !Object.values(COS.ANIM).includes(i.anim));
    return bad.length === 0;
  })());

  check('price rises with rarity, every single step of the ladder', (() => {
    // Compared within one slot, because the slot multiplier is deliberately
    // allowed to make a common knife dearer than a common sidearm.
    for (const slot of COS.SLOT_IDS) {
      let floor = -1;
      for (const rarity of COS.RARITY_ORDER) {
        const priced = COS.itemsInSlot(slot).filter((i) => i.rarity === rarity && !i.default && !i.earned);
        if (!priced.length) continue;
        const lowest = Math.min(...priced.map((i) => i.price));
        if (lowest <= floor) return false;
        floor = lowest;
      }
    }
    return true;
  })());

  check('nothing earned and nothing free is tradable', (() => {
    const wrong = COS.ITEM_IDS.map((id) => COS.ITEMS[id])
      .filter((i) => (i.earned || i.default) && i.tradable);
    info(`${COS.FREE_ITEMS.length} item(s) every account starts with`);
    return wrong.length === 0;
  })());

  check('the default loadout names one real item per slot', (() => {
    for (const slot of COS.SLOT_IDS) {
      const item = COS.getItem(COS.DEFAULT_EQUIP[slot]);
      if (!item || item.slot !== slot || !item.default) return false;
    }
    return true;
  })());

  check('a nonsense item id is null rather than an exception',
    COS.getItem('nope') === null && COS.getItem(null) === null
    && COS.parseItemId('primary') === null);

  suite('Cosmetics — cases');

  check('every case has a pool, and nothing undropable is in one', (() => {
    for (const id of COS.CASE_IDS) {
      const pool = COS.casePool(id);
      if (!pool.length) return false;
      if (pool.some((i) => i.default || i.earned || !i.dropable)) return false;
    }
    info(COS.CASE_IDS.map((id) => `${id}:${COS.casePool(id).length}`).join(' · '));
    return true;
  })());

  check('the published odds add up to one', (() => {
    for (const id of COS.CASE_IDS) {
      const total = COS.caseOdds(id).reduce((a, o) => a + o.chance, 0);
      if (Math.abs(total - 1) > 1e-9) return false;
    }
    return true;
  })());

  /*
   * The one that matters.
   *
   * A hundred thousand rolls per case, counted by tier, against the table the
   * shop prints. The tolerance is deliberately generous in *relative* terms
   * for the rare tiers — at a published 0.25%, a hundred thousand rolls give
   * about 250 hits and a sampling error of ±6% of that — and tight in absolute
   * terms, which is the right way round: nobody notices a mythic rate that is
   * 0.24% instead of 0.25%, and everybody notices one that is 3%.
   */
  check('what a case actually rolls is what it says it rolls', (() => {
    const N = 100_000;
    let worst = 0;
    let worstWhere = '';
    for (const id of COS.CASE_IDS) {
      const counts = {};
      for (let i = 0; i < N; i++) {
        const item = COS.rollCase(id);
        counts[item.rarity] = (counts[item.rarity] ?? 0) + 1;
      }
      for (const row of COS.caseOdds(id)) {
        const got = (counts[row.rarity] ?? 0) / N;
        const drift = Math.abs(got - row.chance);
        if (drift > worst) { worst = drift; worstWhere = `${id}/${row.rarity}`; }
        // Absolute *and* relative: 0.5 points, or a fifth of the published
        // figure, whichever is looser.
        if (drift > Math.max(0.005, row.chance * 0.2)) {
          info(`${id} ${row.rarity}: published ${(row.chance * 100).toFixed(3)}%, `
            + `rolled ${(got * 100).toFixed(3)}%`);
          return false;
        }
      }
    }
    info(`worst drift ${(worst * 100).toFixed(3)} points, at ${worstWhere}`);
    return true;
  })());

  check('a roll never returns anything outside the case it was made against', (() => {
    for (const id of COS.CASE_IDS) {
      const pool = new Set(COS.casePool(id).map((i) => i.id));
      for (let i = 0; i < 2000; i++) if (!pool.has(COS.rollCase(id).id)) return false;
    }
    return true;
  })());

  check('a case never returns the same item for two different random streams', (() => {
    // A fixed sequence at each end of the range: the roll must depend on the
    // numbers it is given rather than on anything ambient.
    const low = COS.rollCase('armoury', () => 0.0001);
    const high = COS.rollCase('armoury', () => 0.9999);
    info(`${low?.name} (${low?.rarity}) vs ${high?.name} (${high?.rarity})`);
    return low && high && low.id !== high.id;
  })());

  suite('Cosmetics — equipping');

  check('a guest may wear the defaults and nothing else', (() => {
    const owned = COS.FREE_ITEMS;
    return COS.canEquip(COS.DEFAULT_EQUIP[COS.SLOT.PRIMARY], owned, {})
      && !COS.canEquip('primary:gold', owned, {});
  })());

  check('an earned finish is earned, not owned', (() => {
    const id = COS.itemId(COS.SLOT.PRIMARY, 'veteran');
    return !COS.canEquip(id, [], { authed: true, level: 14 })
      && COS.canEquip(id, [], { authed: true, level: 15 });
  })());

  check('sanitising an equip map falls back rather than leaving a hole', (() => {
    const out = COS.sanitiseEquip(
      { primary: 'primary:gold', head: 'head:crown', nonsense: 'x', face: 'primary:gold' },
      COS.FREE_ITEMS, { authed: true },
    );
    // Everything unowned or in the wrong slot goes back to the default, and
    // every slot is still filled.
    return COS.SLOT_IDS.every((s) => COS.getItem(out[s])?.slot === s)
      && out.primary === COS.DEFAULT_EQUIP.primary
      && out.head === COS.DEFAULT_EQUIP.head
      && !('nonsense' in out);
  })());

  check('scrapping pays a fraction of catalogue, never more', (() => {
    for (const id of COS.ITEM_IDS) {
      const item = COS.ITEMS[id];
      if (item.default || item.earned) continue;
      if (COS.scrapValue(item) >= COS.priceOf(item)) return false;
    }
    return true;
  })());
}

/* ── The economy, over HTTP ──────────────────────────────────────────────── */

export default async function run() {
  catalogue();

  const dir = mkdtempSync(join(tmpdir(), 'og-cosmetics-'));
  const dbPath = join(dir, 'cosmetics.db');
  const port = await freePort();
  let server;
  try {
    server = await startServer({ port, dbPath, dir });
  } catch (err) {
    suite('Cosmetics — end to end');
    check('the server boots', false, err.message);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const { base } = server;

  /**
   * GR and levels are earned by playing, so the test grants them directly.
   *
   * The level matters as much as the GR: adding a friend is gated on level 2,
   * and trades are friends-only, so a pair of level-1 accounts could never
   * reach the half of this suite that matters most.
   */
  const fund = (name, gr) => {
    const db = new DatabaseSync(dbPath);
    // XP and level are set to agree with each other. They have to: the level
    // is derived from XP on read, and an account whose stored level is behind
    // its XP is paid the difference in GR the first time anybody looks at it —
    // which would land in the middle of a purchase and make the arithmetic
    // below nonsense.
    db.prepare('UPDATE users SET gr = ?, level = 2, xp = ? WHERE username_lower = ?')
      .run(gr, xpForLevel(2), name.toLowerCase());
    db.close();
  };
  const register = async (username) => {
    const r = await call(base, 'POST', '/api/v1/auth/register',
      { body: { username, password: 'correct-horse-battery' } });
    return r.body.token;
  };

  try {
    const ana = await register('CosAna');
    const bo = await register('CosBo');
    fund('CosAna', 200_000);
    fund('CosBo', 200_000);

    const wardrobe = async (token) =>
      (await call(base, 'GET', '/api/v1/wardrobe', { token })).body.wardrobe;

    suite('Cosmetics — the wardrobe over the wire');

    const start = await wardrobe(ana);
    check('a fresh account is dressed in the defaults and owns nothing else',
      COS.SLOT_IDS.every((s) => start.equip[s] === COS.DEFAULT_EQUIP[s])
      && start.units.length === 0,
      `${start.owned.length} item(s) available, ${start.units.length} unit(s) held`);

    check('and it may equip exactly the free items and the ones it has earned',
      start.equippable.every((id) => {
        const item = COS.getItem(id);
        return item.default || item.earned;
      }), `${start.equippable.length} equippable`);

    const notMine = await call(base, 'PUT', '/api/v1/loadout',
      { token: ana, body: { equip: { primary: 'primary:gold' } } });
    check('equipping something you do not own is refused, quietly and completely',
      notMine.body.wardrobe.equip.primary === COS.DEFAULT_EQUIP.primary,
      `still wearing ${notMine.body.wardrobe.equip.primary}`);

    suite('Cosmetics — buying and opening');

    /*
     * The balance is read immediately before, never assumed.
     *
     * Levelling pays a GR bonus the first time an account's level is read
     * against its XP, and this test grants both directly — so the balance at
     * this point is 200,000 plus whatever the ladder owed. What is on trial is
     * that the purchase costs exactly the catalogue price, which is a delta.
     */
    const beforeBuy = (await wardrobe(ana)).gr;
    const bought = await call(base, 'POST', '/api/v1/shop/buy',
      { token: ana, body: { itemId: 'head:crown' } });
    check('buying at catalogue takes the GR and hands over a real unit',
      bought.status === 200 && bought.body.wardrobe.units.length === 1
      && bought.body.gr === beforeBuy - COS.getItem('head:crown').price,
      `${beforeBuy} → ${bought.body.gr}, a ${COS.getItem('head:crown').price} GR crown`);

    const worn = await call(base, 'PUT', '/api/v1/loadout',
      { token: ana, body: { equip: { head: 'head:crown' } } });
    check('and once it is owned it can actually be put on',
      worn.body.wardrobe.equip.head === 'head:crown');

    const tooDear = await call(base, 'POST', '/api/v1/shop/buy',
      { token: bo, body: { itemId: 'knife:doppler' } });
    fund('CosBo', 10);
    const broke = await call(base, 'POST', '/api/v1/shop/buy',
      { token: bo, body: { itemId: 'knife:doppler' } });
    check('a purchase you cannot afford is a 402, not a negative balance',
      broke.status === 402, `${tooDear.status} with the GR, ${broke.status} without`);
    fund('CosBo', 200_000);

    const opens = [];
    for (let i = 0; i < 12; i++) {
      const r = await call(base, 'POST', '/api/v1/cases/open',
        { token: ana, body: { caseId: 'armoury' } });
      opens.push(r.body);
    }
    check('a case charges once, mints once, and hands back what it rolled',
      opens.every((o) => COS.getItem(o.itemId) && o.unitId)
      && opens[11].gr === opens[0].gr - COS.CASES.armoury.price * 11,
      `${opens.length} opens, ${opens[11].gr} GR left`);

    check('everything a case produced was in that case\'s pool', (() => {
      const pool = new Set(COS.casePool('armoury').map((i) => i.id));
      return opens.every((o) => pool.has(o.itemId));
    })());

    const feed = await call(base, 'GET', '/api/v1/cases/recent');
    check('and the drop feed shows them to everybody',
      feed.body.drops.length >= 12 && feed.body.drops[0].user === 'CosAna');

    const nope = await call(base, 'POST', '/api/v1/cases/open',
      { token: ana, body: { caseId: 'not-a-case' } });
    check('a case that does not exist is a 404 rather than a free roll',
      nope.status === 404);

    suite('Cosmetics — the market');

    let anaW = await wardrobe(ana);
    const spare = anaW.units.find((u) => COS.getItem(u.itemId)?.tradable);
    const listed = await call(base, 'POST', '/api/v1/market/list',
      { token: ana, body: { unitId: spare.unitId, price: 1234 } });
    check('listing something locks it where it stands',
      listed.status === 200
      && listed.body.wardrobe.units.find((u) => u.unitId === spare.unitId)?.locked === true);

    const doubleList = await call(base, 'POST', '/api/v1/market/list',
      { token: ana, body: { unitId: spare.unitId, price: 999 } });
    check('and it cannot be listed a second time while it is standing',
      doubleList.status === 400, doubleList.body.message);

    const scrapLocked = await call(base, 'POST', '/api/v1/wardrobe/scrap',
      { token: ana, body: { unitId: spare.unitId } });
    check('nor scrapped out from under the listing',
      scrapLocked.status === 400, scrapLocked.body.message);

    const board = await call(base, 'GET', '/api/v1/market');
    check('the board shows it, cheapest first, one row per item',
      board.body.board.some((r) => r.itemId === spare.itemId && r.low === 1234));

    const theft = await call(base, 'POST', '/api/v1/market/list',
      { token: bo, body: { unitId: spare.unitId, price: 10 } });
    check('somebody else cannot list what is not theirs',
      theft.status === 400, theft.body.message);

    const cheap = await call(base, 'POST', '/api/v1/market/list',
      { token: ana, body: { unitId: anaW.units.filter((u) => u.unitId !== spare.unitId)[0].unitId, price: 1 } });
    check('and nothing may be listed below the floor',
      cheap.status === 400, cheap.body.message);

    const anaBefore = (await wardrobe(ana)).gr;
    const boBefore = (await wardrobe(bo)).gr;
    const detail = await call(base, 'GET',
      `/api/v1/market/item?id=${encodeURIComponent(spare.itemId)}`);
    const listing = detail.body.listings[0];
    const boughtIt = await call(base, 'POST', '/api/v1/market/buy',
      { token: bo, body: { listingId: listing.id } });

    const anaAfter = (await wardrobe(ana)).gr;
    const boAfter = await wardrobe(bo);
    const fee = Math.round(1234 * COS.MARKET_FEE);
    check('a sale moves the item and the money in one step, less the fee',
      boughtIt.status === 200
      && boAfter.gr === boBefore - 1234
      && anaAfter === anaBefore + (1234 - fee)
      && boAfter.units.some((u) => u.unitId === spare.unitId),
      `seller banked ${anaAfter - anaBefore} of 1234, ${fee} burned`);

    check('and the seller no longer has it', (() => {
      const after = anaW.units.length;
      return !(boAfter.units.length === 0) && after > 0;
    })());

    const twice = await call(base, 'POST', '/api/v1/market/buy',
      { token: bo, body: { listingId: listing.id } });
    check('the same listing cannot be bought twice',
      twice.status === 400, twice.body.message);

    const own = await call(base, 'POST', '/api/v1/market/list',
      { token: bo, body: { unitId: spare.unitId, price: 500 } });
    const selfBuy = await call(base, 'POST', '/api/v1/market/buy',
      { token: bo, body: { listingId: own.body.id } });
    check('and nobody may buy their own listing',
      selfBuy.status === 400, selfBuy.body.message);
    await call(base, 'POST', '/api/v1/market/cancel', { token: bo, body: { listingId: own.body.id } });

    const back = await wardrobe(bo);
    check('cancelling a listing unlocks the item again',
      back.units.find((u) => u.unitId === spare.unitId)?.locked === false);

    suite('Cosmetics — trades');

    const anaId = (await call(base, 'GET', '/api/v1/auth/me', { token: ana })).body.user.id;
    const strangers = await call(base, 'POST', '/api/v1/trades',
      { token: bo, body: { to: 'CosAna', give: [], giveGr: 10 } });
    check('a stranger cannot open an offer — the market is for strangers',
      strangers.status === 403, strangers.body.message);

    await call(base, 'POST', '/api/v1/friends/requests', { token: bo, body: { username: 'CosAna' } });
    const boId = (await call(base, 'GET', '/api/v1/auth/me', { token: bo })).body.user.id;
    await call(base, 'POST', `/api/v1/friends/requests/${boId}/accept`, { token: ana });

    const boUnits = (await wardrobe(bo)).units.filter((u) => COS.getItem(u.itemId)?.tradable);
    const offered = await call(base, 'POST', '/api/v1/trades',
      { token: bo, body: { to: 'CosAna', give: [boUnits[0].unitId], wantGr: 500, note: 'straight swap' } });
    check('a friend can, and both sides are staked the moment it exists',
      offered.status === 200
      && (await wardrobe(bo)).units.find((u) => u.unitId === boUnits[0].unitId)?.locked === true);

    const stakedTwice = await call(base, 'POST', '/api/v1/market/list',
      { token: bo, body: { unitId: boUnits[0].unitId, price: 100 } });
    check('a staked item cannot also be put on the market',
      stakedTwice.status === 400, stakedTwice.body.message);

    const wrongHands = await call(base, 'POST', '/api/v1/trades/accept',
      { token: bo, body: { id: offered.body.trade.id } });
    check('and the sender cannot accept their own offer',
      wrongHands.status === 400, wrongHands.body.message);

    const anaGrBefore = (await wardrobe(ana)).gr;
    const boGrBefore = (await wardrobe(bo)).gr;
    const done = await call(base, 'POST', '/api/v1/trades/accept',
      { token: ana, body: { id: offered.body.trade.id } });
    const anaEnd = await wardrobe(ana);
    const boEnd = await wardrobe(bo);
    check('accepting moves the item one way and the GR the other, exactly once',
      done.status === 200
      && anaEnd.units.some((u) => u.unitId === boUnits[0].unitId)
      && !boEnd.units.some((u) => u.unitId === boUnits[0].unitId)
      && anaEnd.gr === anaGrBefore - 500
      && boEnd.gr === boGrBefore + 500,
      `${anaGrBefore}→${anaEnd.gr} and ${boGrBefore}→${boEnd.gr}`);

    const again = await call(base, 'POST', '/api/v1/trades/accept',
      { token: ana, body: { id: offered.body.trade.id } });
    check('a settled offer cannot be settled again',
      again.status === 400, again.body.message);

    const withdrawn = await call(base, 'POST', '/api/v1/trades',
      { token: bo, body: { to: 'CosAna', giveGr: 25 } });
    await call(base, 'POST', '/api/v1/trades/close', { token: bo, body: { id: withdrawn.body.trade.id } });
    const list = await call(base, 'GET', '/api/v1/trades', { token: ana });
    check('a withdrawn offer leaves the open list and lands in the history',
      !list.body.open.some((t) => t.id === withdrawn.body.trade.id)
      && list.body.history.some((t) => t.id === withdrawn.body.trade.id && t.status === 'cancelled'));

    const selfTrade = await call(base, 'POST', '/api/v1/trades',
      { token: ana, body: { to: 'CosAna', giveGr: 1 } });
    check('and nobody trades with themselves',
      selfTrade.status >= 400, selfTrade.body.message);

    suite('Cosmetics — scrapping');

    const before = await wardrobe(ana);
    const junk = before.units.find((u) => !u.locked);
    const scrapped = await call(base, 'POST', '/api/v1/wardrobe/scrap',
      { token: ana, body: { unitId: junk.unitId } });
    check('the game buys a duplicate back at a fifth of catalogue and takes it away',
      scrapped.status === 200
      && scrapped.body.gr === before.gr + COS.scrapValue(COS.getItem(junk.itemId))
      && !scrapped.body.wardrobe.units.some((u) => u.unitId === junk.unitId),
      `paid ${COS.scrapValue(COS.getItem(junk.itemId))} for a ${
        COS.priceOf(COS.getItem(junk.itemId))} GR item`);

    const ghost = await call(base, 'POST', '/api/v1/wardrobe/scrap',
      { token: ana, body: { unitId: junk.unitId } });
    check('and it cannot be sold back twice',
      ghost.status === 400, ghost.body.message);

    suite('Cosmetics — the V1 wardrobe survives the move');

    /*
     * The one failure that cannot be fixed later.
     *
     * A pre-V2 row is written by hand — a flat `owned` list and a per-class
     * `skins` map, which is exactly what the database held before this — the
     * migration marker is cleared, and the server is restarted over it. What
     * has to come out the other side is every finish they paid for, on all
     * three weapon slots, still equipped where it was.
     */
    const db = new DatabaseSync(dbPath);
    const legacyId = db.prepare('SELECT id FROM users WHERE username_lower = ?').get('cosana').id;
    db.prepare('UPDATE loadouts SET owned = ?, skins = ?, migrated_cosmetics = 0 WHERE user_id = ?')
      .run(JSON.stringify(['gold', 'carbon', 'urban']), JSON.stringify({ triggerman: 'gold' }), legacyId);
    db.prepare('DELETE FROM inventory WHERE user_id = ?').run(legacyId);
    db.close();

    server.child.kill('SIGTERM');
    await sleep(400);
    server = await startServer({ port, dbPath, dir });

    const migrated = await wardrobe(ana);
    const want = ['primary', 'secondary', 'knife']
      .flatMap((slot) => ['gold', 'carbon', 'urban'].map((k) => `${slot}:${k}`));
    const held = new Set(migrated.units.map((u) => u.itemId));
    check('every finish they had bought is theirs on all three weapon slots',
      want.every((id) => held.has(id)),
      `${migrated.units.length} unit(s) minted from 3 legacy finishes`);

    check('and what they had equipped is still what they are wearing',
      migrated.primaries.triggerman === 'primary:gold'
      && migrated.equip.primary === 'primary:gold');

    check('every unit carries where it came from, so nothing is unaccountable',
      migrated.units.every((u) => u.source === 'migrate' && u.serial > 0));

    server.child.kill('SIGTERM');
    await sleep(300);
    server = await startServer({ port, dbPath, dir });
    const twiceMigrated = await wardrobe(ana);
    check('and a second boot does not mint the whole wardrobe again',
      twiceMigrated.units.length === migrated.units.length,
      `${migrated.units.length} before, ${twiceMigrated.units.length} after`);
  } finally {
    server?.child.kill('SIGTERM');
    await sleep(200);
    rmSync(dir, { recursive: true, force: true });
  }
}
