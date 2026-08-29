/**
 * Open Grunker — the wardrobe screens.
 *
 * Four pages, one module: the loadout workbench, the cases, the market and
 * trades. They are together because they are one system — everything here
 * either shows you an item, gets you an item or moves an item — and because
 * they share the three things that are genuinely hard: drawing an item card
 * that reads correctly at every rarity, keeping the equipped state in step
 * with a server that is the only authority on it, and the live 3D preview.
 *
 * ── The preview ────────────────────────────────────────────────────────────
 *
 * The operator on the loadout screen is built by the *same* functions that
 * build the operator in the match — `buildWearable` for the worn slots,
 * `buildWeaponMesh` for the guns. That is not tidiness, it is the whole
 * contract of a shop: nothing here can show you something the game would not,
 * because there is no second implementation for it to disagree with.
 *
 * ── Where the truth lives ──────────────────────────────────────────────────
 *
 * Nowhere in this file. The server owns what you own, what you may equip and
 * what anything costs, and every action here sends a request and redraws from
 * the wardrobe that comes back. There is no optimistic update: an economy in
 * which the client guesses is an economy in which the client is wrong, in
 * public, about somebody's money.
 */
import * as THREE from 'three';
import * as COS from '/shared/cosmetics.js';
import { CLASSES, loadoutFor } from '/shared/weapons.js';
import { api } from './api.js';
import { sfx } from './audio.js';
import { buildWeaponMesh, tickCosmetics } from './gunskin.js';
import { buildWearable, outfitColors, gloveColors } from './wearables.js';
// Only for the two sentences this file assembles out of a name and a price.
// Everything it writes as plain text is translated where it lands — see i18n.js.
import { tf } from './i18n.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const hex = (c) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n ?? 0).toLocaleString('en-GB');

/**
 * How long ago, in as few characters as possible.
 *
 * The drop feed is a column of them, so an exact timestamp would be four times
 * the width for information nobody wants: what matters is whether a pull
 * happened a minute ago or last week.
 */
function ago(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - (ts | 0));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The gradient a card's swatch is painted with. */
const swatchCss = (item) => {
  const c = item?.swatch ?? [0x3b424c, 0x2a2e34, 0x8d959f];
  return `linear-gradient(135deg, ${hex(c[0])} 0%, ${hex(c[1])} 52%, ${hex(c[2] ?? c[0])} 100%)`;
};

const rarityColor = (id) => hex(COS.RARITY[id]?.color ?? 0x8fa0b4);

/**
 * One item card.
 *
 * Every grid in this module draws the same card, which is what makes the four
 * pages read as one shop: a Gold Rush knife looks identical whether you are
 * equipping it, buying it, selling it or staking it in a trade, and only the
 * line at the bottom changes.
 */
function itemCard(item, { footer = '', state = '', badge = '' } = {}) {
  const r = COS.RARITY[item.rarity] ?? COS.RARITY.common;
  const card = el('div', `skin-card ${state}`.trim(), `
    <div class="skin-swatch" style="background:${swatchCss(item)}">
      ${item.anim ? '<span class="anim-pip" title="Animated finish">✦ ANIMATED</span>' : ''}
      ${badge ? `<span class="card-badge">${badge}</span>` : ''}
      <span class="skin-zones">${(item.swatch ?? []).map((c) =>
    `<i style="background:${hex(c)}"></i>`).join('')}</span>
    </div>
    <h5>${escapeHtml(item.name)}</h5>
    <div class="skin-rarity" style="color:${rarityColor(item.rarity)}">
      ${r.name.toUpperCase()} · ${escapeHtml(COS.SLOT_META[item.slot]?.name ?? '')}
    </div>
    <p class="skin-blurb">${escapeHtml(item.blurb ?? '')}</p>
    <div class="price">${footer}</div>`);
  card.style.setProperty('--rarity', rarityColor(item.rarity));
  card.dataset.itemId = item.id;
  return card;
}

/* ── The live preview ────────────────────────────────────────────────────── */

/**
 * A tiny scene with one operator in it.
 *
 * Built once and rebuilt only when something equipped changes, because a
 * rebuild is thirty meshes and a re-equip is what happens every time somebody
 * clicks a card. It renders only while the loadout page is actually on screen:
 * an idle turntable behind a settings panel is a GPU running for nothing.
 */
