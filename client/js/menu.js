/**
 * Open Grunker — main menu: account, classes, servers, leaderboard, shop,
 * key bindings and settings.
 *
 * Everything outside the match lives here. The game layer only needs
 * `onPlay(opts)`, so the menu owns all of its own DOM and network chatter.
 */
import * as K from '/shared/constants.js';
import { CLASSES, CLASS_IDS, SKINS, RARITY, loadoutFor } from '/shared/weapons.js';
import { api } from './api.js';
import {
  settings, set as setSetting, SCHEMA, reset as resetSettings,
  exportText as exportSettings, importText as importSettings,
} from './settings.js';
import { getMap, ALL_MAP_IDS } from '/shared/maps.js';
import { GAME_VERSION, PATCH_NOTES, PATCH_KINDS, latestPatch } from '/shared/patchnotes.js';
import * as keys from './keybinds.js';
import { sfx } from './audio.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const NAME_KEY = 'og.name';
const CLASS_KEY = 'og.class';

/** Score events worth explaining on the help screen. */
const SCORING_HELP = [
  ['KILL', 'Every elimination'],
  ['HEADSHOT', 'On top of the kill'],
  ['MIDAIR', 'Victim was airborne'],
  ['DRIFT', 'You were sliding'],
  ['NOSCOPE', 'Sniper kill, no scope'],
  ['LONGSHOT', `Over ${K.LONGSHOT_RANGE} units`],
  ['BACKSTAB', 'Knife from behind'],
  ['MULTIKILL', `Two kills within ${K.MULTIKILL_WINDOW}s`],
];

export class Menu {
  constructor({ onPlay, onSettingsChange, onClassChange, onClassPreview, onBindsChange, input }) {
    this.onPlay = onPlay;
    this.onSettingsChange = onSettingsChange;
    this.onClassChange = onClassChange;
    this.onClassPreview = onClassPreview;
    this.onBindsChange = onBindsChange;
    this.input = input;
    this.selectedClass = localStorage.getItem(CLASS_KEY) || 'triggerman';
    this.selectedRoom = null;
    this.modeFilter = '';
    this.servers = [];
    /** Match code of the room rendering behind the menu right now. */
    this.watchingCode = null;
    this.authMode = 'login';
    /** Server rules fetched from /meta: captcha keys, rename price, mail policy. */
    this.meta = null;
    /** Rendered Turnstile widget ids, keyed by form. */
    this.widgets = { register: null, login: null };
    /** The last /clans/mine answer, so the panel can redraw without refetching. */
    this.clanState = null;
    /** Which profile the player card is currently showing. */
    this.cardName = null;

    this.root = $('menu');
    /** Live server rows keyed by mode, so the play buttons can target one. */
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this._bindTabs();
    this._bindPanels();
    this._bindPlay();
    this._bindAuth();
    this._bindClassModal();
    this._bindProfile();
    this._bindAccountNav();
    this._bindAvatar();
    this._bindClans();
    this._bindPlayerCard();
    this.buildClasses($('classGrid'));
    this.buildClasses($('classGridModal'), true);
    this.buildSettings();
    this.buildBinds();
    this.buildHelp();
    this.buildModeFilter();
    this.loadMeta();
    this.refreshAccount();
    this.refreshServers();
    this.refreshGlobal();

    // The last name this browser played under. There is no box for it any more —
    // the account chip shows it — but it is still what an avatar is drawn from
    // before the server has named this guest.
    this.assignedName = localStorage.getItem(NAME_KEY) || '';
    this.buildPatchNotes();
    // Fire and forget, but never unhandled: the constructor cannot await it.
    this.consumeVerifyLink().catch(() => {});
    $('btnRefreshServers').addEventListener('click', () => { sfx.ui(); this.refreshServers(); });
    $('lbSort').addEventListener('change', () => this.refreshLeaderboard());
    $('srvFilter').addEventListener('change', () => { this.modeFilter = $('srvFilter').value; this.refreshServers(); });
    keys.onChange(() => { this.buildHelp(); this.onBindsChange?.(); });
    this.setLoadoutCard(this.selectedClass);
  }

  /* ── Panels ────────────────────────────────────────────────────────────── */

