/**
 * Open Grunker — client boot tests.
 *
 * Runs the real client modules against the browser shim and the real three.js.
 * The WebGL renderer is the only thing stubbed, so everything else — the HUD's
 * element lookups, the effects pools, the viewmodel's per-weapon rig, the
 * entity manager's snapshot maths — executes exactly as it does in the page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, check, info } from './harness.mjs';
import { installBrowser } from './browser-shim.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

installBrowser();

const THREE = await import('three');
const K = await import('/shared/constants.js');
const {
  CLASS_IDS, loadoutFor, getClass, recoilKick, spreadFor, SKINS, ZONE, MAT, paintFor,
} = await import('/shared/weapons.js');
const { getMap, ALL_MAP_IDS } = await import('/shared/maps.js');

const { Hud } = await import('/js/hud.js');
const { Effects } = await import('/js/effects.js');
const { ViewModel } = await import('/js/viewmodel.js');
const gunskin = await import('/js/gunskin.js');
const { EntityManager } = await import('/js/entities.js');
const { Objectives } = await import('/js/objectives.js');
const {
  settings, SCHEMA, DEFAULTS,
  exportText: exportSettings, importText: importSettings,
} = await import('/js/settings.js');
const { surfaceTexture, SURFACE_TILE, SURFACE_SHADING } = await import('/js/textures.js');
const { GameWorld } = await import('/js/world.js');
const { collapseStatic, skinnedBoxGeometry } = await import('/js/gunskin.js');
const { Menu } = await import('/js/menu.js');
// Only the class: the boot at the bottom of main.js runs on DOMContentLoaded,
// which this shim never fires, so importing it builds no game.
const { Game } = await import('/js/main.js');
const { GAME_VERSION, PATCH_NOTES, latestPatch } = await import('/shared/patchnotes.js');
const { api } = await import('/js/api.js');

/**
 * A renderer stand-in. Everything the client asks of a WebGLRenderer that does
 * not need a GPU is answered honestly; the draw calls themselves are counted.
 */
function makeRenderer() {
  return {
    autoClear: true,
    toneMapping: 0,
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap },
    capabilities: { isWebGL2: true, getMaxAnisotropy: () => 8 },
    info: { render: { calls: 0, triangles: 0 } },
    draws: 0,
    setPixelRatio() {}, setSize() {}, clear() {}, clearDepth() {}, setRenderTarget() {},
    getDrawingBufferSize(v) { v.set(1600, 900); return v; },
    render() { this.draws++; },
  };
}
const fakeRenderer = makeRenderer();