class Preview {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.ok = true;
    } catch {
      // A machine with no WebGL context to spare still gets the whole shop —
      // it just gets it without the turntable.
      return;
    }
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 40);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Three lights and no shadows. A preview is lit to show colour and gloss,
    // which is what a finish is, and a shadow map here would cost more than
    // the rest of the screen put together.
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(2.4, 3.2, 2.6);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.1);
    rim.position.set(-2.6, 1.6, -2.2);
    this.scene.add(key, rim, new THREE.AmbientLight(0x6d7686, 1.5));

    this.spin = true;
    this.yaw = 0.6;
    this.mode = 'body';
    this._drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      this._drag = { x: e.clientX, yaw: this.yaw };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      this.yaw = this._drag.yaw + (e.clientX - this._drag.x) * 0.01;
      this.spin = false;
    });
    for (const ev of ['pointerup', 'pointercancel']) {
      canvas.addEventListener(ev, () => { this._drag = null; });
    }
  }

  /** Throws away the current body and builds the one `equip` describes. */
  rebuild(equip, classId) {
    if (!this.ok) return;
    this.root.clear();
    const worn = { ...COS.DEFAULT_EQUIP, ...(equip ?? {}) };
    const body = new THREE.Group();

    const mats = new Map();
    const mk = (color, opts = {}) => {
      const k = `${color}|${opts.shininess ?? 8}|${opts.emissive ?? -1}|${opts.opacity ?? 1}`;
      let m = mats.get(k);
      if (!m) {
        m = new THREE.MeshPhongMaterial({
          color, shininess: 8, specular: 0x14181d, ...opts,
          ...(opts.opacity != null && opts.opacity < 1 ? { transparent: true } : {}),
        });
        mats.set(k, m);
      }
      return m;
    };
    const box = (w, h, d, color, opts) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mk(color, opts));

    /*
     * A stand-in operator rather than `buildCharacter`.
     *
     * The match's builder needs a team colour, a class definition and a place
     * in a scene graph that poses it; the preview needs a mannequin. What the
     * two genuinely share — the hats, the masks, the packs, the gloves and the
     * guns — is shared, and the fifteen boxes that make up a torso are not
     * worth coupling this screen to the entity manager for.
     */
    const fit = outfitColors(worn[COS.SLOT.BODY], 0x4d9bff);
    const fabric = fit?.fabric ?? 0x3f4954;
    const vestC = fit?.vest ?? 0x23272d;
    const pantsC = fit?.pants ?? 0x363b40;
    const glow = fit?.glow ? { emissive: fit.glow } : {};

    const torso = box(0.6, 0.7, 0.34, fabric, glow); torso.position.y = 1.15;
    const vest = box(0.66, 0.42, 0.42, vestC, { shininess: 22, ...glow }); vest.position.y = 1.24;
    const collar = box(0.4, 0.11, 0.3, vestC); collar.position.y = 1.5;
    const head = box(0.38, 0.34, 0.36, 0xc9a27f); head.position.y = 1.68;
    const shoulderL = box(0.19, 0.19, 0.28, vestC); shoulderL.position.set(-0.38, 1.42, 0);
    const shoulderR = shoulderL.clone(); shoulderR.position.x = 0.38;
    const armL = box(0.16, 0.56, 0.18, fabric, glow); armL.position.set(-0.38, 1.14, 0);
    const armR = armL.clone(); armR.position.x = 0.38;

    const hands = gloveColors(worn[COS.SLOT.GLOVES]);
    const gloveOpts = {
      shininess: 8 + (hands?.gloss ?? 0) * 50,
      ...(hands?.glow ? { emissive: hands.glow } : {}),
    };
    const gloveL = box(0.15, 0.14, 0.17, hands?.color ?? 0x2b3038, gloveOpts);
    gloveL.position.set(-0.38, 0.87, 0);
    const gloveR = gloveL.clone(); gloveR.position.x = 0.38;
    const cuffL = box(0.16, 0.05, 0.18, hands?.cuff ?? 0x1e2228, gloveOpts);
    cuffL.position.set(-0.38, 0.95, 0);
    const cuffR = cuffL.clone(); cuffR.position.x = 0.38;

    const legL = box(0.21, 0.74, 0.23, pantsC); legL.position.set(-0.145, 0.42, 0);
    const legR = legL.clone(); legR.position.x = 0.145;
    const bootL = box(0.23, 0.16, 0.31, 0x141619); bootL.position.set(-0.145, 0.08, -0.03);
    const bootR = bootL.clone(); bootR.position.x = 0.145;

    body.add(torso, vest, collar, head, shoulderL, shoulderR, armL, armR,
      gloveL, gloveR, cuffL, cuffR, legL, legR, bootL, bootR);

    for (const slot of [COS.SLOT.HEAD, COS.SLOT.FACE, COS.SLOT.BACK]) {
      body.add(buildWearable(worn[slot], mk).group);
    }

    // The three guns, held out where the eye lands rather than in the hand:
    // this screen exists to be looked at, and a rifle at the hip is a rifle
    // seen end-on.
    const weapons = loadoutFor(classId) ?? [];
    const slots = [COS.SLOT.PRIMARY, COS.SLOT.SECONDARY, COS.SLOT.KNIFE];
    this.guns = [];
    weapons.forEach((def, i) => {
      const finish = COS.getItem(worn[slots[i]])?.finish ?? null;
      const g = buildWeaponMesh(def, finish, { fine: true, clone: false, collapse: 'static' });
      g.scale.setScalar(1.15);
      g.position.set(0.44, 1.2 - i * 0.42, 0.1);
      g.rotation.y = -0.35;
      body.add(g);
      this.guns.push(g);
    });

    const charm = buildWearable(worn[COS.SLOT.CHARM], mk);
    charm.group.scale.setScalar(2.2);
    charm.group.position.set(0.02, -0.1, 0.16);
    if (this.guns[0]) this.guns[0].add(charm.group);

    this.root.add(body);
    this.body = body;
  }

  /** Frames either the whole operator or just the weapons. */
  look(mode) {
    this.mode = mode;
    if (!this.ok) return;
    if (mode === 'gun') {
      this.camera.position.set(1.5, 1.35, 1.5);
      this.camera.lookAt(0.3, 1.05, 0);
    } else {
      this.camera.position.set(0, 1.35, 3.5);
      this.camera.lookAt(0, 1.05, 0);
    }
  }

  render(dt) {
    if (!this.ok) return;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.look(this.mode);
    }
    if (this.spin) this.yaw += dt * 0.45;
    this.root.rotation.y = this.yaw;
    // The preview drives the same animation clock the match does, so an
    // animated finish is animated here — which is most of what somebody is
    // paying for and all of what they would want to see before paying.
    tickCosmetics(performance.now() / 1000);
    this.renderer.render(this.scene, this.camera);
  }
}

/* ── The wardrobe screens ────────────────────────────────────────────────── */

export class Wardrobe {
  /**
   * @param {object} menu the Menu, for its notifications, its sign-in prompt
   *                      and the class it currently has selected
   */
  constructor(menu) {
    this.menu = menu;
    this.slot = COS.SLOT.PRIMARY;
    this.marketView = 'browse';
    this.filters = { q: '', rarity: '', ownedOnly: false };
    this.preview = null;
    this.pendingUnit = null;
    this.tradeDraft = { give: new Set(), want: new Set() };
    this._lastFrame = performance.now();
  }