  /**
   * Every rail item, top-bar link and loadout button names a panel through
   * `data-open`, so adding an entry to the chrome never needs a new handler.
   */
  _bindPanels() {
    const panel = $('menuPanel');
    for (const btn of document.querySelectorAll('[data-open]')) {
      btn.addEventListener('click', () => { sfx.ui(); this.openTab(btn.dataset.open); });
    }
    $('panelClose').addEventListener('click', () => this.closePanel());
    panel.addEventListener('mousedown', (e) => { if (e.target === panel) this.closePanel(); });
    // Escape closes the panel from the menu too, where the game's own input
    // handler is switched off and would never see the key.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // The player card sits over the panel, so it is what Escape closes first.
      if (this.playerCardOpen) { e.preventDefault(); e.stopPropagation(); this.closePlayerCard(); return; }
      if (!this.panelOpen) return;
      if (!$('authModal').classList.contains('hidden')) return;
      if (!$('classModal').classList.contains('hidden')) return;
      e.preventDefault();
      // Mid-match the game's own Escape handler is listening on window, and it
      // would close the whole menu behind this. One Escape, one panel.
      e.stopPropagation();
      this.closePanel();
    });
  }

  get panelOpen() { return !$('menuPanel').classList.contains('hidden'); }
  openPanel() { $('menuPanel').classList.remove('hidden'); }
  closePanel() { $('menuPanel').classList.add('hidden'); sfx.ui(); }

  /**
   * The name this client would connect under.
   *
   * An account's own, or nothing at all: the server assigns every guest name,
   * so proposing one would only be ignored.
   */
  currentName() {
    return api.account?.username ?? undefined;
  }

  /** The name the server gave this guest, so the account chip shows the truth. */
  setAssignedName(name) {
    if (!name || api.isAuthed) return;
    this.assignedName = name;
    $('acName').textContent = name;
    paintAvatar($('acAvatar'), null, name);
    try { localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ }
  }

  /**
   * The "Now Playing" strip above the play buttons: what the camera behind the
   * menu is actually showing, and the code needed to share it.
   */
  setNowPlaying({ mapName, modeName, code } = {}) {
    $('nowPlaying').textContent = mapName
      ? `Now Playing: ${modeName ?? 'Match'} on ${mapName}`
      : 'Finding a match…';
    $('playSub').textContent = mapName ? `${modeName ?? ''} · ${mapName}`.trim() : 'Jump into the live match';
    $('menuRoomCode').textContent = code ?? '';
    $('menuRegion').textContent = code ? String(code).split(':')[0] : '—';
  }

  /** Kept for callers that only have one string to give. */
  setPlaySubtitle(text) { $('playSub').textContent = text; }

  /** Frame counter for the menu's own readout — the game loop feeds it. */
  tickStats(dt, ping = 0) {
    if (!this.visible) return;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc < 0.5) return;
    $('menuFps').textContent = Math.round(this.fpsFrames / this.fpsAcc);
    $('menuPing').textContent = Math.round(ping);
    this.fpsAcc = 0;
    this.fpsFrames = 0;
  }

  /** Bottom-right card: the class the next spawn will use. */
  setLoadoutCard(classId) {
    const c = CLASSES[classId] ?? CLASSES[CLASS_IDS[0]];
    if (!c) return;
    $('mlClass').textContent = c.name;
    $('mlWeapon').textContent = c.primary?.name ?? '';
  }

  show() {
    this.root.classList.remove('hidden');
    this.refreshServers();
    this.refreshGlobal();
    this.refreshAccount();
  }

  hide() { this.root.classList.add('hidden'); this.closePanelSilently(); }

  closePanelSilently() { $('menuPanel').classList.add('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }

  /* ── Tabs ──────────────────────────────────────────────────────────────── */

  _bindTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        sfx.ui();
        for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
        for (const p of document.querySelectorAll('.tab-panel')) {
          p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
        }
        if (tab.dataset.tab === 'leaderboard') this.refreshLeaderboard();
        if (tab.dataset.tab === 'clans') this.refreshClans();
        if (tab.dataset.tab === 'servers') this.refreshServers();
        if (tab.dataset.tab === 'shop') this.buildShop();
        if (tab.dataset.tab === 'profile') this.refreshAccount();
        if (tab.dataset.tab === 'controls') this.buildBinds();
        if (tab.dataset.tab === 'challenges') this.buildProgress();
      });
    }
  }

  openTab(name) {
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (!tab) return;
    this.openPanel();
    tab.click();
  }

  /* ── Play ──────────────────────────────────────────────────────────────── */

  _bindPlay() {
    const play = (room) => {
      sfx.ui('ok');
      this.onPlay({
        name: this.currentName(),
        classId: this.selectedClass,
        room: room ?? (this.selectedRoom || this.watchingCode || undefined),
      });
    };
    this.play = play;

    $('btnPlay').addEventListener('click', () => play());
    $('btnJoin').addEventListener('click', () => play());

    // Each shortcut resolves to a live room in the browser's own list. Nothing
    // here invents a mode the server does not run: if no room is hosting it the
    // player is sent to the browser instead of into a dead join.
    const byModes = (label, ...modes) => async () => {
      await this.refreshServers();
      const open = this.servers
        .filter((srv) => modes.includes(srv.mode) && srv.players < srv.capacity)
        .sort((a, b) => b.players - a.players)[0];
      if (!open) {
        sfx.ui('error');
        this.notify(`No ${label} server has room right now — pick another from the list.`, 'error');
        this.openTab('servers');
        return;
      }
      this.selectedRoom = open.code;
      play(open.code);
    };

    $('btnTeamPlay').addEventListener('click', byModes('team', 'tdm', 'dom'));
    $('btnGunGame').addEventListener('click', byModes('Gun Game', 'gg'));
    $('btnPractice').addEventListener('click', byModes('practice', 'range'));
    $('btnFindGame').addEventListener('click', () => { sfx.ui(); this.openTab('servers'); });

    $('btnSignupRewards').addEventListener('click', () => {
      sfx.ui();
      this.openAuth('register');
    });

    $('btnInvite').addEventListener('click', async () => {
      const code = this.watchingCode;
      if (!code) return void sfx.ui('error');
      const link = `${location.origin}${location.pathname}?game=${encodeURIComponent(code)}`;
      try {
        await navigator.clipboard.writeText(link);
        sfx.ui('ok');
        $('btnInvite').textContent = 'LINK COPIED';
      } catch {
        // Clipboard access can be refused; showing the link is the fallback.
        $('menuRoomCode').textContent = link;
      }
      setTimeout(() => { $('btnInvite').textContent = 'INVITE'; }, 1800);
    });
  }

  /* ── Controller navigation ─────────────────────────────────────────────── */

  /**
   * Steering the interface with a pad.
   *
   * Nothing here is a second interface: it moves the browser's own focus
   * between the elements that are already there and presses them, so every
   * button, slider and tab works exactly as it does under a mouse and nothing
   * has to be re-declared as "pad-reachable". A pad you can play with but not
   * press PLAY with is not controller support.
   *
   * @param {'up'|'down'|'left'|'right'|'accept'|'back'} dir
   */
  padNav(dir) {
    if (dir === 'accept') return void this._padActivate();
    if (dir === 'back') return void this._padBack();
    this._padMove(dir);
  }

  /** The surface a pad is currently inside: the topmost open thing. */
  _padScope() {
    for (const id of ['reportCard', 'playerCard', 'classModal', 'authModal']) {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) return el;
    }
    const panel = $('menuPanel');
    if (panel && !panel.classList.contains('hidden')) return panel;
    return this.root;
  }

  /** Everything inside `scope` a person could actually click right now. */
  _padTargets(scope) {
    const out = [];
    const sel = 'button:not([disabled]), a[href], select, input:not([type="hidden"]):not([disabled]), '
      + '[tabindex]:not([tabindex="-1"])';
    for (const el of scope.querySelectorAll(sel)) {
      if (el.offsetParent === null) continue;              // hidden or detached
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      out.push(el);
    }
    return out;
  }

  _padActivate() {
    const scope = this._padScope();
    const el = document.activeElement;
    if (el && el !== document.body && scope.contains(el)) {
      sfx.ui();
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT') el.focus();
      else el.click();
      return;
    }
    this._padMove('down');
  }

  /**
   * B, and the one control on a pad that has to mean the same thing everywhere:
   * close whatever is on top, and when nothing is, hand the press to the game's
   * own Escape so it opens or closes the menu.
   */
  _padBack() {
    sfx.ui();
    for (const [id, close] of [
      ['reportCard', () => $('reportCancel')?.click()],
      ['playerCard', () => this.closePlayerCard()],
      ['classModal', () => this.closeClassModal()],
      ['authModal', () => $('authClose')?.click()],
    ]) {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) { close(); return; }
    }
    const panel = $('menuPanel');
    if (panel && !panel.classList.contains('hidden')) { this.closePanel(); return; }
    this.input?.emit('escape');
  }

  /**
   * Moves focus one step in a direction, geometrically.
   *
   * A tab order would be wrong here: this interface is a set of cards laid out
   * in two dimensions, and "down" from the class grid means the card underneath
   * it, not the next element in the document. Candidates are scored on how far
   * they are along the axis being pressed plus twice how far they stray off it,
   * which is what makes a grid feel like a grid.
   */
  _padMove(dir) {
    const scope = this._padScope();
    const targets = this._padTargets(scope);
    if (!targets.length) return;

    const active = document.activeElement;
    const from = active && scope.contains(active) && targets.includes(active) ? active : null;
    if (!from) { this._padFocus(targets[0]); return; }

    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    const axis = dir === 'up' || dir === 'down' ? 'y' : 'x';
    const sign = dir === 'down' || dir === 'right' ? 1 : -1;

    let best = null, bestScore = Infinity;
    for (const el of targets) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      const along = (axis === 'y' ? by - ay : bx - ax) * sign;
      if (along <= 2) continue;                             // behind us, or level
      const across = Math.abs(axis === 'y' ? bx - ax : by - ay);
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) this._padFocus(best);
  }

  _padFocus(el) {
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    sfx.ui();
  }

  /* ── Class cards ───────────────────────────────────────────────────────── */

  buildClasses(container, isModal = false) {
    container.innerHTML = '';
    for (const id of CLASS_IDS) {
      const c = CLASSES[id];
      const w = c.primary;
      const dps = Math.round(w.damage * (w.fireRate / 60) * (w.pellets ?? 1));
      const bar = (v, max) => `<i style="width:${Math.min(100, (v / max) * 100)}%"></i>`;

      const card = el('div', `class-card${id === this.selectedClass ? ' selected' : ''}`, `
        <span class="pick">SELECTED</span>
        <h4>${c.name}</h4>
        <div class="weap">${w.name}</div>
        <p>${c.tagline}</p>
        <div class="class-stats">
          <div class="stat-row"><span>DMG</span><span class="stat-bar">${bar(w.damage * (w.pellets ?? 1), 120)}</span></div>
          <div class="stat-row"><span>RATE</span><span class="stat-bar">${bar(w.fireRate, 1250)}</span></div>
          <div class="stat-row"><span>DPS</span><span class="stat-bar">${bar(dps, 400)}</span></div>
          <div class="stat-row"><span>SPEED</span><span class="stat-bar">${bar(w.moveMult, 1.25)}</span></div>
          <div class="stat-row"><span>MAG</span><span class="stat-bar">${bar(w.magSize, 60)}</span></div>
        </div>
        ${masteryLine(w.id)}`);
      card.dataset.classId = id;
      card.addEventListener('click', () => {
        this.selectedClass = id;
        localStorage.setItem(CLASS_KEY, id);
        this.setLoadoutCard(id);
        sfx.ui();
        for (const n of document.querySelectorAll('.class-card')) {
          n.classList.toggle('selected', n.dataset.classId === id);
        }
        if (api.isAuthed) api.saveLoadout({ classId: id, settings, keybinds: keys.binds }).catch(() => {});
        if (isModal) { this.closeClassModal(); this.onClassChange?.(id); }
        else this.onClassPreview?.(id);
      });
      container.appendChild(card);
    }
  }

  /* ── Servers ───────────────────────────────────────────────────────────── */

  /** Fills the mode dropdown from the modes the build actually knows about. */
  buildModeFilter() {
    const sel = $('srvFilter');
    if (!sel) return;
    sel.innerHTML = '<option value="">All modes</option>'
      + Object.values(K.MODES).map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  }

  async refreshServers() {
    const list = $('serverList');
    try {
      const { servers } = await api.servers();
      this.servers = servers;
      const shown = this.modeFilter ? servers.filter((s) => s.mode === this.modeFilter) : servers;
      list.innerHTML = '';
      for (const s of shown) {
        const total = s.players + s.bots;
        const full = s.players >= s.capacity;
        const row = el('div', 'server-row', `
          <div>
            <div class="s-map">${escapeHtml(s.mapName)}</div>
            <div class="s-mode">${escapeHtml(s.modeName)}</div>
            <span class="s-code">${escapeHtml(s.code ?? '')}</span>
            <div class="s-tags">${(s.tags ?? []).map((t) => `<span class="s-tag">${escapeHtml(t)}</span>`).join('')}</div>
          </div>
          <canvas class="s-thumb" width="124" height="124"></canvas>
          <div class="s-pop${full ? ' full' : ''}">${total}/${s.capacity}${s.bots ? ` <small>(${s.bots} bots)</small>` : ''}</div>
          <div class="s-time">${s.practice ? 'ALWAYS OPEN' : s.phase === 'intermission' ? 'INTERMISSION' : fmtTime(s.endsIn)}</div>
          <div class="s-join">${full ? 'FULL' : 'JOIN ›'}</div>`);
        if (s.code === this.watchingCode) row.classList.add('watching');
        drawMapThumb(row.querySelector('.s-thumb'), s.map);
        row.addEventListener('click', () => {
          this.selectedRoom = s.code;
          sfx.ui(full ? 'error' : 'ok');
          if (full) return;
          $('btnPlay').click();
        });
        list.appendChild(row);
      }
      if (!shown.length) {
        list.innerHTML = `<p class="empty">${servers.length ? 'No server running that mode right now.' : 'No servers running.'}</p>`;
      }
    } catch {
      list.innerHTML = '<p class="empty">Server list unavailable.</p>';
    }
  }

  /**
   * The live readout in the footer — accounts, matches played, who is online.
   *
   * Staff only. The route refuses everyone else, so this asks for it only when
   * it would be answered rather than firing a request a moderator's absence
   * turns into a 403 on every menu open.
   */
  async refreshGlobal() {
    const host = $('globalStats');
    if (!host) return;
    if (!K.canModerate(api.account?.role)) {
      host.classList.add('hidden');
      host.textContent = '';
      return;
    }
    try {
      const s = await api.globalStats();
      host.textContent = `${s.users} account${s.users === 1 ? '' : 's'} · `
        + `${s.matches} matches played · ${s.online} online · ${s.clans} clan${s.clans === 1 ? '' : 's'}`;
      host.classList.remove('hidden');
    } catch {
      host.classList.add('hidden');
    }
  }

  /* ── Patch notes ───────────────────────────────────────────────────────── */

  /**
   * The build in the bottom-left corner, and the whole history behind it.
   *
   * Built once at boot from `shared/patchnotes.js` — it is the same module the
   * server publishes its version from, so the menu and the API can never
   * disagree about which build this is.
   */
  buildPatchNotes() {
    const latest = latestPatch();
    if ($('gameVersion')) $('gameVersion').textContent = `v${GAME_VERSION}`;
    if ($('patchHeadline')) $('patchHeadline').textContent = latest?.title ?? '';
    if ($('patchDate')) $('patchDate').textContent = latest ? `Released ${fmtDate2(latest.date)}` : '';
    if ($('patchNote')) {
      $('patchNote').textContent = `You are playing v${GAME_VERSION}. Newest first.`;
    }

    const host = $('patchList');
    if (host) {
      host.innerHTML = PATCH_NOTES.map((rel, i) => `
        <article class="patch${i === 0 ? ' current' : ''}">
          <header class="patch-head">
            <b>v${escapeHtml(rel.version)}</b>
            <span class="patch-title">${escapeHtml(rel.title)}</span>
            <time>${escapeHtml(fmtDate2(rel.date))}</time>
            ${i === 0 ? '<span class="pill">YOU ARE PLAYING THIS</span>' : ''}
          </header>
          <ul class="patch-changes">${(rel.changes ?? []).map((c) => {
    const kind = PATCH_KINDS[c.kind] ?? PATCH_KINDS.change;
    return `<li><span class="patch-kind" style="color:${kind.color};border-color:${kind.color}66">${
      escapeHtml(kind.label)}</span>${escapeHtml(c.text)}</li>`;
  }).join('')}</ul>
        </article>`).join('');
    }

    $('btnPatchNotes')?.addEventListener('click', () => { sfx.ui(); this.openTab('patch'); });
  }

  /* ── Leaderboard ───────────────────────────────────────────────────────── */

  async refreshLeaderboard() {
    const list = $('lbList');
    const sort = $('lbSort').value;
    list.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const { entries } = await api.leaderboard(sort, 50);
      if (!entries.length) {
        list.innerHTML = '<p class="empty">No ranked players yet — be the first.</p>';
        return;
      }
      list.innerHTML = '';
      list.appendChild(el('div', 'lb-row head',
        '<span>#</span><span>PLAYER</span><span>LVL</span><span>SCORE</span><span>KILLS</span><span>K/D</span><span>WINS</span>'));
      const mine = api.account?.username;
      for (const e of entries) {
        const kd = (e.kills / Math.max(1, e.deaths)).toFixed(2);
        const rankCls = e.rank <= 3 ? ` top${e.rank}` : '';
        list.appendChild(el('div', `lb-row${rankCls}${e.username === mine ? ' me' : ''}`, `
          <span class="r">${e.rank}</span>
          <span class="n">${lbAvatar(e)}<button type="button" class="pname" data-profile="${
  escapeHtml(e.username)}" title="View ${escapeHtml(e.username)}'s profile"><span class="n-text">${
  escapeHtml(e.username)}</span>${badge(e.verified)}</button>${clanTag(e.clan, e.clanVerified)}</span>
          <span class="lv">${e.level}</span>
          <span>${fmtNum(e.score ?? 0)}</span>
          <span>${fmtNum(e.kills)}</span><span>${kd}</span><span>${e.wins}</span>`));
      }
    } catch {
      list.innerHTML = '<p class="empty">Leaderboard unavailable.</p>';
    }
  }

  /* ── Clans ─────────────────────────────────────────────────────────────── */

  /** The rules line under the CLANS heading, straight from /meta. */
  applyClanRules(rules) {
    this.clanRules = rules ?? null;
    const note = $('clanRules');
    if (!note) return;
    if (!rules || rules.enabled === false) {
      note.textContent = 'Clans are switched off on this server.';
      return;
    }
    note.textContent = `A ${rules.tagMin}–${rules.tagMax} character tag, drawn in front of your `
      + `name everywhere it appears. Joining needs level ${rules.joinLevel}; founding one needs `
      + `level ${rules.createLevel} and ${fmtNum(rules.createCost)} GR.`;
  }

  _bindClans() {
    // One hidden picker, reused by whichever clan the player owns.
    this.clanPicker = document.createElement('input');
    this.clanPicker.type = 'file';
    this.clanPicker.accept = 'image/png,image/jpeg,image/webp';
    this.clanPicker.className = 'hidden';
    this.clanPicker.addEventListener('change', async () => {
      const file = this.clanPicker.files?.[0];
      this.clanPicker.value = '';                 // so the same file can be picked twice
      if (file) await this.uploadClanAvatar(file);
    });
    document.body.appendChild(this.clanPicker);

    $('btnClanRefresh')?.addEventListener('click', () => { sfx.ui(); this.refreshClans(); });
    // Debounced rather than per-keystroke: a four-character box would otherwise
    // fire four requests for one word.
    $('clanSearch')?.addEventListener('input', () => {
      clearTimeout(this._clanSearchTimer);
      this._clanSearchTimer = setTimeout(() => this.refreshClanList(), 240);
    });

    // Every button the panel draws names an action rather than carrying its own
    // handler, so redrawing the panel never leaves a listener behind.
    for (const host of [$('clanMine'), $('clanList')]) {
      host?.addEventListener('click', (e) => {
        // Buttons only: the create and invite forms carry `data-clan-act` too,
        // and their submit buttons would otherwise fire the action twice.
        const btn = e.target.closest('button[data-clan-act]');
        if (!btn || !host.contains(btn)) return;
        e.preventDefault();
        this.clanAction(btn.dataset.clanAct, btn.dataset.arg ?? '', btn);
      });
    }
    $('clanMine')?.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-clan-act]');
      if (!form) return;
      e.preventDefault();
      this.clanAction(form.dataset.clanAct, new FormData(form).get('value') ?? '', form);
    });
  }

  /** Both halves of the panel: this account's clan, and everybody else's. */
  async refreshClans() {
    await Promise.all([this.refreshMyClan(), this.refreshClanList()]);
  }

  /**
   * This account's own clan — or, without one, what founding one would cost and
   * who has invited them. Also drives the two invite badges.
   */
  async refreshMyClan() {
    const host = $('clanMine');
    if (!host) return;
    if (!api.isAuthed) {
      this.clanState = null;
      this.setClanBadge(0);
      host.innerHTML = `<div class="clan-empty">
        <h4>SIGN IN TO JOIN A CLAN</h4>
        <p>A clan tag follows your account, so it needs an account to follow.</p>
        <button class="btn-primary" data-clan-act="signin" type="button">SIGN IN / REGISTER</button>
      </div>`;
      return;
    }
    host.innerHTML = '<p class="empty">Loading…</p>';
    try {
      this.clanState = await api.myClan();
    } catch (ex) {
      host.innerHTML = `<p class="empty">${escapeHtml(ex.message || 'Clans are unavailable right now.')}</p>`;
      return;
    }
    this.setClanBadge(this.clanState.invites?.length ?? 0);
    host.innerHTML = this.clanState.clan
      ? this.myClanHtml(this.clanState)
      : this.noClanHtml(this.clanState);
    if (this.clanState.clan) {
      paintAvatar(host.querySelector('.clan-pic'), this.clanState.clan.avatar, this.clanState.clan.tag);
    }
  }

  /** The invite count, on the rail item and on the tab. */
  setClanBadge(n) {
    for (const id of ['railClanBadge', 'clanTabBadge']) {
      const badgeEl = $(id);
      if (!badgeEl) continue;
      badgeEl.textContent = String(n);
      badgeEl.classList.toggle('hidden', !n);
    }
  }

  /** No clan: the invitations waiting, and the form for founding one. */
  noClanHtml(state) {
    const rules = state.rules ?? this.clanRules ?? {};
    const level = state.level ?? 0;
    const gr = state.gr ?? 0;
    const needLevel = level < (rules.createLevel ?? K.CLAN_CREATE_LEVEL);
    const needGr = gr < (rules.createCost ?? K.CLAN_CREATE_COST);

    const invites = (state.invites ?? []).map((i) => `
      <div class="clan-invite">
        <span class="clan-tag${i.verified ? ' verified' : ''}">[${escapeHtml(i.tag)}]</span>
        <span class="ci-who">invited you${i.invitedBy ? ` — ${escapeHtml(i.invitedBy)}` : ''}</span>
        <span class="ci-when">${fmtAgo(i.createdAt)}</span>
        <button class="btn-ghost sm" data-clan-act="join" data-arg="${escapeHtml(i.tag)}" type="button">ACCEPT</button>
        <button class="btn-ghost sm" data-clan-act="decline" data-arg="${escapeHtml(i.tag)}" type="button">DECLINE</button>
      </div>`).join('');

    return `
      ${invites ? `<div class="clan-invites">
        <h4>YOU HAVE BEEN INVITED</h4>
        ${level < (rules.joinLevel ?? K.CLAN_JOIN_LEVEL)
    ? `<p class="panel-note">You are level ${level} — joining a clan needs level ${rules.joinLevel}.</p>` : ''}
        ${invites}
      </div>` : ''}
      <div class="clan-empty">
        <h4>YOU ARE NOT IN A CLAN</h4>
        <p>A clan is a tag of up to ${rules.tagMax ?? K.CLAN_TAG_MAX} characters, drawn in front of
          your nickname on every scoreboard, killfeed, chat line and nametag in the game.
          Grey normally — gold once the developers have verified it.</p>
        <p class="panel-note">Clans are invite-only: an owner has to ask you in.</p>
        <form class="mini-form clan-create" data-clan-act="create">
          <label>FOUND YOUR OWN
            <input name="value" maxlength="${rules.tagMax ?? K.CLAN_TAG_MAX}" autocomplete="off"
                   spellcheck="false" placeholder="${rules.tagMin ?? K.CLAN_TAG_MIN}–${rules.tagMax ?? K.CLAN_TAG_MAX} letters or digits" required>
          </label>
          <div class="cost-line">
            Costs <b>${fmtNum(rules.createCost ?? K.CLAN_CREATE_COST)}</b> GR
            <span class="${needGr ? 'bad' : ''}">· you have ${fmtNum(gr)}</span>
            · needs level <b>${rules.createLevel ?? K.CLAN_CREATE_LEVEL}</b>
            <span class="${needLevel ? 'bad' : ''}">· you are ${level}</span>
          </div>
          <div class="form-msg hidden" id="clanMsg"></div>
          <button type="submit" class="btn-ghost">FOUND A CLAN</button>
        </form>
      </div>`;
  }

  /** In a clan: the hero, the roster, and — for its owner — the tools. */
  myClanHtml(state) {
    const c = state.clan;
    const owner = c.you?.role === 'owner';
    const rules = state.rules ?? this.clanRules ?? {};

    const roster = (c.roster ?? []).map((m) => `
      <div class="clan-member${m.role === 'owner' ? ' owner' : ''}">
        <span class="cm-name">${lbAvatar({ avatar: m.avatar, username: m.username })}
          <button type="button" class="pname" data-profile="${escapeHtml(m.username)}"
                  title="View ${escapeHtml(m.username)}'s profile"><span class="n-text">${escapeHtml(m.username)}</span>${badge(m.verified)}</button>
          ${m.role === 'owner' ? '<span class="cm-role">OWNER</span>' : ''}</span>
        <span class="cm-lv">LVL ${m.level}</span>
        <span class="cm-k">${fmtNum(m.kills)} kills</span>
        <span class="cm-joined">${fmtAgo(m.joinedAt)}</span>
        <span class="cm-act">${owner && m.role !== 'owner' ? `
          <button class="btn-ghost sm" data-clan-act="promote" data-arg="${escapeHtml(m.username)}" type="button">MAKE OWNER</button>
          <button class="btn-ghost sm danger" data-clan-act="kick" data-arg="${escapeHtml(m.username)}" type="button">REMOVE</button>` : ''}</span>
      </div>`).join('');

    const pending = (c.invites ?? []).map((i) => `
      <div class="clan-invite pending">
        <span class="ci-who">${escapeHtml(i.username)} <small>LVL ${i.level}</small></span>
        <span class="ci-when">invited ${fmtAgo(i.createdAt)}</span>
        ${owner ? `<button class="btn-ghost sm" data-clan-act="uninvite" data-arg="${escapeHtml(i.username)}" type="button">CANCEL</button>` : ''}
      </div>`).join('');

    return `
      <div class="clan-hero">
        <button class="clan-pic${owner ? '' : ' static'}" data-clan-act="${owner ? 'avatar' : 'none'}"
                type="button" ${owner ? 'title="Change the clan picture"' : 'disabled'}>
          <img class="av-img hidden" alt="" width="86" height="86"><span class="av-initial">?</span>
          ${owner ? '<span class="ph-avatar-edit">CHANGE</span>' : ''}
        </button>
        <div class="clan-id">
          <h3><span class="clan-tag${c.verified ? ' verified' : ''}">[${escapeHtml(c.tag)}]</span></h3>
          <div class="ph-tags">
            <span class="pill">${c.members} / ${c.maxMembers} MEMBERS</span>
            <span class="pill">${owner ? 'YOU OWN IT' : `OWNER ${escapeHtml(c.ownerName ?? '—')}`}</span>
            ${c.verified
    ? '<span class="pill gold">VERIFIED BY THE DEVS</span>'
    : '<span class="pill">NOT VERIFIED</span>'}
            <span class="pill">FOUNDED ${fmtDate(c.createdAt)}</span>
          </div>
        </div>
        <div class="clan-actions">
          ${owner
    ? `<button class="btn-ghost" data-clan-act="clearAvatar" type="button">REMOVE PICTURE</button>
             <button class="btn-danger" data-clan-act="disband" type="button">DISBAND</button>`
    : '<button class="btn-danger" data-clan-act="leave" type="button">LEAVE CLAN</button>'}
        </div>
      </div>
      <div class="form-msg hidden" id="clanMsg"></div>
      ${owner ? `
      <form class="mini-form clan-invite-form" data-clan-act="invite">
        <label>INVITE SOMEBODY
          <input name="value" maxlength="16" autocomplete="off" spellcheck="false"
                 placeholder="Their exact nickname" required>
        </label>
        <div class="cost-line">They have to be level ${rules.joinLevel ?? K.CLAN_JOIN_LEVEL} or above,
          and in no other clan. An invitation lapses after ${rules.inviteTtlHours ?? 72} hours.</div>
        <button type="submit" class="btn-ghost">SEND INVITE</button>
      </form>` : ''}
      ${pending ? `<div class="clan-invites"><h4>WAITING ON</h4>${pending}</div>` : ''}
      <div class="clan-roster"><h4>MEMBERS</h4>${roster}</div>`;
  }

  /** Every clan on the server, ranked by its members' combined match score. */
  async refreshClanList() {
    const list = $('clanList');
    if (!list) return;
    const q = ($('clanSearch')?.value ?? '').trim();
    list.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const { clans } = await api.clans(q, 50);
      if (!clans.length) {
        list.innerHTML = `<p class="empty">${q ? 'No clan by that tag.' : 'No clans yet — found the first one.'}</p>`;
        return;
      }
      const mine = this.clanState?.clan?.tag ?? null;
      list.innerHTML = clans.map((c) => `
        <div class="clan-row${c.tag === mine ? ' me' : ''}">
          <span class="cr-rank">${c.rank}</span>
          <span class="cr-pic">${clanPic(c)}</span>
          <span class="cr-tag clan-tag${c.verified ? ' verified' : ''}">[${escapeHtml(c.tag)}]</span>
          <span class="cr-owner">${c.ownerName
    ? `<button type="button" class="pname" data-profile="${escapeHtml(c.ownerName)}"><span class="n-text">${escapeHtml(c.ownerName)}</span></button>`
    : '—'}</span>
          <span class="cr-members">${c.members}<small>members</small></span>
          <span class="cr-score">${fmtNum(c.score)}<small>score</small></span>
          <span class="cr-kills">${fmtNum(c.kills)}<small>kills</small></span>
        </div>`).join('');
    } catch {
      list.innerHTML = '<p class="empty">Clan list unavailable.</p>';
    }
  }

  /** One line of feedback, wherever the panel currently has room for it. */
  clanMsg(text, bad = false) {
    const msg = $('clanMsg');
    if (!msg) { this.notify(text, bad ? 'error' : ''); return; }
    msg.textContent = text;
    msg.className = `form-msg${bad ? ' bad' : ''}`;
    msg.classList.remove('hidden');
  }

  /**
   * Everything a clan button can ask for.
   *
   * One switch rather than a handler per button: the panel is redrawn after
   * every one of these, so per-button listeners would have to be re-attached
   * each time and one missed re-attach is a dead button.
   */
  async clanAction(act, arg, source) {
    const tag = this.clanState?.clan?.tag ?? '';
    const ask = (q) => confirm(q);
    if (act === 'none') return;
    if (act === 'signin') { sfx.ui(); this.openAuth('login'); return; }
    if (act === 'avatar') { sfx.ui(); this.clanPicker.click(); return; }

    if (source?.tagName === 'BUTTON') source.disabled = true;
    try {
      switch (act) {
        case 'create': {
          const wanted = K.normaliseClanTag(arg);
          const bad = K.clanTagError(wanted);
          if (bad) { this.clanMsg(bad, true); sfx.ui('error'); return; }
          const r = await api.createClan(wanted);
          sfx.ui('ok');
          this.notify(`[${r.clan.tag}] founded — ${fmtNum(r.spent)} GR spent.`);
          break;
        }
        case 'join':
          await api.joinClan(arg);
          sfx.ui('ok');
          this.notify(`You joined [${arg}].`);
          break;
        case 'decline':
          await api.declineClan(arg);
          break;
        case 'invite':
          await api.inviteToClan(tag, String(arg).trim());
          sfx.ui('ok');
          this.clanMsg(`Invited ${String(arg).trim()} — they accept it from their own CLANS panel.`);
          break;
        case 'uninvite':
          await api.cancelClanInvite(tag, arg);
          break;
        case 'kick':
          if (!ask(`Remove ${arg} from [${tag}]?`)) return;
          await api.kickFromClan(tag, arg);
          break;
        case 'promote':
          if (!ask(`Hand [${tag}] over to ${arg}? You stay in the clan as a member.`)) return;
          await api.transferClan(tag, arg);
          sfx.ui('ok');
          break;
        case 'leave':
          if (!ask(`Leave [${tag}]?`)) return;
          await api.leaveClan(tag);
          break;
        case 'disband':
          if (!ask(`Disband [${tag}]? Every member loses the tag. This cannot be undone.`)) return;
          await api.disbandClan(tag);
          break;
        case 'clearAvatar':
          await api.removeClanAvatar(tag);
          break;
        default:
          return;
      }
      // refreshAccount re-reads the account — the GR spent, the tag it now
      // wears — and redraws the clan half of the panel with it.
      await this.refreshAccount();
      await this.refreshClanList();
    } catch (ex) {
      sfx.ui('error');
      this.clanMsg(ex.message || 'That did not work.', true);
    } finally {
      if (source?.tagName === 'BUTTON') source.disabled = false;
    }
  }

  /** Squares, shrinks and uploads a picture for the clan this account owns. */
  async uploadClanAvatar(file) {
    const tag = this.clanState?.clan?.tag;
    if (!tag) return;
    this.clanMsg('Preparing…');
    try {
      const blob = await squareAvatar(file);
      await api.uploadClanAvatar(tag, blob);
      sfx.ui('ok');
      await this.refreshClans();
      this.clanMsg('Clan picture updated.');
    } catch (ex) {
      sfx.ui('error');
      this.clanMsg(ex.message || 'Could not upload that picture.', true);
    }
  }

  /* ── Player card ───────────────────────────────────────────────────────── */

  /**
   * Any nickname, anywhere, opens the same card.
   *
   * One delegated listener on the document rather than a binding per rendered
   * row: the scoreboard, the chat log, the leaderboard and the clan roster all
   * redraw constantly, and a listener that has to be re-attached after every
   * redraw is a link that stops working the first time one is missed.
   */
  _bindPlayerCard() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest?.('[data-profile]');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      this.openPlayerCard(link.dataset.profile);
    });
    const card = $('playerCard');
    $('playerCardClose')?.addEventListener('click', () => this.closePlayerCard());
    card?.addEventListener('mousedown', (e) => { if (e.target === card) this.closePlayerCard(); });
  }

  get playerCardOpen() { return $('playerCard')?.classList.contains('hidden') === false; }

  closePlayerCard() {
    this.cardName = null;
    $('playerCard')?.classList.add('hidden');
    sfx.ui();
  }

  /** Fetches and draws one player's public profile. */
  async openPlayerCard(name) {
    const card = $('playerCard');
    const body = $('playerCardBody');
    if (!card || !body || !name) return;
    sfx.ui();
    this.cardName = name;
    card.classList.remove('hidden');
    body.innerHTML = `<div class="pc-head"><h3>${escapeHtml(name)}</h3></div>
      <p class="empty">Loading…</p>`;

    let data;
    try {
      data = await api.player(name);
    } catch (ex) {
      if (this.cardName !== name) return;               // a later click won
      body.innerHTML = `<div class="pc-head"><h3>${escapeHtml(name)}</h3></div>
        <p class="empty">${escapeHtml(ex.status === 404
    ? 'That name has no account behind it — a guest, or a player who has since been removed.'
    : ex.message || 'That profile is unavailable right now.')}</p>`;
      return;
    }
    if (this.cardName !== name) return;
    body.innerHTML = playerCardHtml(data);
    paintAvatar(body.querySelector('.pc-avatar'), data.user.avatar, data.user.username);
  }

  /* ── Shop ──────────────────────────────────────────────────────────────── */

  buildShop() {
    const grid = $('shopGrid');
    const owned = api.account?.loadout?.owned ?? [];
    const equipped = api.account?.loadout?.skins?.[this.selectedClass] ?? 'default';
    const cls = CLASSES[this.selectedClass];
    const weaponId = cls?.primary?.id;
    const tier = K.masteryFor(api.mastery?.[weaponId]?.kills ?? 0).tier;
    const level = api.account?.level ?? 0;
    $('grBalance').textContent = fmtNum(api.account?.gr ?? 0);
    $('shopFor').textContent =
      `Applied to ${cls?.name ?? 'your class'} — ${cls?.primary?.name ?? ''}. Pick a class first to skin a different gun.`;

    grid.innerHTML = '';
    for (const skin of Object.values(SKINS)) {
      const earned = skin.price < 0;
      const unlocked = !earned ? true
        : skin.unlock?.type === 'level' ? level >= skin.unlock.value
          : skin.unlock?.type === 'mastery' ? tier >= skin.unlock.value
            : skin.unlock?.type === 'account' ? api.isAuthed
              : false;
      const has = skin.price === 0 || owned.includes(skin.id) || (earned && unlocked);
      const isOn = equipped === skin.id;
      const rarity = RARITY[skin.rarity ?? 'common'];
      const swatch = skin.tint === null
        ? 'linear-gradient(135deg,#39404b,#5a6472)'
        : `linear-gradient(135deg, #${skin.tint.toString(16).padStart(6, '0')}, #${Math.floor(skin.tint * 0.5).toString(16).padStart(6, '0')})`;

      const priceLine = has
        ? (isOn ? 'EQUIPPED' : 'OWNED — EQUIP')
        : earned ? (skin.hint ?? 'EARN IT') : `${fmtNum(skin.price)} GR`;

      const card = el('div', `skin-card${isOn ? ' equipped' : ''}${has ? '' : ' locked'}`, `
        <div class="skin-swatch" style="background:${swatch}"></div>
        <h5>${escapeHtml(skin.name)}</h5>
        <div class="skin-rarity" style="color:#${rarity.color.toString(16).padStart(6, '0')}">${rarity.name.toUpperCase()}</div>
        <div class="price ${has ? 'owned' : earned ? 'locked' : ''}">${escapeHtml(priceLine)}</div>`);

      card.addEventListener('click', async () => {
        if (!api.isAuthed) { this.toastAuth('Sign in to buy and equip skins.'); return; }
        if (earned && !unlocked) { sfx.ui('error'); this.notify(skin.hint ?? 'Not unlocked yet.', 'error'); return; }
        try {
          if (!has) {
            await api.buySkin(skin.id);
            sfx.ui('ok');
          }
          const skins = { ...(api.account.loadout?.skins ?? {}), [this.selectedClass]: skin.id };
          await api.saveLoadout({ classId: this.selectedClass, skins, settings, keybinds: keys.binds });
          this.buildShop();
        } catch (err) {
          sfx.ui('error');
          this.notify(err.message ?? 'Purchase failed.', 'error');
        }
      });
      grid.appendChild(card);
    }
  }

  /* ── Challenges & mastery ──────────────────────────────────────────────── */

  /**
   * The career list: everything still to earn first, everything earned after.
   *
   * A trophy cabinet gives nobody a reason to play tomorrow. What does is the
   * *next* rung of each track, so the unclaimed ones sort to the top by how
   * close they are — the one thing on this screen a player can act on tonight
   * is the first thing on it — and the earned ones settle underneath as the
   * record they are.
   */
  renderMilestones(list) {
    const host = $('milestoneList');
    if (!host) return;
    if (!list.length) { host.innerHTML = '<p class="empty">Nothing to chase yet.</p>'; return; }

    const done = list.filter((m) => m.done);
    const togo = list.filter((m) => !m.done)
      .sort((a, b) => (b.progress / b.goal) - (a.progress / a.goal));
    $('msCount').textContent = `${done.length} of ${list.length} earned`;

    // Only the closest one is highlighted: a screen where everything is the
    // next thing has no next thing on it.
    host.innerHTML = [...togo, ...done].map((m, i) => {
      const pct = Math.min(100, Math.round((m.progress / m.goal) * 100));
      const next = !m.done && i === 0 && pct > 0;
      return `<div class="milestone${m.done ? ' done' : ''}${next ? ' next' : ''}">
        <div class="ms-top">
          <span class="ms-name">${escapeHtml(m.name)}</span>
          <span class="ms-reward">+${fmtNum(m.xp)} XP · +${fmtNum(m.gr)} ${K.CURRENCY}</span>
        </div>
        <div class="ms-desc">${escapeHtml(m.desc)}</div>
        <div class="ms-bar"><i style="width:${pct}%"></i></div>
        <div class="ms-prog">${m.done ? 'EARNED' : milestoneText(m)}</div>
      </div>`;
    }).join('');
  }

  /** One challenge card, drawn the same way whichever board it belongs to. */
  challengeCard(c) {
    const pct = Math.min(100, Math.round((c.progress / c.goal) * 100));
    return `<div class="challenge${c.done ? ' done' : ''}">
      <div class="ch-top">
        <span class="ch-name">${escapeHtml(c.name)}</span>
        <span class="ch-reward">+${fmtNum(c.xp)} XP · +${fmtNum(c.gr)} ${K.CURRENCY}</span>
      </div>
      <div class="ch-desc">${escapeHtml(c.desc)}</div>
      <div class="ch-bar"><i style="width:${pct}%"></i></div>
      <div class="ch-prog">${c.done ? 'COMPLETE' : `${fmtNum(c.progress)} / ${fmtNum(c.goal)}`}</div>
    </div>`;
  }

  async buildProgress() {
    const chList = $('challengeList');
    const wkList = $('weeklyList');
    const msList = $('milestoneList');
    const mList = $('masteryList');
    if (!api.isAuthed) {
      chList.innerHTML = '<p class="empty">Sign in to track challenges, career milestones and weapon mastery.</p>';
      wkList.innerHTML = '';
      msList.innerHTML = '';
      mList.innerHTML = '';
      $('chReset').textContent = '';
      $('wkReset').textContent = '';
      $('msCount').textContent = '';
      return;
    }
    await api.refreshProgress();
    const ch = api.challenges;

    if (!ch?.items?.length) {
      chList.innerHTML = '<p class="empty">No challenges today.</p>';
    } else {
      $('chReset').textContent = `Resets in ${fmtDuration(ch.resetsIn)}`;
      chList.innerHTML = ch.items.map((c) => this.challengeCard(c)).join('');
    }

    // The week's three. Same card, colder ink — see the stylesheet.
    const wk = ch?.week;
    if (!wk?.items?.length) {
      wkList.innerHTML = '<p class="empty">No weekly challenges right now.</p>';
      $('wkReset').textContent = '';
    } else {
      $('wkReset').textContent = `Resets in ${fmtDuration(wk.resetsIn)} · Monday`;
      wkList.innerHTML = wk.items.map((c) => this.challengeCard(c)).join('');
    }

    this.renderMilestones(ch?.milestones ?? []);

    const weapons = [...new Set(CLASS_IDS.flatMap((id) => loadoutFor(id).map((w) => w)))];
    const seen = new Set();
    mList.innerHTML = weapons.filter((w) => {
      if (seen.has(w.id)) return false;
      seen.add(w.id);
      return true;
    }).map((w) => {
      const m = api.mastery?.[w.id] ?? { kills: 0, tier: 1, tierName: 'Recruit', progress: 0, toNext: 25, nextName: null };
      const tierDef = K.MASTERY_TIERS.find((t) => t.tier === m.tier) ?? K.MASTERY_TIERS[0];
      const hex = `#${tierDef.color.toString(16).padStart(6, '0')}`;
      return `<div class="mastery" style="color:${hex}">
        <div class="m-tier">${roman(m.tier)}</div>
        <div class="m-body">
          <div class="m-name"><b style="color:var(--text)">${escapeHtml(w.name)}</b><span>${escapeHtml(m.tierName ?? tierDef.name)}</span></div>
          <div class="m-bar"><i style="width:${Math.round((m.progress ?? 0) * 100)}%"></i></div>
          <div class="m-next">${fmtNum(m.kills)} kills${m.nextName ? ` · ${fmtNum(m.toNext)} to ${m.nextName}` : ' · maxed'}</div>
        </div>
      </div>`;
    }).join('');
  }

  /* ── Settings ──────────────────────────────────────────────────────────── */

  buildSettings() {
    const form = $('settingsForm');
    form.innerHTML = '';

    for (const group of SCHEMA) {
      const box = el('div', 'set-group', `<h4>${group.icon ? `${group.icon} ` : ''}${escapeHtml(group.group)}</h4>`);
      for (const item of group.items) {
        const row = el('div', 'set-row');
        row.appendChild(el('label', null,
          item.hint ? `${escapeHtml(item.label)}<span class="set-hint">${escapeHtml(item.hint)}</span>` : escapeHtml(item.label)));

        const right = el('div');
        let input;
        if (item.type === 'range') {
          input = el('input');
          input.type = 'range';
          input.min = item.min; input.max = item.max; input.step = item.step;
          input.value = settings[item.key];
          const val = el('span', 'set-val', item.fmt ? item.fmt(settings[item.key]) : settings[item.key]);
          val.title = 'Double-click to type a value';
          val.classList.add('editable');
          input.addEventListener('input', () => {
            const v = Number(input.value);
            setSetting(item.key, v);
            val.textContent = item.fmt ? item.fmt(v) : v;
            this.onSettingsChange?.(item.key);
          });
          // Double-clicking the number turns it into a field you can type into.
          // A slider is the wrong instrument for "1.37 exactly", and sensitivity
          // is the setting people most want to carry over from another game to
          // the digit rather than to the nearest notch they can drag.
          val.addEventListener('dblclick', () => this._editNumber(item, input, val));
          right.append(val, input);
        } else if (item.type === 'bool') {
          input = el('input');
          input.type = 'checkbox';
          input.checked = settings[item.key];
          input.addEventListener('change', () => {
            setSetting(item.key, input.checked);
            this.onSettingsChange?.(item.key);
          });
          right.appendChild(input);
        } else if (item.type === 'color') {
          input = el('input');
          input.type = 'color';
          input.value = settings[item.key];
          input.addEventListener('input', () => {
            setSetting(item.key, input.value);
            this.onSettingsChange?.(item.key);
          });
          right.appendChild(input);
        } else if (item.type === 'select') {
          input = el('select');
          const numeric = item.options.every((o) => typeof o === 'number');
          for (const o of item.options) {
            const label = item.fmt ? item.fmt(o) : String(o)[0].toUpperCase() + String(o).slice(1);
            const opt = el('option', null, escapeHtml(label));
            opt.value = String(o);
            if (String(settings[item.key]) === String(o)) opt.selected = true;
            input.appendChild(opt);
          }
          input.addEventListener('change', () => {
            setSetting(item.key, numeric ? Number(input.value) : input.value);
            this.onSettingsChange?.(item.key);
          });
          right.appendChild(input);
        }
        row.appendChild(right);
        box.appendChild(row);
      }
      form.appendChild(box);
    }

    const actions = el('div', 'set-group', '<h4>💾 Backup & sync</h4>');
    actions.appendChild(el('p', 'set-note',
      'Everything here is saved in this browser as you change it — no account needed. '
      + 'Signing in only copies it between devices.'));

    const row = el('div', 'set-actions');
    const exportBtn = el('button', 'btn-ghost', 'EXPORT TO FILE');
    exportBtn.addEventListener('click', () => this._exportSettings(exportBtn));
    const importBtn = el('button', 'btn-ghost', 'IMPORT FROM FILE');
    importBtn.addEventListener('click', () => this._importSettings());
    row.append(exportBtn, importBtn);

    const row2 = el('div', 'set-actions');
    const resetBtn = el('button', 'btn-ghost', 'RESET TO DEFAULTS');
    resetBtn.addEventListener('click', () => {
      resetSettings();
      this.buildSettings();
      this.onSettingsChange?.(null);
      sfx.ui();
    });
    const saveBtn = el('button', 'btn-ghost', 'SYNC TO ACCOUNT');
    saveBtn.addEventListener('click', async () => {
      if (!api.isAuthed) return this.toastAuth('Sign in to sync settings across devices.');
      try {
        await api.saveLoadout({ classId: this.selectedClass, settings, keybinds: keys.binds });
        sfx.ui('ok');
        saveBtn.textContent = 'SYNCED ✓';
        setTimeout(() => { saveBtn.textContent = 'SYNC TO ACCOUNT'; }, 1600);
      } catch { sfx.ui('error'); }
    });
    row2.append(resetBtn, saveBtn);
    actions.append(row, row2);
    form.appendChild(actions);
  }

  /**
   * Types a number straight into a slider's readout.
   *
   * The field replaces the value in place and hands the row back the moment it
   * is committed or abandoned, so nothing about the panel's layout moves. Out
   * of range is clamped rather than refused: somebody asking for a sensitivity
   * of 40 gets the highest one there is, which is a more useful answer than a
   * red border.
   */
  _editNumber(item, input, val) {
    if (val.querySelector('input')) return;
    const field = el('input', 'set-num');
    field.type = 'number';
    field.min = item.min; field.max = item.max; field.step = item.step;
    field.value = String(settings[item.key]);
    const previous = val.textContent;
    val.textContent = '';
    val.appendChild(field);
    field.focus();
    field.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const raw = Number(field.value);
      field.remove();
      if (!commit || !Number.isFinite(raw)) {
        val.textContent = previous;
        return;
      }
      // Snap to the slider's own grid so the two always agree about the value.
      const step = Number(item.step) || 0.01;
      const clamped = Math.min(item.max, Math.max(item.min, raw));
      const snapped = Math.round(clamped / step) * step;
      // …and lose the floating-point tail that division leaves behind.
      const decimals = (String(item.step).split('.')[1] ?? '').length;
      const v = Number(snapped.toFixed(decimals));
      setSetting(item.key, v);
      input.value = String(v);
      val.textContent = item.fmt ? item.fmt(v) : v;
      this.onSettingsChange?.(item.key);
      sfx.ui('ok');
    };

    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    field.addEventListener('blur', () => finish(true));
  }

  /** Writes everything this browser holds — settings and bindings — to a file. */
  _exportSettings(btn) {
    try {
      const blob = new Blob([exportSettings(keys.binds)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `open-grunker-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      sfx.ui('ok');
      if (btn) {
        btn.textContent = 'EXPORTED ✓';
        setTimeout(() => { btn.textContent = 'EXPORT TO FILE'; }, 1600);
      }
    } catch {
      sfx.ui('error');
      this.notify('Could not write the file', 'error');
    }
  }

  /** …and reads one back, bindings included. */
  _importSettings() {
    const picker = el('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.style.display = 'none';
    document.body.appendChild(picker);
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      picker.remove();
      if (!file) return;
      let text = '';
      try { text = await file.text(); } catch { text = ''; }
      const res = importSettings(text);
      if (!res.ok) {
        sfx.ui('error');
        this.notify(res.error ?? 'That file could not be read', 'error');
        return;
      }
      if (res.keybinds) keys.apply(res.keybinds);
      this.buildSettings();
      this.buildBinds();
      this.onSettingsChange?.(null);
      this.onBindsChange?.();
      sfx.ui('ok');
      this.notify(`Imported ${res.applied} setting${res.applied === 1 ? '' : 's'}`, 'good');
    });
    picker.click();
  }

  /* ── Key bindings ──────────────────────────────────────────────────────── */

  buildBinds() {
    const host = $('bindList');
    host.innerHTML = '';
    let group = null;
    let box = null;

    for (const action of keys.ACTIONS) {
      if (action.group !== group) {
        group = action.group;
        box = el('div', 'bind-group', `<h4>${group}</h4>`);
        host.appendChild(box);
      }
      const row = el('div', 'bind-row');
      row.appendChild(el('label', null, action.label));
      const slots = el('div', 'bind-slots');
      for (let slot = 0; slot < keys.SLOTS; slot++) {
        const isPad = slot === keys.PAD_SLOT;
        const btn = el('button', `bind-key${isPad ? ' pad' : ''}`, keys.keyLabel(keys.binds[action.id][slot]));
        btn.type = 'button';
        btn.title = isPad ? 'Controller button · right-click to clear' : 'Right-click to clear';
        if (!keys.binds[action.id][slot]) btn.classList.add('empty');
        btn.addEventListener('click', () => this._captureBinding(action, slot, btn));
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          keys.clearBinding(action.id, slot);
          this.buildBinds();
        });
        slots.appendChild(btn);
      }
      row.appendChild(slots);
      box.appendChild(row);
    }

    if (!$('btnResetBinds').dataset.bound) {
      $('btnResetBinds').dataset.bound = '1';
      $('btnResetBinds').addEventListener('click', () => {
        keys.resetAll();
        this.buildBinds();
        sfx.ui();
      });
    }
    // The controller layout resets on its own: somebody rebinding a pad has no
    // reason to lose the keyboard scheme they have been using for a year.
    const padReset = $('btnResetPadBinds');
    if (padReset && !padReset.dataset.bound) {
      padReset.dataset.bound = '1';
      padReset.addEventListener('click', () => {
        keys.resetPad();
        this.buildBinds();
        sfx.ui();
      });
    }
  }

  _captureBinding(action, slot, btn) {
    if (this.capturing) return;
    const isPad = slot === keys.PAD_SLOT;
    this.capturing = true;
    btn.classList.add('listening');
    btn.textContent = isPad ? 'PRESS A BUTTON…' : 'PRESS A KEY…';
    sfx.ui();

    const finish = () => {
      this.capturing = false;
      this.input?.cancelCapture();
      this.buildBinds();
      if (api.isAuthed) api.saveLoadout({ classId: this.selectedClass, settings, keybinds: keys.binds }).catch(() => {});
    };

    const take = (code) => {
      if (code === null) sfx.ui();                            // cancelled
      else if (code === 'Delete' || code === 'Backspace') keys.clearBinding(action.id, slot);
      else if (!keys.bind(action.id, slot, code).ok) sfx.ui('error');
      finish();
    };

    if (isPad) {
      // Escape still cancels, so a pad slot is never a trap for somebody with
      // no controller plugged in.
      this.input?.capturePadBinding(take);
      this.input?.captureBinding((code) => { if (code === null) take(null); else take(code); });
    } else {
      this.input?.captureBinding(take);
    }
  }

  /* ── Help ──────────────────────────────────────────────────────────────── */

  buildHelp() {
    const kb = (id) => `<kbd>${keys.bindingLabel(id).split(' / ').join('</kbd><kbd>')}</kbd>`;
    const li = (html) => `<li>${html}</li>`;

    const move = $('helpMovement');
    if (move) {
      move.innerHTML = [
        li(`${kb('forward')}${kb('left')}${kb('back')}${kb('right')} Move`),
        li(`${kb('jump')} Jump — hold it and every landing chains into the next hop`),
        li(`${kb('crouch')} Slide — crouch at speed for a burst, then keep hopping`),
        li('Air-strafe: hold a strafe key and turn smoothly the same way to gain speed'),
      ].join('');
    }

    const combat = $('helpCombat');
    if (combat) {
      const pad = (id) => {
        const label = keys.padLabel(id);
        return label && label !== '—' ? `<kbd>${escapeHtml(label)}</kbd>` : '';
      };
      combat.innerHTML = [
        li(`${kb('fire')} Fire · ${kb('ads')} Aim / scope`),
        li(`${kb('reload')} Reload (ammo is unlimited) · ${kb('melee')} Quick melee`),
        li(`${kb('slot1')}${kb('slot2')}${kb('slot3')} Primary / sidearm / knife · ${kb('lastWeapon')} Last weapon`),
        li(`${kb('scoreboard')} Scoreboard · <kbd>ESC</kbd> Menu · ${kb('chat')} Chat`),
        li(`${kb('classMenu')} Change class · ${kb('toggleMinimap')} Minimap · ${kb('toggleFps')} FPS counter`),
        // The controller layout, from the same table the keyboard reads — so a
        // rebound button is right here too, and an unbound one draws nothing.
        li(`<b class="pts">PAD</b> Left stick moves, right stick looks · `
          + `${pad('fire')} Fire · ${pad('ads')} Aim · ${pad('jump')} Jump · ${pad('crouch')} Slide`),
        li(`<b class="pts">PAD</b> <kbd>START</kbd> Menu · ${pad('scoreboard')} Scoreboard · `
          + `${pad('reload')} Reload · ${pad('melee')} Melee · ${pad('classMenu')} Class`),
        li('In the menu a pad moves the highlight with the stick or the d-pad, '
          + '<kbd>A</kbd> presses and <kbd>B</kbd> goes back. Every button is rebindable '
          + 'under CONTROLS, in the third column.'),
      ].join('');
    }

    const modes = $('helpModes');
    if (modes) {
      modes.innerHTML = Object.values(K.MODES)
        .map((m) => li(`<b class="pts">${escapeHtml(m.short ?? m.id.toUpperCase())}</b> ${escapeHtml(m.name)} — ${escapeHtml(m.blurb ?? '')}`))
        .join('');
    }

    const scoring = $('helpScoring');
    if (scoring) {
      scoring.innerHTML = SCORING_HELP
        .map(([key, note]) => li(`<b class="pts">+${K.SCORE[key]}</b> ${K.SCORE_LABELS[key]} — ${note}`))
        .join('') + li(`<b class="pts">${K.GR_PER_SCORE}</b> points earn <b class="pts">1 GR</b> when the match ends`);
    }
  }

  /* ── Server rules ──────────────────────────────────────────────────────── */

  /**
   * Anti-bot keys, the rename price and the mail policy all live on the
   * server. Fetching them once here means none of it is hard-coded twice.
   */
  async loadMeta() {
    try {
      this.meta = await api.meta();
    } catch {
      this.meta = null;
      return;
    }
    $('renameCost').textContent = this.meta.renameCost ?? K.RENAME_COST;
    this.applyAvatarPolicy(this.meta.avatars);
    this.applyClanRules(this.meta.clans);
    const label = $('authForm').querySelector('.reg-only small');
    if (label) {
      label.textContent = this.meta.emailVerification?.required
        ? '(you have to confirm it before you can play)'
        : '(optional, for recovery)';
    }
    this.syncAuthMode();
  }

  /**
   * Brings the sign-in modal in line with the tab that is showing.
   *
   * `required` has to follow visibility: a hidden required field makes the
   * browser refuse to submit the form and then try to focus something nobody
   * can see, which looks exactly like a dead button.
   */
  /**
   * The list of what registering pays, drawn from the shared constants.
   *
   * The button in the top bar has said "GET SIGNUP REWARDS" since the first
   * release and opened a form that promised nothing. This is the other half of
   * that sentence, and it is built from the same object the server grants from
   * — so the card cannot advertise a number the account does not receive.
   */
  buildSignupRewards() {
    const host = $('authRewards');
    if (!host) return;
    host.innerHTML = (K.SIGNUP_REWARD.lines ?? []).map((l) => `
      <li><i>${escapeHtml(l.icon)}</i><b>${escapeHtml(l.title)}</b><span>${escapeHtml(l.desc)}</span></li>`).join('');
  }

  syncAuthMode() {
    const register = this.authMode === 'register';
    this.buildSignupRewards();
    for (const n of document.querySelectorAll('.reg-only')) n.classList.toggle('hidden', !register);
    for (const n of document.querySelectorAll('.login-only')) n.classList.toggle('hidden', register);
    $('authSubmit').textContent = register ? 'CREATE ACCOUNT' : 'SIGN IN';
    $('authForm').querySelector('input[name=email]').required =
      register && !!this.meta?.emailVerification?.required;
    // Switching tabs puts the second question away again: it belongs to one
    // sign-in attempt, and asking a *new* account for a code it does not have
    // would be nonsense.
    this.askForCode(false);
    this.mountTurnstile(this.authMode);
  }

  /**
   * Shows or hides the sign-in form's second-factor field.
   *
   * It only ever appears because the server asked for it, which it only does
   * once the password is already right — so the form never reveals which
   * accounts have two-factor on to somebody guessing passwords at it.
   */
  askForCode(on) {
    const row = $('authCodeRow');
    if (!row) return;
    row.classList.toggle('hidden', !on);
    const input = row.querySelector('input');
    if (input) {
      input.required = !!on;
      if (!on) input.value = '';
      else setTimeout(() => input.focus(), 0);
    }
  }

  /* ── Cloudflare Turnstile ──────────────────────────────────────────────── */

  /**
   * Renders one form's widget, once its container is actually on screen.
   *
   * Explicit rendering rather than Cloudflare's class scan, for two reasons:
   * the modal starts hidden, and a token is single-use — a refused submit has
   * to reset its widget by hand or the next attempt replays a spent token.
   */
  mountTurnstile(form, attempt = 0) {
    const sitekey = this.meta?.turnstile?.[form];
    if (!sitekey || this.widgets[form] !== null) return;

    const host = $(form === 'register' ? 'tsRegister' : 'tsLogin');
    // Rendering into a hidden container is unreliable, and the modal starts
    // closed — so this waits for the widget to actually be on screen.
    if (!host || !host.offsetParent) return;

    if (!window.turnstile) {
      // The script is async; give it a few beats before giving up quietly.
      if (attempt < 40) setTimeout(() => this.mountTurnstile(form, attempt + 1), 250);
      return;
    }
    try {
      this.widgets[form] = window.turnstile.render(host, {
        sitekey,
        theme: 'dark',
        action: form,
        'error-callback': () => { $('authSubmit').disabled = false; },
      });
    } catch { /* a duplicate render; the existing widget is still good */ }
  }

  /** The solved token for a form, or '' when that form is not protected. */
  turnstileToken(form) {
    const id = this.widgets[form];
    if (id === null || !window.turnstile) return '';
    try { return window.turnstile.getResponse(id) || ''; } catch { return ''; }
  }

  /** Throws away a spent token so the next attempt gets a fresh one. */
  resetTurnstile(form = null) {
    if (!window.turnstile) return;
    for (const f of form ? [form] : ['register', 'login']) {
      if (this.widgets[f] === null) continue;
      try { window.turnstile.reset(this.widgets[f]); } catch { /* not rendered yet */ }
    }
  }

  /** Is this form challenged, and is the challenge still unsolved? */
  challengePending(form) {
    return this.widgets[form] !== null && !this.turnstileToken(form);
  }

  /* ── Account ───────────────────────────────────────────────────────────── */

  _bindAuth() {
    const modal = $('authModal');
    const open = (mode = null) => {
      if (mode) {
        const tab = document.querySelector(`.auth-tabs button[data-auth="${mode}"]`);
        if (tab && this.authMode !== mode) tab.click();
      }
      modal.classList.remove('hidden');
      $('authError').classList.add('hidden');
      // The widget can only be rendered now that its container has a box.
      this.syncAuthMode();
      modal.querySelector('input[name=username]').focus();
    };
    this.openAuth = open;

    // The account chip is the only way in and out of an account now: the
    // "signed in as…" line under the old nickname box said the same thing.
    $('accountChip').addEventListener('click', () => {
      if (api.isAuthed) this.openTab('profile');
      else open();
    });
    $('btnProfileSignIn').addEventListener('click', open);
    $('authClose').addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

    for (const b of document.querySelectorAll('.auth-tabs button')) {
      b.addEventListener('click', () => {
        this.authMode = b.dataset.auth;
        for (const o of document.querySelectorAll('.auth-tabs button')) o.classList.toggle('active', o === b);
        $('authError').classList.add('hidden');
        this.syncAuthMode();
        // The widget for the form being left keeps a token nobody will spend.
        this.resetTurnstile(this.authMode === 'login' ? 'register' : 'login');
      });
    }

    $('authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const username = String(fd.get('username') ?? '').trim();
      const password = String(fd.get('password') ?? '');
      const email = String(fd.get('email') ?? '').trim();
      const mode = this.authMode;
      const err = $('authError');
      const btn = $('authSubmit');

      const showError = (message) => {
        err.textContent = message;
        err.classList.remove('hidden');
        sfx.ui('error');
      };

      // A widget that never rendered is almost always a blocked script, and
      // "complete the check" is unhelpful advice about a box nobody can see.
      if (this.meta?.turnstile?.[mode] && this.widgets[mode] === null) {
        showError('The anti-bot check could not load. Reload the page, and allow '
          + 'challenges.cloudflare.com if you block scripts.');
        this.mountTurnstile(mode);
        return;
      }
      if (this.challengePending(mode)) {
        showError('Complete the anti-bot check first.');
        return;
      }

      err.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'PLEASE WAIT…';
      try {
        const captcha = this.turnstileToken(mode);
        if (mode === 'register') {
          const { verification, reward, mailError } = await api.register(username, password, email, captcha);
          // The grant lands before anything else is said: it is the reason the
          // button in the top bar says what it says, and a balance that appears
          // with no explanation is a balance nobody trusts.
          if (reward?.gr > 0) {
            sfx.unlock();
            this.notify(`Welcome — ${reward.gr} ${K.CURRENCY} and the Enlisted finish are yours.`, 'good');
          }
          if (mailError) this.notify(mailError, 'error');
          else if (verification?.sent) {
            this.notify(`Check ${email} — confirm the link before you can play.`, '');
          } else if (verification?.required && !verification.verified) {
            // Mail is not wired up on this server yet; saying "check your
            // inbox" would send the player looking for something that is not
            // coming.
            this.notify('Account created. Address confirmation is not switched on yet.', '');
          }
        } else {
          await api.login(username, password, captcha, String(fd.get('code') ?? '').trim());
        }
        modal.classList.add('hidden');
        this.askForCode(false);
        e.target.reset();
        this.resetTurnstile();
        this.refreshAccount();
        sfx.ui('ok');
      } catch (ex) {
        // Every token is single-use, and a refused attempt has spent one.
        this.resetTurnstile(mode);
        // Not a failure: the password was right and the server is asking the
        // second question. The form grows a field rather than starting over.
        if (ex.code === 'totp_required') {
          this.askForCode(true);
          showError('Enter the six-digit code from your authenticator app.');
        } else {
          if (ex.code === 'totp_invalid') this.askForCode(true);
          showError(ex.message || 'Something went wrong.');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = mode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT';
      }
    });
  }

  /* ── Email verification ────────────────────────────────────────────────── */

  /**
   * A confirmation link opens the game with `?verify=…`. Spend it, tell the
   * player what happened, and take the token out of the address bar so a
   * reload does not try to spend it twice.
   */
  async consumeVerifyLink() {
    let url;
    // An address that will not parse is not a reason to fail to build the menu:
    // this runs from the constructor, and its rejection has nowhere to go.
    try { url = new URL(window.location.href); } catch { return; }
    const token = url.searchParams.get('verify');
    if (!token) return;
    url.searchParams.delete('verify');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);

    try {
      const r = await api.verifyEmail(token);
      this.notify(`${r.username}, your address is confirmed — you can play.`, 'good');
      sfx.ui('ok');
      await this.refreshAccount();
    } catch (ex) {
      this.notify(ex.message || 'That confirmation link did not work.', 'error');
      // A dead link is worth acting on immediately: sign in and resend.
      if (!api.isAuthed) this.openAuth('login');
      else this.openTab('profile');
    }
  }

  /** Paints the address block in the profile panel. */
  renderEmailState(user) {
    const state = api.verification;
    const addr = $('emailAddr');
    const badge = $('emailBadge');
    addr.textContent = user.email || 'no address on file';
    const verified = !!state?.verified || !!user.emailVerified;
    badge.textContent = verified ? 'CONFIRMED' : 'UNCONFIRMED';
    badge.classList.toggle('good', verified);
    badge.classList.toggle('bad', !verified);
    $('btnResendVerify').classList.toggle('hidden', verified || !user.email);
    $('emailForm').querySelector('input[name=email]').placeholder = user.email || 'you@example.com';

    // The same fact, on the overview card that opens first.
    const ovAddr = $('ovEmail');
    const ovBadge = $('ovEmailBadge');
    if (ovAddr) ovAddr.textContent = user.email || 'none on file';
    if (ovBadge) {
      ovBadge.textContent = verified ? 'CONFIRMED' : 'UNCONFIRMED';
      ovBadge.classList.toggle('good', verified);
      ovBadge.classList.toggle('bad', !verified);
    }
  }

  _bindProfile() {
    $('btnSignOut').addEventListener('click', async () => {
      await api.logout();
      sfx.ui();
      this.refreshAccount();
      this.openTab('classes');
    });

    // ── Paid rename ──
    $('nameForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const wanted = String(new FormData(e.target).get('username') ?? '').trim();
      const msg = $('nameMsg');
      const cost = this.meta?.renameCost ?? K.RENAME_COST;
      msg.className = 'form-msg';
      msg.classList.remove('hidden');

      const restyle = wanted.toLowerCase() === (api.account?.username ?? '').toLowerCase();
      if (!restyle && (api.account?.gr ?? 0) < cost) {
        msg.textContent = `A new name costs ${cost} GR — you have ${api.account?.gr ?? 0}.`;
        msg.classList.add('bad');
        sfx.ui('error');
        return;
      }
      // Spending GR is not something to do on a mis-click.
      if (!restyle && !confirm(`Change your nickname to "${wanted}" for ${cost} GR?`)) {
        msg.classList.add('hidden');
        return;
      }

      try {
        const r = await api.changeUsername(wanted);
        msg.textContent = r.spent
          ? `You are now ${r.user.username}. ${r.spent} GR spent, ${r.gr} left.`
          : `You are now ${r.user.username} — a change of spelling is free.`;
        e.target.reset();
        sfx.ui('ok');
        this.refreshAccount();
      } catch (ex) {
        msg.textContent = ex.message || 'Could not change your nickname.';
        msg.classList.add('bad');
        sfx.ui('error');
      }
    });

    // ── Address: correct it, or ask for another link ──
    $('emailForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const msg = $('emailMsg');
      msg.className = 'form-msg';
      msg.classList.remove('hidden');
      try {
        const r = await api.changeEmail(String(fd.get('email') ?? '').trim(), String(fd.get('password') ?? ''));
        msg.textContent = r.sent
          ? `Confirmation link sent to ${r.email}.`
          : `Saved ${r.email}. This server is not sending mail yet, so nothing will arrive.`;
        e.target.reset();
        sfx.ui('ok');
        this.refreshAccount();
      } catch (ex) {
        msg.textContent = ex.message || 'Could not save that address.';
        msg.classList.add('bad');
        sfx.ui('error');
      }
    });

    $('btnResendVerify').addEventListener('click', async () => {
      const msg = $('emailMsg');
      msg.className = 'form-msg';
      msg.classList.remove('hidden');
      msg.textContent = 'Sending…';
      try {
        const r = await api.resendVerification();
        msg.textContent = r.sent
          ? `New link sent to ${r.email}.`
          : 'A new link was issued, but this server is not sending mail yet — ask the operator.';
        sfx.ui('ok');
      } catch (ex) {
        msg.textContent = ex.message || 'Could not send the link.';
        msg.classList.add('bad');
        sfx.ui('error');
      }
    });

    $('passwordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const msg = $('passwordMsg');
      msg.className = 'form-msg';
      try {
        await api.changePassword(String(fd.get('current')), String(fd.get('next')),
          String(fd.get('code') ?? '').trim());
        msg.textContent = 'Password changed — signing you back in is required.';
        e.target.reset();
        sfx.ui('ok');
        setTimeout(() => this.refreshAccount(), 900);
      } catch (ex) {
        // The account has a second factor and this form did not ask for it yet.
        if (ex.code === 'totp_required') $('pwCodeRow')?.classList.remove('hidden');
        msg.textContent = ex.message || 'Could not change the password.';
        msg.classList.add('bad');
        sfx.ui('error');
      }
    });

    this._bindTwoFactor();
  }

  /* ── Two-factor authentication ─────────────────────────────────────────────
     Three states, one at a time: off (with the way in), setting up (the QR and
     the first code), and on (recovery codes, and the way back out). The panel
     never shows two of them at once, because "which of these am I looking at"
     is the one question a security screen must not raise.
     ──────────────────────────────────────────────────────────────────────── */

  _bindTwoFactor() {
    if (!$('tfaPanel')) return;
    /** The secret drawn from `/setup`, held only until it is confirmed. */
    this.tfaSecret = null;
    /** What the confirm form is confirming: 'disable' or 'recovery'. */
    this.tfaConfirming = null;

    $('btnTfaStart').addEventListener('click', () => this.startTwoFactor());
    $('btnTfaCancel').addEventListener('click', () => {
      this.tfaSecret = null;
      sfx.ui();
      this.renderTwoFactor();
    });

    $('btnTfaCopy').addEventListener('click', () => this.copyText(this.tfaSecret, 'Setup key copied'));
    $('btnTfaCopyCodes').addEventListener('click', () => this.copyText(
      [...$('tfaCodeList').querySelectorAll('li')].map((li) => li.textContent).join('\n'),
      'Recovery codes copied'));
    $('btnTfaCodesDone').addEventListener('click', () => {
      $('tfaCodes').classList.add('hidden');
      $('tfaCodeList').textContent = '';
      sfx.ui();
      this.renderTwoFactor();
    });

    $('tfaEnableForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const msg = $('tfaMsg');
      msg.className = 'form-msg';
      try {
        const codes = await api.totpEnable(this.tfaSecret,
          String(fd.get('code') ?? '').trim(), String(fd.get('password') ?? ''));
        this.tfaSecret = null;
        e.target.reset();
        sfx.unlock();
        this.notify('Two-factor is on. Save your recovery codes.', 'good');
        this.showRecoveryCodes(codes);
        this.refreshAccount();
      } catch (ex) {
        msg.textContent = ex.message || 'Could not switch it on.';
        msg.classList.add('bad');
        sfx.ui('error');
      }
    });

    $('btnTfaOff').addEventListener('click', () => this.askTwoFactorConfirm('disable'));
    $('btnTfaNewCodes').addEventListener('click', () => this.askTwoFactorConfirm('recovery'));
    $('btnTfaConfirmCancel').addEventListener('click', () => {
      this.tfaConfirming = null;
      sfx.ui();
      this.renderTwoFactor();
    });

    $('tfaConfirmForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const password = String(fd.get('password') ?? '');
      const code = String(fd.get('code') ?? '').trim();
      const msg = $('tfaConfirmMsg');
      msg.className = 'form-msg';
      const what = this.tfaConfirming;
      try {
        if (what === 'disable') {
          await api.totpDisable(password, code);
          this.tfaConfirming = null;
          e.target.reset();
          this.notify('Two-factor is off. Your password is all that guards this account now.', '');
          sfx.ui('ok');
          this.refreshAccount();
          this.renderTwoFactor();
        } else {
          const codes = await api.totpRecovery(password, code);
          this.tfaConfirming = null;
          e.target.reset();
          this.notify('New recovery codes. The old ones no longer work.', 'good');
          sfx.ui('ok');
          this.showRecoveryCodes(codes);
        }
      } catch (ex) {
        msg.textContent = ex.message || 'That did not work.';
        msg.classList.add('bad');
        sfx.ui('error');
      }
    });
  }

  /** Draws the secret and its QR code, without committing to anything. */
  async startTwoFactor() {
    const setup = $('tfaSetup');
    try {
      const r = await api.totpSetup();
      this.tfaSecret = r.secret;
      $('tfaSecret').textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
      // Rendered here rather than fetched: a QR code of *this* secret requested
      // from somebody else's server would hand them the secret.
      const { qrSvg } = await import('./qr.js');
      $('tfaQr').innerHTML = qrSvg(r.uri);
      $('tfaMsg').className = 'form-msg hidden';
      $('tfaEnableForm').reset();
      this.renderTwoFactor();
      setup.querySelector('input[name=code]')?.focus();
      sfx.ui();
    } catch (ex) {
      this.notify(ex.message || 'Could not start the setup.', 'error');
      sfx.ui('error');
    }
  }

  /** The password-and-code gate in front of turning it off or reissuing codes. */
  askTwoFactorConfirm(what) {
    this.tfaConfirming = what;
    const form = $('tfaConfirmForm');
    form.classList.remove('hidden');
    $('tfaConfirmMsg').className = 'form-msg hidden';
    $('tfaConfirmWhy').textContent = what === 'disable'
      ? 'Turning it off leaves your password as the only thing guarding this account.'
      : 'The codes you have now will stop working the moment the new ones appear.';
    $('tfaConfirmGo').textContent = what === 'disable' ? 'TURN IT OFF' : 'ISSUE NEW CODES';
    form.querySelector('input[name=password]')?.focus();
    sfx.ui();
  }

  /** The one and only time a set of recovery codes is ever on screen. */
  showRecoveryCodes(codes = []) {
    const list = $('tfaCodeList');
    list.textContent = '';
    for (const c of codes) {
      const li = document.createElement('li');
      li.textContent = c;                      // never innerHTML: this is a secret
      list.appendChild(li);
    }
    $('tfaCodes').classList.toggle('hidden', !codes.length);
    $('tfaConfirmForm').classList.add('hidden');
    this.renderTwoFactor();
  }

  /** Clipboard, with the one fallback that still works without permission. */
  async copyText(text, said) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.notify(said, 'good');
    } catch {
      // A clipboard the page is not allowed to touch is not an error worth a
      // red banner — a selection the player can copy themselves is the answer.
      const box = document.createElement('textarea');
      box.value = text;
      box.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand?.('copy');
      box.remove();
      this.notify(ok ? said : 'Select the text and copy it by hand.', ok ? 'good' : '');
    }
    sfx.ui();
  }

  /**
   * Puts the panel into whichever of its three states the account is in.
   *
   * `tfaSecret` set means a setup is half-done and the QR is on screen; past
   * that, the account itself is the only source of truth about whether the
   * second factor is on.
   */
  async renderTwoFactor() {
    if (!$('tfaPanel')) return;
    const setting = !!this.tfaSecret;
    const on = !!api.account?.totp?.enabled;

    $('tfaOff').classList.toggle('hidden', setting || on);
    $('tfaSetup').classList.toggle('hidden', !setting);
    $('tfaOn').classList.toggle('hidden', setting || !on);
    if (!on) {
      $('tfaConfirmForm').classList.add('hidden');
      this.tfaConfirming = null;
    }
    // The password form asks for a code only when there is one to ask for.
    $('pwCodeRow')?.classList.toggle('hidden', !on);

    const badge = $('tfaBadge');
    badge.textContent = on ? 'ON' : setting ? 'SETTING UP' : 'OFF';
    badge.classList.toggle('good', on);
    $('tfaState').textContent = on
      ? 'Signing in asks for a code from your authenticator app.'
      : setting
        ? 'Scan the code, then confirm with the six digits it shows.'
        : 'Your password is the only thing guarding this account.';

    if (!on) return;
    // How many codes are left is the one thing the account payload does not
    // carry, and the one number worth warning about.
    try {
      const state = await api.totpState();
      const left = state.recoveryLeft ?? 0;
      $('tfaRecoveryNote').textContent = left === 0
        ? 'You have no recovery codes left. Issue a new set before you lose the phone.'
        : `${left} unused recovery code${left === 1 ? '' : 's'}. Each one signs you in once, without the app.`;
    } catch {
      $('tfaRecoveryNote').textContent = 'Recovery codes sign you in once each, without the app.';
    }
  }

  /* ── Account sub-navigation ────────────────────────────────────────────── */

  /**
   * Five views behind one row of buttons.
   *
   * The account panel used to be a single column with three forms stacked at
   * the bottom of it, which meant everything past your stats was a scroll away
   * and nothing was findable. Each view is now one click and one screen.
   */
  _bindAccountNav() {
    for (const tab of document.querySelectorAll('.acct-tab')) {
      tab.addEventListener('click', () => { sfx.ui(); this.openAccountView(tab.dataset.acct); });
    }
  }

  openAccountView(name) {
    for (const tab of document.querySelectorAll('.acct-tab')) {
      tab.classList.toggle('active', tab.dataset.acct === name);
    }
    for (const view of document.querySelectorAll('.acct-view')) {
      view.classList.toggle('active', view.dataset.acctView === name);
    }
    // Only fetched when it is actually looked at.
    if (name === 'reports') this.loadReports();
    if (name === 'matches' && api.account) this.loadMatches(api.account.username);
    if (name === 'progression') this.renderProgression(api.account);
  }

  /* ── Progression ───────────────────────────────────────────────────────── */

  /**
   * The ladder: what each level is worth, and where this account stands on it.
   *
   * The steps come from the server, so they are this server's thresholds rather
   * than the defaults — an operator who raised the report level in .env has
   * raised it here too. Everything already earned is struck through and dimmed;
   * the next thing waiting is the one row that says how much XP is left, which
   * is the only number on this screen a player can act on.
   */
  renderProgression(user) {
    const host = $('progList');
    if (!host) return;
    if (!user) {
      host.innerHTML = '<li class="empty">Sign in to see how far along you are.</li>';
      return;
    }

    const level = user.level ?? 1;
    const span = Math.max(1, (user.nextLevelXp ?? 0) - (user.levelXp ?? 0));
    const into = Math.max(0, (user.xp ?? 0) - (user.levelXp ?? 0));
    const pct = Math.max(0, Math.min(100, (into / span) * 100));
    $('progLevel').textContent = level;
    $('progXpFill').style.width = `${pct}%`;
    $('progXpText').textContent = `${fmtNum(into)} / ${fmtNum(span)} XP`;
    $('progXpLeft').textContent = `${fmtNum(Math.max(0, span - into))} to level ${level + 1}`;
    $('progNote').textContent =
      `XP is your match score, one for one — a ${fmtNum(3204)}-point match pays ${fmtNum(3204)} XP.`;

    this.renderStreak(user.streak);

    const steps = this.meta?.progression
      ?? K.progressionLadder({ reportLevel: this.meta?.reports?.minLevel });
    // The first thing still ahead: only that one carries the "how far" line.
    const nextUp = steps.find((step) => step.level > level)?.level ?? null;

    host.innerHTML = steps.map((step) => {
      const done = level >= step.level;
      const next = step.level === nextUp;
      const need = Math.max(0, K.xpForLevel(step.level) - (user.xp ?? 0));
      return `<li class="prog-step${done ? ' done' : ''}${next ? ' next' : ''}">
        <span class="ps-lv"><small>LV</small><b>${step.level}</b></span>
        <span class="ps-body">
          <b>${escapeHtml(step.title)}</b>
          <small>${escapeHtml(step.desc)}</small>
        </span>
        <span class="ps-mark">${done
    ? '<span class="ps-done">UNLOCKED</span>'
    : `<span class="ps-need">${fmtNum(need)} XP</span>`}</span>
      </li>`;
    }).join('');
  }

  /**
   * The daily streak card.
   *
   * Seven pips, one per day up to where the reward stops climbing, plus the two
   * bonuses waiting today. It draws even at zero, because the whole job of this
   * card is to be seen by somebody who has not started one yet.
   */
  renderStreak(streak) {
    const host = $('streakCard');
    if (!host) return;
    const days = streak?.days ?? 0;
    const done = !!streak?.todayDone;
    const next = streak?.next ?? K.streakReward(days + 1);

    host.classList.toggle('lit', days > 0);
    host.classList.toggle('claimed', done);
    $('skDays').textContent = K.streakLabel(days);
    $('skNote').textContent = done
      ? 'Claimed for today — come back tomorrow to keep it alive.'
      : days > 0
        ? 'Finish a match today to keep it going.'
        : 'Finish a match today to start one.';
    $('skBest').textContent = (streak?.best ?? 0) > 1 ? `BEST ${streak.best}` : '';

    const cap = K.STREAK_CAP_DAYS;
    // Past the cap the run keeps counting but the pips stop moving, so the last
    // one is drawn as "at least this far" rather than resetting the row.
    const filled = Math.min(days, cap);
    $('skPips').innerHTML = Array.from({ length: cap }, (_, i) => {
      const on = i < filled;
      const isNext = !done && i === filled;
      return `<li class="sk-pip${on ? ' on' : ''}${isNext ? ' next' : ''}"><i></i><small>${i + 1}</small></li>`;
    }).join('');

    $('skToday').innerHTML = done
      ? '<s>Today</s> claimed'
      : `Today · <b>+${fmtNum(next.gr)} GR</b> · <b>+${fmtNum(next.xp)} XP</b>`;
    const fw = streak?.firstWin ?? K.FIRST_WIN_BONUS;
    $('skWin').innerHTML = streak?.firstWinDone
      ? '<s>First win</s> claimed'
      : `First win · <b>+${fmtNum(fw.gr)} GR</b> · <b>+${fmtNum(fw.xp)} XP</b>`;
  }

  /* ── Profile picture ───────────────────────────────────────────────────── */

  /**
   * The picker says what this server will actually take.
   *
   * Hard-coding the numbers here would let the panel promise something an
   * operator has since turned down in .env — and the refusal would arrive only
   * after the player had picked a file.
   */
  applyAvatarPolicy(policy) {
    const editor = document.querySelector('.avatar-editor');
    if (!editor) return;
    const on = policy?.enabled !== false;
    editor.classList.toggle('hidden', !on);
    $('phAvatar').disabled = !on;
    if (!on || !policy) return;
    $('avatarLimits').textContent =
      `Any PNG, JPEG or WebP. It is cropped to a circle and shrunk to `
      + `${policy.size}×${policy.size} in your browser before it is uploaded, so a `
      + `normal picture lands around 20 KB. The server takes at most `
      + `${Math.floor(policy.maxBytes / 1024)} KB and ${policy.maxDimension}×${policy.maxDimension}.`;
  }

  _bindAvatar() {
    const input = $('avatarInput');
    if (!input) return;
    const pick = () => { sfx.ui(); input.click(); };
    $('btnAvatarPick').addEventListener('click', pick);
    // The hero picture is its own edit button: clicking what you want to change
    // is a shorter path than finding the control that changes it.
    $('phAvatar').addEventListener('click', () => {
      this.openAccountView('identity');
      pick();
    });

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';                       // so the same file can be picked twice
      if (file) await this.uploadAvatar(file);
    });

    $('btnAvatarRemove').addEventListener('click', async () => {
      const msg = $('avatarMsg');
      msg.className = 'form-msg';
      if (!api.account?.avatar) {
        msg.textContent = 'You do not have a picture to remove.';
        msg.classList.remove('hidden');
        return;
      }
      if (!confirm('Remove your profile picture?')) return;
      try {
        await api.removeAvatar();
        msg.textContent = 'Picture removed — you are back to your initials.';
        msg.classList.remove('hidden');
        sfx.ui('ok');
        this.paintAvatars(api.account);
      } catch (ex) {
        msg.textContent = ex.message || 'Could not remove the picture.';
        msg.classList.add('bad');
        msg.classList.remove('hidden');
        sfx.ui('error');
      }
    });
  }

  /** Squares, shrinks and uploads a picked file, then repaints every frame. */
  async uploadAvatar(file) {
    const msg = $('avatarMsg');
    const btn = $('btnAvatarPick');
    msg.className = 'form-msg';
    msg.classList.remove('hidden');
    msg.textContent = 'Preparing…';
    btn.disabled = true;
    try {
      const blob = await squareAvatar(file);
      const r = await api.uploadAvatar(blob);
      msg.textContent = `Picture updated — ${Math.max(1, Math.round((r.bytes ?? blob.size) / 1024))} KB stored.`;
      sfx.ui('ok');
      this.paintAvatars(api.account);
    } catch (ex) {
      msg.textContent = ex.message || 'Could not upload that picture.';
      msg.classList.add('bad');
      sfx.ui('error');
    } finally {
      btn.disabled = false;
    }
  }

  /** Every frame that draws this account: header chip, hero, picker preview. */
  paintAvatars(user) {
    const name = user?.username ?? this.assignedName ?? 'Guest';
    const url = user?.avatar ?? null;
    paintAvatar($('acAvatar'), url, name);
    paintAvatar($('phAvatar'), url, name);
    paintAvatar($('avatarPreview'), url, name);
    $('btnAvatarRemove')?.classList.toggle('hidden', !url);
  }

  /* ── Reports ───────────────────────────────────────────────────────────── */

  /**
   * What became of every report this account filed.
   *
   * A verdict is the entire point of showing this: a report that disappears
   * into a queue and is never spoken of again is a report nobody bothers to
   * file a second time, and a moderation queue nobody files into is worthless.
   */
  async loadReports() {
    const host = $('reportList');
    if (!host) return;
    host.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const { reports = [], standing } = await api.myReports();
      const open = reports.filter((rep) => rep.status === 'open').length;
      this.setReportBadge(open, reports.length);

      // Where this account stands right now, not a recital of the rules. The
      // route hands back the same standing the game socket checks before it
      // writes a row, so this line and the greyed scoreboard button never
      // disagree about why the button is off.
      $('reportQuota').textContent = !standing
        ? 'Report a player from the scoreboard, mid-match.'
        : standing.allowed
          ? `You can report — up to ${standing.limits?.maxPerHour ?? 6} an hour, `
            + `${standing.hour ?? 0} filed in the last hour.`
          : standing.reason ?? 'You cannot report right now.';
      $('reportQuota').classList.toggle('bad', !!standing && !standing.allowed);

      if (!reports.length) {
        host.innerHTML = '<p class="empty">You have not reported anybody. '
          + 'Hold the scoreboard key in a match and use the REPORT button on their row.</p>';
        return;
      }

      host.innerHTML = reports.map((rep) => `
        <div class="report-row ${escapeHtml(rep.status)}">
          <div class="rr-head">
            <span class="rr-target">${escapeHtml(rep.target)}</span>
            <span class="rr-reason">${escapeHtml(rep.reasonLabel ?? rep.reason)}</span>
            <span class="rr-when">${fmtAgo(rep.at)}</span>
            <span class="rr-status">${escapeHtml(rep.statusLabel ?? rep.status)}</span>
          </div>
          ${rep.detail ? `<div class="rr-detail">“${escapeHtml(rep.detail)}”</div>` : ''}
          <div class="rr-foot">
            <span class="rr-where">${escapeHtml([rep.mode?.toUpperCase(), rep.map, rep.room].filter(Boolean).join(' · '))}</span>
            ${rep.status === 'open'
              ? '<span class="rr-outcome pending">Waiting on a moderator</span>'
              : `<span class="rr-outcome">${escapeHtml(rep.outcome ?? rep.actionLabel ?? 'Closed')}</span>`}
          </div>
        </div>`).join('');
    } catch (ex) {
      host.innerHTML = `<p class="empty">${escapeHtml(ex.message || 'Your reports are unavailable right now.')}</p>`;
    }
  }

  /** The count on the REPORTS sub-tab: how many are still being looked at. */
  setReportBadge(open, total = open) {
    const badgeEl = $('acctReportBadge');
    if (badgeEl) {
      badgeEl.textContent = String(open);
      badgeEl.classList.toggle('hidden', !open);
    }
    if ($('ovReports')) $('ovReports').textContent = String(total);
    if ($('ovReportsNote')) {
      $('ovReportsNote').textContent = open
        ? `${open} still under review`
        : (total ? 'All settled' : 'None yet');
    }
  }

  /** The clan tag on the account chip, from whatever the account last said. */
  setChipClan(clan, verified = false) {
    const el = $('acClan');
    if (!el) return;
    el.classList.toggle('hidden', !clan);
    el.classList.toggle('verified', !!clan && !!verified);
    el.title = clan ? (verified ? 'Verified clan' : 'Clan') : '';
    el.textContent = clan ? `[${clan}]` : '';
  }

  async refreshAccount() {
    const user = await api.me();

    $('profileSignedIn').classList.toggle('hidden', !user);
    $('profileSignedOut').classList.toggle('hidden', !!user);

    $('btnSignupRewards').classList.toggle('hidden', !!user);

    if (!user) {
      $('acName').textContent = this.assignedName || 'Guest';
      $('acMeta').textContent = 'Not signed in — nothing is saved';
      this.setChipClan(null, false);
      this.tfaSecret = null;
      this.renderTwoFactor();
      this.paintAvatars(null);
      $('acGr').textContent = '0';
      $('acXpFill').style.width = '0%';
      $('acVerified').classList.add('hidden');
      $('grBalance').textContent = '0';
      this.refreshMyClan();
      this.refreshGlobal();
      return;
    }

    const s = user.stats ?? {};

    // Header chip
    const span = Math.max(1, user.nextLevelXp - user.levelXp);
    const pct = Math.max(0, Math.min(100, ((user.xp - user.levelXp) / span) * 100));
    $('acName').textContent = user.username;
    this.setChipClan(user.clan, user.clanVerified);
    this.renderTwoFactor();
    $('acMeta').textContent = api.needsVerification
      ? 'Confirm your email to play'
      : `LEVEL ${user.level} · ${fmtNum(s.kills ?? 0)} kills · K/D ${s.kd ?? 0}`;
    $('acGr').textContent = fmtNum(user.gr ?? 0);
    $('acXpFill').style.width = `${pct}%`;
    $('acVerified').classList.toggle('hidden', !user.verified);
    $('grBalance').textContent = fmtNum(user.gr ?? 0);

    // Profile panel
    $('phName').textContent = user.username;
    this.paintAvatars(user);
    $('phVerified').classList.toggle('hidden', !user.verified);
    $('phClan').classList.toggle('hidden', !user.clan);
    $('phClan').classList.toggle('verified', !!user.clanVerified);
    $('phClan').title = user.clanVerified ? 'Verified clan' : '';
    $('phClan').textContent = user.clan ? `[${user.clan}]` : '';
    $('phRole').textContent = (user.role ?? 'player').toUpperCase();
    $('phJoined').textContent = `Joined ${fmtDate(user.createdAt)}`;
    $('phLevel').textContent = user.level;
    $('phXpFill').style.width = `${pct}%`;
    $('phXpText').textContent = `${fmtNum(user.xp - user.levelXp)} / ${fmtNum(span)} XP`;
    $('phGr').textContent = fmtNum(user.gr ?? 0);
    $('renameBalance').textContent = fmtNum(user.gr ?? 0);
    const cost = this.meta?.renameCost ?? K.RENAME_COST;
    $('renameCost').textContent = cost;
    $('ovRenameCost').textContent = cost;
    $('ovRenames').textContent = String(user.nameChanges ?? 0);
    this.renderEmailState(user);

    $('phStats').innerHTML = [
      ['SCORE', fmtNum(s.score ?? 0)], ['KILLS', fmtNum(s.kills ?? 0)], ['DEATHS', fmtNum(s.deaths ?? 0)],
      ['K/D', s.kd ?? 0], ['HEADSHOTS', fmtNum(s.headshots ?? 0)], ['ACCURACY', `${s.accuracy ?? 0}%`],
      ['ASSISTS', fmtNum(s.assists ?? 0)], ['DAMAGE', fmtNum(s.damage ?? 0)], ['BEST STREAK', s.bestStreak ?? 0],
      ['WINS', s.wins ?? 0], ['MATCHES', s.matches ?? 0], ['PLAYTIME', fmtDuration(s.playtime ?? 0)],
    ].map(([k, v]) => `<div class="stat-cell"><b>${v}</b><span>${k}</span></div>`).join('');

    // Preferences that live on the account
    if (user.loadout?.classId) {
      this.selectedClass = user.loadout.classId;
      localStorage.setItem(CLASS_KEY, this.selectedClass);
      this.setLoadoutCard(this.selectedClass);
      this.buildClasses($('classGrid'));
      this.buildClasses($('classGridModal'), true);
    }
    if (user.loadout?.settings && Object.keys(user.loadout.settings).length) {
      const { apply } = await import('./settings.js');
      apply(user.loadout.settings);
      this.buildSettings();
      this.onSettingsChange?.(null);
    }
    if (user.loadout?.keybinds && Object.keys(user.loadout.keybinds).length) {
      keys.apply(user.loadout.keybinds);
      this.buildBinds();
    }

    this.renderProgression(user);
    this.loadMatches(user.username);
    this.refreshGlobal();
    this.buildProgress().catch(() => {});
    // Also the invite badge on the rail, which is visible from the main menu.
    this.refreshMyClan().catch(() => {});
    this.buildClasses($('classGrid'));
    // Only when somebody is actually looking at the account panel: the badge
    // and the overview card are the only things that read it.
    if (this.profileTabOpen) this.loadReports();
  }

  /** Is the account panel the one on screen right now? */
  get profileTabOpen() {
    return this.panelOpen
      && !!document.querySelector('.tab-panel[data-panel="profile"].active');
  }

  async loadMatches(username) {
    const host = $('phMatches');
    host.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const { matches } = await api.matches(username, 10);
      if (!matches.length) { host.innerHTML = '<p class="empty">No matches played yet.</p>'; return; }
      host.innerHTML = matches.map((m) => `
        <div class="match-row ${m.won ? 'won' : 'lost'}">
          <span class="m-map">${escapeHtml(m.map)}</span>
          <span class="m-mode">${escapeHtml(m.mode.toUpperCase())}</span>
          <span class="m-kd">${m.kills}<i>/</i>${m.deaths}</span>
          <span class="m-score">${fmtNum(m.score)}<small>pts</small></span>
          <span class="m-gr">+${m.gr ?? 0}<small>GR</small></span>
          <span class="m-when">${fmtAgo(m.started_at)}</span>
        </div>`).join('');
    } catch {
      host.innerHTML = '<p class="empty">Match history unavailable.</p>';
    }
  }

  /** A message that belongs in the sign-in modal, because that is the next step. */
  toastAuth(message) {
    const err = $('authError');
    err.textContent = message;
    err.classList.remove('hidden');
    $('authModal').classList.remove('hidden');
  }

  /** Everything else: a passing line at the bottom of the screen. */
  notify(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast-item ${kind}`;
    el.textContent = message;
    $('toast').appendChild(el);
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 400); }, 3200);
  }

  /* ── In-match class modal ──────────────────────────────────────────────── */

  _bindClassModal() {
    $('classClose').addEventListener('click', () => { this.closeClassModal(); this.onClassChange?.(null); });
    $('classModal').addEventListener('click', (e) => {
      if (e.target === $('classModal')) { this.closeClassModal(); this.onClassChange?.(null); }
    });
  }

  openClassModal() {
    this.buildClasses($('classGridModal'), true);
    $('classModal').classList.remove('hidden');
  }

  closeClassModal() { $('classModal').classList.add('hidden'); }
  get classModalOpen() { return !$('classModal').classList.contains('hidden'); }
  get authModalOpen() { return !$('authModal').classList.contains('hidden'); }
}