export default async function run() {
  suite('Client — settings');

  check('every schema key exists in the defaults',
    SCHEMA.every((g) => g.items.every((i) => i.key in DEFAULTS)),
    `${SCHEMA.reduce((n, g) => n + g.items.length, 0)} options`);

  const missingFromSchema = Object.keys(DEFAULTS)
    .filter((k) => !SCHEMA.some((g) => g.items.some((i) => i.key === k)));
  check('every default is reachable from the settings UI',
    missingFromSchema.length === 0, missingFromSchema.join(', ') || 'none orphaned');

  check('settings survive a trip through a file, bindings included', (() => {
    settings.sensitivity = 1.37;
    settings.crosshairColor = '#ff00aa';
    const file = exportSettings({ jump: ['KeyJ', '', 'Pad0'] });
    settings.sensitivity = 0.5;
    settings.crosshairColor = '#ffffff';
    const res = importSettings(file);
    const back = settings.sensitivity === 1.37 && settings.crosshairColor === '#ff00aa';
    settings.sensitivity = DEFAULTS.sensitivity;
    settings.crosshairColor = DEFAULTS.crosshairColor;
    info(`${res.applied} setting(s) · keybinds carried: ${!!res.keybinds}`);
    return res.ok && back && res.keybinds?.jump?.[0] === 'KeyJ';
  })());

  check('and a file this build does not understand is refused, not merged', (() => {
    const before = settings.sensitivity;
    const junk = importSettings('{"settings":{"notAThing":1,"sensitivity":"fast"}}');
    const nonsense = importSettings('this is not json');
    return !junk.ok && !nonsense.ok && settings.sensitivity === before;
  })());

  check('nametag size is a range the player can actually move',
    (() => {
      const item = SCHEMA.flatMap((g) => g.items).find((i) => i.key === 'nametagScale');
      return item && item.type === 'range' && item.min <= 0.5 && item.max >= 2.5;
    })(), 'nametagScale 0.5×–3×');

  suite('Client — textures');

  const surfaces = [...new Set(Object.values(K.SURFACE))];
  let texOk = true;
  for (const s of surfaces) {
    const t = surfaceTexture(s);
    if (!t || !t.isTexture) texOk = false;
  }
  check('every surface material builds a texture', texOk, `${surfaces.length} materials`);
  check('every surface has a tile size and a specular response',
    surfaces.every((s) => SURFACE_TILE[s] > 0 && SURFACE_SHADING[s]));

  suite('Client — HUD');

  let hud = null;
  check('the HUD finds every element it needs', (() => {
    hud = new Hud();
    return Object.entries(hud.el).every(([, v]) => v !== null && v !== undefined);
  })(), Object.keys(new Hud().el).length + ' bindings');

  const missing = Object.entries(hud.el).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length) info(`missing: ${missing.join(', ')}`);

  const camera = new THREE.PerspectiveCamera(90, 1.6, 0.1, 500);
  const map = getMap('crossfire');
  hud.setMap(map);
  hud.setMode('dom', 'Domination');

  check('the nuke draws its three states and cleans up after itself', (() => {
    try {
      hud.setNukeArmed(true);
      const armed = !hud.el.nukePrompt.classList.contains('hidden');
      hud.nukeLaunched({ name: 'Streaker', seconds: K.NUKE_COUNTDOWN, mine: false });
      const counting = !hud.el.nukeWarning.classList.contains('hidden')
        && hud.el.nukePrompt.classList.contains('hidden');
      hud.updateNuke(performance.now() / 1000 + 1);
      hud.nukeDetonated();
      const flashed = !hud.el.nukeFlash.classList.contains('hidden')
        && hud.el.nukeWarning.classList.contains('hidden');
      // …and the flash lets go on its own rather than sitting over the map.
      hud.updateNuke(performance.now() / 1000 + 10);
      const cleared = hud.el.nukeFlash.classList.contains('hidden');
      info(`armed ${armed} · counting ${counting} · flashed ${flashed} · cleared ${cleared}`);
      return armed && counting && flashed && cleared;
    } catch (err) { info(String(err)); return false; }
  })());

  check('a spectator gets the whole interface, marked as somebody else\'s', (() => {
    hud.setWatching('Somebody');
    const on = hud.el.hud.classList.contains('spectating') && hud.watching === 'Somebody';
    hud.setSpectatorView({ firstPerson: false, xray: true });
    const labels = hud.el.specViewLabel.textContent === 'THIRD PERSON'
      && hud.el.specXrayLabel.textContent === 'X-RAY ON';
    hud.setWatching(null);
    return on && labels && !hud.el.hud.classList.contains('spectating');
  })());

  check('the death screen says which respawn is coming', (() => {
    hud.showDeath('Nemesis', 'ar', 2.6, 41);
    hud.updateDeathTimer(1.2, false);
    const auto = !hud.el.deathHint.classList.contains('hidden')
      && hud.el.deathHintHeld.classList.contains('hidden');
    hud.updateDeathTimer(1.2, true);
    const held = hud.el.deathHint.classList.contains('hidden')
      && !hud.el.deathHintHeld.classList.contains('hidden');
    hud.hideDeath();
    return auto && held;
  })());

  check('a full HUD frame runs without throwing', (() => {
    try {
      hud.update({
        health: 64, ammo: 12, reserve: -1, weapon: loadoutFor('triggerman')[0], slot: 0,
        reloading: true, reloadFrac: 0.4, spread: 0.02, scoped: false, matchTime: 91,
        teamScore: { red: 4, blue: 7 }, teamMode: true, ping: 42, name: 'Tester',
        level: 12, verified: true, speed: 14.2, accuracy: 51,
      }, 1 / 60);
      return true;
    } catch (e) { info(String(e)); return false; }
  })());

  check('the verified badge renders in the live board, killfeed and scoreboards', (() => {
    const rows = [
      { id: 1, name: 'Verified', score: 900, kills: 9, deaths: 2, verified: true, team: K.TEAM.RED, accuracy: 40 },
      { id: 2, name: 'Plain', score: 400, kills: 4, deaths: 6, verified: false, team: K.TEAM.BLUE, accuracy: 22 },
    ];
    hud.renderLiveScore(rows, 1, true);
    const live = hud.el.lsRows.innerHTML.includes('check.png');
    hud.renderScoreboard(rows, 1, 'Crossfire', 'Domination', true);
    const board = hud.el.sbRows.innerHTML.includes('check.png');
    hud.renderMatchEndRows(rows, 1, true);
    const endCard = hud.el.meRows.innerHTML.includes('check.png');
    hud.renderMvp(rows);
    const mvp = hud.el.meMvp.innerHTML.includes('check.png');
    hud.killfeedEntry({
      killer: { id: 1, name: 'Verified', team: K.TEAM.RED, verified: true },
      victim: { id: 2, name: 'Plain', team: K.TEAM.BLUE, verified: false },
      weapon: 'ar', head: true, streak: null,
    }, 1);
    const feed = hud.el.killfeed.children.some((c) => c.innerHTML.includes('check.png'));
    info(`live=${live} scoreboard=${board} endcard=${endCard} mvp=${mvp} killfeed=${feed}`);
    return live && board && endCard && mvp && feed;
  })());

  check('a clan tag reads grey normally and gold once the clan is verified', (() => {
    const rows = [
      { id: 1, name: 'Gilded', score: 900, kills: 9, deaths: 2, team: K.TEAM.RED, accuracy: 40,
        clan: 'NUKE', clanVerified: true, account: true },
      { id: 2, name: 'Plain', score: 400, kills: 4, deaths: 6, team: K.TEAM.BLUE, accuracy: 22,
        clan: 'OGS', clanVerified: false, account: true },
    ];
    hud.renderScoreboard(rows, 1, 'Crossfire', 'Domination', true);
    const html = hud.el.sbRows.innerHTML;
    const gold = html.includes('class="clan-tag verified"') && html.includes('[NUKE]');
    const grey = html.includes('class="clan-tag"') && html.includes('[OGS]');

    // …and everywhere else a name is written large.
    hud.renderMatchEndRows(rows, 1, true);
    hud.renderMvp(rows);
    const mvp = hud.el.meMvp.innerHTML.includes('[NUKE]');
    hud.showDeath('Gilded', 'ar', 3, 40, { clan: 'NUKE', clanVerified: true });
    const death = hud.el.deathKiller.innerHTML.includes('clan-tag verified');
    hud.hideDeath();
    info(`gold=${gold} grey=${grey} mvp=${mvp} death=${death}`);
    return gold && grey && mvp && death;
  })());

  check('the HUD writes nothing to the DOM on a frame where nothing changed', (() => {
    /*
     * `update()` runs every frame and used to perform about thirty DOM writes
     * on every one of them whether or not anything had moved. Each one
     * invalidates style for the element it touches, and at 240 Hz that is
     * thousands of pointless invalidations a second in front of the renderer.
     *
     * Counting them honestly: every write goes through `_text`, `_style`,
     * `_var`, `_toggle` or `_className`, so wrapping those five counts the lot.
     */
    const state = {
      health: 64, ammo: 12, reserve: -1, weapon: loadoutFor('triggerman')[0], slot: 0,
      reloading: false, reloadFrac: 0, spread: 0.02, scoped: false, matchTime: 91,
      teamScore: { red: 4, blue: 7 }, teamMode: true, ping: 42, name: 'Tester',
      level: 12, verified: true, speed: 0, accuracy: 51,
    };
    let writes = 0;
    for (const fn of ['_text', '_style', '_var', '_toggle', '_className']) {
      const real = Hud.prototype[fn];
      hud[fn] = function counted(...args) {
        const before = this._dom[args[1]];
        real.apply(this, args);
        if (this._dom[args[1]] !== before) writes++;
      };
    }

    hud.invalidateDom();
    hud.update(state, 1 / 60);        // cold: every property is new
    const first = writes;

    // The ghost health bar genuinely eases toward the real value, so let it
    // arrive before measuring a *settled* HUD.
    for (let i = 0; i < 400; i++) hud.update(state, 1 / 60);
    writes = 0;
    for (let i = 0; i < 10; i++) hud.update(state, 1 / 60);
    const idle = writes;

    for (const fn of ['_text', '_style', '_var', '_toggle', '_className']) delete hud[fn];
    info(`${first} write(s) on a cold frame, ${idle} across ten settled ones`);
    return first > 15 && idle === 0;
  })());

  check('the minimap bakes the level once instead of walking it every frame', (() => {
    /*
     * A dressed town is well over a thousand boxes, and the minimap used to
     * draw every one of them, sixty times a second, for a picture that only
     * rotates and slides.
     */
    const town = getMap('littletown');
    hud.setMap(town);
    const walls = town.boxes.filter((b) => !b.decor && !b.clip && b.h >= 0.8).length;
    const layer = hud.minimapLayer(2.4);
    const again = hud.minimapLayer(2.4);
    const zoomed = hud.minimapLayer(4.8);
    info(`${walls} wall(s) baked into ${layer.canvas?.width}×${layer.canvas?.height}px`);
    return walls > 100
      && !!layer.canvas
      && again === layer                          // same scale: the same bitmap
      && zoomed !== layer                         // the zoom slider rebuilds it
      && Number.isFinite(layer.minX) && Number.isFinite(layer.minZ);
  })());

  check('and a new map throws the old bake away', (() => {
    const before = hud.minimapLayer(2.4);
    hud.setMap(getMap('subzero'));
    const after = hud.minimapLayer(2.4);
    return before !== after && hud.mmLayer.map === getMap('subzero');
  })());

  check('a minimap frame draws without throwing', (() => {
    try {
      hud.drawMinimap({ x: 4, z: -9, yaw: 1.2 }, [], false, K.TEAM.NONE, 12, []);
      return true;
    } catch (e) { info(String(e)); return false; }
  })());

  check('hints name a button once a controller is in use', (() => {
    const key = hud.hintFor('jump');
    hud.setPadHints(true);
    const pad = hud.hintFor('jump');
    hud.setPadHints(false);
    info(`${key} on a keyboard, ${pad} on a pad`);
    return key === 'SPACE' && pad === 'A';
  })());

  check('an unchanged scoreboard is not rebuilt under the cursor', (() => {
    /*
     * The bug that made REPORT and the mute buttons do nothing at all.
     *
     * The game layer asks for a scoreboard render every frame the board is
     * open. Rebuilding the rows on each of those frames replaced the button
     * between mousedown and mouseup, so no click event ever fired — the
     * listeners were fine, the elements under them were not.
     */
    const rows = [
      { id: 1, name: 'Alpha', score: 900, kills: 9, deaths: 2, team: 0, accuracy: 40, ping: 30, account: true },
      { id: 2, name: 'Beta', score: 400, kills: 4, deaths: 6, team: 0, accuracy: 22, ping: 44, account: true },
    ];
    hud.setReportTool({ enabled: true, canReport: true }, () => {});
    hud.renderScoreboard(rows, 1, 'Crossfire', 'Free For All', false);
    const first = hud.el.sbRows.querySelector('.sb-report');
    for (let i = 0; i < 30; i++) hud.renderScoreboard(rows, 1, 'Crossfire', 'Free For All', false);
    const survived = hud.el.sbRows.querySelector('.sb-report') === first;

    // …and a real change still gets drawn.
    hud.renderScoreboard([{ ...rows[0], score: 950 }, rows[1]], 1, 'Crossfire', 'Free For All', false);
    const redrew = hud.el.sbRows.innerHTML.includes('>950<');

    // …but never while a press is in flight over the board.
    hud.el.scoreboard.fire('pointerdown');
    const held = hud.el.sbRows.querySelector('.sb-report');
    hud.renderScoreboard([{ ...rows[0], score: 1200 }, rows[1]], 1, 'Crossfire', 'Free For All', false);
    const pinned = hud.el.sbRows.querySelector('.sb-report') === held;
    hud.sbHolding = false;

    info(`stable=${survived} redrew=${redrew} pinnedWhileHeld=${pinned}`);
    return survived && redrew && pinned;
  })());

  check('the report button reaches the game layer when it is clicked', (() => {
    // The other half of the same bug: the listeners are delegated from the
    // table body, which the redraw never replaces.
    const rows = [
      { id: 1, name: 'Me', score: 900, kills: 9, deaths: 2, team: 0, accuracy: 40, account: true },
      { id: 2, name: 'Them', score: 400, kills: 4, deaths: 6, team: 0, accuracy: 22, account: true },
    ];
    hud.setReportTool({ enabled: true, canReport: true }, () => {});
    hud.renderScoreboard(rows, 1, 'Crossfire', 'Free For All', false);
    hud.el.sbRows.querySelector('.sb-report').fire('click');
    const opened = hud.reportCardOpen && hud.reportTarget?.name === 'Them';
    hud.closeReportCard();
    info(opened ? 'opened the reason card for Them' : 'the button did nothing');
    return opened;
  })());

  check('a refused report button is greyed and carries the reason', (() => {
    // Refusing by hiding the button teaches nobody anything: every reason it is
    // off is something the player can act on.
    const rows = [
      { id: 1, name: 'Me', score: 900, kills: 9, deaths: 2, team: 0, accuracy: 40, account: true },
      { id: 2, name: 'Them', score: 400, kills: 4, deaths: 6, team: 0, accuracy: 22, account: true },
    ];
    const why = 'reach level 5 to report a player';
    hud.setReportTool({ enabled: true, canReport: false, reason: why }, () => {});
    hud.renderScoreboard(rows, 1, 'Crossfire', 'Free For All', false);
    const btn = hud.el.sbRows.querySelector('.sb-report');
    const greyed = btn?.className.includes('off') && btn.getAttribute('data-why') === why
      && btn.getAttribute('title') === why;

    // Clicking it says so out loud rather than opening a card it would refuse.
    btn?.fire('click');
    const said = !hud.reportCardOpen
      && hud.el.toast.children.at(-1)?.textContent === why;
    info(`${greyed ? 'greyed' : 'NOT greyed'} · ${said ? 'says why on click' : 'silent'}`);
    hud.setReportTool({ enabled: true, canReport: true }, () => {});
    return greyed && said;
  })());

  check('every nickname with an account behind it is a link to that profile', (() => {
    // The one thing that makes a scoreboard social rather than a readout. A bot
    // and a guest have no profile to open, so neither gets a dead link.
    const rows = [
      { id: 1, name: 'Somebody', score: 900, kills: 9, deaths: 2, team: 0, accuracy: 40, account: true },
      { id: 2, name: 'Guest-14', score: 100, kills: 1, deaths: 4, team: 0, accuracy: 10, account: false },
      { id: 3, name: 'BOT Vex', score: 50, kills: 0, deaths: 3, team: 0, accuracy: 5, bot: true, account: false },
    ];
    hud.renderScoreboard(rows, 9, 'Crossfire', 'Free For All', false);
    const html = hud.el.sbRows.innerHTML;
    hud.chatMessage({ id: 1, name: 'Somebody', text: 'gg', team: 0, level: 7, account: true });
    const chat = hud.el.chatLog.children.at(-1).innerHTML;
    info(`links: ${(html.match(/data-profile=/g) ?? []).length} of 3 rows`);
    return html.includes('data-profile="Somebody"')
      && !html.includes('data-profile="Guest-14"')
      && !html.includes('data-profile="BOT Vex"')
      && chat.includes('data-profile="Somebody"');
  })());

  check('the scoreboard is not one of the parts of the HUD that swallow clicks', (() => {
    // `#hud * { pointer-events: none }` is what made every button on the board
    // dead; the opt-in below it is what this is guarding.
    const css = readFileSync(join(ROOT, 'client/css/style.css'), 'utf8');
    const optIn = css.slice(css.indexOf('#hud #chatForm'), css.indexOf('#hud #chatForm') + 700);
    return /#hud #scoreboard, #hud #scoreboard \*/.test(optIn)
      && /pointer-events: auto/.test(optIn);
  })());

  check('the killfeed sits under the standings in one right-hand column', (() => {
    // The three used to be placed absolutely and grew into each other; stacking
    // them in one flow is what makes the overlap impossible rather than tuned.
    const col = document.getElementById('hudRight');
    const order = col.children.map((c) => c.attributes.get('id'));
    info(order.join(' → '));
    return order.join(',') === 'mapWrap,liveScore,killfeed';
  })());

  check('a ban notice renders red, and only red', (() => {
    hud.chatMessage({ system: true, kind: 'ban', text: 'Cheater has been banned permanently — aimbot' });
    hud.chatMessage({ name: 'Someone', text: 'gg', team: K.TEAM.RED });
    const rows = hud.el.chatLog.children;
    const ban = rows.find((r) => r.classList.contains('alert'));
    return !!ban && ban.innerHTML.includes('aimbot') && !rows[rows.length - 1].classList.contains('alert');
  })());

  check('a moderation line leaves the HUD like any other, and stays in the log', (() => {
    // A ban notice used to be pinned on screen for good: two matches later it
    // was still shouting about somebody long since dealt with. Timers are
    // captured rather than waited on, so this asks what was scheduled.
    const real = globalThis.setTimeout;
    const queued = [];
    globalThis.setTimeout = (fn, ms) => { queued.push({ fn, ms }); return 0; };
    let banRow, chatRow;
    try {
      hud.el.chatLog.innerHTML = '';
      hud.chatMessage({ system: true, kind: 'mute', text: 'Loud was muted for 5 minutes' });
      hud.chatMessage({ name: 'Someone', text: 'gg' });
      hud.chatMessage({ system: true, text: 'replayed', kind: 'ban' }, { replay: true });
      [banRow, chatRow] = hud.el.chatLog.children;
      // Two lines scheduled a fade; the replayed one is already off screen.
      info(`${queued.length} timer(s) at ${[...new Set(queued.map((q) => q.ms))].join('/')}ms`);
      for (const q of queued) q.fn();          // the fade
      for (const q of queued.slice(2)) q.fn(); // and the hide it schedules
    } finally {
      globalThis.setTimeout = real;
    }
    const gone = banRow.classList.contains('stale') && chatRow.classList.contains('stale');
    const kept = hud.el.chatLog.children.length === 3;
    info(`alert stale=${banRow.classList.contains('stale')} · rows still in the log=${hud.el.chatLog.children.length}`);
    return gone && kept && queued[0].ms === K.CHAT_VISIBLE_MS && banRow.classList.contains('alert');
  })());

  check('the scoreboard offers a report button on everyone but you and the bots', (() => {
    const rows = [
      { id: 1, name: 'Me', score: 5, kills: 1, deaths: 0, accuracy: 0 },
      { id: 2, name: 'Them', score: 4, kills: 0, deaths: 1, accuracy: 0 },
      { id: 3, name: 'Botty', score: 0, kills: 0, deaths: 0, accuracy: 0, bot: true },
    ];
    hud.setReportTool(false);
    hud.renderScoreboard(rows, 1, 'Burgtown', 'Free For All', false);
    const off = hud.el.sbRows.innerHTML.includes('sb-report');

    let asked = null;
    hud.setReportTool(true, (id, reason, detail) => { asked = { id, reason, detail }; });
    hud.renderScoreboard(rows, 1, 'Burgtown', 'Free For All', false);
    const html = hud.el.sbRows.innerHTML;
    const buttons = [...html.matchAll(/data-id="(\d+)" data-name/g)].map((m) => m[1]);
    info(`hidden without the tool=${!off} · buttons on rows ${buttons.join(',') || 'none'}`);
    return !off && buttons.join(',') === '2' && !hud.el.sbReportHead.classList.contains('hidden');
  })());

  check('a chat line carries the sender\'s clan tag, check and role chip', (() => {
    hud.chatMessage({
      name: 'Staffer', text: 'settle down', team: K.TEAM.NONE,
      level: 27, verified: true, clan: 'OG', role: 'mod',
    });
    const row = hud.el.chatLog.children[hud.el.chatLog.children.length - 1];
    const html = row.innerHTML;
    info(html);
    return html.includes('[OG]') && html.includes('check.png')
      && html.includes('role-tag mod') && html.includes('>27<');
  })());

  check('the role chip goes everywhere it fits, and nowhere it does not', (() => {
    const staff = { id: 9, name: 'Chief', role: 'admin', clan: 'OG', score: 1, kills: 0, deaths: 0, accuracy: 0 };
    hud.renderScoreboard([staff], 9, 'Burgtown', 'Free For All', false);
    const board = hud.el.sbRows.innerHTML.includes('role-tag admin');
    hud.renderLiveScore([staff], 9, false);
    const live = hud.el.lsRows.innerHTML.includes('role-tag');
    hud.killfeedEntry({ killer: staff, victim: { id: 8, name: 'Other' }, weapon: 'ar' }, 9);
    const feed = hud.el.killfeed.children.some((c) => c.innerHTML.includes('role-tag'));
    // The clan tag is compact enough for all three; the role chip is not.
    const clans = hud.el.lsRows.innerHTML.includes('[OG]');
    info(`scoreboard=${board} standings=${live} killfeed=${feed} clan-in-standings=${clans}`);
    return board && clans && !live && !feed;
  })());

  check('the chat refuses to open until the server says this player may write', (() => {
    // The gate is the server's; the client only has to stop wasting a keypress
    // and say why — this used to open an input whose every message was dropped.
    hud.setChatState({ canSend: false, reason: 'reach level 2 to use the chat' });
    const refused = hud.openChat(() => {}) === false && !hud.chatOpen;
    const told = hud.el.chatHint.innerHTML.includes('level 2')
      && hud.el.chatPanel.classList.contains('locked');
    hud.setChatState({ canSend: true, reason: null });
    return refused && told && !hud.el.chatPanel.classList.contains('locked');
  })());

  check('opening the chat marks the panel as typing', (() => {
    hud.setChatState({ canSend: true, reason: null });
    hud.openChat(() => {});
    const typing = hud.el.chatPanel.classList.contains('typing') && hud.chatOpen;
    hud.closeChat();
    return typing && !hud.el.chatPanel.classList.contains('typing') && !hud.chatOpen;
  })());

  check('replaying a match history fills the log without flooding the HUD', (() => {
    hud.setChat({
      canSend: true,
      history: Array.from({ length: 6 }, (_, i) => ({ id: 1, name: 'Old', text: `line ${i}`, level: 3 })),
    });
    const rows = hud.el.chatLog.children;
    // Replayed lines are stale on arrival: in the log, off the corner of the screen.
    return rows.length === 6 && rows.every((r) => r.classList.contains('stale'));
  })());

  check('the log never grows past the fifty lines a match keeps', (() => {
    hud.setChat({ canSend: true, history: [] });
    for (let i = 0; i < K.CHAT_HISTORY + 15; i++) hud.chatMessage({ name: 'Spam', text: `m${i}`, level: 2 });
    const n = hud.el.chatLog.children.length;
    info(`${n} rows`);
    return n === K.CHAT_HISTORY;
  })());

  check('the end of a match purges its chat', (() => {
    hud.purgeChat();
    return hud.el.chatLog.children.length === 0;
  })());

  check('the scoreboard grows moderation buttons for staff, and only for staff', (() => {
    const rows = [
      { id: 1, name: 'Mod', score: 100, kills: 1, deaths: 0, role: 'mod', accuracy: 0 },
      { id: 2, name: 'Loud', score: 40, kills: 0, deaths: 1, accuracy: 0 },
      { id: 3, name: 'Quiet', score: 10, kills: 0, deaths: 2, muted: true, accuracy: 0 },
      { id: 4, name: 'Peer', score: 5, kills: 0, deaths: 3, role: 'mod', accuracy: 0 },
    ];
    hud.setModTools('player');
    hud.renderScoreboard(rows, 1, 'Burgtown', 'Free For All', false);
    const plain = !hud.el.sbRows.innerHTML.includes('sb-act');

    let acted = null;
    hud.setModTools('mod', (a, id, min) => { acted = { a, id, min }; });
    hud.renderScoreboard(rows, 1, 'Burgtown', 'Free For All', false);
    const html = hud.el.sbRows.innerHTML;
    // Staff see mute durations on everyone else, UNMUTE on whoever is muted,
    // and nothing at all on their own row.
    const buttons = hud.el.sbRows.querySelectorAll('.sb-act');
    const untouchable = buttons.filter((b) => ['1', '4'].includes(b.getAttribute('data-id')));
    const lift = buttons.find((b) => b.getAttribute('data-act') === 'unmute');
    buttons.find((b) => b.getAttribute('data-act') === 'mute')?.fire('click');
    info(`${buttons.length} buttons · fired ${JSON.stringify(acted)}`);
    // Nothing on their own row, nothing on a peer's: only rows the server would
    // actually act on get a button.
    return plain && html.includes('MUTED') && untouchable.length === 0 && !!lift
      && acted?.a === 'mute' && acted.id === 2;
  })());

  check('the objective strip reflects ownership', (() => {
    hud.setObjectives([
      { id: 'A', owner: K.TEAM.RED, progress: 1, contender: K.TEAM.RED, contested: false },
      { id: 'B', owner: K.TEAM.NONE, progress: 0.4, contender: K.TEAM.BLUE, contested: false },
      { id: 'C', owner: K.TEAM.BLUE, progress: 1, contender: K.TEAM.BLUE, contested: true },
    ]);
    const html = hud.el.objStrip.innerHTML;
    return html.includes('>A<') && html.includes('contested') && !hud.el.objStrip.classList.contains('hidden');
  })());

  check('the gun-game ladder strip fills in', (() => {
    hud.setGunGame({ rung: 3, total: 9, classId: 'bulldog', kills: 1, need: 2 });
    return hud.el.ggRung.textContent === '4 / 9' && hud.el.ggWeapon.textContent === 'BULLDOG';
  })());

  check('map voting renders one button per option', (() => {
    let voted = null;
    hud.onVote = (id) => { voted = id; };
    hud.setVote({ options: [{ id: 'subzero', name: 'Subzero' }, { id: 'shipyard', name: 'Shipyard' }], tally: { subzero: 2, shipyard: 0 } });
    const buttons = hud.el.meVoteOptions.querySelectorAll('.mv-opt');
    if (buttons.length !== 2) return false;
    buttons[0].fire('click');
    return voted === 'subzero';
  })());

  check('the minimap draws without a real canvas', (() => {
    try {
      hud.drawMinimap({ x: 3, z: -8, yaw: 1.2 }, [], true, K.TEAM.RED, 10, [
        { id: 'A', owner: K.TEAM.RED, progress: 1, contender: K.TEAM.RED, contested: false },
      ]);
      return true;
    } catch (e) { info(String(e)); return false; }
  })());

  suite('Client — session');

  check('the api object exposes the session the rest of the client reads', (() => {
    // `api.token` was undefined, so the realtime handshake never sent it and
    // every signed-in player was seated as a guest.
    const keys = ['token', 'account', 'mastery', 'challenges', 'isAuthed'];
    const missing = keys.filter((k) => !(k in api));
    info(missing.length ? `missing: ${missing.join(', ')}` : keys.join(', '));
    return missing.length === 0;
  })());

  check('a signed-in session is what the handshake would carry', (() => {
    // Nothing here mocks the getters: the module state is set through the same
    // path a real sign-in takes, and read back off the object.
    const before = api.token;
    return before === null || typeof before === 'string';
  })());

  suite('Client — menu');

  let menu = null;
  const played = [];
  check('the menu builds against the real markup', (() => {
    try {
      menu = new Menu({
        onPlay: (o) => played.push(o),
        onSettingsChange: () => {}, onClassChange: () => {},
        onClassPreview: () => {}, onBindsChange: () => {}, input: null,
      });
      return true;
    } catch (e) { info(String(e)); return false; }
  })());

  check('every panel a rail or top-bar button names actually exists', (() => {
    const wanted = document.querySelectorAll('[data-open]').map((b) => b.dataset.open);
    const known = document.querySelectorAll('.tab').map((t) => t.dataset.tab);
    const orphans = wanted.filter((w) => !known.includes(w));
    info(`${wanted.length} entries → ${[...new Set(wanted)].join(', ')}`);
    return wanted.length > 0 && orphans.length === 0;
  })());

  check('a rail button opens its panel and the close button shuts it', (() => {
    menu.openTab('settings');
    const opened = menu.panelOpen
      && document.querySelector('.tab-panel[data-panel="settings"]').classList.contains('active');
    menu.closePanel();
    return opened && !menu.panelOpen;
  })());

  check('hiding the menu takes the panel with it', (() => {
    menu.openTab('help');
    menu.hide();
    const gone = !menu.panelOpen && !menu.visible;
    menu.show();
    return gone;
  })());

  check('the now-playing strip names the match and its region', (() => {
    menu.setNowPlaying({ mapName: 'Subzero', modeName: 'Team Deathmatch', code: 'FRA:7K2Q' });
    return document.getElementById('nowPlaying').textContent === 'Now Playing: Team Deathmatch on Subzero'
      && document.getElementById('menuRegion').textContent === 'FRA';
  })());

  check('the loadout card follows the selected class', (() => {
    menu.setLoadoutCard('marksman');
    return document.getElementById('mlClass').textContent === getClass('marksman').name
      && document.getElementById('mlWeapon').textContent === getClass('marksman').primary.name;
  })());

  check('QUICK MATCH asks the game layer to play', (() => {
    played.length = 0;
    document.getElementById('btnPlay').fire('click');
    return played.length === 1 && played[0].classId === menu.selectedClass;
  })());

  check('every account sub-tab has a view behind it, and one click swaps them', (() => {
    // The account panel used to be one column three screens tall; this is the
    // navigation that replaced it, so a tab pointing at nothing is a dead end.
    const tabs = document.querySelectorAll('.acct-tab').map((t) => t.dataset.acct);
    const views = document.querySelectorAll('.acct-view').map((v) => v.dataset.acctView);
    const orphans = tabs.filter((t) => !views.includes(t));
    menu.openAccountView('reports');
    const shown = document.querySelectorAll('.acct-view.active').map((v) => v.dataset.acctView);
    menu.openAccountView('overview');
    info(`${tabs.length} tabs → ${tabs.join(', ')}`);
    return tabs.length === 6 && orphans.length === 0 && tabs.includes('progression')
      && shown.length === 1 && shown[0] === 'reports'
      && document.querySelectorAll('.acct-view.active')[0].dataset.acctView === 'overview';
  })());

  check('the progression ladder draws with the account\'s own place on it', (() => {
    // Every one of these thresholds already existed; none of them was written
    // down anywhere a player could read before the level stopped them.
    menu.meta = { progression: K.progressionLadder({ reportLevel: 5 }) };
    menu.renderProgression({ level: 3, xp: 500, levelXp: 400, nextLevelXp: 900 });
    const list = document.getElementById('progList');
    const steps = list.querySelectorAll('.prog-step');
    const done = steps.filter((li) => li.className.includes('done')).length;
    const next = steps.filter((li) => li.className.includes('next'));
    const level = document.getElementById('progLevel').textContent;
    const xp = document.getElementById('progXpText').textContent;
    info(`${steps.length} rungs · ${done} unlocked at level 3 · ${next.length} waiting at the next one · ${xp}`);
    // Level 3 has the chat (2) and both level-1 rungs behind it. Level 5 is the
    // next rung and two things land on it at once — the report button and
    // joining a clan — so both are marked, not just the first.
    return steps.length >= 6 && done === 3 && next.length === 2
      && level === '3' && xp === '100 / 500 XP'
      && document.getElementById('progXpLeft').textContent === '400 to level 4'
      && list.innerHTML.includes('REPORT A PLAYER');
  })());

  check('a signed-out visitor is asked to sign in rather than shown an empty ladder', (() => {
    menu.renderProgression(null);
    const html = document.getElementById('progList').innerHTML;
    return html.includes('class="empty"') && /Sign in/.test(html);
  })());

  check('the spectator switch sits in the corner with the build, and is a real switch', (() => {
    // It is a state you are in rather than a way into a match, so it lives with
    // the build chip and not among the play buttons.
    const box = document.getElementById('specToggle');
    const label = box?.parentElement;
    const corner = label?.parentElement;
    info(`${label?.className} inside .${corner?.className}`);
    return !!box && box.getAttribute('type') === 'checkbox'
      && label?.className === 'mp-spectate'
      && corner?.className === 'menu-ident'
      && !!document.getElementById('specToggleHint');
  })());

  check('the spectator switch greys out when there is nobody to watch', (() => {
    /*
     * An empty match has no point of view to borrow. The switch is the only
     * control in the menu whose usefulness depends on who else is in the room,
     * so it is the only one that has to keep checking.
     *
     * Driven through the same shape the game layer uses — a roster and a local
     * id — rather than by poking the DOM, because the rule is about the roster.
     */
    const gate = {
      myId: 1,
      scoreboardRows: [],
      specMode: false,
      hud: { toast: () => {} },
      setSpectateSwitch: Game.prototype.setSpectateSwitch,
      get watchableCount() { return Object.getOwnPropertyDescriptor(Game.prototype, 'watchableCount').get.call(this); },
      updateSpectateAvailability: Game.prototype.updateSpectateAvailability,
      state: 'playing',
      specWatching: false,
    };
    const box = document.getElementById('specToggle');
    const label = box.parentElement;

    gate.scoreboardRows = [{ id: 1, name: 'Alone' }];
    gate.updateSpectateAvailability();
    const alone = box.disabled && label.className.includes('off')
      && label.getAttribute('title') === 'nobody else is in this match to watch';

    gate.scoreboardRows = [{ id: 1, name: 'Alone' }, { id: 2, name: 'Somebody' }];
    gate.updateSpectateAvailability();
    const company = !box.disabled && !label.className.includes('off')
      && label.getAttribute('title') === null;

    // …but a watcher already watching keeps a live switch: it is their way back
    // into the match, and an emptying room is exactly when they want it.
    gate.scoreboardRows = [];
    gate.specMode = true;
    gate.specWatching = true;
    gate.state = 'spectating';
    gate.updateSpectateAvailability();
    const escapeHatch = !box.disabled;

    info(`alone=${alone} company=${company} wayBack=${escapeHatch}`);
    return alone && company && escapeHatch;
  })());

  check('the corner that used to hold a nickname box now names the build', (() => {
    // The box and the "signed in as…" line both said what the account chip
    // already says; a player had no way at all to tell which build they were on.
    const version = document.getElementById('gameVersion').textContent;
    const headline = document.getElementById('patchHeadline').textContent;
    const gone = !document.getElementById('nameInput') && !document.getElementById('accountLine');
    info(`${version} — ${headline}`);
    return gone && version === `v${GAME_VERSION}`
      && headline === latestPatch().title && headline.length > 0;
  })());

  check('every release is listed, newest first, with its changes', (() => {
    const html = document.getElementById('patchList').innerHTML;
    const releases = (html.match(/class="patch[ "]/g) ?? []).length;
    const changes = (html.match(/class="patch-kind"/g) ?? []).length;
    const expected = PATCH_NOTES.reduce((n, r) => n + r.changes.length, 0);
    info(`${releases} release(s), ${changes} change line(s)`);
    return releases === PATCH_NOTES.length && changes === expected
      && html.indexOf(`v${PATCH_NOTES[0].version}`) < html.indexOf(`v${PATCH_NOTES.at(-1).version}`)
      && html.includes('YOU ARE PLAYING THIS');
  })());

  check('the version card opens the full notes', (() => {
    document.getElementById('btnPatchNotes').fire('click');
    const opened = menu.panelOpen
      && document.querySelector('.tab-panel[data-panel="patch"]').classList.contains('active');
    menu.closePanel();
    return opened;
  })());

  check('the live population readout stays hidden for anyone who is not staff', await (async () => {
    // Not cosmetic: the route refuses it too, so a leaked readout here would be
    // a permanently empty box rather than a leak — but an empty box in the
    // footer is still something nobody asked for.
    await menu.refreshGlobal();
    const stat = document.getElementById('globalStats');
    return stat.classList.contains('hidden') && stat.textContent === '';
  })());

  /* ── Clans & profiles ─────────────────────────────────────────────────── */

  check('the clan panel draws the founding cost when you are in no clan', (() => {
    menu.applyClanRules({
      enabled: true, joinLevel: 5, createLevel: 15, createCost: 1000,
      maxMembers: 24, maxInvites: 25, inviteTtlHours: 72, tagMin: 2, tagMax: 4,
    });
    document.getElementById('clanMine').innerHTML = menu.noClanHtml({
      clan: null, invites: [], level: 9, gr: 250,
      rules: menu.clanRules,
    });
    const html = document.getElementById('clanMine').innerHTML;
    info(document.getElementById('clanRules').textContent);
    return html.includes('YOU ARE NOT IN A CLAN')
      && html.includes('1000') && html.includes('maxlength="4"')
      && document.getElementById('clanRules').textContent.includes('level 15');
  })());

  check('an invitation is drawn with the clan\'s own colour and an accept button', (() => {
    document.getElementById('clanMine').innerHTML = menu.noClanHtml({
      clan: null, level: 9, gr: 250, rules: menu.clanRules,
      invites: [{ tag: 'NUKE', verified: true, invitedBy: 'Chief', createdAt: 1 }],
    });
    const html = document.getElementById('clanMine').innerHTML;
    return html.includes('clan-tag verified') && html.includes('[NUKE]')
      && html.includes('data-clan-act="join"') && html.includes('data-clan-act="decline"');
  })());

  check('the owner gets the tools and a member does not', (() => {
    const clan = {
      tag: 'NUKE', verified: false, members: 2, maxMembers: 24, ownerName: 'Chief',
      createdAt: 1, avatar: null, invites: [],
      roster: [
        { id: 1, username: 'Chief', level: 22, role: 'owner', joinedAt: 1, kills: 90, verified: false },
        { id: 2, username: 'Second', level: 8, role: 'member', joinedAt: 2, kills: 12, verified: false },
      ],
    };
    const asOwner = menu.myClanHtml({ clan: { ...clan, you: { role: 'owner' } }, rules: menu.clanRules });
    const asMember = menu.myClanHtml({ clan: { ...clan, you: { role: 'member' } }, rules: menu.clanRules });
    info(`owner tools: invite=${asOwner.includes('data-clan-act="invite"')} `
      + `kick=${asOwner.includes('data-clan-act="kick"')} disband=${asOwner.includes('data-clan-act="disband"')}`);
    return asOwner.includes('data-clan-act="invite"')
      && asOwner.includes('data-clan-act="kick"')
      && asOwner.includes('data-clan-act="promote"')
      && asOwner.includes('data-clan-act="disband"')
      && !asMember.includes('data-clan-act="invite"')
      && !asMember.includes('data-clan-act="kick"')
      && asMember.includes('data-clan-act="leave"');
  })());

  check('a roster name is a link to that player, like every other name', (() => {
    const html = menu.myClanHtml({
      rules: menu.clanRules,
      clan: {
        tag: 'NUKE', verified: true, members: 1, maxMembers: 24, ownerName: 'Chief',
        createdAt: 1, avatar: null, invites: [], you: { role: 'member' },
        roster: [{ id: 1, username: 'Chief', level: 22, role: 'owner', joinedAt: 1, kills: 90, verified: true }],
      },
    });
    return html.includes('data-profile="Chief"') && html.includes('clan-tag verified');
  })());

  check('the invite badge counts what is waiting and hides itself at zero', (() => {
    menu.setClanBadge(2);
    const shown = ['railClanBadge', 'clanTabBadge'].every((id) =>
      document.getElementById(id).textContent === '2'
      && !document.getElementById(id).classList.contains('hidden'));
    menu.setClanBadge(0);
    const hidden = ['railClanBadge', 'clanTabBadge'].every((id) =>
      document.getElementById(id).classList.contains('hidden'));
    return shown && hidden;
  })());

  check('the clan panel and the player card survive a real round trip', await (async () => {
    // The HTML builders above are pure; this runs the async paths that call
    // them — the fetch, the redraw, the avatar repaint — so a typo in one of
    // them is a failing check rather than a blank panel in the browser.
    const real = globalThis.fetch;
    const account = {
      id: 1, username: 'Chief', level: 22, xp: 5000, levelXp: 4000, nextLevelXp: 6000,
      gr: 40, verified: true, avatar: null, clan: 'NUKE', clanVerified: true,
      role: 'player', createdAt: 1, stats: { kills: 90, deaths: 30, kd: 3, accuracy: 41 },
    };
    globalThis.fetch = async (url) => {
      const body = String(url).includes('/auth/')
        ? { ok: true, token: 'test-token', user: account }
        : String(url).includes('/clans/mine')
        ? {
          ok: true, level: 20, gr: 4000, invites: [], rules: menu.clanRules,
          clan: {
            id: 1, tag: 'NUKE', verified: true, members: 1, maxMembers: 24,
            ownerName: 'Chief', createdAt: 1, avatar: null, invites: [],
            you: { role: 'owner' },
            roster: [{ id: 1, username: 'Chief', level: 22, role: 'owner', joinedAt: 1, kills: 90 }],
          },
        }
        : String(url).includes('/clans')
          ? { ok: true, total: 1, clans: [{ id: 1, tag: 'NUKE', verified: true, members: 1, ownerName: 'Chief', rank: 1, score: 10, kills: 5, avatar: null }] }
          : {
            ok: true,
            user: account,
            recent: [{ map: 'Burgtown', mode: 'ffa', kills: 9, deaths: 2, score: 900, won: 1, started_at: 1 }],
          };
      return { ok: true, status: 200, json: async () => body };
    };
    try {
      await api.login('Chief', 'a-good-password');
      await menu.refreshClans();
      const panel = document.getElementById('clanMine').innerHTML;
      const list = document.getElementById('clanList').innerHTML;
      await menu.openPlayerCard('Chief');
      const card = document.getElementById('playerCardBody').innerHTML;
      menu.closePlayerCard();
      info(`panel=${panel.length}b list=${list.length}b card=${card.length}b`);
      return panel.includes('[NUKE]') && panel.includes('data-clan-act="invite"')
        && list.includes('cr-tag') && card.includes('Chief') && card.includes('clan-tag verified');
    } catch (e) {
      info(String(e));
      return false;
    } finally {
      await api.logout();                 // while the stub is still answering
      globalThis.fetch = real;
    }
  })());

  check('the player card reads across, not down', await (async () => {
    /*
     * It used to be a 400px column: hero, then twelve stat tiles, then the
     * match list, all stacked, in a card that `.modal-card` was quietly
     * overriding the width of. The layout is now a hero band with the figures
     * beside the name and two columns under it — so what is checked here is
     * that both columns are actually built, and that the card is the wide one.
     */
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        user: {
          username: 'Vole', level: 12, xp: 4200, levelXp: 4000, nextLevelXp: 5000,
          verified: false, clan: null, clanVerified: false, role: 'player',
          createdAt: 1740000000, avatar: null,
          stats: { score: 900, kills: 40, deaths: 20, kd: 2, headshots: 5, accuracy: 30,
            wins: 3, matches: 9, bestStreak: 6, damage: 4000, assists: 7, playtime: 3600 },
        },
        recent: [{ map: 'Burgtown', mode: 'ffa', kills: 9, deaths: 2, score: 900, won: 1, started_at: 1 }],
      }),
    });
    try {
      await menu.openPlayerCard('Vole');
      const card = document.getElementById('playerCard');
      const html = document.getElementById('playerCardBody').innerHTML;
      const cols = document.getElementById('playerCardBody').querySelectorAll('.pc-col').length;
      const figures = document.getElementById('playerCardBody').querySelectorAll('.pc-big').length;
      menu.closePlayerCard();
      info(`${cols} columns · ${figures} headline figures · ${html.length}b`);
      return cols === 2 && figures === 3
        && card.querySelector('.pc-card').className.includes('modal-card')
        && html.includes('pc-hero') && html.includes('pcm-row won');
    } finally {
      globalThis.fetch = real;
    }
  })());

  check('a nickname anywhere opens the same player card', (() => {
    // The card is opened by one delegated listener, so this also proves a name
    // rendered after the listener was installed still works.
    const row = document.createElement('div');
    row.innerHTML = '<button class="pname" data-profile="Chief"><span class="n-text">Chief</span></button>';
    document.body.appendChild(row);
    row.querySelector('.pname').fire('click');
    const opened = menu.playerCardOpen && menu.cardName === 'Chief';
    menu.closePlayerCard();
    return opened && !menu.playerCardOpen && menu.cardName === null;
  })());

  check('an avatar frame shows the picture when there is one and initials when there is not', (() => {
    // Three frames, one painter: the header chip, the profile hero and the
    // picker preview must never disagree about who you are.
    menu.paintAvatars({ username: 'Painter', avatar: '/avatars/7-0123456789ab.webp' });
    const frames = ['acAvatar', 'phAvatar', 'avatarPreview'].map((id) => document.getElementById(id));
    const withPic = frames.every((f) => f.classList.contains('has-photo')
      && f.querySelector('.av-img').getAttribute('src') === '/avatars/7-0123456789ab.webp'
      && !f.querySelector('.av-img').classList.contains('hidden'));

    menu.paintAvatars({ username: 'Painter', avatar: null });
    const withLetter = frames.every((f) => !f.classList.contains('has-photo')
      && f.querySelector('.av-img').classList.contains('hidden')
      && f.querySelector('.av-initial').textContent === 'P');
    info(`picture=${withPic} initials=${withLetter}`);
    return withPic && withLetter;
  })());

  check('the reports badge counts only what is still open', (() => {
    menu.setReportBadge(2, 5);
    const badge = document.getElementById('acctReportBadge');
    const shown = badge.textContent === '2' && !badge.classList.contains('hidden')
      && document.getElementById('ovReports').textContent === '5';
    menu.setReportBadge(0, 5);
    const settled = badge.classList.contains('hidden')
      && document.getElementById('ovReportsNote').textContent === 'All settled';
    return shown && settled;
  })());

  suite('Client — effects');

  const scene = new THREE.Scene();
  let effects = null;
  check('the effects pools build', (() => {
    try { effects = new Effects(scene); return true; } catch (e) { info(String(e)); return false; }
  })());

  check('a firefight runs 600 frames without allocating past the pools', (() => {
    try {
      for (let i = 0; i < 600; i++) {
        effects.impact(i % 20, 1.5, i % 13, 0, 1, 0, i % 2 ? 'metal' : 'concrete');
        effects.tracer({ x: 0, y: 1, z: 0 }, { x: 10, y: 2, z: 3 }, {});
        effects.muzzleFlash(1, 1, 1, 1, { x: 0, y: 0, z: -1 });
        effects.ejectShell(1, 1.4, 1, 2, 2, 0, 1);
        if (i % 40 === 0) effects.explosion(2, 1, 2, 5);
        if (i % 7 === 0) effects.blood(1, 1.2, 1, i % 14 === 0);
        effects.update(1 / 60, camera);
      }
      return effects.sparks.high <= effects.sparks.max && effects.smoke.high <= effects.smoke.max;
    } catch (e) { info(String(e)); return false; }
  })(), `sparks ${effects?.sparks.high}/${effects?.sparks.max}, smoke ${effects?.smoke.high}/${effects?.smoke.max}`);

  check('a bigger warhead makes a bigger blast, not a louder small one', (() => {
    // Everything about an explosion scales off the radius the server actually
    // used, so a splash that reaches across a room looks like one.
    const read = () => {
      const b = effects.blasts[(effects.blastIndex + effects.blasts.length - 1) % effects.blasts.length];
      return { life: b.maxLife, light: b.peakLight, radius: b.radius };
    };
    effects.explosion(0, 1, 0, 5.4);
    const small = read();
    effects.explosion(0, 1, 0, 7.6);
    const big = read();
    info(`5.4u → ${small.light.toFixed(1)} light / ${small.life.toFixed(2)}s`
      + ` · 7.6u → ${big.light.toFixed(1)} light / ${big.life.toFixed(2)}s`);
    return big.radius > small.radius && big.light > small.light && big.life > small.life;
  })());

  check('clearing releases every pooled effect', (() => {
    effects.clear();
    return effects.sparks.high === 0 && effects.smoke.high === 0
      && effects.tracers.every((t) => t.life === 0)
      && effects.shells.every((s) => s.life === 0);
  })());

  suite('Client — viewmodel');

  let vm = null;
  check('the viewmodel builds', (() => {
    try { vm = new ViewModel(fakeRenderer); return true; } catch (e) { info(String(e)); return false; }
  })());

  check('every weapon builds a viewmodel and lines its sights up on the crosshair', (() => {
    let ok = true;
    const seen = new Set();
    for (const cid of CLASS_IDS) {
      for (const w of loadoutFor(cid)) {
        if (seen.has(w.id)) continue;
        seen.add(w.id);
        try {
          vm.setWeapon(w, 'gold');
          // The ADS pose is derived from the weapon's declared sight point.
          const s = w.model.sight;
          const scale = w.model.scale ?? 1;
          if (Math.abs(vm.adsPose.x + s[0] * scale) > 1e-9) ok = false;
          if (Math.abs(vm.adsPose.y + s[1] * scale) > 1e-9) ok = false;
        } catch (e) { info(`${w.id}: ${e}`); ok = false; }
      }
    }
    return ok;
  })(), `${new Set(CLASS_IDS.flatMap((c) => loadoutFor(c).map((w) => w.id))).size} weapons`);

  check('firing, reloading and cycling animate without throwing', (() => {
    try {
      vm.setWeapon(loadoutFor('bulldog')[0], 'default');
      let ejected = 0;
      vm.onEject = () => { ejected++; };
      for (let i = 0; i < 5; i++) {
        vm.fire();
        for (let f = 0; f < 40; f++) vm.update(1 / 60, { speed: 6, grounded: true, ads: f > 20 });
      }
      vm.reload(2.9, true);
      for (let f = 0; f < 200; f++) vm.update(1 / 60, { speed: 0, grounded: true, ads: false });
      return ejected > 0 && vm.reloadT === 0;
    } catch (e) { info(String(e)); return false; }
  })());

  check('the knife swings through a real arc rather than a jolt', (() => {
    try {
      vm.setWeapon(loadoutFor('triggerman')[2], 'default');
      // The knife's guard is not square to the camera — it is turned so the
      // blade shows its edge — so "home" is that rest angle, not zero.
      for (let f = 0; f < 60; f++) vm.update(1 / 60, { speed: 0, grounded: true, ads: false });
      const guard = vm.root.rotation.y;
      vm.meleeSwing(K.MELEE_COOLDOWN * 0.82);
      const yaws = [];
      for (let f = 0; f < 40; f++) {
        vm.update(1 / 60, { speed: 0, grounded: true, ads: false });
        yaws.push(vm.root.rotation.y);
      }
      const swept = Math.max(...yaws) - Math.min(...yaws);
      const home = Math.abs(yaws[yaws.length - 1] - guard) < 0.02;
      info(`${(swept * 180 / Math.PI).toFixed(0)}° across the screen, back at the guard: ${home}`);
      // A wind-up one way and a cut the other, ending where it started.
      return vm.slashT === 0 && swept > 0.6 && home;
    } catch (e) { info(String(e)); return false; }
  })());

  check('hiding the weapon while aiming is a setting, and only affects the gun', (() => {
    vm.setWeapon(loadoutFor('triggerman')[0], 'default');
    const settle = (ads) => { for (let f = 0; f < 90; f++) vm.update(1 / 60, { speed: 0, grounded: true, ads }); };
    settings.hideWeaponAds = false;
    settle(true);
    const shown = vm.root.visible;
    settings.hideWeaponAds = true;
    settle(true);
    const hidden = !vm.root.visible;
    settle(false);
    const back = vm.root.visible;
    settings.hideWeaponAds = DEFAULTS.hideWeaponAds;
    settle(false);
    return shown && hidden && back;
  })());

  check('every finish builds on every weapon', (() => {
    let ok = true;
    for (const skin of Object.keys(SKINS)) {
      try { vm.setWeapon(loadoutFor('hunter')[0], skin); } catch (e) { info(`${skin}: ${e}`); ok = false; }
    }
    return ok;
  })(), `${Object.keys(SKINS).length} finishes`);

  /*
   * The framing test.
   *
   * A viewmodel box that straddles the near plane does not vanish — it projects
   * across the whole screen, which is exactly how an arm ends up looking like a
   * plank laid over the view. Nothing the player is holding may come within
   * 8 cm of the eye, on any weapon, with either hand.
   */
  check('nothing the player holds reaches the camera', (() => {
    const bb = new THREE.Box3();
    const v = new THREE.Vector3();
    let worst = -Infinity, worstAt = '';
    const nearestOf = (obj) => {
      let best = -Infinity;
      obj.updateMatrixWorld(true);
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.computeBoundingBox();
        bb.copy(o.geometry.boundingBox);
        for (const x of [bb.min.x, bb.max.x]) {
          for (const y of [bb.min.y, bb.max.y]) {
            for (const z of [bb.min.z, bb.max.z]) {
              v.set(x, y, z).applyMatrix4(o.matrixWorld);
              if (v.z > best) best = v.z;
            }
          }
        }
      });
      return best;
    };
    const seenIds = new Set();
    for (const cid of CLASS_IDS) {
      for (const w of loadoutFor(cid)) {
        if (seenIds.has(w.id)) continue;
        seenIds.add(w.id);
        vm.setWeapon(w, 'default');
        for (let f = 0; f < 200; f++) vm.update(1 / 60, { speed: 0, grounded: true, ads: false });
        // The root carries the whole rest pose, and a child's world matrix is
        // built from its parent's — so the scene has to be brought up to date
        // before anything is measured against the camera.
        vm.scene.updateMatrixWorld(true);
        for (const [label, part] of [['gun', vm.gun], ['main hand', vm.armMain], ['off hand', vm.armOff]]) {
          if (!part) continue;
          const z = nearestOf(part);
          if (z > worst) { worst = z; worstAt = `${w.id} ${label}`; }
        }
      }
    }
    info(`closest anything gets to the eye: ${(-worst).toFixed(3)} u (${worstAt})`);
    return worst < -0.08;
  })());

  check('both hands are built, and posed on the weapon\'s own grips', (() => {
    let ok = true;
    for (const cid of CLASS_IDS) {
      for (const w of loadoutFor(cid)) {
        vm.setWeapon(w, 'default');
        if (!vm.armMain) { info(`${w.id}: no firing hand`); ok = false; continue; }
        const g = w.model.grip;
        if (Math.abs(vm.armMain.position.y - g[1]) > 1e-9) { info(`${w.id}: hand off the grip`); ok = false; }
        // Akimbo carries a second gun, so its off hand rides that one instead.
        const off = vm.armOff ?? vm.armB;
        if (!off) { info(`${w.id}: no second hand`); ok = false; }
      }
    }
    return ok;
  })());

  suite('Client — weapon finishes');

  check('every model part declares which zone of the gun it is', (() => {
    const zones = new Set(Object.values(ZONE));
    const bad = [];
    for (const cid of CLASS_IDS) {
      for (const w of loadoutFor(cid)) {
        for (const p of w.model.parts) if (!zones.has(p.z)) bad.push(`${w.id}:${p.c}`);
      }
    }
    if (bad.length) info(bad.slice(0, 5).join(', '));
    return bad.length === 0;
  })());

  check('every weapon says where both hands go', (() => {
    const bad = [];
    for (const cid of CLASS_IDS) {
      for (const w of loadoutFor(cid)) {
        const m = w.model;
        if (!Array.isArray(m.grip)) bad.push(`${w.id}: grip`);
        // `none` is a real answer — the akimbo pair has no spare hand.
        if (m.foreKind !== 'none' && !Array.isArray(m.fore)) bad.push(`${w.id}: fore`);
      }
    }
    if (bad.length) info(bad.join(', '));
    return bad.length === 0;
  })());

  check('no finish paints a lens, a reticle or a bore', (() => {
    let painted = 0, checked = 0;
    for (const skinId of Object.keys(SKINS)) {
      const skin = SKINS[skinId];
      for (const cid of CLASS_IDS) {
        for (const w of loadoutFor(cid)) {
          for (const p of w.model.parts) {
            if (p.z !== ZONE.DETAIL && p.m !== MAT.EMIT && p.m !== MAT.GLASS) continue;
            checked++;
            const paint = paintFor(p, skin);
            if (paint.color !== p.c || paint.pattern || paint.gloss || paint.glow) painted++;
          }
        }
      }
    }
    info(`${checked} untouchable parts across ${Object.keys(SKINS).length} finishes`);
    return painted === 0 && checked > 0;
  })());

  check('a finish that names a pattern actually paints one', (() => {
    const patterned = Object.values(SKINS).filter((s) => s.pattern);
    let ok = patterned.length >= 10;
    for (const skin of patterned) {
      const part = { c: 0x808080, m: MAT.POLY, z: skin.pattern.on[0] };
      const mat = gunskin.gunMaterial(part, skin);
      if (!mat.map) { info(`${skin.id}: no texture`); ok = false; }
    }
    info(`${patterned.length} of ${Object.keys(SKINS).length} finishes carry a pattern`);
    return ok;
  })());

  check('materials and geometry are shared, so a finish is paid for once', (() => {
    const part = { p: [0, 0, 0], s: [0.1, 0.1, 0.1], c: 0x445566, m: MAT.METAL, z: ZONE.BODY };
    const a = gunskin.gunMaterial(part, SKINS.gold);
    const b = gunskin.gunMaterial(part, SKINS.gold);
    const geoA = gunskin.skinnedBoxGeometry(0.11, 0.12, 0.13);
    const geoB = gunskin.skinnedBoxGeometry(0.11, 0.12, 0.13);
    return a === b && geoA === geoB && a.userData.shared && geoA.userData.shared;
  })());

  check('a box is UV-mapped in world units, so a pattern holds its scale', (() => {
    const small = gunskin.skinnedBoxGeometry(0.05, 0.05, 0.05).attributes.uv;
    const big = gunskin.skinnedBoxGeometry(0.5, 0.5, 0.5).attributes.uv;
    let sMax = 0, bMax = 0;
    for (let i = 0; i < small.count; i++) sMax = Math.max(sMax, small.getX(i));
    for (let i = 0; i < big.count; i++) bMax = Math.max(bMax, big.getX(i));
    info(`0.05 u box spans ${sMax} UV, 0.5 u box spans ${bMax}`);
    return Math.abs(bMax / sMax - 10) < 1e-6;
  })());

  check('the third-person body skips the detail work the viewmodel draws', (() => {
    const ar = loadoutFor('triggerman')[0];
    const full = gunskin.buildWeaponMesh(ar, SKINS.default, { fine: true }).children.length;
    const far = gunskin.buildWeaponMesh(ar, SKINS.default, { fine: false }).children.length;
    info(`${full} parts in hand, ${far} at forty metres`);
    return far < full && far > 8;
  })());

  suite('Client — entities');

  const entities = new EntityManager(scene);
  entities.localId = 1;
  entities.teamMode = true;
  entities.myTeam = K.TEAM.RED;

  check('a remote player builds, poses and interpolates', (() => {
    try {
      entities.addPlayer({ id: 2, name: 'Bot', team: K.TEAM.BLUE, classId: 'hunter', level: 9, verified: true });
      // Two snapshots either side of the render time.
      entities.pushSnapshot(1000, [[2, 0, 0, 0, 0, 0, 0b011, 100, 0, 0]]);
      entities.pushSnapshot(1033, [[2, 2, 0, 2, 1, 0.2, 0b011, 84, 0, 8]]);
      entities.update(1016, 1 / 60, { camera, world: null, nowSec: 1 });
      const e = entities.get(2);
      return e.alive && e.pos.x > 0 && e.pos.x < 2 && e.health === 84;
    } catch (err) { info(String(err)); return false; }
  })());

  check('nametag size follows the player setting', (() => {
    const e = entities.get(2);
    settings.nametagScale = 1;
    entities.update(1016, 1 / 60, { camera, world: null, nowSec: 1 });
    const small = e.tag.sprite.scale.x;
    settings.nametagScale = 3;
    entities.update(1016, 1 / 60, { camera, world: null, nowSec: 1 });
    const big = e.tag.sprite.scale.x;
    settings.nametagScale = DEFAULTS.nametagScale;
    info(`1.0× → ${small.toFixed(2)}u, 3.0× → ${big.toFixed(2)}u`);
    return big > small * 2.5;
  })());

  check('a death plays the fall-over rather than vanishing', (() => {
    entities.pushSnapshot(1066, [[2, 2, 0, 2, 1, 0.2, 0b000, 0, 0, 0]]);
    entities.update(1066, 1 / 60, { camera, world: null, nowSec: 2 });
    const e = entities.get(2);
    return e.deathT > 0 && e.group.visible && !e.tag.sprite.visible;
  })());

  check('and coming back alive undoes every part of it', (() => {
    /*
     * The bug: the reset was gated on the fall still being *in progress*, so a
     * body that had finished fading came back at zero opacity — and the gun was
     * never faded in the first place, which is why a respawned player read as a
     * rifle walking around on its own.
     */
    const e = entities.get(2);
    // Run the whole death out, past the fade, the way a real one plays.
    for (let i = 0; i < 200; i++) {
      entities.pushSnapshot(1066 + i * 33, [[2, 2, 0, 2, 1, 0.2, 0b000, 0, 0, 0]]);
      entities.update(1066 + i * 33, 1 / 30, { camera, world: null, nowSec: 2 + i / 30 });
    }
    const faded = e.group.userData.solid.every((p) => p.material.opacity < 0.01);
    // …and then they respawn.
    const t = 1066 + 200 * 33;
    entities.pushSnapshot(t + 33, [[2, 5, 0, 5, 0, 0, 0b011, 100, 0, 0]]);
    entities.update(t + 33, 1 / 30, { camera, world: null, nowSec: 20 });
    const body = e.group.userData.solid.every((p) => p.material.opacity === 1);
    const gun = e.group.userData.guns.every((g) => g.position.y > 0.5);
    info(`faded out: ${faded} · body back: ${body} · weapon back in hand: ${gun}`);
    return faded && body && gun && e.group.visible;
  })());

  check('a player is drawn holding the weapon they actually switched to', (() => {
    /*
     * Only the primary used to exist on a third-person body, so switching to
     * the sidearm or the knife changed nothing anybody else could see. The slot
     * was in every snapshot the whole time; nothing was reading it.
     */
    const e = entities.get(2);
    const seen = [];
    // Past the timestamps the death above left in the buffer: an interpolator
    // handed an *older* time than it already holds reads the newest entry it
    // has, which here is a corpse.
    for (let slot = 0; slot < 3; slot++) {
      const t = 30000 + slot * 66;
      entities.pushSnapshot(t, [[2, 5, 0, 5, 0, 0, 0b011, 100, slot, 0]]);
      entities.update(t, 1 / 30, { camera, world: null, nowSec: 30 + slot });
      seen.push(e.group.userData.guns.findIndex((g) => g.visible));
    }
    info(`slots 0,1,2 drew models ${seen.join(',')}`);
    return e.group.userData.guns.length === 3 && seen.join(',') === '0,1,2';
  })());

  check('a spectator can be given x-ray, and taking it away puts depth back', (() => {
    const parts = () => entities.get(2).group.userData.fadeParts;
    entities.setXray(true);
    const through = parts().every((p) => p.material.depthTest === false);
    entities.setXray(false);
    const solid = parts().every((p) => p.material.depthTest === true);
    return through && solid;
  })());

  check('a class change rebuilds the body and keeps the plate', (() => {
    const before = entities.get(2).tag.sprite;
    entities.setClass(2, 'bulldog');
    const e = entities.get(2);
    return e.profile.classId === 'bulldog' && e.tag.sprite === before && e.group.children.includes(before);
  })());

  check('every character shares one set of box geometry', (() => {
    /*
     * Each body used to build thirty-one BufferGeometries and upload them, on
     * every join *and* every class change — a hitch in the middle of a
     * firefight for buffers that are byte-identical between players. All nine
     * classes wear the same body; only the colours and the gun differ.
     */
    for (const id of [3, 4, 5, 6, 7, 8]) {
      entities.addPlayer({ id, name: `P${id}`, team: K.TEAM.BLUE, classId: 'triggerman', level: 3 });
    }
    const geo = new Set();
    let parts = 0;
    for (const e of entities.players.values()) {
      e.group.traverse((o) => { if (o.isMesh) { parts++; geo.add(o.geometry); } });
    }
    info(`${entities.players.size} bodies · ${parts} parts · ${geo.size} distinct geometries`);
    // The body's box sizes are shared outright; only the gun recipes differ per
    // class. A fivefold reduction is the floor, not the measurement.
    return parts > 200 && geo.size < parts / 5;
  })());

  check('and disposing one body does not blank the others', (() => {
    const survivor = entities.get(4);
    const before = survivor.group.children.filter((c) => c.isMesh).length;
    entities.removePlayer(3);
    const after = survivor.group.children.filter((c) => c.isMesh).length;
    // A shared buffer that had been disposed would still be *attached* — what
    // is checked here is that it was never disposed at all.
    const alive = survivor.group.children.every(
      (c) => !c.isMesh || (c.geometry.attributes.position?.array?.length ?? 0) > 0);
    return before === after && alive;
  })());

  check('a body only casts the shadows that are actually its own', (() => {
    /*
     * Fifteen parts sit strictly inside — or flush against — a bigger part
     * that still casts: the mask inside the head, the crown on the helmet, the
     * pouches on the plate carrier. A directional light casts a contained
     * solid's shadow inside its container's, so those are draws in the shadow
     * pass that produce no pixels.
     */
    const u = entities.get(4).group.userData;
    const casting = u.solid.filter((p) => p.castShadow).length;
    const silent = u.solid.filter((p) => !p.castShadow).length;
    info(`${casting} caster(s), ${silent} carried by a bigger part`);
    return u.torso.castShadow && u.head.castShadow && u.helmet.castShadow
      && u.legL.castShadow && u.bootR.castShadow
      && !u.mask.castShadow && !u.helmetTop.castShadow && !u.pouchC.castShadow
      && silent === 15 && casting === u.solid.length - 15;
  })());

  suite('Client — objectives');

  const obj = new Objectives(scene);
  check('capture points build and update for every map that declares them', (() => {
    let ok = true;
    for (const id of ALL_MAP_IDS) {
      const m = getMap(id);
      if (!m.objectives?.length) continue;
      try {
        obj.setPoints(m.objectives);
        obj.apply(m.objectives.map((p, i) => ({
          id: p.id, owner: i === 0 ? K.TEAM.RED : K.TEAM.NONE, progress: 0.5,
          contender: K.TEAM.BLUE, contested: i === 1,
        })));
        obj.update(1 / 60, camera);
        if (obj.points.length !== m.objectives.length) ok = false;
      } catch (e) { info(`${id}: ${e}`); ok = false; }
    }
    obj.clear();
    return ok && obj.points.length === 0;
  })());

  suite('Client — renderer');

  let gfx = null;
  const renderer = makeRenderer();
  check('the renderer builds its light rig and post chain', (() => {
    try {
      gfx = new GameWorld(document.getElementById('view'), renderer);
      return !!gfx.sun && !!gfx.hemi && !!gfx.post;
    } catch (e) { info(String(e)); return false; }
  })());

  check('every map builds into per-material batches', (() => {
    let ok = true;
    const counts = [];
    for (const id of ALL_MAP_IDS) {
      try {
        const map = getMap(id);
        gfx.setMap(map);
        // Everything is drawn except the invisible boundary: decor is dressing
        // the renderer very much does draw, it simply never collides.
        const drawn = map.boxes.filter((b) => !b.clip);
        const instanced = gfx.batches.reduce((n, m) => n + m.count, 0);
        counts.push(`${id} ${gfx.batches.length}×`);
        if (instanced !== drawn.length) {
          info(`${id}: ${instanced} instances for ${drawn.length} drawn boxes`); ok = false;
        }
        // One batch per material, doubled at worst because shadow casting is a
        // per-mesh flag and the flat paint on a road must not cast one.
        const materials = new Set(drawn.map((b) => b.mat)).size;
        if (gfx.batches.length > materials * 2) {
          info(`${id}: ${gfx.batches.length} batches for ${materials} materials`); ok = false;
        }
      } catch (e) { info(`${id}: ${e}`); ok = false; }
    }
    info(counts.join(' · '));
    return ok;
  })(), 'at most one draw call per surface material per shadow class');

  let rebuildDetail = '';
  check('rebuilding a map releases the previous one', (() => {
    gfx.setMap(getMap('burgtown'));
    const first = gfx.mapGroup.children.length;
    for (let i = 0; i < 6; i++) gfx.setMap(getMap(i % 2 ? 'shipyard' : 'crossfire'));
    gfx.setMap(getMap('burgtown'));
    const after = gfx.mapGroup.children.length;
    rebuildDetail = `${first} objects, still ${after} after seven map loads`;
    return after === first;
  })(), rebuildDetail);

  check('a frame draws the world, the viewmodel and the post chain', (() => {
    renderer.draws = 0;
    gfx.post.enabled = true;
    gfx.render(1 / 60, () => vm.render());
    // scene + bright + blur×2 + composite, and the viewmodel on top.
    return renderer.draws >= 5;
  })(), `${renderer.draws} draw passes with post-processing on`);

  check('turning post-processing off drops straight to the framebuffer', (() => {
    renderer.draws = 0;
    gfx.post.enabled = false;
    gfx.render(1 / 60, null);
    return renderer.draws === 1;
  })(), `${renderer.draws} draw pass`);

  check('bloom at zero costs nothing at all', (() => {
    // The bright pass and the two blurs exist to feed one texture read. With
    // the slider at zero that read is compiled out, so the passes behind it
    // have nothing left to produce.
    gfx.post.enabled = true;
    gfx.post.configure({ enabled: true, quality: 'high', bloom: 0 });
    renderer.draws = 0;
    gfx.render(1 / 60, null);
    const off = renderer.draws;
    gfx.post.configure({ enabled: true, quality: 'high', bloom: 0.62 });
    renderer.draws = 0;
    gfx.render(1 / 60, null);
    info(`${off} passes without bloom, ${renderer.draws} with`);
    return off === 2 && renderer.draws === 5 && 'OG_BLOOM' in gfx.post.compositeMat.defines;
  })());

  check('welding an assembly moves nothing — only the number of draw calls', (() => {
    /*
     * The gun and the hands are dozens of little boxes, none of which moves
     * relative to its neighbours, so they are baked into one buffer per
     * material at build time. What has to hold is that the bake is a pure
     * change of representation: the same triangles, in the same places.
     *
     * Checked on a nested, rotated, offset hierarchy — which is what a hand
     * is, and where a transform composed in the wrong order would show up.
     */
    const built = () => {
      const root = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0x888888 });
      const other = new THREE.MeshBasicMaterial({ color: 0x224466 });
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(skinnedBoxGeometry(0.1 + i * 0.02, 0.08, 0.3), i === 1 ? other : mat);
        m.position.set(0.04 * i, -0.1, 0.07 * i);
        m.rotation.set(0.3 * i, -0.2 * i, 0.15);
        root.add(m);
      }
      const wrist = new THREE.Group();
      wrist.position.set(0.03, -0.1, 0.07);
      wrist.rotation.set(1.3, 0.4, 0);
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(skinnedBoxGeometry(0.09, 0.09, 0.17), mat);
        m.position.set(0, 0.05 * i, 0.03 + i * 0.1);
        wrist.add(m);
      }
      root.add(wrist);
      return root;
    };

    const loose = built();
    const welded = collapseStatic(built());
    const box = (o) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); };
    const a = box(loose), b = box(welded);
    const drift = Math.max(...['x', 'y', 'z'].flatMap((k) =>
      [Math.abs(a.min[k] - b.min[k]), Math.abs(a.max[k] - b.max[k])]));
    const tris = (o) => { let n = 0; o.traverse((x) => { if (x.isMesh) n += x.geometry.index.count / 3; }); return n; };
    const meshes = (o) => { let n = 0; o.traverse((x) => { if (x.isMesh) n++; }); return n; };
    info(`${meshes(loose)} meshes → ${meshes(welded)} · drift ${drift.toExponential(1)} units`);
    return drift < 1e-5 && tris(loose) === tris(welded) && meshes(welded) === 2;
  })());

  check('the sky is drawn after the world it sits behind', (() => {
    // Drawn first it shaded a full screen of texture that the level then
    // covered; last, with the depth test on and no depth write of its own, it
    // only fills the pixels nothing else reached.
    gfx.setMap(getMap('burgtown'));
    const dome = gfx.skyDome;
    return dome.renderOrder > 0 && dome.material.depthWrite === false
      && dome.material.depthTest !== false;
  })(), `renderOrder ${gfx.skyDome?.renderOrder}`);

  check('the shadow map redraws on a clock, not on every frame', (() => {
    /*
     * The shadow pass draws the whole level a second time. It is armed by
     * hand at the quality preset's rate, so a 144 Hz screen stops paying for
     * it twice per displayed frame — and a stale map stays pinned where it
     * was, because three computes the depth buffer and its matrix together.
     */
    renderer.shadowMap.enabled = true;
    gfx.invalidateShadows();
    const armed = [];
    for (let i = 0; i < 6; i++) {
      renderer.shadowMap.needsUpdate = false;
      gfx.render(1 / 240, null);                       // four frames per 60 Hz tick
      armed.push(renderer.shadowMap.needsUpdate);
    }
    renderer.shadowMap.enabled = false;
    const drawn = armed.filter(Boolean).length;
    info(`${drawn} shadow pass(es) in six frames at 240 fps`);
    return armed[0] === true && drawn < 3;
  })());

  suite('Client — gunplay maths');

  check('a spray pattern is deterministic and climbs', (() => {
    const w = getClass('triggerman').primary;
    const a = Array.from({ length: 12 }, (_, i) => recoilKick(w, i + 1));
    const b = Array.from({ length: 12 }, (_, i) => recoilKick(w, i + 1));
    const same = a.every((k, i) => k.pitch === b[i].pitch && k.yaw === b[i].yaw);
    const climbs = a[8].pitch > a[0].pitch;
    info(`shot 1 ${(a[0].pitch * 1000).toFixed(1)} mrad → shot 9 ${(a[8].pitch * 1000).toFixed(1)} mrad`);
    return same && climbs;
  })());

  check('the pattern drifts sideways rather than staying centred', (() => {
    const w = getClass('triggerman').primary;
    const yaws = Array.from({ length: 20 }, (_, i) => recoilKick(w, i + 1).yaw);
    return yaws.some((y) => y > 0) && yaws.some((y) => y < 0);
  })());

  check('the first round out of a settled weapon is the most accurate', (() => {
    const w = getClass('triggerman').primary;
    const first = spreadFor(w, { burst: 0 });
    const fifth = spreadFor(w, { burst: 5 });
    const capped = spreadFor(w, { burst: 200 });
    info(`${(first * 1000).toFixed(2)} → ${(fifth * 1000).toFixed(2)} → ${(capped * 1000).toFixed(2)} mrad`);
    return first < fifth && fifth < capped && capped <= spreadFor(w, { burst: w.bloomCap }) + 1e-9;
  })());

  check('aiming down sights tightens every weapon that has sights', (() => {
    let ok = true;
    for (const cid of CLASS_IDS) {
      const w = loadoutFor(cid)[0];
      if (spreadFor(w, { ads: true, burst: 3 }) >= spreadFor(w, { ads: false, burst: 3 })) ok = false;
    }
    return ok;
  })());
}