  /** The account's wardrobe, or an empty one for a guest. */
  get w() {
    return api.wardrobe ?? {
      classId: this.menu?.selectedClass, equip: { ...COS.DEFAULT_EQUIP }, primaries: {},
      owned: COS.FREE_ITEMS, equippable: COS.FREE_ITEMS, units: [], gr: 0,
    };
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  bind() {
    this._bindLoadout();
    this._bindCases();
    this._bindMarket();
    this._bindTrades();
  }

  /** Called by the menu when a page is opened. */
  onTab(name) {
    if (name === 'classes') this.buildLoadout();
    if (name === 'cases') this.buildCases();
    if (name === 'market') this.buildMarket();
    if (name === 'trades') this.buildTrades();
    this.running = name === 'classes';
  }

  /** Every page's balance readout, kept in one place so none of them lags. */
  paintBalance() {
    const gr = fmt(api.account?.gr ?? 0);
    for (const id of ['grBalance', 'grBalanceCases', 'grBalanceMarket']) {
      const n = $(id);
      if (n) n.textContent = gr;
    }
  }

  /* ── The loadout workbench ─────────────────────────────────────────────── */

  _bindLoadout() {
    const canvas = $('loCanvas');
    if (canvas) {
      this.preview = new Preview(canvas);
      if (!this.preview.ok) {
        $('loViewEmpty')?.classList.remove('hidden');
      } else {
        $('loViewEmpty')?.classList.add('hidden');
        this.preview.look('body');
        const frame = (t) => {
          const dt = Math.min(0.1, (t - this._lastFrame) / 1000);
          this._lastFrame = t;
          if (this.running && $('loView')?.offsetParent) this.preview.render(dt);
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }
    }
    $('loSpin')?.addEventListener('click', () => {
      this.preview.spin = !this.preview.spin;
      sfx.ui();
    });
    $('loZoomGun')?.addEventListener('click', () => {
      this.preview.look(this.preview.mode === 'gun' ? 'body' : 'gun');
      sfx.ui();
    });

    // The slot rail, and the rarity filter, are both generated from the
    // catalogue rather than typed into the markup: adding a slot or a tier is
    // a change to shared/cosmetics.js and nothing else.
    const rail = $('loSlots');
    if (rail) {
      for (const slot of COS.SLOT_IDS) {
        const meta = COS.SLOT_META[slot];
        const b = el('button', `lo-slot${slot === this.slot ? ' active' : ''}`,
          `<i>${meta.icon}</i><span>${escapeHtml(meta.name)}</span>`);
        b.dataset.slot = slot;
        b.addEventListener('click', () => {
          this.slot = slot;
          sfx.ui();
          this.buildLoadout();
        });
        rail.appendChild(b);
      }
    }
    const rarity = $('loRarity');
    if (rarity) {
      for (const id of COS.RARITY_ORDER) {
        rarity.appendChild(el('option', null, COS.RARITY[id].name)).value = id;
      }
      rarity.addEventListener('change', () => {
        this.filters.rarity = rarity.value;
        this.buildLoadout();
      });
    }
    $('loSearch')?.addEventListener('input', (e) => {
      this.filters.q = e.target.value.trim().toLowerCase();
      this.buildLoadout();
    });
    $('loOwnedOnly')?.addEventListener('change', (e) => {
      this.filters.ownedOnly = e.target.checked;
      this.buildLoadout();
    });
  }

  /** The whole loadout page: preview, equipped strip, slot grid. */
  buildLoadout() {
    const w = this.w;
    const classId = this.menu?.selectedClass ?? w.classId;
    const equip = this._equipFor(classId);
    this.paintBalance();

    const stage = $('loStageName');
    if (stage) stage.textContent = (CLASSES[classId]?.name ?? 'Operator').toUpperCase();
    this.preview?.rebuild(equip, classId);

    // The strip under the preview: nine slots, what is in each, click to jump.
    const strip = $('loEquipped');
    if (strip) {
      strip.innerHTML = '';
      for (const slot of COS.SLOT_IDS) {
        const item = COS.getItem(equip[slot]);
        const chip = el('button', `lo-chip${slot === this.slot ? ' active' : ''}`, `
          <i class="lo-chip-sw" style="background:${swatchCss(item)}"></i>
          <span class="lo-chip-slot">${escapeHtml(COS.SLOT_META[slot].name)}</span>
          <span class="lo-chip-item" style="color:${rarityColor(item?.rarity)}">${
  escapeHtml(item?.name ?? '—')}</span>`);
        chip.addEventListener('click', () => { this.slot = slot; sfx.ui(); this.buildLoadout(); });
        strip.appendChild(chip);
      }
    }
    for (const b of document.querySelectorAll('.lo-slot')) {
      b.classList.toggle('active', b.dataset.slot === this.slot);
    }

    const note = $('loSlotNote');
    if (note) {
      const meta = COS.SLOT_META[this.slot];
      note.textContent = meta.perClass
        ? `${meta.blurb} Remembered per class — this is ${CLASSES[classId]?.name ?? 'your class'}.`
        : meta.blurb;
    }
    this._paintSlotGrid(equip, classId);
  }

  /** What this account has on, with the per-class primary folded in. */
  _equipFor(classId) {
    const w = this.w;
    const primary = w.primaries?.[classId];
    return { ...COS.DEFAULT_EQUIP, ...(w.equip ?? {}), ...(primary ? { [COS.SLOT.PRIMARY]: primary } : {}) };
  }

  _paintSlotGrid(equip, classId) {
    const grid = $('loGrid');
    if (!grid) return;
    const w = this.w;
    const owned = new Set(w.owned ?? []);
    const equippable = new Set(w.equippable ?? []);
    grid.innerHTML = '';

    let shown = 0;
    for (const item of COS.itemsInSlot(this.slot)) {
      if (this.filters.rarity && item.rarity !== this.filters.rarity) continue;
      if (this.filters.q && !item.name.toLowerCase().includes(this.filters.q)) continue;
      const has = owned.has(item.id) || equippable.has(item.id);
      if (this.filters.ownedOnly && !has) continue;
      shown++;

      const on = equip[this.slot] === item.id;
      const footer = on ? 'EQUIPPED'
        : has ? 'EQUIP'
          : item.earned ? escapeHtml(item.hint ?? 'EARN IT')
            : `${fmt(item.price)} GR`;
      const card = itemCard(item, {
        footer,
        state: `${on ? 'equipped' : ''} ${has ? '' : 'locked'}`.trim(),
      });
      card.addEventListener('click', () => this._onSlotCard(item, has, on, classId));
      grid.appendChild(card);
    }
    if (!shown) grid.appendChild(el('p', 'pn-none', 'Nothing in this slot matches that.'));
  }

  async _onSlotCard(item, has, on, classId) {
    if (!api.isAuthed) { this.menu.toastAuth('Sign in to equip and buy cosmetics.'); return; }
    if (on) return;
    try {
      if (!has) {
        if (item.earned) { sfx.ui('error'); this.menu.notify(item.hint ?? 'Not unlocked yet.', 'error'); return; }
        // Buying outright is deliberately the dear way to get something. The
        // card says the price, and clicking it is the confirmation — there is
        // no second dialogue, because there is no way to do it by accident:
        // a locked card is the only card that charges anything.
        if (!await this.menu.confirm({
          title: 'BUY IT OUTRIGHT?',
          body: tf('{item} costs {price} GR.', { item: item.name, price: fmt(item.price) }),
          ok: 'BUY IT',
        })) return;
        await api.buyItem(item.id);
        sfx.ui('ok');
      }
      await this._equip(item, classId);
    } catch (err) {
      sfx.ui('error');
      this.menu.notify(err.message ?? 'That did not work.', 'error');
    }
  }

  /** Puts one item on, and tells the running match about it. */
  async _equip(item, classId) {
    const payload = { classId, equip: { [item.slot]: item.id } };
    if (item.slot === COS.SLOT.PRIMARY) payload.primaries = { [classId]: item.id };
    await api.saveLoadout(payload);
    sfx.ui('ok');
    this.buildLoadout();
    // A player who changes their knife between rounds sees it on the next
    // draw rather than on the next reconnect.
    this.menu.onCosmeticsChange?.();
  }

  /* ── Cases ─────────────────────────────────────────────────────────────── */

  _bindCases() {
    $('caseClose')?.addEventListener('click', () => this._closeCase());
    $('caseSkip')?.addEventListener('click', () => this._settleCase(true));
    $('caseAgain')?.addEventListener('click', () => {
      const id = this._lastCase;
      this._closeCase();
      if (id) this.openCase(id);
    });
  }

  buildCases() {
    this.paintBalance();
    const grid = $('caseGrid');
    if (!grid) return;
    const gr = api.account?.gr ?? 0;
    grid.innerHTML = '';

    for (const id of COS.CASE_IDS) {
      const box = COS.CASES[id];
      const odds = COS.caseOdds(id);
      const pool = COS.casePool(id);
      const animated = pool.filter((i) => i.anim).length;
      const short = gr < box.price;

      /*
       * The button says one of three things, and each is the true one.
       *
       * A signed-out player gets a way in rather than a dead control; somebody
       * short of the price is told how short, which is the only useful thing
       * that sentence could say; everybody else gets the price they are about
       * to pay. Nobody has to click a case to find out they cannot open it.
       */
      const label = !api.isAuthed ? 'SIGN IN TO OPEN'
        : short ? `${fmt(box.price - gr)} GR SHORT`
          : `OPEN — ${fmt(box.price)} GR`;

      const card = el('article', 'case-card', `
        <header class="case-lid" style="--case-accent:${hex(box.accent)}">
          <div class="case-ident">
            <h4>${escapeHtml(box.name)}</h4>
            <p>${pool.length} items${animated ? ` · ${animated} animated` : ''}</p>
          </div>
          <span class="case-price">${fmt(box.price)}<i>GR</i></span>
        </header>
        <p class="case-blurb">${escapeHtml(box.blurb)}</p>
        <div class="case-odds">
          <div class="odds-bar">${odds.map((o) =>
    `<i style="flex:${o.chance.toFixed(5)};background:${rarityColor(o.rarity)}"></i>`).join('')}</div>
          <ul class="odds">${odds.map((o) => `
            <li>
              <i style="background:${rarityColor(o.rarity)}"></i>
              <span>${COS.RARITY[o.rarity].name}</span>
              <b>${(o.chance * 100).toFixed(o.chance < 0.01 ? 3 : 2)}%</b>
            </li>`).join('')}</ul>
        </div>
        <button class="btn-primary case-open" type="button"${
  api.isAuthed && short ? ' disabled' : ''}>${label}</button>`);
      card.querySelector('.case-open').addEventListener('click', () => this.openCase(id));
      grid.appendChild(card);
    }
    this._loadDropFeed();
  }

  async _loadDropFeed() {
    const feed = $('dropFeed');
    if (!feed) return;
    try {
      const { drops } = await api.recentDrops(24);
      feed.innerHTML = '';
      if (!drops.length) { feed.appendChild(el('p', 'pn-none', 'Nobody has opened anything yet.')); return; }
      for (const d of drops) {
        const item = COS.getItem(d.itemId);
        if (!item) continue;
        // The rarity colour goes on the row, not on the swatch inside it: the
        // row's left edge is what makes a wall of pulls readable at a glance,
        // and a legendary is worth a little more than a hairline.
        const hot = COS.RARITY[item.rarity].tier >= 4;
        const row = el('div', `drop${hot ? ' hot' : ''}`, `
          <i class="drop-sw" style="background:${swatchCss(item)}"></i>
          <span class="drop-who">${escapeHtml(d.user ?? 'Somebody')}</span>
          <span class="drop-what">${escapeHtml(item.name)}</span>
          <span class="drop-case">${escapeHtml(COS.CASES[d.caseId]?.name ?? d.caseId)}</span>
          <time class="drop-when">${ago(d.at)}</time>`);
        row.style.setProperty('--rarity', rarityColor(item.rarity));
        feed.appendChild(row);
      }
    } catch { /* the feed is decoration; a failure here is not worth a toast */ }
  }

  /**
   * Opens a case, and plays the reel.
   *
   * The order matters and is not negotiable: the server rolls *first*, and the
   * animation is then built around the answer it gave. The alternative — spin
   * a wheel and ask the server what it landed on — is how a client ends up
   * showing somebody a knife it then takes away, and it also makes the reel
   * something worth tampering with. Here the reel is scenery.
   */
  async openCase(caseId) {
    if (!api.isAuthed) { this.menu.toastAuth('Sign in to open cases.'); return; }
    const box = COS.CASES[caseId];
    if (!box) return;
    if ((api.account?.gr ?? 0) < box.price) {
      sfx.ui('error');
      this.menu.notify(`That case costs ${fmt(box.price)} GR.`, 'error');
      return;
    }
    let result;
    try {
      result = await api.openCase(caseId);
    } catch (err) {
      sfx.ui('error');
      this.menu.notify(err.message ?? 'The case would not open.', 'error');
      return;
    }
    this._lastCase = caseId;
    this._won = COS.getItem(result.itemId);
    this.paintBalance();
    this._playReel(caseId, this._won);
  }

  _playReel(caseId, won) {
    const modal = $('caseModal');
    const reel = $('caseReel');
    if (!modal || !reel || !won) return;
    $('caseTitle').textContent = COS.CASES[caseId]?.name?.toUpperCase() ?? 'CASE';
    $('caseResult').classList.add('hidden');
    // Only one of these is useful while the strip is moving. Opening a second
    // case on top of a running animation would throw the first result away
    // before it had been read.
    this._caseButtons({ skip: true, again: false, caseId });
    modal.classList.remove('hidden');

    /*
     * The strip: fifty-odd cards drawn at random from the case's own pool,
     * with the real one dropped in at a fixed index near the end.
     *
     * Filling it from the pool rather than from the whole catalogue matters:
     * a reel that flickers past items the case cannot produce is a reel that
     * lies about what you were ever in with a chance of.
     */
    const pool = COS.casePool(caseId);
    const LAND = 46;
    const cards = [];
    for (let i = 0; i < LAND + 8; i++) {
      cards.push(i === LAND ? won : pool[Math.floor(Math.random() * pool.length)]);
    }
    reel.innerHTML = '';
    for (const item of cards) {
      const c = el('div', 'reel-card', `
        <i style="background:${swatchCss(item)}"></i>
        <span style="color:${rarityColor(item.rarity)}">${escapeHtml(item.name)}</span>`);
      c.style.setProperty('--rarity', rarityColor(item.rarity));
      reel.appendChild(c);
    }

    // The landing point is jittered inside the winning card rather than dead
    // centre, so the reel stops looking mechanical after the third one.
    const CARD = 132;
    const jitter = (Math.random() - 0.5) * (CARD * 0.5);
    const travel = LAND * CARD + CARD / 2 + jitter - (reel.parentElement.clientWidth / 2);
    reel.style.transition = 'none';
    reel.style.transform = 'translateX(0px)';
    // One frame at rest, or the browser folds the two transforms into one and
    // there is no animation at all.
    requestAnimationFrame(() => {
      reel.style.transition = 'transform 6.4s cubic-bezier(0.06, 0.72, 0.09, 1)';
      reel.style.transform = `translateX(${-travel}px)`;
    });
    sfx.ui('ok');
    this._reelTimer = setTimeout(() => this._settleCase(false), 6500);
  }

  /** Shows what was won and stops the reel, whether it finished or was skipped. */
  _settleCase(skipped) {
    clearTimeout(this._reelTimer);
    const won = this._won;
    if (!won) return;
    const out = $('caseResult');
    if (skipped) {
      const reel = $('caseReel');
      if (reel) reel.style.transition = 'transform 0.25s ease-out';
    }
    out.classList.remove('hidden');
    out.innerHTML = `
      <div class="case-won" style="--rarity:${rarityColor(won.rarity)}">
        <i style="background:${swatchCss(won)}"></i>
        <div class="case-won-body">
          <h4>${escapeHtml(won.name)}</h4>
          <p class="case-won-tier" style="color:${rarityColor(won.rarity)}">
            ${COS.RARITY[won.rarity].name.toUpperCase()}${won.anim ? ' · ANIMATED' : ''}
            · ${escapeHtml(COS.SLOT_META[won.slot].name).toUpperCase()}
          </p>
          <p class="case-won-blurb">${escapeHtml(won.blurb)}</p>
          <p class="case-won-worth">Worth about ${fmt(COS.priceOf(won))} GR at catalogue.</p>
        </div>
      </div>`;
    sfx.ui(COS.RARITY[won.rarity].tier >= 3 ? 'ok' : 'hover');
    this._caseButtons({ skip: false, again: true, caseId: this._lastCase });
    this._loadDropFeed();
  }

  /**
   * Arms the reel's two buttons for the moment the modal is in.
   *
   * `again` also carries the price, so somebody who has just spent their last
   * GR is told so on the button rather than by a toast after clicking it.
   */
  _caseButtons({ skip, again, caseId }) {
    const box = COS.CASES[caseId];
    const skipBtn = $('caseSkip');
    const againBtn = $('caseAgain');
    if (skipBtn) skipBtn.disabled = !skip;
    if (!againBtn) return;
    const gr = api.account?.gr ?? 0;
    const short = !box || gr < box.price;
    againBtn.disabled = !again || short;
    againBtn.textContent = !box ? 'OPEN ANOTHER'
      : short ? `${fmt(Math.max(0, box.price - gr))} GR SHORT`
        : `OPEN ANOTHER — ${fmt(box.price)} GR`;
  }

  _closeCase() {
    clearTimeout(this._reelTimer);
    $('caseModal')?.classList.add('hidden');
    this._won = null;
    // The wallet is lighter and the wardrobe is fuller than they were when
    // this modal opened, so both pages behind it are re-priced rather than
    // left showing what could be afforded a minute ago.
    this.buildCases();
    this.buildLoadout();
  }

  /* ── The market ────────────────────────────────────────────────────────── */

  _bindMarket() {
    for (const b of document.querySelectorAll('#marketNav .sub')) {
      b.addEventListener('click', () => {
        this.marketView = b.dataset.market;
        for (const o of document.querySelectorAll('#marketNav .sub')) o.classList.toggle('active', o === b);
        for (const v of document.querySelectorAll('.market-view')) {
          v.classList.toggle('hidden', v.dataset.marketView !== this.marketView);
        }
        sfx.ui();
        this.buildMarket();
      });
    }
    const slot = $('mkSlot');
    if (slot) {
      for (const id of COS.SLOT_IDS) {
        slot.appendChild(el('option', null, COS.SLOT_META[id].name)).value = id;
      }
    }
    const rarity = $('mkRarity');
    if (rarity) {
      for (const id of COS.RARITY_ORDER) {
        rarity.appendChild(el('option', null, COS.RARITY[id].name)).value = id;
      }
    }
    for (const id of ['mkSearch', 'mkSlot', 'mkRarity', 'mkSort']) {
      $(id)?.addEventListener(id === 'mkSearch' ? 'input' : 'change', () => this._debouncedBoard());
    }
    $('itemClose')?.addEventListener('click', () => $('itemModal').classList.add('hidden'));
    $('sellClose')?.addEventListener('click', () => $('sellModal').classList.add('hidden'));
    $('sellCancel')?.addEventListener('click', () => $('sellModal').classList.add('hidden'));
    $('sellConfirm')?.addEventListener('click', () => this._confirmSell());
  }

  _debouncedBoard() {
    clearTimeout(this._boardTimer);
    this._boardTimer = setTimeout(() => this.buildMarket(), 220);
  }

  buildMarket() {
    this.paintBalance();
    if (this.marketView === 'browse') this._buildBoard();
    if (this.marketView === 'sell') this._buildSellGrid();
    if (this.marketView === 'mine') this._buildMyListings();
  }

  async _buildBoard() {
    const grid = $('mkBoard');
    if (!grid) return;
    grid.innerHTML = '<p class="pn-none">Looking…</p>';
    try {
      const { board, fee } = await api.marketBoard({
        q: $('mkSearch')?.value ?? '',
        slot: $('mkSlot')?.value ?? '',
        rarity: $('mkRarity')?.value ?? '',
        sort: $('mkSort')?.value ?? 'price',
      });
      $('mkNote').textContent = board.length
        ? `${board.length} item${board.length === 1 ? '' : 's'} on sale. `
          + `The market takes ${Math.round((fee ?? 0) * 100)}% of every sale.`
        : 'Nothing is listed that matches that.';
      grid.innerHTML = '';
      for (const row of board) {
        const item = COS.getItem(row.itemId);
        if (!item) continue;
        const card = itemCard(item, {
          footer: `FROM ${fmt(row.low)} GR`,
          badge: row.count > 1 ? `×${row.count}` : '',
        });
        card.addEventListener('click', () => this._openItem(item));
        grid.appendChild(card);
      }
      if (!board.length) grid.appendChild(el('p', 'pn-none', 'Nothing listed matches that.'));
    } catch (err) {
      grid.innerHTML = `<p class="pn-none">${escapeHtml(err.message ?? 'The market is not answering.')}</p>`;
    }
  }

  /** One item's standing listings, and what it has actually been selling for. */
  async _openItem(item) {
    const modal = $('itemModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    $('itemHead').innerHTML = `
      <i class="item-sw" style="background:${swatchCss(item)}"></i>
      <div>
        <h3>${escapeHtml(item.name)}</h3>
        <p style="color:${rarityColor(item.rarity)}">
          ${COS.RARITY[item.rarity].name.toUpperCase()} · ${escapeHtml(COS.SLOT_META[item.slot].name)}
          ${item.anim ? ' · ANIMATED' : ''}
        </p>
        <p class="skin-blurb">${escapeHtml(item.blurb)}</p>
        <p class="panel-note">Catalogue price ${fmt(COS.priceOf(item))} GR.</p>
      </div>`;
    const list = $('itemListings');
    list.innerHTML = '<p class="pn-none">Looking…</p>';
    try {
      const { listings, history } = await api.marketItem(item.id);
      list.innerHTML = '';
      if (!listings.length) list.appendChild(el('p', 'pn-none', 'Nothing standing for this one.'));
      for (const l of listings) {
        const row = el('div', 'listing', `
          <span class="listing-price">${fmt(l.price)} GR</span>
          <span class="listing-seller">${escapeHtml(l.seller ?? '—')}</span>
          ${l.serial ? `<span class="listing-serial">#${l.serial}</span>` : ''}
          <button class="btn-primary sm" type="button">BUY</button>`);
        row.querySelector('button').addEventListener('click', async () => {
          if (!api.isAuthed) { this.menu.toastAuth('Sign in to buy on the market.'); return; }
          if (!await this.menu.confirm({
            title: 'BUY FROM THE MARKET?',
            body: tf('{item} costs {price} GR.', { item: item.name, price: fmt(l.price) }),
            ok: 'BUY IT',
          })) return;
          try {
            await api.marketBuy(l.id);
            sfx.ui('ok');
            this.menu.notify(`Bought ${item.name}.`, 'ok');
            this.paintBalance();
            this._openItem(item);
            this._buildBoard();
          } catch (err) {
            sfx.ui('error');
            this.menu.notify(err.message ?? 'Somebody was quicker.', 'error');
          }
        });
        list.appendChild(row);
      }
      this._paintSpark(history);
    } catch (err) {
      list.innerHTML = `<p class="pn-none">${escapeHtml(err.message ?? 'No listings.')}</p>`;
    }
  }

  /**
   * The price history, as a sparkline.
   *
   * Deliberately unlabelled and unaxised: this is a shape, not a chart. What
   * somebody wants to know before they pay is whether the asking price is near
   * what the last few actually went for, and a line and an average say that in
   * a quarter of the space a real chart would.
   */
  _paintSpark(history) {
    const canvas = $('itemSpark');
    const note = $('itemAvg');
    if (!canvas) return;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    const sales = (history?.sales ?? []).slice().reverse();
    if (note) {
      note.textContent = sales.length
        ? `${sales.length} recent sale${sales.length === 1 ? '' : 's'}, averaging ${fmt(history.average)} GR.`
        : 'No sales yet — nothing to go on but the asking prices.';
    }
    if (sales.length < 2) return;
    const prices = sales.map((s) => s.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const span = Math.max(1, hi - lo);
    g.strokeStyle = '#4d9bff';
    g.lineWidth = 2;
    g.beginPath();
    prices.forEach((p, i) => {
      const x = (i / (prices.length - 1)) * (canvas.width - 8) + 4;
      const y = canvas.height - 6 - ((p - lo) / span) * (canvas.height - 14);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke();
  }

  /** Everything the account holds that could be sold, one card per unit. */
  _buildSellGrid() {
    const grid = $('mkSellGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const units = this.w.units ?? [];
    if (!units.length) {
      grid.appendChild(el('p', 'pn-none', 'You have nothing to sell yet. Open a case.'));
      return;
    }
    for (const unit of units) {
      const item = COS.getItem(unit.itemId);
      if (!item) continue;
      const card = itemCard(item, {
        footer: unit.locked ? 'LOCKED — LISTED OR STAKED' : 'SELL',
        state: unit.locked ? 'locked' : '',
        badge: unit.serial ? `#${unit.serial}` : '',
      });
      if (!unit.locked) card.addEventListener('click', () => this._openSell(unit, item));
      grid.appendChild(card);
    }
  }