/* ── Formatting helpers ──────────────────────────────────────────────────── */

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
const roman = (n) => ROMAN[n] ?? String(n);

/** A one-line mastery badge under a class card. */
function masteryLine(weaponId) {
  const m = api.mastery?.[weaponId];
  if (!m || !m.kills) return '';
  const tier = K.MASTERY_TIERS.find((t) => t.tier === m.tier) ?? K.MASTERY_TIERS[0];
  return `<div class="class-mastery" style="color:#${tier.color.toString(16).padStart(6, '0')}">
    <b>${roman(m.tier)}</b> ${escapeHtml(m.tierName ?? tier.name)} · ${fmtNum(m.kills)} kills</div>`;
}

/**
 * A top-down sketch of a map, drawn straight from its box list. Free preview
 * art for the server browser without shipping a single screenshot.
 */
function drawMapThumb(canvas, mapId) {
  if (!canvas || !ALL_MAP_IDS.includes(mapId)) return;
  const map = getMap(mapId);
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const s = W / (map.size * 1.12);
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#0b0f15';
  g.fillRect(0, 0, W, H);
  g.save();
  g.translate(W / 2, H / 2);
  for (const b of map.boxes) {
    if (b.decor || b.clip || b.h < 0.8) continue;
    g.fillStyle = b.h > 3.2 ? 'rgba(150,172,200,.55)' : 'rgba(104,124,152,.32)';
    g.fillRect((b.x - b.w / 2) * s, (b.z - b.d / 2) * s, Math.max(1, b.w * s), Math.max(1, b.d * s));
  }
  for (const o of map.objectives ?? []) {
    g.strokeStyle = 'rgba(245,166,35,.85)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(o.x * s, o.z * s, 4, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

function fmtDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  // A weekly reset is days away, and "137h 12m" is not a length of time anybody
  // reads as five and a half days.
  if (d) return `${d}d ${h}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * How far along a milestone is, in the unit that milestone is counted in.
 *
 * Playtime is stored in seconds and nobody thinks in seconds, so that one track
 * reads in hours; everything else is a plain count with thin thousands
 * separators, exactly as it appears on the scoreboard.
 */
function milestoneText(m) {
  if (m.stat === 'playtime') {
    return `${Math.floor(m.progress / 3600)} / ${Math.floor(m.goal / 3600)} h`;
  }
  const sep = (n) => Number(n ?? 0).toLocaleString('en-GB').replace(/,/g, '\u202f');
  return `${sep(m.progress)} / ${sep(m.goal)}`;
}

const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : '—');

/** A patch note's date is an ISO day, not a unix stamp. */
const fmtDate2 = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString();
};

function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/**
 * Paints one avatar frame — the header chip, the profile hero, the picker's
 * preview. A frame holds a picture and a fallback initial; which of the two is
 * showing is the only difference between an account with a picture and one
 * without, so every frame in the client goes through here.
 */
function paintAvatar(frame, url, name) {
  if (!frame) return;
  const img = frame.querySelector('.av-img');
  const initial = frame.querySelector('.av-initial');
  const label = String(name || 'G').trim() || 'G';
  if (initial) initial.textContent = label[0].toUpperCase();
  frame.classList.toggle('has-photo', !!url);
  // The tinted gradient is the fallback's backdrop; a picture covers it.
  frame.style.background = url ? 'none' : avatarColor(label);
  if (!img) return;
  img.classList.toggle('hidden', !url);
  // setAttribute rather than `.src`: the property reflects an *absolute* URL
  // back, so reading it to skip a redundant write would never match.
  if (url) { if (img.getAttribute('src') !== url) img.setAttribute('src', url); }
  else img.removeAttribute('src');
}

/** Decodes a picked file, preferring the fast path where it exists. */
async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('that file could not be read as an image'));
      img.src = url;
    });
  } finally {
    // Revoking immediately is safe: the decode has already finished.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

const encode = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));

/**
 * Squares a picked file, scales it to AVATAR_SIZE and re-encodes it.
 *
 * This is what keeps profile pictures from costing anything: whatever came off
 * a phone camera leaves here as a 256×256 WebP of roughly twenty kilobytes, so
 * the server stores a thumbnail rather than a photograph. It is a convenience
 * and not a control — the server measures what actually arrives and refuses it
 * on its own terms.
 *
 * @param {File} file
 * @returns {Promise<Blob>} an image inside AVATAR_MAX_BYTES
 */
async function squareAvatar(file) {
  if (!K.AVATAR_TYPES.includes(file.type) && !/^image\//.test(file.type)) {
    throw new Error('pick a PNG, JPEG or WebP image');
  }
  if (file.size > K.AVATAR_SOURCE_MAX_BYTES) {
    throw new Error(`that file is ${(file.size / 1048576).toFixed(1)} MB — `
      + `pick one under ${Math.round(K.AVATAR_SOURCE_MAX_BYTES / 1048576)} MB`);
  }

  const bitmap = await loadBitmap(file);
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  if (!w || !h) throw new Error('that file could not be read as an image');

  // Centre crop to a square: the frame is a circle, so the corners were never
  // going to be visible anyway.
  const side = Math.min(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = K.AVATAR_SIZE;
  canvas.height = K.AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (w - side) / 2, (h - side) / 2, side, side, 0, 0, K.AVATAR_SIZE, K.AVATAR_SIZE);
  bitmap.close?.();

  // WebP first, JPEG second. A browser that cannot encode either quietly hands
  // back a PNG, which the server accepts too — as long as it fits.
  for (const [type, quality] of [['image/webp', 0.86], ['image/jpeg', 0.85]]) {
    const blob = await encode(canvas, type, quality);
    if (blob && blob.size <= K.AVATAR_MAX_BYTES) return blob;
  }
  throw new Error('that picture would not compress far enough — try another one');
}

/** Deterministic accent per name, so avatars are stable. */
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `linear-gradient(135deg, hsl(${h % 360} 62% 46%), hsl(${(h % 360) + 40} 62% 32%))`;
}

/** The small round picture on a leaderboard row — initials when there is none. */
const lbAvatar = (row) => (row.avatar
  ? `<img class="lb-pic" src="${escapeHtml(row.avatar)}" alt="" width="22" height="22" loading="lazy">`
  : `<i class="lb-pic letter" style="background:${avatarColor(row.username ?? '?')}">${
    escapeHtml(String(row.username ?? '?')[0].toUpperCase())}</i>`);

const badge = (on) => (on ? '<img class="verified" src="/check.png" alt="verified" width="13" height="13">' : '');

/**
 * `[TAG]` — grey for a clan, gold for one the developers have verified. Same
 * rule, same colours, as the in-match HUD draws.
 */
const clanTag = (clan, verified = false) => (clan
  ? `<i class="clan-tag${verified ? ' verified' : ''}"${verified ? ' title="Verified clan"' : ''}>[${
    escapeHtml(String(clan).slice(0, 4))}]</i>`
  : '');

/** The small square a clan wears in the browse list. */
const clanPic = (c) => (c.avatar
  ? `<img class="cr-img" src="${escapeHtml(c.avatar)}" alt="" width="26" height="26" loading="lazy">`
  : `<i class="cr-img letter" style="background:${avatarColor(c.tag ?? '?')}">${
    escapeHtml(String(c.tag ?? '?')[0])}</i>`);

/**
 * One public profile, as the card draws it.
 *
 * Deliberately the same information for everybody — no address, no session, no
 * moderation state. It is what a stranger on the scoreboard is allowed to know
 * about you, which is why this is the same card whether you click your own name
 * or somebody else's.
 */
function playerCardHtml({ user, recent = [] }) {
  const s = user.stats ?? {};
  const span = Math.max(1, (user.nextLevelXp ?? 1) - (user.levelXp ?? 0));
  const pct = Math.max(0, Math.min(100, ((user.xp - (user.levelXp ?? 0)) / span) * 100));

  const cells = [
    ['SCORE', fmtNum(s.score ?? 0)], ['KILLS', fmtNum(s.kills ?? 0)], ['DEATHS', fmtNum(s.deaths ?? 0)],
    ['K/D', s.kd ?? 0], ['HEADSHOTS', fmtNum(s.headshots ?? 0)], ['ACCURACY', `${s.accuracy ?? 0}%`],
    ['WINS', s.wins ?? 0], ['MATCHES', s.matches ?? 0], ['BEST STREAK', s.bestStreak ?? 0],
    ['DAMAGE', fmtNum(s.damage ?? 0)], ['ASSISTS', fmtNum(s.assists ?? 0)], ['PLAYTIME', fmtDuration(s.playtime ?? 0)],
  ];

  const matches = recent.slice(0, 5).map((m) => `
    <div class="match-row ${m.won ? 'won' : 'lost'}">
      <span class="m-map">${escapeHtml(m.map)}</span>
      <span class="m-mode">${escapeHtml(String(m.mode).toUpperCase())}</span>
      <span class="m-kd">${m.kills}<i>/</i>${m.deaths}</span>
      <span class="m-score">${fmtNum(m.score)}<small>pts</small></span>
      <span class="m-when">${fmtAgo(m.started_at)}</span>
    </div>`).join('');

  return `
    <div class="pc-hero">
      <span class="pc-avatar av-frame">
        <img class="av-img hidden" alt="" width="86" height="86"><span class="av-initial">?</span>
      </span>
      <div class="pc-id">
        <h3>${clanTag(user.clan, user.clanVerified)}<span class="pc-name">${escapeHtml(user.username)}</span>${
  user.verified ? '<img class="verified big" src="/check.png" alt="verified" width="18" height="18">' : ''}</h3>
        <div class="ph-tags">
          <span class="pill">${escapeHtml(String(user.role ?? 'player').toUpperCase())}</span>
          <span class="pill">JOINED ${fmtDate(user.createdAt)}</span>
          ${user.clan ? `<span class="pill${user.clanVerified ? ' gold' : ''}">CLAN ${escapeHtml(user.clan)}${
  user.clanVerified ? ' · VERIFIED' : ''}</span>` : ''}
        </div>
        <div class="ph-level">
          <div class="ph-lv"><b>${user.level}</b><small>LEVEL</small></div>
          <div class="ph-bar"><i style="width:${pct}%"></i><span>${fmtNum(user.xp - (user.levelXp ?? 0))} / ${fmtNum(span)} XP</span></div>
        </div>
      </div>
    </div>
    <div class="stat-grid pc-stats">${cells.map(([k, v]) =>
    `<div class="stat-cell"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    ${matches ? `<h4 class="pc-sub">RECENT MATCHES</h4><div class="match-list">${matches}</div>` : ''}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export default Menu;
