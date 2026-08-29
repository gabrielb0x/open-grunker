/**
 * Open Grunker — main menu: account, classes, servers, leaderboard, shop,
 * key bindings and settings.
 *
 * Everything outside the match lives here. The game layer only needs
 * `onPlay(opts)`, so the menu owns all of its own DOM and network chatter.
 */
import * as K from '/shared/constants.js';
import { CLASSES, CLASS_IDS, loadoutFor } from '/shared/weapons.js';
import { Wardrobe } from './wardrobe.js';
import { api } from './api.js';
import {
  settings, set as setSetting, SCHEMA, reset as resetSettings,
  apply as applySettings,
  exportText as exportSettings, importText as importSettings,
} from './settings.js';
import { getMap, ALL_MAP_IDS } from '/shared/maps.js';
import { GAME_VERSION, PATCH_NOTES, PATCH_KINDS, latestPatch } from '/shared/patchnotes.js';
import * as keys from './keybinds.js';
import { sfx, initAudio, loadAnthem, playAnthem, stopAnthem } from './audio.js';
import { icon } from './icons.js';
import { avatarAccent, nameAccent } from './avatarcolor.js';
import { PadKeyboard } from './padkeyboard.js';
import * as i18n from './i18n.js';

/**
 * Clickable things the browser's own focus order cannot see.
 *
 * Half this interface is cards — a class, a server, a finish, a case, a
 * discipline — and every one of them is a `div` with a click handler, because
 * each contains a heading and a list and wrapping that in a `<button>` is
 * markup a screen reader reads as one very long label. A mouse presses them; a
 * pad, a keyboard and a screen reader could not reach them at all. `_padTargets`
 * gives anything matching this list `tabindex="-1"` on the way past, which is
 * programmatic focus without putting a hundred cards into the Tab order.
 */
const PAD_CARDS = '.class-card, .server-row, .skin-card, .case-card, .listing, '
  + '.friend-row, .clan-row, .cr-kind, [role="button"]';

/** Input types the on-screen keyboard is the right answer for. */
const PAD_TEXT_TYPES = new Set(['text', 'search', 'email', 'password', 'number', 'tel', 'url', '']);

/**
 * What left and right walk a colour input through.
 *
 * A colour picker is an operating-system window, and there is no pad gesture
 * that opens one. Twelve is not every colour; it is enough of them that a
 * crosshair can be made a colour somebody chose rather than the one it shipped
 * with, which is the whole of what this control is for.
 */