  _openSell(unit, item) {
    this.pendingUnit = unit;
    $('sellItem').innerHTML = `
      <i class="item-sw" style="background:${swatchCss(item)}"></i>
      <div><h4>${escapeHtml(item.name)}</h4>
      <p style="color:${rarityColor(item.rarity)}">${COS.RARITY[item.rarity].name.toUpperCase()}</p></div>`;
    const suggested = COS.priceOf(item);
    $('sellPrice').value = suggested;
    this._paintSellNote(suggested, item);
    $('sellPrice').oninput = (e) => this._paintSellNote(Number(e.target.value) || 0, item);
    $('sellModal').classList.remove('hidden');
  }

  _paintSellNote(price, item) {
    const fee = Math.round(price * COS.MARKET_FEE);
    $('sellNote').textContent =
      `You would bank ${fmt(Math.max(0, price - fee))} GR after the ${
        Math.round(COS.MARKET_FEE * 100)}% market fee. `
      + `Catalogue is ${fmt(COS.priceOf(item))} GR; the game itself would only pay ${
        fmt(COS.scrapValue(item))} GR for it.`;
  }

  async _confirmSell() {
    const unit = this.pendingUnit;
    if (!unit) return;
    try {
      await api.marketList(unit.unitId, Number($('sellPrice').value) || 0);
      sfx.ui('ok');
      $('sellModal').classList.add('hidden');
      this.menu.notify('Listed.', 'ok');
      this.marketView = 'mine';
      for (const o of document.querySelectorAll('#marketNav .sub')) {
        o.classList.toggle('active', o.dataset.market === 'mine');
      }
      for (const v of document.querySelectorAll('.market-view')) {
        v.classList.toggle('hidden', v.dataset.marketView !== 'mine');
      }
      this.buildMarket();
    } catch (err) {
      sfx.ui('error');
      this.menu.notify(err.message ?? 'That listing was refused.', 'error');
    }
  }

  async _buildMyListings() {
    const box = $('mkMine');
    if (!box) return;
    box.innerHTML = '<p class="pn-none">Looking…</p>';
    try {
      const { listings } = await api.marketMine();
      box.innerHTML = '';
      if (!listings.length) { box.appendChild(el('p', 'pn-none', 'You have nothing listed.')); return; }
      for (const l of listings) {
        const item = COS.getItem(l.itemId);
        const row = el('div', 'listing', `
          <i class="listing-sw" style="background:${swatchCss(item)}"></i>
          <span class="listing-name" style="color:${rarityColor(item?.rarity)}">${
  escapeHtml(item?.name ?? l.itemId)}</span>
          <span class="listing-price">${fmt(l.price)} GR</span>
          <button class="btn-ghost sm" type="button">TAKE DOWN</button>`);
        row.querySelector('button').addEventListener('click', async () => {
          try {
            await api.marketCancel(l.id);
            sfx.ui('ok');
            this._buildMyListings();
          } catch (err) {
            sfx.ui('error');
            this.menu.notify(err.message ?? 'It would not come down.', 'error');
          }
        });
        box.appendChild(row);
      }
    } catch (err) {
      box.innerHTML = `<p class="pn-none">${escapeHtml(err.message ?? 'No listings.')}</p>`;
    }
  }