const PAD_COLORS = [
  '#ffffff', '#000000', '#f5a623', '#ff7a2f', '#ff4d4d', '#ff5ea8',
  '#b07cff', '#4da6ff', '#33e0e0', '#4ddb7a', '#c8ff3d', '#ffe066',
];

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
  constructor({ onPlay, onSettingsChange, onClassChange, onClassPreview, onPerkChange,
    onCosmeticsChange, onBindsChange, input }) {
    this.onPlay = onPlay;
    this.onSettingsChange = onSettingsChange;
    this.onClassChange = onClassChange;
    this.onClassPreview = onClassPreview;
    this.onPerkChange = onPerkChange;
    /** Something was equipped: the running match rebuilds its viewmodel. */
    this.onCosmeticsChange = onCosmeticsChange;
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
    /** The last /friends answer — list, both queues and who is online. */
    this.friendState = null;
    /**
     * The address behind the mask on the account panel, and whether it is
     * currently showing. Never persisted: revealing it is a decision made once,
     * for ten seconds, and never remembered into the next session.
     */
    this.emailShown = null;
    this.emailRevealed = false;
    this.emailHideTimer = null;
    /** Live polling handle, running only while the friends tab is the open one. */
    this.friendTimer = null;
    /** Which profile the player card is currently showing. */
    this.cardName = null;
    /**
     * The card being edited, and the privacy answers behind it.
     *
     * The draft is deliberately not the saved card: everything in the editor
     * writes here and only SAVE sends it, so trying eight patterns costs eight
     * repaints and no requests — and RESET has something to go back to.
     */
    this.cardDraft = { ...K.CARD_DEFAULTS, featured: [...K.CARD_DEFAULTS.featured] };
    this.privacy = { ...K.PRIVACY_DEFAULTS };
    /** Real rows for the editor's preview, so it does not read as an empty card. */
    this.cardPreviewMatches = [];
    this.socialLoaded = false;

    this.root = $('menu');
    /** Live server rows keyed by mode, so the play buttons can target one. */
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this._bindTabs();
    this._bindPanels();
    this._bindPlay();
    this._bindAuth();
    this._bindClassModal();
    this._bindPerkModal();
    this._bindProfile();
    this._bindAccountNav();
    this._bindAvatar();
    this._bindClans();
    this._bindFriends();
    this._bindCreator();
    this._bindDeveloper();
    this._bindPlayerCard();
    this._bindCardEditor();
    this._bindPrivacy();
    /**
     * The letters, for the one input device that cannot spell.
     *
     * Built on its first use rather than here — most sessions never plug a
     * controller in — and it is the pad's own focus walker that steers it, so
     * opening it is the whole of the integration. See padkeyboard.js.
     */
    // No `onClose`: closing it hands focus back to the field it was typing
    // into, which is where the player was and where the next press should land.
    this.padKeyboard = new PadKeyboard({ sound: (kind) => sfx.ui(kind) });
    /**
     * The four wardrobe pages.
     *
     * Bound after the panels exist and before the first class is drawn: it
     * hangs off the same DOM the loadout page does, and the class grid's own
     * click handler asks it to redraw the preview.
     */
    this.wardrobe = new Wardrobe(this);
    this.wardrobe.bind();
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
      // A question sits over everything, including the card below.
      if (this.confirmOpen) {
        e.preventDefault(); e.stopPropagation(); this._confirmClose?.(); return;
      }
      // The player card sits over the panel, so it is what Escape closes first.
      if (this.playerCardOpen) { e.preventDefault(); e.stopPropagation(); this.closePlayerCard(); return; }
      if (!this.panelOpen) return;
      if (!$('authModal').classList.contains('hidden')) return;
      if (!$('classModal').classList.contains('hidden')) return;
      if (!$('perkModal').classList.contains('hidden')) return;
      e.preventDefault();
      // Mid-match the game's own Escape handler is listening on window, and it
      // would close the whole menu behind this. One Escape, one panel.
      e.stopPropagation();
      this.closePanel();
    });
  }

  /**
   * "Are you sure?", asked in the page rather than by the browser.
   *
   * `window.confirm()` opens an operating-system window, and there is no
   * controller gesture that dismisses one — so every irreversible action in
   * this game had a door a pad could open and then not close. This is the same
   * question in the same two buttons every other card is built from, which
   * means the pad's focus walker reaches it without knowing it exists.
   *
   * Returns a promise rather than taking a callback because every caller was
   * already `await`-ing the thing it guards, so the shape of the call site does
   * not change: `if (!await this.confirm(…)) return;`.
   *
   * @param {{title?:string, body:string, ok?:string, cancel?:string, danger?:boolean}} o
   * @returns {Promise<boolean>}
   */
  confirm({ title = 'ARE YOU SURE?', body, ok = 'CONFIRM', cancel = 'CANCEL', danger = false }) {
    const modal = $('confirmModal');
    if (!modal) return Promise.resolve(window.confirm(body));
    const yes = $('confirmYes');
    const no = $('confirmNo');
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    yes.textContent = ok;
    no.textContent = cancel;
    yes.className = danger ? 'btn-danger' : 'btn-primary';
    modal.classList.remove('hidden');
    // Focus starts on the safe half. A pad or a keyboard that answers by
    // reflex answers "no", which is the right way round for a question asked
    // in front of something that cannot be undone.
    try { no.focus({ preventScroll: true }); } catch { /* not focusable yet */ }

    return new Promise((resolve) => {
      const done = (answer) => {
        modal.classList.add('hidden');
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        modal.removeEventListener('mousedown', onOutside);
        this._confirmClose = null;
        sfx.ui(answer ? 'ok' : 'click');
        resolve(answer);
      };
      const onYes = () => done(true);
      const onNo = () => done(false);
      const onOutside = (e) => { if (e.target === modal) done(false); };
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      modal.addEventListener('mousedown', onOutside);
      // Escape and the pad's B both answer no, through the one door.
      this._confirmClose = () => done(false);
    });
  }

  /** True while the question is up. Read by Escape and by the pad. */
  get confirmOpen() { return $('confirmModal')?.classList.contains('hidden') === false; }

  get panelOpen() { return !$('menuPanel').classList.contains('hidden'); }
  openPanel() { $('menuPanel').classList.remove('hidden'); }
  closePanel() { this.closePanelSilently(); sfx.ui(); }

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

  closePanelSilently() {
    $('menuPanel').classList.add('hidden');
    // The friends poll belongs to the open tab, not to the session.
    this.watchFriends(false);
  }
  get visible() { return !this.root.classList.contains('hidden'); }

  /* ── Tabs ──────────────────────────────────────────────────────────────── */

  /**
   * The rail down the left of the panel.
   *
   * Each button carries its own icon name, title and subtitle in the markup, so
   * adding a destination is one line of HTML and never a change here. The icon
   * is injected rather than written inline twelve times: it is the same helper
   * every other icon in the client goes through, and a hand-pasted SVG per
   * button is twelve chances to paste the wrong one.
   */
  _bindTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      // The badge is the only thing already inside the button, and it has to
      // survive the rebuild: it is the count of requests waiting for an answer.
      const badge = tab.querySelector('.tab-badge');
      tab.innerHTML = `${icon(tab.dataset.icon ?? 'chevron')}<span class="t-label">${
        escapeHtml(tab.dataset.label ?? tab.dataset.title ?? '')}</span>`;
      if (badge) tab.appendChild(badge);

      tab.addEventListener('click', () => {
        sfx.ui();
        this.selectTab(tab);
      });
      // A rail is a list of things you move along, so it should sound like one.
      tab.addEventListener('pointerenter', () => { if (!tab.classList.contains('active')) sfx.ui('hover'); });
    }
    this._bindTabSearch();
    // Whatever starts marked active owns the header on the first open.
    this.paintPanelHead(document.querySelector('.tab.active'));
  }

  /** Switches to one rail entry and runs whatever that page needs on arrival. */
  selectTab(tab) {
    if (!tab) return;
    const name = tab.dataset.tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.tab-panel')) {
      p.classList.toggle('active', p.dataset.panel === name);
    }
    this.paintPanelHead(tab);
    // A new page starts at its own top rather than wherever the last one was
    // scrolled to, which is the one thing a shared scroller always gets wrong.
    const scroller = $('menuPanel')?.querySelector('.panel-scroll');
    if (scroller) scroller.scrollTop = 0;

    if (name === 'leaderboard') this.refreshLeaderboard();
    if (name === 'clans') this.refreshClans();
    // Presence is the whole point of the friends list, so it is the one panel
    // that keeps looking while it is open — and stops the moment it is not,
    // rather than polling a tab nobody is on.
    this.watchFriends(name === 'friends');
    if (name === 'servers') this.refreshServers();
    if (['classes', 'cases', 'market', 'trades'].includes(name)) this.wardrobe?.onTab(name);
    if (name === 'profile') this.refreshAccount();
    if (name === 'creator') this.refreshCreator();
    if (name === 'developer') this.renderDeveloper();
    if (name === 'controls') this.buildBinds();
    if (name === 'challenges') this.buildProgress();
  }

  /** The panel's own header: what you are looking at, and why you would. */
  paintPanelHead(tab) {
    if (!tab) return;
    const title = $('panelTitle');
    const sub = $('panelSub');
    if (title) title.textContent = tab.dataset.title ?? tab.dataset.label ?? '';
    if (sub) sub.textContent = tab.dataset.sub ?? '';
  }

  /**
   * The filter box over the rail.
   *
   * Matches the label, the subtitle and the group heading, so "sound" finds
   * SETTINGS and "tag" finds CLANS. A group whose every entry is filtered out
   * hides its heading too — a heading over nothing reads as a bug.
   */
  _bindTabSearch() {
    const box = $('tabSearch');
    if (!box) return;
    const apply = () => {
      const q = box.value.trim().toLowerCase();
      let shown = 0;
      for (const group of document.querySelectorAll('.pn-group')) {
        let hits = 0;
        for (const tab of group.querySelectorAll('.tab')) {
          // A locked entry is not a search miss, it is a page this account may
          // not open — so the filter leaves it hidden rather than revealing it
          // the moment the box is cleared. `data-locked` is set by whoever owns
          // the gate (see `setDevAccess`), never by this function.
          if (tab.dataset.locked === '1') { tab.classList.add('hidden'); continue; }
          const hay = `${tab.dataset.tab} ${tab.dataset.label ?? ''} ${tab.dataset.title ?? ''} ${
            tab.dataset.sub ?? ''} ${group.dataset.group ?? ''}`.toLowerCase();
          const hit = !q || hay.includes(q);
          tab.classList.toggle('hidden', !hit);
          if (hit) hits++;
        }
        group.classList.toggle('hidden', !hits);
        shown += hits;
      }
      $('tabSearchNone')?.classList.toggle('hidden', !!shown);
    };
    box.addEventListener('input', apply);
    // Enter goes to the first thing left standing — the whole point of typing
    // three letters rather than reaching for the mouse.
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && box.value) { e.stopPropagation(); box.value = ''; apply(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = document.querySelector('.pn-group:not(.hidden) .tab:not(.hidden)');
      if (first) { sfx.ui('ok'); this.selectTab(first); }
    });
  }

  openTab(name) {
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (!tab) return;
    this.openPanel();
    this.selectTab(tab);
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
   * @param {'up'|'down'|'left'|'right'|'accept'|'back'|'search'
   *         |'tab-prev'|'tab-next'|'page-up'|'page-down'} dir
   */
  padNav(dir) {
    if (dir === 'accept') return void this._padActivate();
    if (dir === 'back') return void this._padBack();
    if (dir === 'search') return void this._padSearch();
    if (dir === 'tab-prev' || dir === 'tab-next') return void this._padTab(dir === 'tab-next' ? 1 : -1);
    if (dir === 'page-up' || dir === 'page-down') return void this._padPage(dir === 'page-down' ? 1 : -1);
    // A slider, a dropdown or a colour is a *value*, not a place: with one of
    // them focused, left and right change what it says rather than walking off
    // it. Without this a pad could reach every setting in the game and move
    // exactly none of them.
    if ((dir === 'left' || dir === 'right') && this._padAdjust(dir === 'right' ? 1 : -1)) return;
    this._padMove(dir);
  }

  /**
   * Left/right on a focused widget. True when it was one.
   *
   * The event is dispatched rather than the handler called, because every one
   * of these controls is already wired to `input`/`change` from the mouse path
   * — a pad that called the handlers directly would be a second copy of the
   * settings panel that could fall out of step with the first.
   */
  _padAdjust(sign) {
    const el = document.activeElement;
    if (!el || el.disabled) return false;

    if (el.tagName === 'INPUT' && el.type === 'range') {
      const step = Number(el.step) || 1;
      const min = Number(el.min), max = Number(el.max);
      const next = Math.min(max, Math.max(min, (Number(el.value) || 0) + step * sign));
      if (next === Number(el.value)) return true;               // already at the end
      el.value = String(next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      sfx.ui('hover');
      return true;
    }

    if (el.tagName === 'SELECT') {
      const n = el.options.length;
      if (!n) return true;
      el.selectedIndex = (el.selectedIndex + sign + n) % n;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      sfx.ui();
      return true;
    }

    if (el.tagName === 'INPUT' && el.type === 'color') {
      // A colour picker is a native window nothing on a pad can reach, so the
      // stick walks a short list instead. Not every colour — enough of them
      // that a crosshair can be made a colour somebody wanted.
      const i = PAD_COLORS.indexOf(el.value.toLowerCase());
      el.value = PAD_COLORS[(i < 0 ? 0 : i + sign + PAD_COLORS.length) % PAD_COLORS.length];
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      sfx.ui();
      return true;
    }

    return false;
  }

  /** LB / RB: the rail entry either side of this one, skipping hidden ones. */
  _padTab(sign) {
    const tabs = [...document.querySelectorAll('#panelRail .tab')]
      .filter((t) => !t.classList.contains('hidden') && t.offsetParent !== null);
    if (!tabs.length) return;
    this.openPanel();
    const at = tabs.findIndex((t) => t.classList.contains('active'));
    const next = tabs[((at < 0 ? 0 : at) + sign + tabs.length) % tabs.length];
    this.selectTab(next);
    next.scrollIntoView({ block: 'nearest' });
    sfx.ui();
  }

  /** LT / RT: a page of whatever is scrolling under the pad right now. */
  _padPage(sign) {
    const scope = this._padScope();
    const scroller = scope.querySelector('.panel-scroll')
      ?? scope.closest('.panel-scroll')
      ?? scope;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 4) return;
    scroller.scrollBy({ top: sign * scroller.clientHeight * 0.85, behavior: 'smooth' });
    sfx.ui('hover');
  }

  /** Y: the filter box over the rail, which is the fastest way across twenty tabs. */
  _padSearch() {
    const box = $('tabSearch');
    if (!box) return;
    this.openPanel();
    box.focus();
    sfx.ui();
    this.padKeyboard?.open(box);
  }

  /**
   * Is a full-screen sheet sitting over the backdrop right now?
   *
   * The menu renders a live match behind itself, and behind a settings panel
   * or a modal that match is a couple of dark, blurred strips down the edges
   * of the screen. Drawing it at the display's full rate there is a whole 3D
   * frame — shadow pass, post chain and all — spent on something nobody is
   * looking at, so the loop slows the backdrop down instead. See `Game.loop`.
   */
  get coveredByPanel() {
    if (this.padKeyboard?.open_) return true;
    for (const id of ['confirmModal', 'reportCard', 'playerCard', 'classModal', 'perkModal', 'authModal', 'menuPanel']) {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  }

  /** The surface a pad is currently inside: the topmost open thing. */
  _padScope() {
    // The on-screen keyboard is over everything, including the modal that
    // opened it, so a stick pushed while it is up moves between its keys and
    // nothing else.
    const keys = this.padKeyboard?.element;
    if (keys && !keys.classList.contains('hidden')) return keys;
    /*
     * Topmost first, and three of these live in the HUD rather than in the
     * menu: the pause card, the end-of-match vote and the scoreboard's report
     * buttons are all things a player is looking at *during* a match, and a
     * scope that stopped at the menu left a pad able to open every one of them
     * and press nothing on any of them.
     */
    for (const id of ['confirmModal', 'reportCard', 'playerCard', 'classModal', 'perkModal', 'authModal',
      'pause', 'matchEnd', 'scoreboard']) {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) return el;
    }
    const panel = $('menuPanel');
    if (panel && !panel.classList.contains('hidden')) return panel;
    return this.root;
  }

  /**
   * Everything inside `scope` a person could actually click right now.
   *
   * Half this interface is cards: a class, a server, a finish, a case. Every
   * one of them is a `div` with a click handler, which a mouse presses and the
   * browser's own focus order cannot see — so a pad could walk the buttons
   * around them and never reach the thing the page is *for*. They are made
   * focusable here, lazily and at `-1`, which is programmatic focus without
   * putting a hundred cards into the keyboard's tab order.
   */
  _padTargets(scope) {
    const out = [];
    const sel = 'button:not([disabled]), a[href], select, textarea:not([disabled]), '
      + 'input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"]), '
      + PAD_CARDS;
    for (const el of scope.querySelectorAll(sel)) {
      if (el.offsetParent === null) continue;              // hidden or detached
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (!el.hasAttribute('tabindex') && el.matches(PAD_CARDS)) el.tabIndex = -1;
      out.push(el);
    }
    return out;
  }

  _padActivate() {
    const scope = this._padScope();
    const el = document.activeElement;
    if (!el || el === document.body || !scope.contains(el)) { this._padMove('down'); return; }

    /*
     * A is "do the obvious thing to this", and what that is depends on what it
     * is. Focusing a control and calling it activated — which is what this used
     * to do for every input and every select — is the one answer that is never
     * right: a native dropdown cannot be opened by a pad and a text field
     * cannot be typed into by one, so both simply sat there looking focused.
     */
    if (el.tagName === 'SELECT') { this._padAdjust(1); return; }
    if (el.tagName === 'INPUT' && PAD_TEXT_TYPES.has(el.type)) {
      sfx.ui();
      this.padKeyboard?.open(el);
      return;
    }
    if (el.tagName === 'TEXTAREA') { sfx.ui(); this.padKeyboard?.open(el); return; }
    if (el.tagName === 'INPUT' && el.type === 'range') { this._padAdjust(1); return; }
    sfx.ui();
    el.click();
  }

  /**
   * B, and the one control on a pad that has to mean the same thing everywhere:
   * close whatever is on top, and when nothing is, hand the press to the game's
   * own Escape so it opens or closes the menu.
   */
  _padBack() {
    sfx.ui();
    if (this.padKeyboard?.close(false)) return;
    if (this.confirmOpen) { this._confirmClose?.(); return; }
    for (const [id, close] of [
      ['reportCard', () => $('reportCancel')?.click()],
      ['playerCard', () => this.closePlayerCard()],
      ['classModal', () => this.closeClassModal()],
      ['perkModal', () => this.closePerkModal()],
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
        // The preview, the equipped strip and the primary-finish grid are all
        // per class, so choosing one redraws the workbench around it.
        this.wardrobe?.buildLoadout();
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

  /**
   * CREATORS_ENABLED, as far as the interface is concerned.
   *
   * The routes already refuse everything when an operator turns the programme
   * off; what was left was a rail entry leading to a page whose every button
   * answered 403, which is the interface advertising something this server
   * does not do. The entry goes the same way the DEVELOPER one does — hidden
   * *and* marked locked, because the search box must not be able to filter a
   * hidden entry back into view.
   */
  applyCreatorRules(rules) {
    this.creatorRules = rules ?? null;
    const on = rules ? rules.enabled !== false : true;
    const tab = document.querySelector('.tab[data-tab="creator"]');
    if (tab) {
      tab.dataset.locked = on ? '0' : '1';
      tab.classList.toggle('hidden', !on);
    }
    // Somebody standing on the page when it closes is moved somewhere that
    // still exists rather than left reading a dead one.
    if (!on && document.querySelector('.tab-panel[data-panel="creator"].active')) {
      this.openTab('settings');
    }
    if (!on) {
      $('creatorSignedOut')?.classList.add('hidden');
      $('creatorBody')?.classList.add('hidden');
      $('creatorClosed')?.classList.remove('hidden');
    }
  }

  /* ── Friends ───────────────────────────────────────────────────────────
   *
   * The list is an address book; the presence on it is the product. Everything
   * below is arranged around one question — "who is on, and can I get into
   * their match" — which is why the JOIN button lives on the row rather than
   * behind a profile, and why the panel keeps refreshing itself while it is the
   * open tab and stops the second it is not.
   * ────────────────────────────────────────────────────────────────────────*/

  _bindFriends() {
    $('btnFriendsSignIn')?.addEventListener('click', () => { sfx.ui(); this.openAuth('login'); });
    $('btnFriendRefresh')?.addEventListener('click', () => { sfx.ui(); this.refreshFriends(); });

    $('friendAddForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('friendAddName');
      const name = input.value.trim();
      if (!name) return;
      await this.friendAction('add', name);
      input.value = '';
    });

    // Every row names its action rather than carrying a handler, so redrawing
    // the panel — which it does every few seconds — never leaks a listener.
    for (const id of ['friendList', 'friendIncoming', 'friendOutgoing']) {
      $(id)?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-friend-act]');
        if (!btn) return;
        e.preventDefault();
        this.friendAction(btn.dataset.friendAct, btn.dataset.arg ?? '', btn);
      });
    }
  }

  /** Starts or stops the presence poll. Only ever runs while the tab is open. */
  watchFriends(on) {
    clearInterval(this.friendTimer);
    this.friendTimer = null;
    if (!on) return;
    this.refreshFriends();
    this.friendTimer = setInterval(() => {
      // A backgrounded tab is not somebody looking at a friend list.
      if (!document.hidden && this.visible) this.refreshFriends({ quiet: true });
    }, 12_000);
  }

  /**
   * Pulls the list and redraws it.
   *
   * `quiet` is the polling case: it must never blank the panel on a hiccup, and
   * must never steal a message the player is still reading.
   */
  async refreshFriends({ quiet = false } = {}) {
    const signedIn = api.isAuthed;
    $('friendsSignedOut')?.classList.toggle('hidden', signedIn);
    $('friendsSignedIn')?.classList.toggle('hidden', !signedIn);
    if (!signedIn) {
      this.friendState = null;
      this.setFriendBadge(0);
      return;
    }
    try {
      this.friendState = await api.friends();
    } catch (ex) {
      if (!quiet) this.friendNote(ex.message || 'Friends are unavailable right now.', 'error');
      return;
    }
    this.renderFriends();
  }

  /** The waiting-request count, on the tab. */
  setFriendBadge(n) {
    const badge = $('friendTabBadge');
    if (!badge) return;
    badge.textContent = String(n);
    badge.classList.toggle('hidden', !n);
  }

  friendNote(text, kind = '') {
    const el = $('friendMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `form-msg${text ? '' : ' hidden'}${kind ? ` ${kind}` : ''}`;
  }

  renderFriends() {
    const state = this.friendState;
    if (!state) return;
    const { friends = [], incoming = [], outgoing = [], limits = {} } = state;

    this.setFriendBadge(incoming.length);
    $('friendCount').textContent = friends.length
      ? `${state.online ?? 0} of ${friends.length} online · ${friends.length}/${limits.max ?? K.FRIENDS_MAX}`
      : 'nobody yet';

    $('friendRequests').classList.toggle('hidden', !incoming.length);
    $('friendReqCount').textContent = String(incoming.length);
    $('friendIncoming').innerHTML = incoming.map((f) => this.friendRowHtml(f, 'incoming')).join('');

    $('friendList').innerHTML = friends.length
      ? friends.map((f) => this.friendRowHtml(f, 'friend')).join('')
      : `<p class="empty">Add somebody by their nickname. Once they accept, you will see
         when they are playing and can drop into their match from here.</p>`;

    $('friendOutgoingWrap').classList.toggle('hidden', !outgoing.length);
    $('friendOutgoing').innerHTML = outgoing.map((f) => this.friendRowHtml(f, 'outgoing')).join('');

    for (const host of ['friendList', 'friendIncoming', 'friendOutgoing']) {
      for (const frame of $(host).querySelectorAll('.fr-pic')) {
        paintAvatar(frame, frame.dataset.avatar || null, frame.dataset.name || '?');
      }
    }
  }

  /**
   * One row.
   *
   * The status line is the whole reason to open this panel, so it is the thing
   * that changes: a room somebody can be joined in, the fact that a full room
   * cannot be, or how long ago they were last seen at all.
   */
  friendRowHtml(f, kind) {
    const state = f.playing
      ? (f.room
        ? `<span class="fr-live">IN A MATCH</span> ${escapeHtml(f.mode ?? '')} · ${escapeHtml(f.map ?? '')}`
        : `<span class="fr-live">IN A MATCH</span> that room is full`)
      : f.online ? '<span class="fr-idle">IN THE MENU</span>'
        : kind === 'friend' ? `last seen ${fmtAgo(f.lastLogin)}`
          : `asked ${fmtAgo(f.askedAt)}`;

    const actions = kind === 'incoming'
      ? `<button class="btn-primary sm" data-friend-act="accept" data-arg="${escapeHtml(f.id)}" type="button">ACCEPT</button>
         <button class="btn-ghost sm" data-friend-act="decline" data-arg="${escapeHtml(f.id)}" type="button">DECLINE</button>`
      : kind === 'outgoing'
        ? `<button class="btn-ghost sm" data-friend-act="cancel" data-arg="${escapeHtml(f.id)}" type="button">CANCEL</button>`
        : `${f.room ? `<button class="btn-primary sm" data-friend-act="join" data-arg="${escapeHtml(f.room)}" type="button">JOIN</button>` : ''}
           <button class="btn-ghost sm" data-friend-act="profile" data-arg="${escapeHtml(f.username)}" type="button">PROFILE</button>
           <button class="btn-ghost sm danger" data-friend-act="remove" data-arg="${escapeHtml(f.id)}" type="button">REMOVE</button>`;

    return `<div class="friend-row${f.playing ? ' playing' : f.online ? ' online' : ''}">
      <div class="fr-pic av-frame" data-avatar="${escapeHtml(f.avatar ?? '')}" data-name="${escapeHtml(f.username)}">
        <img class="av-img hidden" alt="" width="40" height="40"><span class="av-initial">?</span>
      </div>
      <div class="fr-id">
        <div class="fr-name">${escapeHtml(f.username)}${
  f.verified ? '<img class="verified" src="/check.png" alt="verified" width="13" height="13">' : ''}${
  f.clan ? `<span class="clan-tag${f.clanVerified ? ' verified' : ''}">[${escapeHtml(f.clan)}]</span>` : ''}</div>
        <div class="fr-state">${state}</div>
      </div>
      <div class="fr-lv">LV ${f.level ?? 1}</div>
      <div class="fr-actions">${actions}</div>
    </div>`;
  }

  /** Every button on the panel lands here. The server decides; this only asks. */
  async friendAction(action, arg, btn = null) {
    if (btn) btn.disabled = true;
    this.friendNote('');
    try {
      if (action === 'join') {
        // Straight into their room, by the same code the server browser joins by.
        sfx.ui('ok');
        this.selectedRoom = arg;
        this.onPlay({ name: this.currentName(), classId: this.selectedClass, room: arg });
        return;
      }
      if (action === 'profile') { this.openPlayerCard(arg); return; }

      if (action === 'add') {
        const r = await api.addFriend(arg);
        this.friendState = r;
        this.friendNote(r.outcome === 'accepted'
          ? `${r.friend} had already asked you — you are friends now.`
          : `Asked ${r.friend}. They will see it next time they open the menu.`, 'good');
      } else if (action === 'accept') {
        this.friendState = await api.acceptFriend(arg);
        this.friendNote('Added.', 'good');
      } else if (action === 'decline' || action === 'cancel') {
        this.friendState = await api.dropFriendRequest(arg);
      } else if (action === 'remove') {
        const r = await api.removeFriend(arg);
        this.friendState = r;
        this.friendNote(`${r.removed} is no longer on your list.`, '');
      }
      sfx.ui('ok');
      this.renderFriends();
    } catch (ex) {
      sfx.ui('error');
      this.friendNote(ex.message || 'That did not work.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
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

    /*
     * The interstitial in front of a creator's links.
     *
     * These are the only outbound links in the game and they are put there by
     * one player for another to click, so leaving is a thing somebody agrees to
     * rather than a thing that happens. The host is read back off the anchor's
     * own href — never off anything in the markup — so what the confirm names
     * is exactly where the browser is about to go.
     */
    document.addEventListener('click', (e) => {
      const link = e.target.closest?.('a[data-external]');
      if (!link) return;
      let host;
      try { host = new URL(link.href).host; } catch { e.preventDefault(); return; }
      /*
       * Always prevented, then opened by hand if the answer is yes.
       *
       * The question is asynchronous now and `preventDefault` is not: letting
       * the navigation start while the card is still on screen would be the
       * browser leaving before anybody answered.
       */
      e.preventDefault();
      const href = link.href;
      this.confirm({
        title: 'LEAVING OPEN GRUNKER',
        body: i18n.tf('This link goes to {host}. Open it?', { host }),
        ok: 'OPEN IT',
      }).then((yes) => {
        if (yes) window.open(href, '_blank', 'noopener,noreferrer');
      });
    });
    // One listener on the card rather than one per button: the card is rebuilt
    // from scratch after every action it offers.
    card?.addEventListener('click', (e) => {
      const btn = e.target.closest?.('button[data-card-act]');
      if (!btn || !card.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      this.cardAction(btn.dataset.cardAct, btn.dataset.arg ?? '', btn);
    });
  }

  get playerCardOpen() { return $('playerCard')?.classList.contains('hidden') === false; }

  closePlayerCard() {
    this.cardName = null;
    $('playerCard')?.classList.add('hidden');
    sfx.ui();
  }

  /**
   * Fetches and draws one player's public profile.
   *
   * The colour is settled before the card is written rather than after: a card
   * that paints itself amber and then flips to its owner's colour a beat later
   * reads as a glitch, and the accent is a custom property that everything on
   * the card is derived from, so it has to be right on the first frame.
   *
   * Which colour that is comes from the card itself. On `auto` — what every
   * account starts on — it is pulled out of the profile picture, so a card
   * nobody has ever edited still belongs to somebody. The picture is read once
   * per URL and cached, and an account with no picture falls back to the same
   * name-derived colour its initials are already drawn in.
   */
  async openPlayerCard(name) {
    const card = $('playerCard');
    const body = $('playerCardBody');
    if (!card || !body || !name) return;
    sfx.ui();
    this.cardName = name;
    card.classList.remove('hidden');
    body.innerHTML = `<div class="pc-stub"><h3>${escapeHtml(name)}</h3>
      <p class="empty">Loading…</p></div>`;

    let data;
    try {
      data = await api.player(name);
    } catch (ex) {
      if (this.cardName !== name) return;               // a later click won
      body.innerHTML = `<div class="pc-stub"><h3>${escapeHtml(name)}</h3>
        <p class="empty">${escapeHtml(ex.status === 404
    ? 'That name has no account behind it — a guest, or a player who has since been removed.'
    : ex.message || 'That profile is unavailable right now.')}</p></div>`;
      return;
    }
    if (this.cardName !== name) return;

    this.cardData = data;
    const accent = await cardAccent(data.user);
    if (this.cardName !== name) return;                 // the read is awaited

    body.innerHTML = playerCardHtml(data, accent);
    paintAvatar(body.querySelector('.pc-avatar'), data.user.avatar, data.user.username);
    // The modal's own border is outside the shell the accent is declared on,
    // so it is given the colour directly rather than inheriting it upwards.
    card.querySelector('.pc-card')?.style.setProperty('--pc-accent', accent);
  }

  /**
   * Every button on the card lands here.
   *
   * The card redraws itself after anything that changes the relationship, so
   * ADD FRIEND becomes REQUEST SENT without the player having to close it and
   * open it again — which is the whole difference between a card you act from
   * and a card you read.
   */
  async cardAction(action, arg, btn = null) {
    const name = this.cardName;
    if (btn) btn.disabled = true;
    try {
      switch (action) {
        case 'edit':
          this.closePlayerCard();
          this.openTab('profile');
          this.openAccountView('card');
          return;
        case 'privacy':
          this.closePlayerCard();
          this.openTab('profile');
          this.openAccountView('social');
          return;
        case 'signin':
          this.closePlayerCard();
          this.openAuth('login');
          return;
        case 'join':
          sfx.ui('ok');
          this.closePlayerCard();
          this.selectedRoom = arg;
          this.onPlay({ name: this.currentName(), classId: this.selectedClass, room: arg });
          return;
        case 'add':
          this.friendState = await api.addFriend(arg);
          this.notify(`Asked ${arg} to be friends.`, 'good');
          break;
        case 'accept':
          this.friendState = await api.acceptFriend(arg);
          this.notify('Added.', 'good');
          break;
        case 'decline':
        case 'cancel':
          this.friendState = await api.dropFriendRequest(arg);
          break;
        case 'unfriend': {
          const r = await api.removeFriend(arg);
          this.friendState = r;
          this.notify(`${r.removed} is no longer on your list.`);
          break;
        }
        default:
          return;
      }
      sfx.ui('ok');
      this.renderFriends();
      // Re-read rather than patch: accepting a request can change what the
      // server is willing to show on this card at all, and guessing which half
      // moved is how a card ends up disagreeing with the panel behind it.
      if (this.cardName === name) await this.openPlayerCard(name);
    } catch (ex) {
      sfx.ui('error');
      this.notify(ex.message || 'That did not work.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── The wardrobe ──────────────────────────────────────────────────────
   *
   * Four pages — loadout, cases, market, trades — all of which live in
   * client/js/wardrobe.js. This class keeps only the seam: the wardrobe needs
   * to know which class is selected, needs somewhere to put a message, and
   * needs to be able to tell the running match that something was equipped.
   */

  /** Kept so a cached older bundle calling `buildShop()` still lands somewhere. */
  buildShop() { this.wardrobe?.buildLoadout(); }

  /** The names the trade builder may offer to. Trades are friends-only. */
  friendNames() {
    return (this.friendState?.friends ?? []).map((f) => f.name).filter(Boolean);
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
      // The icon is its own element rather than a character glued to the front
      // of the heading: the translator matches whole text nodes, and "🎯 Aim"
      // is not a phrase anybody wrote a translation for.
      const box = el('div', 'set-group',
        `<h4>${group.icon ? `<i class="set-icon">${group.icon}</i>` : ''}${escapeHtml(group.group)}</h4>`);
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

    const actions = el('div', 'set-group', '<h4><i class="set-icon">💾</i>Backup &amp; sync</h4>');
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
    this.applyCreatorRules(this.meta.creators);
    // The operator's own default, for a server run for one country. It only
    // ever applies to somebody whose browser has not already asked for a
    // language this game speaks — see i18n.init.
    i18n.init({ serverDefault: this.meta.defaultLanguage ?? null });
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

  /**
   * Paints the address block in the profile panel.
   *
   * Masked, both here and on the overview card. The account panel is what is on
   * screen while somebody picks a class or reads their stats, which is exactly
   * when a screen is most likely to be shared — and an address printed in full
   * on that panel is an address handed to everybody watching. SHOW puts the
   * real one back for ten seconds and then takes it away again, because the one
   * failure this is guarding against is forgetting it is up there.
   *
   * The placeholder on the change-address form is masked for the same reason;
   * it is the same string, in the same panel, drawn slightly greyer.
   */
  renderEmailState(user) {
    const state = api.verification;
    const verified = !!state?.verified || !!user.emailVerified;
    this.emailShown = user.email ?? null;

    this.paintEmail(false);
    $('btnEmailReveal')?.classList.toggle('hidden', !user.email);
    $('btnOvEmailReveal')?.classList.toggle('hidden', !user.email);
    $('btnResendVerify').classList.toggle('hidden', verified || !user.email);
    $('emailForm').querySelector('input[name=email]').placeholder =
      maskEmail(user.email) || 'you@example.com';

    for (const id of ['emailBadge', 'ovEmailBadge']) {
      const badge = $(id);
      if (!badge) continue;
      badge.textContent = verified ? 'CONFIRMED' : 'UNCONFIRMED';
      badge.classList.toggle('good', verified);
      badge.classList.toggle('bad', !verified);
    }
  }

  /** Draws the address masked or in full, in both places it appears. */
  paintEmail(reveal) {
    const email = this.emailShown;
    const text = email
      ? (reveal ? email : maskEmail(email))
      : 'no address on file';
    for (const id of ['emailAddr', 'ovEmail']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = text;
      el.classList.toggle('masked', !!email && !reveal);
    }
    for (const id of ['btnEmailReveal', 'btnOvEmailReveal']) {
      const btn = $(id);
      if (btn) btn.textContent = reveal ? 'HIDE' : 'SHOW';
    }
  }

  /**
   * Shows the address, then puts it away on its own.
   *
   * The timer is the point: somebody who reveals it to check a typo and then
   * walks off is the case this whole thing exists for.
   */
  toggleEmail() {
    clearTimeout(this.emailHideTimer);
    this.emailRevealed = !this.emailRevealed;
    this.paintEmail(this.emailRevealed);
    if (!this.emailRevealed) return;
    this.emailHideTimer = setTimeout(() => {
      this.emailRevealed = false;
      this.paintEmail(false);
    }, 10_000);
  }

  _bindProfile() {
    for (const id of ['btnEmailReveal', 'btnOvEmailReveal']) {
      $(id)?.addEventListener('click', () => { sfx.ui(); this.toggleEmail(); });
    }

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
    if (name === 'card' || name === 'social') {
      // One fetch for both, on the first visit. After that the panels redraw
      // from what is already in hand — the card editor in particular is a
      // hundred repaints per visit and none of them are worth a round trip.
      if (this.socialLoaded) { this.buildCardEditor(); this.buildPrivacyForm(); }
      else this.loadSocial();
    }
  }

  /* ── The card editor ───────────────────────────────────────────────────
   *
   * Two halves that never talk to the server: the controls write into
   * `this.cardDraft`, the draft repaints the preview, and only SAVE sends
   * anything. That is what makes trying eight patterns free, and it is also
   * what makes CANCEL possible — a live-saving editor has no way back to the
   * card you had before you started fiddling.
   * ──────────────────────────────────────────────────────────────────────*/

  _bindCardEditor() {
    // The preview is scaled to the width it has, so it has to be re-fitted
    // whenever that width changes.
    window.addEventListener('resize', () => {
      if (document.querySelector('.acct-view.active')?.dataset.acctView === 'card') {
        this.fitCardPreview();
      }
    });
    $('btnCardSave')?.addEventListener('click', () => this.saveCard());
    $('btnCardReset')?.addEventListener('click', () => {
      sfx.ui();
      this.cardDraft = { ...K.CARD_DEFAULTS, featured: [...K.CARD_DEFAULTS.featured] };
      this.buildCardEditor();
      this.cardNote('Back to the default card. Nothing is saved until you press SAVE.');
    });

    // The controls are rebuilt whenever the draft changes, so they cannot carry
    // their own listeners: one delegated pair on the host handles all of them.
    const host = $('cardEditor');
    host?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-card-set]');
      if (!btn || !host.contains(btn)) return;
      e.preventDefault();
      this.setCardField(btn.dataset.cardSet, btn.dataset.value);
    });
    host?.addEventListener('input', (e) => {
      const field = e.target.dataset?.cardField;
      if (!field) return;
      // Text and colour boxes only: they fire on every keystroke, so they
      // update the draft and repaint the preview without rebuilding the
      // controls underneath the cursor.
      this.cardDraft = { ...this.cardDraft, [field]: e.target.value };
      if (field === 'accent') this.cardDraft.accentMode = 'custom';
      this.paintCardPreview();
      const counter = host.querySelector(`[data-count="${field}"]`);
      if (counter) counter.textContent = String(e.target.value.length);
    });
  }

  /**
   * Applies one choice.
   *
   * `featured` is the only field that toggles rather than sets: it is a set of
   * up to three, and picking a fourth drops the oldest rather than refusing —
   * a control that silently does nothing is a control people press twice.
   */
  setCardField(field, value) {
    sfx.ui();
    const draft = { ...this.cardDraft, featured: [...(this.cardDraft.featured ?? [])] };
    if (field === 'featured') {
      const at = draft.featured.indexOf(value);
      if (at >= 0) {
        // Never below one: an empty band is not a layout, it is a hole.
        if (draft.featured.length > 1) draft.featured.splice(at, 1);
      } else {
        draft.featured.push(value);
        if (draft.featured.length > K.CARD_FEATURED_MAX) draft.featured.shift();
      }
    } else if (field === 'glow') {
      draft.glow = value === 'on';
    } else if (field === 'accent') {
      // Reaching for a colour is an unambiguous "I want this one", so it takes
      // the card off auto rather than quietly storing a colour nothing uses.
      draft.accent = value;
      draft.accentMode = 'custom';
    } else {
      draft[field] = value;
    }
    this.cardDraft = draft;
    this.buildCardEditor();
  }

  /** Draws every control from the shared catalogues, marked against the draft. */
  buildCardEditor() {
    const host = $('cardEditor');
    if (!host) return;
    const d = this.cardDraft ?? (this.cardDraft = { ...K.CARD_DEFAULTS });

    const chips = (field, list, current) => list.map((item) => {
      const id = item.id ?? item;
      const name = item.name ?? String(item).replace(/^./, (c) => c.toUpperCase());
      const on = Array.isArray(current) ? current.includes(id) : current === id;
      return `<button class="ce-chip${on ? ' on' : ''}" data-card-set="${field}"
        data-value="${escapeHtml(id)}" type="button">${escapeHtml(name)}</button>`;
    }).join('');

    // Swatches worth offering next to the picker: the game's own accents, then
    // a spread around the wheel. The picker still takes anything.
    const SWATCHES = ['#f5a623', '#ff7a2f', '#ff4d4d', '#e0457b', '#b07cff', '#6c7bff',
      '#4d9bff', '#33c9d6', '#4ddb7a', '#a8c832', '#d9b45b', '#8fa1b7'];

    host.innerHTML = `
      <section class="ce-block">
        <h4>${icon('palette')}COLOUR</h4>
        <p class="ce-note">On <b>auto</b> your card takes the main colour out of your
          profile picture, and follows it whenever you change the picture.</p>
        <div class="ce-chips">${chips('accentMode', [
    { id: 'auto', name: 'From my picture' }, { id: 'custom', name: 'Pick my own' },
  ], d.accentMode)}</div>
        <div class="ce-colour${d.accentMode === 'custom' ? '' : ' off'}">
          <input type="color" data-card-field="accent" value="${escapeHtml(d.accent)}"
                 aria-label="Card colour">
          <div class="ce-swatches">${SWATCHES.map((hex) =>
    `<button class="ce-sw${d.accent === hex && d.accentMode === 'custom' ? ' on' : ''}"
        style="--sw:${hex}" data-card-set="accent" data-value="${hex}" type="button"
        aria-label="${hex}"></button>`).join('')}</div>
        </div>
      </section>

      <section class="ce-block">
        <h4>${icon('spark')}BACKDROP</h4>
        <div class="ce-chips">${chips('pattern', K.CARD_PATTERNS, d.pattern)}</div>
        <label class="ce-row">HOW STRONG
          <span class="ce-chips inline">${chips('intensity', K.CARD_INTENSITIES, d.intensity)}</span>
        </label>
        <label class="ce-row">GLOW
          <span class="ce-chips inline">${chips('glow', [
    { id: 'on', name: 'On' }, { id: 'off', name: 'Off' },
  ], d.glow ? 'on' : 'off')}</span>
        </label>
      </section>

      <section class="ce-block">
        <h4>${icon('user')}PICTURE FRAME</h4>
        <div class="ce-chips">${chips('frame', K.CARD_FRAMES, d.frame)}</div>
      </section>

      <section class="ce-block">
        <h4>${icon('sliders')}LAYOUT</h4>
        <div class="ce-chips">${chips('layout', K.CARD_LAYOUTS, d.layout)}</div>
        <p class="ce-note">${escapeHtml(
    K.CARD_LAYOUTS.find((l) => l.id === d.layout)?.note ?? '')}</p>
      </section>

      <section class="ce-block">
        <h4>${icon('medal')}PINNED STATS</h4>
        <p class="ce-note">Up to ${K.CARD_FEATURED_MAX}, in the big band beside your name.
          Everything else stays on the card either way.</p>
        <div class="ce-chips">${chips('featured', K.CARD_STATS, d.featured)}</div>
      </section>

      <section class="ce-block">
        <h4>${icon('pencil')}WHAT IT SAYS</h4>
        <label class="ce-text">TAGLINE <small><i data-count="title">${d.title.length}</i>/${K.CARD_TITLE_MAX}</small>
          <input data-card-field="title" maxlength="${K.CARD_TITLE_MAX}" autocomplete="off"
                 spellcheck="false" placeholder="Quickscoper. Allegedly."
                 value="${escapeHtml(d.title)}"></label>
        <label class="ce-text">ABOUT <small><i data-count="bio">${d.bio.length}</i>/${K.CARD_BIO_MAX}</small>
          <textarea data-card-field="bio" rows="3" maxlength="${K.CARD_BIO_MAX}"
                    placeholder="A line or two. Anyone who clicks your name reads this."
                    >${escapeHtml(d.bio)}</textarea></label>
        <p class="ce-note">Both are public and both are reportable — this is on your card
          wherever your name is drawn.</p>
      </section>`;

    this.paintCardPreview();
  }

  /**
   * Repaints the preview from the draft.
   *
   * Deliberately the real card renderer rather than a simplified stand-in: an
   * editor whose preview is a different piece of code from the thing it is
   * previewing is an editor that lies eventually.
   */
  async paintCardPreview() {
    const stage = $('cardPreview');
    if (!stage) return;
    const account = api.account;
    if (!account) { stage.innerHTML = '<p class="empty small">Sign in to style a card.</p>'; return; }

    // The colour is read asynchronously, so a fast run of clicks can land out
    // of order. The token is what makes the last edit the one that shows.
    const token = (this._previewToken = (this._previewToken ?? 0) + 1);
    const user = { ...account, card: K.normaliseCard(this.cardDraft) };
    const accent = await cardAccent(user);
    if (token !== this._previewToken) return;

    stage.innerHTML = playerCardHtml({
      user,
      relation: 'self',
      recent: this.cardPreviewMatches ?? [],
      can: {}, pending: {},
    }, accent);
    paintAvatar(stage.querySelector('.pc-avatar'), user.avatar, user.username);
    this.fitCardPreview();
  }

  /**
   * Scales the preview down to the width it has.
   *
   * Built at the width a real card opens at and then transformed, rather than
   * left to re-flow into a narrow column: a preview that lays itself out
   * differently from the thing it is previewing is showing you a card nobody
   * will ever see. The stage takes the scaled height so nothing below it is
   * left sitting under an empty gap.
   */
  fitCardPreview() {
    const stage = $('cardPreview');
    const shell = stage?.querySelector('.pc-shell');
    if (!stage || !shell) return;
    const DESIGN = 1000;
    shell.style.width = `${DESIGN}px`;
    const scale = Math.min(1, (stage.clientWidth || DESIGN) / DESIGN);
    shell.style.transform = `scale(${scale})`;
    stage.style.height = `${Math.round((shell.offsetHeight || 0) * scale)}px`;
  }

  cardNote(text, kind = '') {
    const el = $('cardMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `form-msg${text ? '' : ' hidden'}${kind ? ` ${kind}` : ''}`;
  }

  async saveCard() {
    const btn = $('btnCardSave');
    if (btn) btn.disabled = true;
    try {
      const saved = await api.saveCard(this.cardDraft);
      // What came back is what is now true — the server normalises, so a draft
      // that asked for something it does not recognise is corrected here rather
      // than left looking saved.
      this.cardDraft = saved;
      this.buildCardEditor();
      sfx.ui('ok');
      this.cardNote('Saved. This is what people see when they click your name.', 'good');
    } catch (ex) {
      sfx.ui('error');
      this.cardNote(ex.message || 'Could not save that.', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── Privacy ───────────────────────────────────────────────────────────
   *
   * Saved on change rather than behind a button: each of these is one decision
   * on its own, and a form that batches eight independent decisions behind a
   * SAVE is a form people leave half-made.
   * ──────────────────────────────────────────────────────────────────────*/

  _bindPrivacy() {
    const host = $('privacyForm');
    host?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-priv]');
      if (!btn || !host.contains(btn)) return;
      e.preventDefault();
      this.setPrivacy(btn.dataset.priv, btn.dataset.value === 'true' ? true
        : btn.dataset.value === 'false' ? false : btn.dataset.value);
    });
  }

  buildPrivacyForm() {
    const host = $('privacyForm');
    if (!host) return;
    const p = this.privacy ?? (this.privacy = { ...K.PRIVACY_DEFAULTS });

    const row = (field) => {
      const labels = field.labels ?? K.PRIVACY_AUDIENCE_LABELS;
      const opts = field.options.map((opt) => `
        <button class="pv-opt${p[field.id] === opt ? ' on' : ''}" data-priv="${field.id}"
                data-value="${opt}" type="button">${escapeHtml(labels[opt] ?? opt)}</button>`).join('');
      return `<div class="pv-row">
        <div class="pv-id"><b>${escapeHtml(field.name)}</b><small>${escapeHtml(field.note)}</small></div>
        <div class="pv-opts">${opts}</div>
      </div>`;
    };

    host.innerHTML = `${K.PRIVACY_FIELDS.map(row).join('')}
      <div class="pv-row">
        <div class="pv-id"><b>Show me on the leaderboard</b>
          <small>Off takes your name off the public board. Your stats still count.</small></div>
        <div class="pv-opts">
          <button class="pv-opt${p.listed ? ' on' : ''}" data-priv="listed" data-value="true" type="button">Listed</button>
          <button class="pv-opt${p.listed ? '' : ' on'}" data-priv="listed" data-value="false" type="button">Hidden</button>
        </div>
      </div>`;
  }

  async setPrivacy(field, value) {
    const next = { ...this.privacy, [field]: value };
    // Painted first, then saved: the switch has to move under the finger that
    // pressed it, and a failed save puts it back and says so.
    this.privacy = next;
    this.buildPrivacyForm();
    sfx.ui();
    try {
      this.privacy = await api.savePrivacy(next);
      this.buildPrivacyForm();
      this.privacyNote('Saved.', 'good');
    } catch (ex) {
      sfx.ui('error');
      this.privacy = api.account?.privacy ?? { ...K.PRIVACY_DEFAULTS };
      this.buildPrivacyForm();
      this.privacyNote(ex.message || 'Could not save that.', 'error');
    }
  }

  privacyNote(text, kind = '') {
    const el = $('privacyMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `form-msg${text ? '' : ' hidden'}${kind ? ` ${kind}` : ''}`;
    clearTimeout(this._privacyNoteTimer);
    if (text && kind === 'good') {
      this._privacyNoteTimer = setTimeout(() => this.privacyNote(''), 2200);
    }
  }

  /**
   * Pulls the card and the privacy answers together, once per visit.
   *
   * Both come from one route because the panel that draws them is one panel,
   * and because the catalogue behind the editor is the server's list rather
   * than the client's — so a server that adds a pattern gets it without a new
   * build of the browser side.
   */
  async loadSocial() {
    if (!api.isAuthed) return;
    try {
      const r = await api.social();
      this.cardDraft = r.card ?? { ...K.CARD_DEFAULTS };
      this.privacy = r.privacy ?? { ...K.PRIVACY_DEFAULTS };
      this.socialLoaded = true;
    } catch {
      // A card editor that cannot reach the server still opens, on defaults;
      // saving is what will tell them, and it says something useful when it does.
      this.cardDraft ??= { ...K.CARD_DEFAULTS };
      this.privacy ??= { ...K.PRIVACY_DEFAULTS };
    }
    // The preview reads better with real rows in it than with "no matches yet".
    try {
      const mine = await api.matches(api.account.username, 4);
      this.cardPreviewMatches = mine.matches ?? [];
    } catch { this.cardPreviewMatches = []; }
    this.buildCardEditor();
    this.buildPrivacyForm();
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
    const pct = Math.max(0, Math.min(100, (into / span) * 100)).toFixed(1);
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

    // Both rail entries follow the session, not a match. `/auth/me` is what
    // restores it, so this is where the DEVELOPER page appears and disappears
    // — signing out has to take it away as surely as signing in brings it.
    this.setDevAccess(api.devAccess, this.devOpen);

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
      // Three pages carry the balance now; the wardrobe owns all three.
      this.wardrobe?.paintBalance();
      $('friendsSignedOut')?.classList.remove('hidden');
      $('friendsSignedIn')?.classList.add('hidden');
      this.friendState = null;
      this.setFriendBadge(0);
      // The card and the privacy answers belong to an account, so signing out
      // has to drop them: the next person to sign in on this browser must not
      // find the last one's draft sitting in the editor.
      this.socialLoaded = false;
      this.cardDraft = { ...K.CARD_DEFAULTS, featured: [...K.CARD_DEFAULTS.featured] };
      this.privacy = { ...K.PRIVACY_DEFAULTS };
      this.cardPreviewMatches = [];
      this.refreshMyClan();
      this.refreshGlobal();
      return;
    }

    // `/auth/me` already carries this account's own answers, so the privacy
    // panel is right the moment it is opened rather than after a fetch.
    if (user.privacy) this.privacy = user.privacy;
    if (user.card && !this.socialLoaded) {
      this.cardDraft = { ...user.card, featured: [...(user.card.featured ?? [])] };
    }

    // A friend request waiting is the one thing on this panel somebody has to
    // answer, so the badge is fetched with the account rather than only when
    // the friends tab is opened — a request nobody is told about is a request
    // nobody accepts.
    this.refreshFriends({ quiet: true }).catch(() => {});

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
    this.wardrobe?.paintBalance();

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
      applySettings(user.loadout.settings);
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

  /* ── The perk picker ────────────────────────────────────────────────────────
   *
   * Deliberately the same shape as the class modal above, because it is the
   * same gesture: a grid of cards, one of them lit, click to choose. What is
   * different is what the cards say — a class card is a stat block, and there
   * is no useful stat block for "half the health, hops that never bleed". So
   * each card is two lists in plain words, the good and the bad, and the player
   * reads a trade rather than four bars.
   *
   * The catalogue comes from the room over the wire rather than from this
   * client's copy of the constants, so a server running its own numbers
   * describes its own numbers. `onPerkChange` is the game's; nothing here
   * decides anything.
   * ─────────────────────────────────────────────────────────────────────────*/

  _bindPerkModal() {
    $('perkClose').addEventListener('click', () => this.closePerkModal());
    $('perkModal').addEventListener('click', (e) => {
      if (e.target === $('perkModal')) this.closePerkModal();
    });
    $('perkGrid').addEventListener('click', (e) => {
      const card = e.target.closest('[data-perk]');
      if (!card) return;
      sfx.ui('ok');
      this.selectedPerk = card.dataset.perk;
      this.buildPerks(this.perkCatalogue, this.selectedPerk);
      this.onPerkChange?.(this.selectedPerk);
      this.closePerkModal();
    });
  }

  buildPerks(list, selected) {
    this.perkCatalogue = list ?? this.perkCatalogue ?? [];
    this.selectedPerk = selected ?? this.selectedPerk;
    const hex = (n) => `#${Number(n ?? 0x8b95a6).toString(16).padStart(6, '0')}`;
    $('perkGrid').innerHTML = this.perkCatalogue.map((p) => `
      <div class="perk-card${p.id === this.selectedPerk ? ' selected' : ''}" data-perk="${escapeHtml(p.id)}">
        <span class="pick">SELECTED</span>
        <h4 style="color:${hex(p.color)}">${escapeHtml(p.name)}</h4>
        <p>${escapeHtml(p.tagline ?? '')}</p>
        <ul class="perk-good">${(p.good ?? []).map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul>
        <ul class="perk-bad">${(p.bad ?? []).map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>
      </div>`).join('');
  }

  openPerkModal(list, selected) {
    this.buildPerks(list, selected);
    $('perkModal').classList.remove('hidden');
  }

  closePerkModal() { $('perkModal').classList.add('hidden'); }
  get perkModalOpen() { return !$('perkModal').classList.contains('hidden'); }
  get authModalOpen() { return !$('authModal').classList.contains('hidden'); }

  /* ── Creator ────────────────────────────────────────────────────────────────
   *
   * One page with three states — never applied, applied and waiting, approved —
   * and the state is the row at the top rather than three different screens.
   * The catalogue below it is drawn in all three, because somebody deciding
   * whether to apply needs to see what each discipline earns and somebody
   * already approved still wants to read what the other three get.
   *
   * The rules come from `/creator` rather than from the constants, so an
   * operator who moved the level or closed the programme in .env has moved it
   * for this page too. Nothing here decides anything: every button below asks a
   * route, and the route is what refuses.
   * ─────────────────────────────────────────────────────────────────────────── */

  _bindCreator() {
    $('btnCreatorSignIn')?.addEventListener('click', () => { sfx.ui(); this.openAuth('login'); });

    // The application.
    $('crApplyForm')?.addEventListener('submit', (e) => { e.preventDefault(); this.submitCreatorApplication(); });
    $('crAddLink')?.addEventListener('click', () => {
      sfx.ui();
      this.addCreatorLinkRow('crLinks');
      this.syncCreatorLinks();
    });
    $('crPitch')?.addEventListener('input', () => {
      $('crPitchCount').textContent = String($('crPitch').value.length);
    });
    // The select stays the value that is sent; the cards are a second way to
    // move it, so both have to end up looking like the same choice.
    $('crKind')?.addEventListener('change', () => this.markCreatorKind());
    $('crKinds')?.addEventListener('click', (e) => this._pickCreatorKind(e.target));
    $('crKinds')?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this._pickCreatorKind(e.target);
    });

    // Links on an approved card. Deliberately a separate editor from the one in
    // the application: the first is part of a pitch and the second is what
    // strangers see, and editing one must not quietly rewrite the other until
    // SAVE is pressed.
    $('crAddCardLink')?.addEventListener('click', () => {
      sfx.ui();
      this.addCreatorLinkRow('crCardLinks');
      this.syncCreatorLinks('crCardLinks', 'crAddCardLink', null);
    });
    $('crSaveLinks')?.addEventListener('click', () => this.saveCreatorLinks());

    $('crResign')?.addEventListener('click', () => this.resignCreator());

    this._bindAnthem();
    this._bindBriefs();

    // Delegated, because every list on this page is redrawn wholesale.
    $('creatorBody')?.addEventListener('click', (e) => {
      const drop = e.target.closest('[data-drop-link]');
      if (drop) {
        sfx.ui();
        const host = drop.closest('.cr-links');
        drop.closest('.cr-link')?.remove();
        if (host?.id === 'crLinks') this.syncCreatorLinks();
        else this.syncCreatorLinks('crCardLinks', 'crAddCardLink', null);
        return;
      }
      const withdraw = e.target.closest('[data-withdraw-brief]');
      if (withdraw) this.withdrawBrief(withdraw.dataset.withdrawBrief);
    });
  }

  /** A card in the catalogue was pressed: move the select to it. */
  _pickCreatorKind(node) {
    const card = node?.closest?.('.cr-kinds.picking .cr-kind');
    const select = $('crKind');
    if (!card || !select || !card.dataset.kind) return;
    select.value = card.dataset.kind;
    this.markCreatorKind();
    sfx.ui();
  }

  crNote(text, kind = '') {
    const el = $('crMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `form-msg cr-msg${text ? '' : ' hidden'}${kind ? ` ${kind}` : ''}`;
    // The bar lives at the top of the page and half of what writes to it — the
    // anthem uploader, the brief form — is a screen and a half further down.
    // It is sticky, so this only has to bring it back into the scroller when
    // the page is scrolled past it entirely.
    if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Pulls the whole page's state in one request and redraws. */
  async refreshCreator({ quiet = false } = {}) {
    // A closed programme outranks everything else on this page: there is no
    // point offering to sign in for something this server does not do.
    if (this.creatorRules && this.creatorRules.enabled === false) {
      this.applyCreatorRules(this.creatorRules);
      return;
    }
    const signedOut = !api.isAuthed;
    $('creatorSignedOut')?.classList.toggle('hidden', !signedOut);
    $('creatorBody')?.classList.toggle('hidden', signedOut);
    $('creatorClosed')?.classList.add('hidden');
    if (signedOut) return;

    try {
      this.creatorState = await api.creator();
    } catch (ex) {
      if (ex.code === 'creators_disabled') {
        $('creatorBody')?.classList.add('hidden');
        $('creatorClosed')?.classList.remove('hidden');
        return;
      }
      if (!quiet) this.crNote(ex.message || 'Creator status is unavailable right now.', 'error');
      return;
    }
    // This answer is fresher than the one the session restore brought: somebody
    // approved as a code creator two minutes ago should not have to reload to
    // find the DEVELOPER page they were just given.
    this.setDevAccess(this.creatorState.dev, this.devOpen);
    this.renderCreator();
  }

  renderCreator() {
    const state = this.creatorState;
    if (!state) return;
    const { rules, creator, apply, skinRequests = [] } = state;

    $('creatorBody')?.classList.remove('hidden');
    $('crRules').textContent = `Level ${rules.minLevel}+`
      + (rules.needEmail ? ', with a confirmed email address' : '')
      + `. ${rules.linksMax} links, ${rules.reapplyDays} days between attempts.`;

    this.renderCreatorStanding(creator, apply);
    this.renderCreatorKinds(rules, creator);

    // The form is up only when there is no application standing. `apply.can` is
    // the server's own answer, so a level too low and a wait still running both
    // grey the button with the sentence the route would have refused with.
    const form = $('crApplyForm');
    const showForm = !creator || creator.status === 'rejected' || creator.status === 'revoked';
    form?.classList.toggle('hidden', !showForm);
    if (showForm) {
      const pitch = $('crPitch');
      $('crPitchMax').textContent = String(rules.pitchMax);
      if (pitch) {
        pitch.maxLength = rules.pitchMax;
        // Redrawing the page does not empty the box, so the counter under it
        // has to be re-read rather than left saying whatever it last said.
        $('crPitchCount').textContent = String(pitch.value.length);
      }
      const select = $('crKind');
      if (select && !select.options.length) {
        select.innerHTML = rules.kinds
          .map((k) => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.name)}</option>`).join('');
      }
      if (!$('crLinks').children.length) this.addCreatorLinkRow('crLinks');
      this.syncCreatorLinks();
      const btn = $('crSubmit');
      btn.disabled = !apply.can;
      btn.textContent = apply.can ? 'SEND IT' : (apply.why ?? 'NOT YET').toUpperCase();
    }
    // The catalogue is redrawn after the form so it can mark the discipline the
    // select is actually sitting on.
    this.markCreatorKind();

    const grants = creator?.status === 'approved' ? (creator.grants ?? []) : [];
    $('crAnthemPerk')?.classList.toggle('hidden', !grants.includes('anthem'));
    $('crSkinPerk')?.classList.toggle('hidden', !grants.includes('skinRequest'));
    $('crLinksPerk')?.classList.toggle('hidden', creator?.status !== 'approved');
    $('crResignPerk')?.classList.toggle('hidden', creator?.status !== 'approved');

    if (grants.includes('anthem')) this.renderAnthem(creator, rules);
    if (grants.includes('skinRequest')) this.renderBriefs(skinRequests, creator, rules);
    if (creator?.status === 'approved') this.fillCreatorLinks('crCardLinks', creator.links, rules);
  }

  /** The one row at the top: where this account stands, and what to do next. */
  renderCreatorStanding(creator, apply) {
    const el = $('crStanding');
    if (!el) return;
    if (!creator) {
      el.className = 'cr-standing none';
      el.innerHTML = `${icon('badge')}<div><b>NOT A CREATOR</b>`
        + `<span>${escapeHtml(apply?.can ? 'You can apply below.' : (apply?.why ?? ''))}</span></div>`;
      return;
    }
    const kind = K.getCreatorKind(creator.kind);
    const lines = {
      pending: ['IN THE QUEUE', 'Somebody will read it. You will see the answer here.'],
      approved: [`${(kind?.name ?? creator.kind).toUpperCase()} CREATOR`,
        creator.since ? `Since ${fmtDate(creator.since)}.` : 'Approved.'],
      rejected: ['NOT THIS TIME', creator.verdict ?? 'No reason was given.'],
      revoked: ['STATUS ENDED', creator.verdict ?? 'The status was withdrawn.'],
    };
    const [title, note] = lines[creator.status] ?? ['—', ''];
    el.className = `cr-standing ${creator.status}`;
    el.innerHTML = `${icon(kind?.icon ?? 'badge')}<div><b>${escapeHtml(title)}</b>`
      + `<span>${escapeHtml(note)}</span></div>`;
  }

  /**
   * The four cards. The one this account holds is marked; the rest are read.
   *
   * While there is an application to make they are also the control that picks
   * which discipline it is for — the select below stays, and stays the value
   * that is sent, but choosing a discipline and reading what it earns used to
   * be two gestures a screen apart, which is how somebody applies as whichever
   * one the select happened to open on.
   */
  renderCreatorKinds(rules, creator) {
    const el = $('crKinds');
    if (!el) return;
    const picking = !creator || creator.status === 'rejected' || creator.status === 'revoked';
    el.classList.toggle('picking', picking);
    el.innerHTML = rules.kinds.map((kind) => {
      const mine = creator?.status === 'approved' && creator.kind === kind.id;
      // `tabindex` rather than a button: it is a card with a list in it, and a
      // button wrapping a list is markup a screen reader reads as one long
      // label. This makes it reachable by keyboard and by controller, which
      // between them is what "clickable" has to mean.
      return `<article class="cr-kind${mine ? ' mine' : ''}" data-kind="${escapeHtml(kind.id)}"
               ${picking ? 'tabindex="0" role="button"' : ''}>
        <h5>${icon(kind.icon)}${escapeHtml(kind.name)}${mine ? '<i>YOURS</i>' : ''}</h5>
        <p class="cr-blurb">${escapeHtml(kind.blurb)}</p>
        <ul>${kind.perks.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        ${picking ? '<span class="cr-pick">APPLYING AS THIS</span>' : ''}
      </article>`;
    }).join('');
  }

  /** Lights the card the discipline select is sitting on. */
  markCreatorKind() {
    const want = $('crKind')?.value;
    for (const card of document.querySelectorAll('.cr-kinds.picking .cr-kind')) {
      card.classList.toggle('chosen', card.dataset.kind === want);
    }
  }

  /**
   * The link counter, and the button that stops promising a row it will refuse.
   *
   * `addCreatorLinkRow` already turned the limit away with a message; a full
   * editor now says so before anybody presses anything, which is the difference
   * between a rule and an error.
   */
  syncCreatorLinks(hostId = 'crLinks', buttonId = 'crAddLink', countId = 'crLinkCount') {
    const host = $(hostId);
    const max = this.creatorState?.rules?.linksMax ?? 0;
    if (!host || !max) return;
    const n = host.children.length;
    const count = $(countId);
    if (count) count.textContent = `${n} / ${max}`;
    const btn = $(buttonId);
    if (btn) {
      btn.disabled = n >= max;
      btn.textContent = n >= max ? `${max} LINKS IS THE LIMIT` : 'ADD A LINK';
    }
  }

  /* ── The link editor ─────────────────────────────────────────────────────
   *
   * A platform and a handle, never a URL. The address is built by the server
   * out of the pair — see the block comment on CREATOR_PLATFORMS in
   * shared/constants.js — so this editor cannot be used to put an arbitrary
   * destination on somebody else's screen, and does not have to be trusted not
   * to be.
   * ────────────────────────────────────────────────────────────────────────── */

  addCreatorLinkRow(hostId, link = null) {
    const host = $(hostId);
    const rules = this.creatorState?.rules;
    if (!host || !rules) return;
    if (host.children.length >= rules.linksMax) {
      this.crNote(`${rules.linksMax} links is the limit.`, 'error');
      return;
    }
    /*
     * Built from nodes rather than from a string, and that is not a style
     * choice. The one value on this row that came from a person is the handle,
     * and putting it through `innerHTML` means escaping it correctly every time
     * this function is edited. Setting `.value` on an input is not markup at
     * all, so there is nothing to escape and nothing to get wrong.
     */
    const row = document.createElement('div');
    row.className = 'cr-link';

    const select = document.createElement('select');
    select.className = 'cr-link-platform';
    for (const spec of rules.platforms) {
      const opt = document.createElement('option');
      opt.value = spec.id;
      opt.textContent = spec.name;
      if (spec.id === link?.platform) opt.selected = true;
      select.appendChild(opt);
    }
    if (link?.platform) select.value = link.platform;

    const input = document.createElement('input');
    input.className = 'mini-input cr-link-handle';
    input.maxLength = 80;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = link?.handle ?? '';

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'btn-icon';
    drop.dataset.dropLink = '';
    drop.setAttribute('aria-label', 'Remove');
    drop.title = 'Remove this link';
    drop.textContent = '\u00d7';

    /*
     * What the pair actually becomes.
     *
     * The paragraph above the editor promises that the address is built from
     * the platform and the handle rather than typed — but until it is drawn,
     * that promise is a sentence somebody has to take on trust while looking at
     * a box that behaves exactly like a URL field. `creatorLinkUrl` is the same
     * function the server builds the stored address with, so this is the real
     * answer and not an illustration of one.
     */
    const preview = document.createElement('small');
    preview.className = 'cr-link-url';

    row.append(select, input, drop, preview);
    host.appendChild(row);

    // The placeholder is the whole of the instruction: "@handle", "channel",
    // "you.bsky.social". It follows the platform, because the shape of what
    // goes in the box is different for every one of them.
    const hint = () => {
      const spec = rules.platforms.find((p) => p.id === select.value);
      input.placeholder = spec ? `${spec.prefix ?? ''}${spec.placeholder}${spec.suffix ?? ''}` : '';
      const typed = input.value.trim();
      // Normalised first, exactly as the server will: somebody who pastes a
      // whole profile URL has typed a handle, and the preview has to show them
      // the address that will actually be stored rather than a refusal.
      const handle = typed ? K.normaliseCreatorHandle(select.value, typed) : '';
      const url = handle ? K.creatorLinkUrl({ platform: select.value, handle }) : '';
      preview.textContent = url || '';
      preview.classList.toggle('bad', !!typed && !url);
      if (typed && !url) {
        const spec2 = rules.platforms.find((pl) => pl.id === select.value);
        preview.textContent = `that is not a ${spec2?.name ?? 'valid'} ${spec2?.placeholder ?? 'handle'}`;
      }
    };
    select.addEventListener('change', hint);
    input.addEventListener('input', hint);
    hint();
  }

  /** Reads one editor back out as `[{platform, handle}]`, dropping blanks. */
  readCreatorLinks(hostId) {
    return [...($(hostId)?.querySelectorAll('.cr-link') ?? [])]
      .map((row) => ({
        platform: row.querySelector('.cr-link-platform').value,
        handle: row.querySelector('.cr-link-handle').value.trim(),
      }))
      .filter((l) => l.handle);
  }

  fillCreatorLinks(hostId, links, rules) {
    const host = $(hostId);
    if (!host) return;
    host.innerHTML = '';
    for (const link of links ?? []) this.addCreatorLinkRow(hostId, link);
    if (!host.children.length && rules) this.addCreatorLinkRow(hostId);
    if (hostId === 'crCardLinks') this.syncCreatorLinks('crCardLinks', 'crAddCardLink', null);
  }

  async submitCreatorApplication() {
    const links = this.readCreatorLinks('crLinks');
    // Checked here for the message, and again on the server for the rule.
    const error = K.creatorLinksError(links);
    if (error) { sfx.ui('error'); this.crNote(error, 'error'); return; }
    try {
      this.crNote('Sending…');
      const r = await api.applyAsCreator({
        kind: $('crKind').value,
        pitch: $('crPitch').value,
        links,
      });
      this.creatorState.creator = r.creator;
      sfx.ui('ok');
      this.crNote('Sent. Somebody will read it.', 'ok');
      await this.refreshCreator({ quiet: true });
    } catch (ex) {
      sfx.ui('error');
      this.crNote(ex.message || 'That did not go through.', 'error');
    }
  }

  async saveCreatorLinks() {
    const links = this.readCreatorLinks('crCardLinks');
    const error = K.creatorLinksError(links);
    if (error) { sfx.ui('error'); this.crNote(error, 'error'); return; }
    try {
      const r = await api.setCreatorLinks(links);
      this.creatorState.creator = r.creator;
      sfx.ui('ok');
      this.crNote('Saved.', 'ok');
    } catch (ex) {
      sfx.ui('error');
      this.crNote(ex.message || 'Could not save those.', 'error');
    }
  }

  async resignCreator() {
    const days = this.creatorState?.rules?.reapplyDays ?? 14;
    const yes = await this.confirm({
      title: 'GIVE UP CREATOR STATUS?',
      body: i18n.tf('Your anthem is deleted with it, and you cannot apply again for '
        + '{days} days.', { days }),
      ok: 'GIVE IT UP',
      danger: true,
    });
    if (!yes) return;
    try {
      await api.resignCreator();
      sfx.ui('ok');
      this.crNote('Done.', 'ok');
      await this.refreshCreator({ quiet: true });
    } catch (ex) {
      sfx.ui('error');
      this.crNote(ex.message || 'That did not go through.', 'error');
    }
  }

  /* ── The anthem uploader ────────────────────────────────────────────────────
   *
   * Takes whatever a musician has — an MP3, an OGG, a FLAC, a WAV off a
   * phone — and turns it into the one thing the server can measure: ten seconds
   * of mono 16-bit PCM at ANTHEM_SAMPLE_RATE.
   *
   * The browser does the decoding because the browser is the only side of this
   * with a decoder. A server that cannot decode what it stores cannot measure
   * how loud it is, and a loudness rule that cannot be checked is not a rule —
   * so the expensive, format-aware half happens here and the arithmetic that
   * actually protects a listener happens there. See server/util/audio.js.
   *
   * Nothing here is a security control. Everything below is *convenience*: the
   * trim, the resample, the level meter. The server re-measures the samples it
   * is sent and rewrites them whatever this file did, which is exactly why this
   * file is allowed to be helpful rather than suspicious.
   * ────────────────────────────────────────────────────────────────────────── */

  _bindAnthem() {
    const file = $('crAnthemFile');
    $('crAnthemPick')?.addEventListener('click', () => { sfx.ui(); file?.click(); });
    file?.addEventListener('change', () => this.loadAnthemFile(file.files?.[0] ?? null));
    $('crAnthemCancel')?.addEventListener('click', () => { sfx.ui(); this.clearAnthemDraft(); });
    $('crAnthemUpload')?.addEventListener('click', () => this.uploadAnthem());
    $('crAnthemRemove')?.addEventListener('click', () => this.removeAnthem());
    $('crAnthemPlay')?.addEventListener('click', () => this.previewAnthem());
    $('crTrimRange')?.addEventListener('input', () => {
      const at = Number($('crTrimRange').value) || 0;
      $('crTrimAt').textContent = `${at.toFixed(1)}s`;
    });
  }

  renderAnthem(creator, rules) {
    const el = $('crAnthemState');
    if (!el) return;
    const max = rules.anthem.maxSeconds;
    $('crAnthemNote').textContent = `Up to ${max} seconds, played over the kill cam of everyone `
      + `you kill. Levelled to ${rules.anthem.targetDb} dB on the way in, so nobody can be shouted at.`;

    if (creator.anthem) {
      el.className = 'cr-anthem has';
      el.innerHTML = `${icon('wave')}<div><b>${escapeHtml(creator.anthemTitle || 'Untitled')}</b>`
        + `<span>Playing on your kills.</span></div>`;
    } else {
      el.className = 'cr-anthem none';
      el.innerHTML = `${icon('note')}<div><b>NO TRACK YET</b>`
        + '<span>The kill cam runs silent until you upload one.</span></div>';
    }
    $('crAnthemPlay')?.classList.toggle('hidden', !creator.anthem);
    $('crAnthemRemove')?.classList.toggle('hidden', !creator.anthem);
    $('crAnthemPick').textContent = creator.anthem ? 'REPLACE IT' : 'CHOOSE A TRACK';
  }

  /**
   * Decodes a chosen file and offers the trim.
   *
   * The whole file is decoded, not just the first ten seconds, because a
   * musician's ten seconds is almost never the first ten — the point of the
   * slider below is that they pick it. Decoding is done in an AudioContext the
   * page already has; a file too large to read at all is refused before that,
   * since decoding a hundred-megabyte upload to tell somebody it was too big is
   * a way to hang a tab.
   */
  async loadAnthemFile(file) {
    if (!file) return;
    const rules = this.creatorState?.rules?.anthem;
    if (!rules) return;
    if (file.size > K.ANTHEM_SOURCE_MAX_BYTES) {
      sfx.ui('error');
      this.crNote(`That file is ${(file.size / 1048576).toFixed(0)} MB — `
        + `open something under ${K.ANTHEM_SOURCE_MAX_BYTES / 1048576} MB.`, 'error');
      return;
    }
    this.crNote('Decoding…');
    try {
      const ctx = initAudio();
      if (!ctx) throw new Error('this browser has no audio');
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      this.anthemDraft = { buffer: decoded, name: file.name };

      const room = Math.max(0, decoded.duration - rules.maxSeconds);
      const range = $('crTrimRange');
      range.max = String(Math.round(room * 10) / 10);
      range.value = '0';
      // A track already short enough has nothing to trim, and a disabled
      // slider under a heading that says START AT is a control asking to be
      // dragged and then refusing to move. The whole row goes instead.
      $('crTrimPick')?.classList.toggle('hidden', room <= 0);
      $('crTrimAt').textContent = '0.0s';
      $('crTrim').classList.remove('hidden');
      if (!$('crAnthemTitle').value) {
        $('crAnthemTitle').value = file.name.replace(/\.[^.]+$/, '').slice(0, K.ANTHEM_TITLE_MAX);
      }
      sfx.ui('ok');
      this.crNote(room > 0
        ? `${decoded.duration.toFixed(1)}s decoded — pick which ${rules.maxSeconds} seconds to use.`
        : `${decoded.duration.toFixed(1)}s decoded.`, 'ok');
    } catch (ex) {
      sfx.ui('error');
      this.crNote(`Could not read that file — ${ex.message || 'unsupported format'}.`, 'error');
      this.clearAnthemDraft();
    }
  }

  clearAnthemDraft() {
    this.anthemDraft = null;
    $('crTrim')?.classList.add('hidden');
    const file = $('crAnthemFile');
    if (file) file.value = '';
  }

  /**
   * Renders the chosen window down to mono at the server's rate, and uploads it.
   *
   * `OfflineAudioContext` does the resample, which is the right tool: it is the
   * browser's own high-quality resampler and it runs faster than real time. But
   * a context does not have to honour the rate it was asked for — Safari
   * historically ignored it — so the result is checked and resampled by hand if
   * it came back at something else. Uploading at the wrong rate would be
   * refused by the server with a message about sample rates, which is not a
   * sentence anybody should have to read.
   */
  async uploadAnthem() {
    const draft = this.anthemDraft;
    const rules = this.creatorState?.rules?.anthem;
    if (!draft || !rules) return;

    const btn = $('crAnthemUpload');
    btn.disabled = true;
    this.crNote('Encoding…');
    try {
      const start = Number($('crTrimRange').value) || 0;
      const seconds = Math.min(rules.maxSeconds, draft.buffer.duration - start);
      if (seconds < rules.minSeconds) throw new Error(`that leaves under ${rules.minSeconds}s`);

      const samples = await this.renderAnthemMono(draft.buffer, start, seconds, rules.sampleRate);
      const wav = encodeWav(samples, rules.sampleRate);
      this.crNote(`Uploading ${(wav.byteLength / 1024) | 0} KB…`);

      const r = await api.uploadAnthem(wav, $('crAnthemTitle').value);
      this.creatorState.creator = r.creator;
      this.clearAnthemDraft();
      sfx.ui('ok');
      // The levelling report, verbatim. "We turned your track down 19 dB" is
      // the one piece of feedback that stops the next upload being the same
      // track, louder — and hiding it would make the levelling feel like a bug.
      const lv = r.levelling;
      this.crNote(lv
        ? `Done — ${lv.seconds}s, levelled ${lv.gainDb > 0 ? '+' : ''}${lv.gainDb} dB `
          + `(peak ${lv.before.peakDb} → ${lv.after.peakDb} dB).`
        : 'Done.', 'ok');
      this.renderCreator();
    } catch (ex) {
      sfx.ui('error');
      this.crNote(ex.message || 'That did not upload.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * One channel of PCM at exactly `rate`, from a window of a decoded buffer.
   *
   * Mixed to mono by the OfflineAudioContext's own channel-count rule rather
   * than by averaging the channels here: a stereo track with a wide mix loses
   * less that way than it does to a naive L+R.
   */
  async renderAnthemMono(buffer, start, seconds, rate) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const frames = Math.max(1, Math.round(seconds * rate));
    const off = new OAC(1, frames, rate);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start(0, start, seconds);
    const rendered = await off.startRendering();
    const data = rendered.getChannelData(0);
    // The context honoured the rate: nothing else to do.
    if (Math.abs(rendered.sampleRate - rate) < 1) return data;

    // It did not. Linear resample by hand — the material is already
    // band-limited by the render above, so this is a rate correction rather
    // than a real downsample and linear is entirely adequate for it.
    const ratio = rendered.sampleRate / rate;
    const out = new Float32Array(Math.floor(data.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const at = i * ratio;
      const a = Math.floor(at);
      const b = Math.min(data.length - 1, a + 1);
      const t = at - a;
      out[i] = data[a] * (1 - t) + data[b] * t;
    }
    return out;
  }

  /** Plays the stored anthem back, through the same bus a kill cam uses. */
  async previewAnthem() {
    const url = this.creatorState?.creator?.anthem;
    if (!url) return;
    initAudio();
    const buffer = await loadAnthem(url);
    if (!buffer) { sfx.ui('error'); this.crNote('That track would not load.', 'error'); return; }
    playAnthem(buffer, { volume: Math.max(0.35, settings.anthemVolume) });
    this.crNote('Playing it back at your own anthem volume.', 'ok');
  }

  async removeAnthem() {
    const yes = await this.confirm({
      title: 'DELETE YOUR ANTHEM?',
      body: 'Your kill cam runs silent until you upload another.',
      ok: 'DELETE IT',
      danger: true,
    });
    if (!yes) return;
    try {
      stopAnthem(0.1);
      const r = await api.removeAnthem();
      this.creatorState.creator = r.creator;
      sfx.ui('ok');
      this.crNote('Removed.', 'ok');
      this.renderCreator();
    } catch (ex) {
      sfx.ui('error');
      this.crNote(ex.message || 'Could not remove it.', 'error');
    }
  }

  /* ── Skin commissions ───────────────────────────────────────────────────── */

  _bindBriefs() {
    $('crBriefNew')?.addEventListener('click', () => {
      sfx.ui();
      $('crBriefForm')?.classList.remove('hidden');
      $('crBriefNew')?.classList.add('hidden');
    });
    $('crBriefCancel')?.addEventListener('click', () => {
      sfx.ui();
      $('crBriefForm')?.classList.add('hidden');
      $('crBriefNew')?.classList.remove('hidden');
    });
    $('crBriefForm')?.addEventListener('submit', (e) => { e.preventDefault(); this.submitBrief(); });
  }

  renderBriefs(requests, creator, rules) {
    const open = requests.filter((r) => r.status === 'open').length;
    $('crSkinNote').textContent = `${open} of ${rules.skinRequest.openMax} open. `
      + 'A brief goes into a queue a human reads and answers.';

    const list = $('crBriefs');
    list.innerHTML = requests.length ? requests.map((r) => `
      <article class="cr-brief ${escapeHtml(r.status)}">
        <header><b>${escapeHtml(r.name)}</b><span>${escapeHtml(r.status.toUpperCase())}</span></header>
        <p>${escapeHtml(r.brief)}</p>
        <div class="cr-swatches">${r.palette.map((hex) =>
    `<i style="background:${escapeHtml(hex)}" title="${escapeHtml(hex)}"></i>`).join('')}</div>
        ${r.verdict ? `<p class="cr-verdict">${escapeHtml(r.verdict)}</p>` : ''}
        ${r.status === 'open'
    ? `<button type="button" class="btn-ghost small" data-withdraw-brief="${escapeHtml(r.id)}">WITHDRAW</button>`
    : ''}
      </article>`).join('') : '<p class="empty small">No briefs filed yet.</p>';

    /*
     * Full is full — but a button that has simply gone is a button somebody
     * looks for. It stays and says what the ceiling is, which is the same
     * sentence the route would have refused with; only the form being open
     * takes it off the screen, and that is because the form replaces it.
     */
    const full = open >= rules.skinRequest.openMax;
    const btn = $('crBriefNew');
    if (btn) {
      btn.classList.toggle('hidden', !$('crBriefForm').classList.contains('hidden'));
      btn.disabled = full;
      btn.textContent = full
        ? `${rules.skinRequest.openMax} OPEN BRIEFS IS THE LIMIT`
        : 'NEW BRIEF';
    }

    const slot = $('crBriefSlot');
    if (slot && !slot.options.length) {
      slot.innerHTML = rules.skinRequest.slots
        .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    }
    // The reference is one of this creator's *own* links, picked by platform —
    // never a URL typed into a box. Same rule as the card links.
    const ref = $('crBriefRef');
    if (ref) {
      ref.innerHTML = '<option value="">— none —</option>'
        + (creator.links ?? []).map((l) =>
          `<option value="${escapeHtml(l.platform)}">${escapeHtml(l.label)}</option>`).join('');
    }
    this.renderPalette();
  }

  /**
   * The palette editor: up to six swatches, each one on or off.
   *
   * Colour inputs rather than hex fields, because "#f5a623" is a spelling test
   * and a colour is a thing you look at. Three start on and the rest start off,
   * since most finishes are two or three colours and a brief that ships six by
   * default is a brief nobody chose the colours of — but every one of them can
   * be turned on, which the first version of this forgot: it drew three greyed
   * swatches with nothing to click.
   *
   * The × beside each is what toggles it. `data-off` is the state, read back by
   * `submitBrief`, so what is sent is exactly what is lit.
   */
  renderPalette() {
    const host = $('crPalette');
    if (!host || host.children.length) return;
    const seed = ['#f5a623', '#1a2230', '#e6edf6', '#ff7a2f', '#4ddb7a', '#b07cff'];
    for (const [i, hex] of seed.slice(0, this.creatorState.rules.skinRequest.paletteMax).entries()) {
      const label = document.createElement('label');
      label.className = 'cr-swatch';
      const input = document.createElement('input');
      input.type = 'color';
      input.value = hex;
      if (i > 2) input.setAttribute('data-off', '');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'cr-swatch-toggle';
      // The label follows the state. It used to read "Use this colour" on both
      // halves of a two-state control, so the × on a swatch that was already in
      // the brief looked like the way to *add* it.
      const say = () => {
        const on = !input.hasAttribute('data-off');
        toggle.textContent = on ? '\u00d7' : '+';
        toggle.title = on ? 'Take this colour out of the brief' : 'Put this colour in the brief';
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
        input.disabled = !on;
      };
      toggle.addEventListener('click', () => {
        if (input.hasAttribute('data-off')) input.removeAttribute('data-off');
        else input.setAttribute('data-off', '');
        say();
        sfx.ui();
      });
      say();
      label.append(input, toggle);
      host.appendChild(label);
    }
  }

  async submitBrief() {
    try {
      const palette = [...$('crPalette').querySelectorAll('input[type=color]')]
        .filter((i) => !i.hasAttribute('data-off')).map((i) => i.value);
      const r = await api.fileSkinRequest({
        name: $('crBriefName').value,
        slot: $('crBriefSlot').value,
        brief: $('crBriefText').value,
        palette,
        reference: $('crBriefRef').value || undefined,
      });
      sfx.ui('ok');
      this.crNote(`Filed “${r.request.name}”. Somebody will answer it here.`, 'ok');
      $('crBriefForm').classList.add('hidden');
      $('crBriefName').value = '';
      $('crBriefText').value = '';
      await this.refreshCreator({ quiet: true });
    } catch (ex) {
      sfx.ui('error');
      this.crNote(ex.message || 'That did not go through.', 'error');
    }
  }

  async withdrawBrief(id) {
    try {
      await api.withdrawSkinRequest(id);
      sfx.ui('ok');
      await this.refreshCreator({ quiet: true });
    } catch (ex) {
      sfx.ui('error');
      this.crNote(ex.message || 'Could not withdraw that.', 'error');
    }
  }

  /* ── Developer mode ─────────────────────────────────────────────────────────
   *
   * The tab is hidden outright below the level, so this page is only ever read
   * by somebody who can turn the thing on. It is a switch, a list of panels and
   * a sentence about what each reads.
   *
   * `game` is handed in by main.js after the handshake, because the *access* is
   * the server's answer and not something this file works out: the menu can
   * draw the page, and only the game knows whether the account may open it.
   * ─────────────────────────────────────────────────────────────────────────── */

  _bindDeveloper() {
    $('dvToggle')?.addEventListener('click', () => {
      sfx.ui();
      this.onDevToggle?.();
      this.renderDeveloper();
    });
    $('dvPanels')?.addEventListener('change', (e) => {
      const box = e.target.closest('input[data-dev-panel]');
      if (!box) return;
      const id = box.dataset.devPanel;
      const on = new Set(settings.devPanels ?? []);
      if (box.checked) on.add(id); else on.delete(id);
      setSetting('devPanels', K.DEV_PANEL_IDS.filter((p) => on.has(p)));
      sfx.ui();
    });
  }

  /**
   * Shows or hides the rail entry and draws the page.
   * @param {{allowed:boolean, pro:boolean, need:number, level:number, panels:string[]}} access
   * @param {boolean} open whether the overlay is on right now
   */
  setDevAccess(access, open = false) {
    // Called from three places — the session restore, the creator tab, and the
    // join handshake — and null from any of them means "not for this account",
    // which is also what a signed-out player is.
    this.devAccess = access ?? { allowed: false, pro: false, panels: [] };
    this.devOpen = !!open;
    const tab = document.querySelector('.tab[data-tab="developer"]');
    if (tab) {
      // Both, and they mean different things: `hidden` is what the rail draws
      // now, `data-locked` is what the filter must not undo.
      tab.dataset.locked = this.devAccess.allowed ? '0' : '1';
      tab.classList.toggle('hidden', !this.devAccess.allowed);
    }
    // A player demoted out of the tab while standing on it is sent somewhere
    // that exists rather than left looking at a page they may no longer read.
    if (!this.devAccess.allowed
        && document.querySelector('.tab-panel[data-panel="developer"].active')) {
      this.openTab('settings');
    }
    this.renderDeveloper();
  }

  renderDeveloper() {
    const access = this.devAccess;
    if (!access?.allowed) return;
    const btn = $('dvToggle');
    if (btn) {
      btn.textContent = this.devOpen ? 'TURN OFF' : 'TURN ON';
      btn.classList.toggle('btn-primary', !this.devOpen);
      btn.classList.toggle('btn-ghost', this.devOpen);
    }
    $('dvNote').textContent = access.pro
      ? 'Code creator — every panel, including the three the level gate does not open.'
      : `Unlocked at level ${access.need}. Three more panels come with code creator status.`;
    // `bindingLabel` takes the action, not a key: it already folds the keyboard
    // and mouse slots into one readable string and answers "—" for unbound.
    const bind = keys.bindingLabel('devMode');
    $('dvBind').textContent = bind === '—'
      ? 'Unbound — give it a key under CONTROLS to toggle the overlays mid-match.'
      : `Bound to ${bind} — change it under CONTROLS.`;

    const on = new Set(settings.devPanels ?? []);
    $('dvPanels').innerHTML = K.DEV_PANELS.map((panel) => {
      const locked = panel.pro && !access.pro;
      return `<label class="dv-panel${locked ? ' locked' : ''}">
        <input type="checkbox" data-dev-panel="${escapeHtml(panel.id)}"
               ${on.has(panel.id) ? 'checked' : ''}${locked ? ' disabled' : ''}>
        <span class="dv-panel-id"><b>${escapeHtml(panel.name)}</b>${
  panel.pro ? '<i>CODE CREATOR</i>' : ''}</span>
        <span class="dv-panel-note">${escapeHtml(panel.note)}</span>
      </label>`;
    }).join('');
  }
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

/**
 * An address as it is safe to leave on a screen somebody else can see.
 *
 * The first character of each side and the top-level domain survive, which is
 * enough for the owner to recognise their own address and not enough for anyone
 * watching to write it down. The run of bullets is clamped at both ends, so it
 * is never the length of the thing it is hiding either. Anything not shaped
 * like an address is masked whole rather than guessed at.
 */
function maskEmail(email) {
  const raw = String(email ?? '').trim();
  if (!raw) return '';
  const at = raw.lastIndexOf('@');
  if (at < 1 || at === raw.length - 1) return '\u2022'.repeat(Math.min(12, raw.length));
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const hide = (part, keep) => part.slice(0, keep)
    + '\u2022'.repeat(Math.max(1, Math.min(10, part.length - keep)));
  return `${hide(local, 1)}@${hide(host, 1)}${tld}`;
}

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

/**
 * Float samples to a canonical 16-bit mono WAV.
 *
 * The one format the server can read without an audio library — see the block
 * comment on anthems in shared/constants.js — written here rather than
 * anywhere clever because it is forty lines and a dependency for it would
 * weigh more than the whole sound engine.
 *
 * Nothing here is a safety measure: the server re-measures every sample and
 * rewrites the gain whatever this produced. What this file owes the server is a
 * file it can *parse*, and nothing more than that.
 *
 * @param {Float32Array} samples in [-1, 1]
 * @param {number} rate
 * @returns {ArrayBuffer}
 */
function encodeWav(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const ascii = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);            // PCM fmt chunk size
  view.setUint16(20, 1, true);             // WAVE_FORMAT_PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);      // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);

  for (let i = 0; i < n; i++) {
    // Clamped before scaling: a decoder is allowed to hand back samples past
    // full scale, and a wrapped Int16 is the loudest sound a computer can make.
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return buf;
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
 * The colour one player's card is painted in.
 *
 * Two sources, and the card itself picks between them. `custom` is a colour its
 * owner chose and is used exactly as given. `auto` — the default, and what
 * every account that has never opened the editor is on — reads the profile
 * picture and takes the colour the picture is *about*: the card ends up
 * matching the face on it without anybody having chosen anything.
 *
 * An account with no picture, or a picture the browser will not let us read,
 * falls back to the same name-derived colour its initials are drawn in. So
 * every card has a colour, and the same account always has the same one.
 */
async function cardAccent(user) {
  const card = user.card ?? K.CARD_DEFAULTS;
  if (card.accentMode === 'custom') return card.accent;
  if (user.avatar) {
    const found = await avatarAccent(user.avatar);
    if (found) return found;
  }
  return nameAccent(user.username);
}

/**
 * One value out of a profile, by the name the card catalogue calls it.
 *
 * Featured statistics are picked by their owner from a list that spans three
 * different objects — career stats, the account row, the daily streak — so this
 * is the one place that knows which is which. A stat whose section its owner
 * has hidden resolves to a dash rather than a zero: "not shared" and "none" are
 * different answers and a card that prints 0 for the first is telling a lie.
 */
function cardStat(id, user) {
  const s = user.stats;
  if (id === 'level') return String(user.level ?? 1);
  if (id === 'streak') return user.streak ? `${user.streak.days ?? 0}d` : '—';
  if (!s) return '—';
  switch (id) {
    case 'kd': return String(s.kd ?? 0);
    case 'accuracy': return `${s.accuracy ?? 0}%`;
    case 'playtime': return fmtDuration(s.playtime ?? 0);
    case 'bestStreak': return String(s.bestStreak ?? 0);
    default: return fmtNum(s[id] ?? 0);
  }
}

/** The heading a featured stat wears. */
const cardStatName = (id) =>
  (K.CARD_STATS.find((st) => st.id === id)?.name ?? id).toUpperCase();

/**
 * The sentence a hidden section gets instead of an empty box.
 *
 * Only the two sections that own a whole column of the card are in here. The
 * others — the clan tag, the streak, the join date — are pills in a row of
 * pills, and a row that is one pill shorter needs no explanation; a column that
 * is empty very much does.
 *
 * Named per section rather than one generic line, because "they have not shared
 * this" is only useful if you can tell *what* they have not shared.
 */
const HIDDEN_NOTE = {
  showStats: 'This player keeps their career stats private.',
  showMatches: 'This player keeps their match history private.',
};

/**
 * What the card offers this viewer, as buttons.
 *
 * Every one of them is drawn from what the *server* said is possible — `can`,
 * `relation` and `pending` — rather than from what the client can work out. A
 * button the route would refuse is worse than no button at all: it teaches
 * people that the card lies.
 */
function cardActions({ user, relation, can = {}, pending = {}, presence = null }) {
  if (relation === 'self') {
    return `<button class="pc-act primary" data-card-act="edit" type="button">
        ${icon('palette')}<span>CUSTOMISE THIS CARD</span></button>
      <button class="pc-act" data-card-act="privacy" type="button">
        ${icon('lock')}<span>WHO CAN SEE IT</span></button>`;
  }

  const out = [];

  // Joining comes first when it is on the table: it is the one button on this
  // card that is time-limited, and the reason most people opened it.
  if (presence?.room && can.join) {
    out.push(`<button class="pc-act primary" data-card-act="join" data-arg="${escapeHtml(presence.room)}" type="button">
      ${icon('play')}<span>JOIN THEIR MATCH</span></button>`);
  }

  if (relation === 'friend') {
    out.push(`<span class="pc-act flat" title="You are friends">${icon('userCheck')}<span>FRIENDS</span></span>`);
    out.push(`<button class="pc-act danger" data-card-act="unfriend" data-arg="${escapeHtml(user.id)}" type="button">
      ${icon('userX')}<span>REMOVE</span></button>`);
  } else if (pending.incoming) {
    out.push(`<button class="pc-act primary" data-card-act="accept" data-arg="${escapeHtml(user.id)}" type="button">
      ${icon('userCheck')}<span>ACCEPT REQUEST</span></button>`);
    out.push(`<button class="pc-act" data-card-act="decline" data-arg="${escapeHtml(user.id)}" type="button">
      ${icon('close')}<span>DECLINE</span></button>`);
  } else if (pending.outgoing) {
    out.push(`<button class="pc-act" data-card-act="cancel" data-arg="${escapeHtml(user.id)}" type="button">
      ${icon('userClock')}<span>REQUEST SENT — CANCEL</span></button>`);
  } else if (can.add) {
    out.push(`<button class="pc-act primary" data-card-act="add" data-arg="${escapeHtml(user.username)}" type="button">
      ${icon('userPlus')}<span>ADD FRIEND</span></button>`);
  } else if (api.isAuthed) {
    // They said no, or the server did. Same sentence either way — which of the
    // two it is, is a fact about their account they did not offer.
    out.push(`<span class="pc-act flat muted" title="Their settings do not allow it">
      ${icon('lock')}<span>NOT TAKING REQUESTS</span></span>`);
  } else {
    out.push(`<button class="pc-act" data-card-act="signin" type="button">
      ${icon('userPlus')}<span>SIGN IN TO ADD</span></button>`);
  }

  return out.join('');
}

/** The presence line, when its owner lets this viewer read it. */
function cardPresence(presence) {
  if (!presence) return '';
  if (presence.playing) {
    const where = [presence.mode, presence.map].filter(Boolean).map(escapeHtml).join(' · ');
    const tail = presence.room ? '' : presence.full ? ' — that room is full' : '';
    return `<span class="pc-live playing">${icon('bolt')}<b>IN A MATCH</b>${
      where ? `<i>${where}${tail}</i>` : ''}</span>`;
  }
  if (presence.online) return `<span class="pc-live online">${icon('user')}<b>IN THE MENU</b></span>`;
  return `<span class="pc-live off">${icon('clock')}<b>OFFLINE</b><i>last seen ${
    fmtAgo(presence.lastLogin)}</i></span>`;
}

/**
 * One public profile, as the card draws it.
 *
 * The card is painted in its owner's colour and wears their pattern, their
 * frame and their layout — everything the editor writes ends up as a data
 * attribute or a custom property here, so the CSS does the styling and this
 * function only ever decides *what* is on the card, never how it looks.
 *
 * What is on it is the server's decision, not this function's: a section the
 * owner hid never arrived, and `hidden` is what turns an absence into a
 * sentence rather than an empty box.
 */
function playerCardHtml(data, accent) {
  const { user, relation = 'none', hidden = [], recent = [] } = data;
  const card = user.card ?? K.CARD_DEFAULTS;
  const s = user.stats ?? {};
  const span = Math.max(1, (user.nextLevelXp ?? 1) - (user.levelXp ?? 0));
  const into = Math.max(0, (user.xp ?? 0) - (user.levelXp ?? 0));
  const pct = Math.max(0, Math.min(100, (into / span) * 100)).toFixed(1);
  const hid = new Set(hidden);

  const featured = (card.featured?.length ? card.featured : K.CARD_DEFAULTS.featured)
    .map((id) => `<div class="pc-big"><b>${escapeHtml(cardStat(id, user))}</b><span>${
      escapeHtml(cardStatName(id))}</span></div>`).join('');

  const cells = hid.has('showStats') ? '' : [
    ['SCORE', fmtNum(s.score ?? 0)], ['DEATHS', fmtNum(s.deaths ?? 0)],
    ['ASSISTS', fmtNum(s.assists ?? 0)], ['HEADSHOTS', fmtNum(s.headshots ?? 0)],
    ['ACCURACY', `${s.accuracy ?? 0}%`], ['DAMAGE', fmtNum(s.damage ?? 0)],
    ['MATCHES', fmtNum(s.matches ?? 0)], ['BEST STREAK', s.bestStreak ?? 0],
    ['PLAYTIME', fmtDuration(s.playtime ?? 0)],
  ].map(([k, v]) => `<div class="pc-cell"><b>${v}</b><span>${k}</span></div>`).join('');

  const matches = recent.slice(0, 6).map((m) => `
    <div class="pcm-row ${m.won ? 'won' : 'lost'}">
      <span class="pcm-flag">${m.won ? 'W' : 'L'}</span>
      <span class="pcm-map">${escapeHtml(m.map)}<i>${escapeHtml(String(m.mode).toUpperCase())}</i></span>
      <span class="pcm-kd">${m.kills}<i>/</i>${m.deaths}</span>
      <span class="pcm-score">${fmtNum(m.score)}<i>pts</i></span>
      <span class="pcm-when">${fmtAgo(m.started_at)}</span>
    </div>`).join('');

  const pills = [
    user.creator ? `<span class="pill creator ${escapeHtml(user.creator.kind)}">${
      escapeHtml(String(user.creator.kindName).toUpperCase())} CREATOR</span>` : '',
    `<span class="pill">${escapeHtml(String(user.role ?? 'player').toUpperCase())}</span>`,
    hid.has('showJoined') || !user.createdAt ? '' : `<span class="pill">JOINED ${fmtDate(user.createdAt)}</span>`,
    user.clan ? `<span class="pill${user.clanVerified ? ' gold' : ''}">CLAN ${escapeHtml(user.clan)}${
      user.clanVerified ? ' · VERIFIED' : ''}</span>` : '',
    !hid.has('showStreak') && user.streak?.days
      ? `<span class="pill">${user.streak.days}-DAY STREAK</span>` : '',
  ].join('');

  return `
  <div class="pc-shell" style="--pc-accent:${escapeHtml(accent)}"
       data-pattern="${escapeHtml(card.pattern)}" data-intensity="${escapeHtml(card.intensity)}"
       data-layout="${escapeHtml(card.layout)}" data-frame="${escapeHtml(card.frame)}"
       data-glow="${card.glow ? 'on' : 'off'}">
    <div class="pc-banner">
      <span class="pc-pattern" aria-hidden="true"></span>
      <div class="pc-hero">
        <span class="pc-avatar av-frame">
          <img class="av-img hidden" alt="" width="112" height="112"><span class="av-initial">?</span>
        </span>
        <div class="pc-id">
          <h3>${clanTag(user.clan, user.clanVerified)}<span class="pc-name">${escapeHtml(user.username)}</span>${
  user.verified ? '<img class="verified big" src="/check.png" alt="verified" width="18" height="18">' : ''}</h3>
          ${card.title ? `<p class="pc-flair">${escapeHtml(card.title)}</p>` : ''}
          <div class="ph-tags">${pills}</div>
          ${cardPresence(data.presence)}
          <div class="pc-xp">
            <span class="pc-lv"><b>${user.level}</b><small>LEVEL</small></span>
            <span class="pc-bar"><i style="width:${pct}%"></i></span>
            <span class="pc-xp-num">${fmtNum(into)} / ${fmtNum(span)} XP</span>
          </div>
        </div>
        <div class="pc-headline">${featured}</div>
      </div>
      ${card.bio ? `<p class="pc-bio">${escapeHtml(card.bio)}</p>` : ''}
      ${creatorStrip(user.creator)}
      <div class="pc-actions">${cardActions(data)}</div>
    </div>

    <div class="pc-cols">
      <section class="pc-col">
        <h4 class="pc-sub">${icon('medal')}CAREER</h4>
        ${cells
    ? `<div class="pc-grid">${cells}</div>`
    : `<p class="empty small">${HIDDEN_NOTE.showStats}</p>`}
      </section>
      <section class="pc-col">
        <h4 class="pc-sub">${icon('clock')}RECENT MATCHES</h4>
        ${hid.has('showMatches')
    ? `<p class="empty small">${HIDDEN_NOTE.showMatches}</p>`
    : matches
      ? `<div class="pcm-list">${matches}</div>`
      : '<p class="empty small">No matches on record yet.</p>'}
      </section>
    </div>
  </div>`;
}

/**
 * A creator's links, and their anthem, on their card.
 *
 * ── Why every one of these is a plain anchor with a confirm in front of it ──
 *
 * These are the only outbound links in the game, and they are put there by one
 * player and clicked by another. Three rules follow from that and none of them
 * is optional:
 *
 *  · The URL is *built by the server* out of a platform id and a handle, never
 *    sent as a URL. `link.url` here is already the output of `creatorLinkUrl`
 *    in shared/constants.js, and a link whose pair did not make a valid URL
 *    never arrived. Nothing a player typed reaches this function as a scheme.
 *  · What is *shown* is the handle, not the address — so a display string can
 *    never disagree with a destination, which is the whole of how a link is
 *    normally made to lie.
 *  · `noopener noreferrer` on every one, because a tab opened from here must
 *    not be able to reach back into the game's, and where somebody came from
 *    is nobody's business but theirs.
 *
 * The interstitial is bound in `_bindPlayerCard`: clicking says where you are
 * going before it takes you.
 */
function creatorStrip(creator) {
  if (!creator || creator.status !== 'approved') return '';
  const links = (creator.links ?? []).filter((l) => l.url);
  if (!links.length && !creator.anthem) return '';

  const anthem = creator.anthem
    ? `<span class="pc-anthem">${icon('note')}<b>${escapeHtml(creator.anthemTitle || 'Untitled')}</b>
       <small>PLAYS ON THEIR KILLS</small></span>`
    : '';
  const list = links.map((l) => `<a class="pc-link" href="${escapeHtml(l.url)}"
      target="_blank" rel="noopener noreferrer nofollow"
      data-external="${escapeHtml(l.url)}">${icon('link')}<span>${escapeHtml(l.label)}</span></a>`).join('');

  return `<div class="pc-creator ${escapeHtml(creator.kind)}">
    <span class="pc-creator-kind">${escapeHtml(String(creator.kindName).toUpperCase())} CREATOR</span>
    ${anthem}
    ${list ? `<div class="pc-links">${list}</div>` : ''}
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export default Menu;