  /* ── Trades ────────────────────────────────────────────────────────────── */

  _bindTrades() {
    $('tradeNew')?.addEventListener('click', () => this._openTradeBuilder());
    $('tradeClose')?.addEventListener('click', () => $('tradeModal').classList.add('hidden'));
    $('tradeCancel')?.addEventListener('click', () => $('tradeModal').classList.add('hidden'));
    $('tradeSend')?.addEventListener('click', () => this._sendOffer());
  }

  async buildTrades() {
    const open = $('tradeOpen');
    const past = $('tradeHistory');
    if (!open || !past) return;
    if (!api.isAuthed) {
      open.innerHTML = '<p class="pn-none">Sign in to trade.</p>';
      past.innerHTML = '';
      return;
    }
    open.innerHTML = '<p class="pn-none">Looking…</p>';
    try {
      const r = await api.trades();
      this._paintTrades(open, r.open, true);
      this._paintTrades(past, r.history, false);
      const badge = $('tradeTabBadge');
      const waiting = r.open.filter((t) => t.incoming).length;
      if (badge) {
        badge.textContent = waiting;
        badge.classList.toggle('hidden', !waiting);
      }
    } catch (err) {
      open.innerHTML = `<p class="pn-none">${escapeHtml(err.message ?? 'No offers.')}</p>`;
    }
  }

  _paintTrades(box, list, live) {
    box.innerHTML = '';
    if (!list.length) {
      box.appendChild(el('p', 'pn-none', live ? 'No offers open.' : 'Nothing settled yet.'));
      return;
    }
    for (const t of list) {
      const side = (ids) => (ids.length
        ? ids.map((id) => {
          const item = COS.getItem(id);
          return `<i class="trade-sw" title="${escapeHtml(item?.name ?? id)}"
                     style="background:${swatchCss(item)};--rarity:${rarityColor(item?.rarity)}"></i>`;
        }).join('')
        : '<span class="trade-none">nothing</span>');
      const row = el('div', `trade${t.incoming ? ' incoming' : ''}`, `
        <div class="trade-who">
          <b>${escapeHtml(t.incoming ? t.from : t.to)}</b>
          <span>${t.incoming ? 'offered you' : 'you offered'}</span>
          ${live ? '' : `<span class="trade-status ${t.status}">${t.status.toUpperCase()}</span>`}
        </div>
        <div class="trade-sides">
          <div>${side(t.fromItems)}${t.fromGr ? `<span class="trade-gr">${fmt(t.fromGr)} GR</span>` : ''}</div>
          <span class="trade-arrow">⇄</span>
          <div>${side(t.toItems)}${t.toGr ? `<span class="trade-gr">${fmt(t.toGr)} GR</span>` : ''}</div>
        </div>
        ${t.note ? `<p class="trade-note">${escapeHtml(t.note)}</p>` : ''}
        ${live ? '<div class="trade-actions"></div>' : ''}`);
      if (live) {
        const actions = row.querySelector('.trade-actions');
        if (t.incoming) {
          const yes = el('button', 'btn-primary sm', 'ACCEPT');
          yes.addEventListener('click', () => this._settleTrade(t.id, 'accept'));
          actions.appendChild(yes);
        }
        const no = el('button', 'btn-ghost sm', t.incoming ? 'DECLINE' : 'WITHDRAW');
        no.addEventListener('click', () => this._settleTrade(t.id, 'close'));
        actions.appendChild(no);
      }
      box.appendChild(row);
    }
  }

  async _settleTrade(id, how) {
    try {
      if (how === 'accept') await api.acceptTrade(id);
      else await api.closeTrade(id);
      sfx.ui('ok');
      this.buildTrades();
      this.buildLoadout();
    } catch (err) {
      sfx.ui('error');
      this.menu.notify(err.message ?? 'That offer would not settle.', 'error');
    }
  }

  /**
   * The offer builder.
   *
   * You can only pick from your own units, and only name GR for the other
   * side. That is the whole safety story: there is no field here in which
   * somebody can be persuaded to type something they did not mean, because
   * every item in the offer is one they clicked on themselves.
   */
  async _openTradeBuilder() {
    if (!api.isAuthed) { this.menu.toastAuth('Sign in to trade.'); return; }
    const who = $('tradeWho');
    who.innerHTML = '';
    const friends = this.menu.friendNames?.() ?? [];
    if (!friends.length) {
      this.menu.notify('Trades are between friends. Add somebody first.', 'error');
      return;
    }
    for (const name of friends) who.appendChild(el('option', null, escapeHtml(name))).value = name;

    this.tradeDraft = { give: new Set(), want: new Set() };
    this._paintTradePick('tradeGive', this.w.units ?? [], 'give');
    // The other side's inventory is not ours to browse, so an offer asks for
    // GR rather than for named items. Anything else would need the server to
    // publish everybody's wardrobe, which is a privacy question nobody asked.
    $('tradeWant').innerHTML =
      '<p class="pn-none">Ask for GR — what they are giving up is theirs to choose.</p>';
    $('tradeNote2').textContent = `At most ${COS.TRADE_MAX_ITEMS} items a side.`;
    $('tradeModal').classList.remove('hidden');
  }

  _paintTradePick(id, units, side) {
    const box = $(id);
    box.innerHTML = '';
    const free = units.filter((u) => !u.locked && COS.getItem(u.itemId)?.tradable);
    if (!free.length) { box.appendChild(el('p', 'pn-none', 'Nothing tradable.')); return; }
    for (const unit of free) {
      const item = COS.getItem(unit.itemId);
      const chip = el('button', 'trade-chip', `
        <i style="background:${swatchCss(item)}"></i>
        <span style="color:${rarityColor(item.rarity)}">${escapeHtml(item.name)}</span>`);
      chip.addEventListener('click', () => {
        const set = this.tradeDraft[side];
        if (set.has(unit.unitId)) set.delete(unit.unitId);
        else if (set.size >= COS.TRADE_MAX_ITEMS) return;
        else set.add(unit.unitId);
        chip.classList.toggle('on', set.has(unit.unitId));
        sfx.ui();
      });
      box.appendChild(chip);
    }
  }

  async _sendOffer() {
    try {
      await api.offerTrade({
        to: $('tradeWho').value,
        give: [...this.tradeDraft.give],
        giveGr: Number($('tradeGiveGr').value) || 0,
        wantGr: Number($('tradeWantGr').value) || 0,
        note: $('tradeNote').value,
      });
      sfx.ui('ok');
      $('tradeModal').classList.add('hidden');
      this.menu.notify('Offer sent.', 'ok');
      this.buildTrades();
    } catch (err) {
      sfx.ui('error');
      this.menu.notify(err.message ?? 'That offer was refused.', 'error');
    }
  }
}

export default Wardrobe;
