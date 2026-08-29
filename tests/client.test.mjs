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
  CLASS_IDS, loadoutFor, getClass, recoilKick, spreadFor, ZONE, MAT, paintFor,
} = await import('/shared/weapons.js');
const COS = await import('/shared/cosmetics.js');

/** Every weapon finish in the game, as the shape `gunMaterial` wants. */
const FINISHES = COS.itemsInSlot(COS.SLOT.PRIMARY)
  .map((i) => ({ ...i.finish, name: i.name }));
/** A wardrobe wearing one finish on all three guns, for `setWeapon`. */
const wearing = (key) => ({
  ...COS.DEFAULT_EQUIP,
  [COS.SLOT.PRIMARY]: COS.itemId(COS.SLOT.PRIMARY, key),
  [COS.SLOT.SECONDARY]: COS.itemId(COS.SLOT.SECONDARY, key),
  [COS.SLOT.KNIFE]: COS.itemId(COS.SLOT.KNIFE, key),
});
const { getMap, ALL_MAP_IDS } = await import('/shared/maps.js');
const { World } = await import('/shared/physics.js');

const { Hud } = await import('/js/hud.js');
const { Effects } = await import('/js/effects.js');
const { ViewModel } = await import('/js/viewmodel.js');
const gunskin = await import('/js/gunskin.js');
const { EntityManager } = await import('/js/entities.js');
const { Objectives } = await import('/js/objectives.js');
const { KillCam } = await import('/js/killcam.js');
const { DevMode } = await import('/js/devmode.js');
const {
  settings, SCHEMA, DEFAULTS, PANEL_OWNED_KEYS,
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
const audio = await import('/js/audio.js');

/** A listener at the origin, facing +Z, for the positional-audio checks. */
const listener = { pos: { x: 0, y: 1.6, z: 0 }, right: { x: 1, z: 0 } };

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

  /*
   * A setting that is stored and adjustable nowhere is a bug that only ever
   * surfaces as "why is this on", so nothing may be orphaned. SETTINGS is the
   * usual home; `PANEL_OWNED_KEYS` is the written-down list of the few that
   * belong to a panel of their own instead.
   *
   * Both halves are checked, and the second is the one that matters: a key can
   * only escape the settings panel by being *named*, and a name that turns out
   * to be in the schema after all fails too — so the exemption list cannot rot
   * into a place where real orphans go to hide.
   */
  const missingFromSchema = Object.keys(DEFAULTS)
    .filter((k) => !SCHEMA.some((g) => g.items.some((i) => i.key === k)))
    .filter((k) => !PANEL_OWNED_KEYS.includes(k));
  const bogusExemptions = PANEL_OWNED_KEYS
    .filter((k) => SCHEMA.some((g) => g.items.some((i) => i.key === k)) || !(k in DEFAULTS));
  check('every default is reachable from the settings UI',
    missingFromSchema.length === 0 && bogusExemptions.length === 0,
    [
      missingFromSchema.length ? `orphaned: ${missingFromSchema.join(', ')}` : 'none orphaned',
      bogusExemptions.length ? `stale exemptions: ${bogusExemptions.join(', ')}`
        : `${PANEL_OWNED_KEYS.length} owned by their own panel`,
    ].join(' · '));

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

  /* ── The kill cam ─────────────────────────────────────────────────────── */

  check('the kill cam draws the killer, and only the facts that are true', (() => {
    // A melee has no distance worth printing and a survivor on full health is
    // not the interesting number; drawing every field always would make the
    // one that matters — "they had 8 HP" — impossible to spot.
    hud.showKillCam({
      name: 'Nemesis', clan: 'GRUN', clanVerified: true, verified: true, level: 34,
      creator: 'music', weapon: 'ar', head: true, distance: 41, health: 8,
      anthemTitle: 'Overdrive', director: false,
    });
    const open = !hud.el.killCam.classList.contains('hidden');
    const named = hud.el.kcName.textContent === 'Nemesis';
    const badges = hud.el.kcTags.innerHTML.includes('clan-tag')
      && hud.el.kcTags.innerHTML.includes('creator-tag')
      && hud.el.kcTags.innerHTML.includes('LEVEL 34');
    const facts = hud.el.kcFacts.innerHTML;
    const credited = !hud.el.kcAnthem.classList.contains('hidden')
      && hud.el.kcTrack.textContent === 'Overdrive';

    hud.showKillCam({
      name: 'Knifey', weapon: 'knife', head: false, distance: 1, health: 0,
      anthemTitle: null, level: 0,
    });
    const quiet = hud.el.kcAnthem.classList.contains('hidden');
    const bare = hud.el.kcFacts.innerHTML;
    hud.hideKillCam();
    info(`with music: HEADSHOT ${facts.includes('HEADSHOT')} · 41 m ${facts.includes('41 m')} `
      + `· 8 HP ${facts.includes('8 HP')} — knife: ${bare.includes('m<') ? 'has a range' : 'no range'}`);
    return open && named && badges && credited && quiet
      && facts.includes('HEADSHOT') && facts.includes('41 m') && facts.includes('8 HP')
      && !bare.includes('HEADSHOT') && !bare.includes('HP')
      && hud.el.killCam.classList.contains('hidden');
  })());

  check('the skip fills for three seconds and then becomes a button', (() => {
    // The fill *is* the explanation: a disabled button with a countdown in it
    // needs no tooltip, and a skip that lit up instantly would be one nobody
    // ever saw a cam behind.
    hud.showKillCam({ name: 'Nemesis', weapon: 'ar', level: 3 });
    hud.updateKillCam({
      remaining: 8.4, canSkip: false, skipIn: 1.6, skipProgress: 0.47, name: 'Nemesis',
    }, 8.4);
    const waiting = hud.el.kcSkip.disabled
      && hud.el.kcSkipLabel.textContent === 'SKIP IN 2'
      && hud.el.kcSkipFill.style.width === '47%';
    hud.updateKillCam({
      remaining: 6, canSkip: true, skipIn: 0, skipProgress: 1, name: 'Nemesis',
    }, 6);
    const ready = !hud.el.kcSkip.disabled && hud.el.kcSkipLabel.textContent === 'SKIP'
      && hud.el.kcSkip.classList.contains('ready');
    hud.hideKillCam();
    return waiting && ready;
  })());

  check('a track that lands late is credited when it starts, not when it was asked for', (() => {
    // The anthem is fetched on the death that needs it, so it can arrive a
    // second in. Promising music that never comes would be worse than silence.
    hud.showKillCam({ name: 'Nemesis', weapon: 'ar', anthemTitle: null, level: 3 });
    const silent = hud.el.kcAnthem.classList.contains('hidden');
    hud.updateKillCam({
      remaining: 8, canSkip: false, skipIn: 2, skipProgress: 0.3,
      name: 'Nemesis', anthemTitle: 'Late Arrival',
    }, 8);
    const credited = !hud.el.kcAnthem.classList.contains('hidden')
      && hud.el.kcTrack.textContent === 'Late Arrival';
    hud.hideKillCam();
    return silent && credited;
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

  // God mode stops the room counting rounds out of the magazine, so a number
  // there would be a number that never moves. The blade and the reserve already
  // read as the symbol; this is the third thing that is genuinely endless.
  check('an admin in god mode reads ∞ where the magazine count goes', (() => {
    const frame = (extra) => {
      hud.update({
        health: 100, ammo: 12, reserve: -1, weapon: loadoutFor('triggerman')[0], slot: 0,
        reloading: false, reloadFrac: 0, spread: 0.02, scoped: false, matchTime: 91,
        teamScore: { red: 0, blue: 0 }, teamMode: false, ping: 20, name: 'Tester',
        level: 12, verified: false, speed: 0, accuracy: 50, ...extra,
      }, 1 / 60);
      return String(hud.el.ammoMag.textContent);
    };
    const mortal = frame({});
    const god = frame({ godMode: true });
    // A watcher's HUD is drawn from the same method with no flag on it, so
    // spectating out of god mode has to put the number back.
    const watching = frame({});
    info(`${mortal} → ${god} → ${watching}`);
    return mortal === '12' && god === '\u221e' && watching === '12';
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

  check('nothing owns a state class the scoreboard and the match lists share', (() => {
    /*
     * `won`, `lost` and `me` are *states*, and three different lists put them
     * on a row: the in-match scoreboard, ACCOUNT ▸ MATCHES, and the player
     * card. They are ordinary enough words that a later feature reaches for
     * one as a name of its own — and a bare `.won { display: flex }` anywhere
     * in this stylesheet takes all three apart at once.
     *
     * That is not hypothetical. The V2 case-opening modal called its result
     * card `.won`, which turned every won row in the game into a flexbox and
     * blew the "/" between kills and deaths up to a hundred pixels.
     *
     * A compound selector is fine — `.match-row.won` names exactly one thing.
     * What is banned is owning the word outright.
     */
    const css = readFileSync(join(ROOT, 'client/css/style.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const states = ['won', 'lost', 'me', 'hot', 'active', 'selected', 'locked', 'equipped'];
    const owned = [];
    for (const rule of css.matchAll(/(?:^|[{}])([^{}@]+)\{/g)) {
      for (const sel of rule[1].split(',')) {
        for (const compound of sel.trim().split(/[\s>+~]+/)) {
          const c = compound.trim();
          if (/^\.[a-z-]+$/.test(c) && states.includes(c.slice(1))) owned.push(`${c} (in "${sel.trim()}")`);
        }
      }
    }
    if (owned.length) info(owned.join(' · '));
    return owned.length === 0;
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

  /* ── Friends ─────────────────────────────────────────────────────────── */

  check('the friends panel draws the list, both queues and who is online', (() => {
    menu.friendState = {
      friends: [
        { id: 'u1', username: 'InAMatch', level: 12, online: true, playing: true,
          room: 'FRA:7K2Q', map: 'Subzero', mode: 'Team Deathmatch' },
        { id: 'u2', username: 'InTheMenu', level: 4, online: true, playing: false },
        { id: 'u3', username: 'Offline', level: 9, online: false, lastLogin: 1 },
      ],
      incoming: [{ id: 'u4', username: 'Asking', level: 3, askedAt: 1 }],
      outgoing: [{ id: 'u5', username: 'Asked', level: 6, askedAt: 1 }],
      online: 2,
      limits: { max: 100 },
    };
    menu.renderFriends();
    const rows = document.getElementById('friendList').querySelectorAll('.friend-row');
    info(`${rows.length} friends · ${document.getElementById('friendCount').textContent}`);
    return rows.length === 3
      && document.getElementById('friendIncoming').querySelectorAll('.friend-row').length === 1
      && document.getElementById('friendOutgoing').querySelectorAll('.friend-row').length === 1
      && !document.getElementById('friendRequests').classList.contains('hidden')
      && document.getElementById('friendCount').textContent.startsWith('2 of 3 online');
  })());

  check('only a friend in a room you can walk into gets a JOIN button', (() => {
    const html = document.getElementById('friendList').innerHTML;
    const joins = document.getElementById('friendList')
      .querySelectorAll('button[data-friend-act=join]');
    return joins.length === 1 && joins[0].dataset.arg === 'FRA:7K2Q'
      && html.includes('Team Deathmatch') && html.includes('IN THE MENU');
  })());

  check('a waiting request is badged on the tab, so nobody misses one', (() => {
    const badge = document.getElementById('friendTabBadge');
    const shown = badge.textContent === '1' && !badge.classList.contains('hidden');
    menu.setFriendBadge(0);
    return shown && badge.classList.contains('hidden');
  })());

  check('JOIN drops straight into their match', (() => {
    played.length = 0;
    menu.friendAction('join', 'FRA:7K2Q');
    return played.length === 1 && played[0].room === 'FRA:7K2Q';
  })());

  /* ── The address that is not on your stream ──────────────────────────── */

  check('the account panel masks the email address', (() => {
    menu.renderEmailState({ email: 'gabriel@proton.me', emailVerified: true });
    const shown = document.getElementById('emailAddr').textContent;
    const overview = document.getElementById('ovEmail').textContent;
    info(`${shown} · reveal reads ${document.getElementById('btnEmailReveal').textContent}`);
    return shown === overview && shown.includes('@') && shown.endsWith('.me')
      && !shown.includes('gabriel') && !shown.includes('proton')
      && shown.startsWith('g') && document.getElementById('emailAddr').classList.contains('masked');
  })());

  check('SHOW puts it back, and HIDE takes it away again', (() => {
    menu.toggleEmail();
    const revealed = document.getElementById('emailAddr').textContent === 'gabriel@proton.me'
      && document.getElementById('btnEmailReveal').textContent === 'HIDE';
    menu.toggleEmail();
    return revealed && document.getElementById('emailAddr').textContent !== 'gabriel@proton.me'
      && document.getElementById('btnEmailReveal').textContent === 'SHOW';
  })());

  check('the change-address form does not print it either', (() => {
    const placeholder = document.getElementById('emailForm')
      .querySelector('input[name=email]').placeholder;
    return !placeholder.includes('gabriel@proton.me') && placeholder.includes('@');
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
    // The count is not the invariant — "nothing here is a dead end" is. Named
    // rather than counted so adding a page cannot quietly break the test, and
    // removing one of these cannot quietly pass it.
    const wanted = ['overview', 'progression', 'matches', 'reports', 'identity',
      'card', 'social', 'security'];
    return orphans.length === 0 && wanted.every((t) => tabs.includes(t))
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
    /*
     * Level 3 has the chat (2) and both level-1 rungs behind it. The next rung
     * is level 5, and *everything* landing on it is marked rather than only the
     * first — which is the actual invariant, so the count comes from the ladder
     * instead of being pinned. Pinning it meant that adding a rung at level 5
     * failed this check for being new rather than for being wrong.
     */
    const nextLevel = Math.min(...menu.meta.progression.map((r) => r.level).filter((l) => l > 3));
    const wantNext = menu.meta.progression.filter((r) => r.level === nextLevel).length;
    return steps.length >= 6 && done === 3 && next.length === wantNext && wantNext >= 2
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

  check('nothing an impact throws off ends up inside the wall it hit', (() => {
    // Every particle leaves along the surface normal through `_cone`. Spraying
    // into a sphere instead puts half of each impact behind the geometry,
    // where it is invisible at best and visible through the wall at worst.
    effects.clear();
    const [nx, ny, nz] = [0, 0, -1];             // a wall facing the camera
    for (let i = 0; i < 12; i++) effects.impact(4, 1.5, 9, nx, ny, nz, 'metal');
    let checked = 0;
    let inside = 0;
    for (const cloud of [effects.sparks, effects.smoke]) {
      for (let i = 0; i < cloud.high; i++) {
        if (cloud.life[i] <= 0) continue;
        const j = i * 3;
        // Gravity is added on the way out, so only the axis the wall faces
        // along says anything about which side of it a particle left on.
        const along = cloud.vel[j] * nx + cloud.vel[j + 1] * ny + cloud.vel[j + 2] * nz;
        checked++;
        // The strike flash has no velocity at all — it sits on the surface.
        if (along < -1e-6) inside++;
      }
    }
    info(`${checked} particles, ${inside} heading into the wall`);
    return checked > 40 && inside === 0;
  })());

  check('the ring of dust a landing kicks up really is a ring', (() => {
    effects.clear();
    effects.dust(0, 0, 0, 12);
    let outward = 0;
    let total = 0;
    for (let i = 0; i < effects.smoke.high; i++) {
      if (effects.smoke.life[i] <= 0) continue;
      const j = i * 3;
      const px = effects.smoke.pos[j];
      const pz = effects.smoke.pos[j + 2];
      // Moving away from where the boot landed, not through it.
      if (px * effects.smoke.vel[j] + pz * effects.smoke.vel[j + 2] > 0) outward++;
      total++;
    }
    info(`${outward}/${total} moving outward`);
    return total >= 6 && outward === total;
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
          vm.setWeapon(w, COS.SLOT.PRIMARY, wearing('gold'));
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
      vm.setWeapon(loadoutFor('bulldog')[0], COS.SLOT.PRIMARY, wearing('factory'));
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
      vm.setWeapon(loadoutFor('triggerman')[2], COS.SLOT.KNIFE, wearing('factory'));
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
    vm.setWeapon(loadoutFor('triggerman')[0], COS.SLOT.PRIMARY, wearing('factory'));
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

  check('every finish builds on every weapon slot', (() => {
    let ok = true;
    for (const key of [...Object.keys(COS.FINISHES), ...Object.keys(COS.EARNED_FINISHES)]) {
      const cos = wearing(key);
      for (const slot of COS.WEAPON_SLOTS) {
        // Not every finish is minted for every slot — `on` decides — and a
        // slot it was not minted for falls back to factory rather than
        // throwing, which is the behaviour being checked as much as the build.
        const i = COS.WEAPON_SLOTS.indexOf(slot);
        try { vm.setWeapon(loadoutFor('hunter')[i], slot, cos); }
        catch (e) { info(`${key}/${slot}: ${e}`); ok = false; }
      }
    }
    return ok;
  })(), `${FINISHES.length} finishes × ${COS.WEAPON_SLOTS.length} slots`);

  check('an animated finish registers motion rather than baking it in', (() => {
    const before = gunskin.animatedCount();
    vm.setWeapon(loadoutFor('hunter')[0], COS.SLOT.PRIMARY, wearing('prismatic'));
    const after = gunskin.animatedCount();
    // And ticking the clock must not throw on any of them.
    for (let t = 0; t < 4; t += 0.25) gunskin.tickCosmetics(t);
    info(`${after} animated texture(s)/material(s) registered`);
    return after >= before && after > 0;
  })());

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
        vm.setWeapon(w, COS.SLOT.PRIMARY, wearing('factory'));
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
        vm.setWeapon(w, COS.SLOT.PRIMARY, wearing('factory'));
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
    for (const skin of FINISHES) {
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
    info(`${checked} untouchable parts across ${FINISHES.length} finishes`);
    return painted === 0 && checked > 0;
  })());

  check('a finish that names a pattern actually paints one', (() => {
    const patterned = FINISHES.filter((f) => f.pattern);
    let ok = patterned.length >= 10;
    for (const skin of patterned) {
      const part = { c: 0x808080, m: MAT.POLY, z: skin.pattern.on[0] };
      const mat = gunskin.gunMaterial(part, skin);
      if (!mat.map) { info(`${skin.id}: no texture`); ok = false; }
    }
    info(`${patterned.length} of ${FINISHES.length} finishes carry a pattern`);
    return ok;
  })());

  check('materials and geometry are shared, so a finish is paid for once', (() => {
    const part = { p: [0, 0, 0], s: [0.1, 0.1, 0.1], c: 0x445566, m: MAT.METAL, z: ZONE.BODY };
    const gold = COS.getItem('primary:gold').finish;
    const a = gunskin.gunMaterial(part, gold);
    const b = gunskin.gunMaterial(part, gold);
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
    const factory = COS.getItem('primary:factory').finish;
    const full = gunskin.buildWeaponMesh(ar, factory, { fine: true }).children.length;
    const far = gunskin.buildWeaponMesh(ar, factory, { fine: false }).children.length;
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

  check('the ring holds enough history for the kill cam to replay out of', (() => {
    /*
     * The replay is not a second recording: it is this buffer read at an older
     * timestamp. So the one thing that makes it possible is the *length* of the
     * ring, and the one thing that would silently break it is somebody shorting
     * that length back to the fifth of a second interpolation needs.
     */
    const ring = new EntityManager(scene);
    ring.localId = 1;
    ring.addPlayer({ id: 3, name: 'B', team: K.TEAM.BLUE, classId: 'hunter' });
    const step = 1000 / K.SNAPSHOT_RATE;
    for (let i = 0; i < K.SNAPSHOT_RATE * (K.KILLCAM_SECONDS + 1); i++) {
      ring.pushSnapshot(i * step, [[3, i * 0.1, 0, 0, 0, 0, 0b011, 100, 0, 0]]);
    }
    const depth = (ring.latestTime - ring.earliestTime) / 1000;
    info(`${ring.buffer.length} frames · ${depth.toFixed(1)}s deep`);
    return depth >= K.KILLCAM_SECONDS;
  })());

  check('reading a moment before the ring starts clamps instead of teleporting', (() => {
    /*
     * The scan this replaced answered a too-old timestamp by interpolating
     * across the *whole* buffer, which put every body on the map at wherever
     * they had been when it started. Harmless at a fifth of a second; with ten
     * seconds in the ring it is a scene that jumps.
     */
    const ring = new EntityManager(scene);
    ring.localId = 1;
    ring.pushSnapshot(5000, [[3, 10, 0, 0, 0, 0, 0b011, 100, 0, 0]]);
    ring.pushSnapshot(9000, [[3, 90, 0, 0, 0, 0, 0b011, 100, 0, 0]]);
    const before = ring.sampleAt(3, 0);
    const after = ring.sampleAt(3, 99999);
    const middle = ring.sampleAt(3, 7000);
    info(`before: x=${before.x} · middle: x=${middle.x} · after: x=${after.x}`);
    return before.x === 10 && after.x === 90 && Math.abs(middle.x - 50) < 0.01;
  })());

  check('the local player has a body, and nothing but the replay draws it', (() => {
    /*
     * A snapshot never carries your own entry — the server cuts it out, because
     * you are predicting it — so without this the replay would be the killer's
     * ten seconds with the person they were shooting at missing from them.
     */
    const ring = new EntityManager(scene);
    ring.localId = 4;
    ring.addSelf({ id: 4, name: 'Me', team: K.TEAM.RED, classId: 'triggerman' });
    const refused = (() => { ring.addPlayer({ id: 4, name: 'Me', classId: 'hunter' }); return true; })();
    const self = () => ring.get(4);
    const entry = [4, 3, 0, 3, 1.2, 0.3, 0b011, 90, 0, 4];
    ring.pushSnapshot(1000, [], entry);
    ring.pushSnapshot(1050, [], entry);

    ring.update(1025, 1 / 60, { camera, world: null, nowSec: 1 });
    const hiddenLive = self().group.visible === false;

    ring.replaying = true;
    ring.update(1025, 1 / 60, { camera, world: null, nowSec: 1 });
    const shownInReplay = self().group.visible === true;
    const posed = Math.abs(self().pos.x - 3) < 0.01 && Math.abs(self().yaw - 1.2) < 0.01;
    // Never a nametag: from inside a replay it would be a plate over your own head.
    const noTag = self().tag.sprite.visible === false;
    ring.replaying = false;
    info(`live: ${hiddenLive ? 'hidden' : 'DRAWN'} · replay: ${shownInReplay ? 'drawn' : 'HIDDEN'}`);
    return refused && hiddenLive && shownInReplay && posed && noTag;
  })());

  check('and a jump back through a death does not kill anybody twice', (() => {
    // `update` reads a death out of the transition from alive to not. Ten
    // seconds in one frame is not a transition, so leaving a replay has to
    // re-seed the flags or everybody who died inside the window falls over
    // again on the frame the cam ended.
    const ring = new EntityManager(scene);
    ring.localId = 1;
    ring.addPlayer({ id: 5, name: 'C', team: K.TEAM.BLUE, classId: 'hunter' });
    ring.pushSnapshot(1000, [[5, 0, 0, 0, 0, 0, 0b011, 100, 0, 0]]);
    ring.pushSnapshot(2000, [[5, 0, 0, 0, 0, 0, 0b000, 0, 0, 0]]);
    ring.update(1000, 1 / 60, { camera, world: null, nowSec: 1 });   // alive, in the past
    ring.syncAlive(2000);
    const e = ring.get(5);
    const reseeded = e.wasAlive === false && e.deathT === 0;
    ring.update(2000, 1 / 60, { camera, world: null, nowSec: 2 });
    return reseeded && e.deathT === 0;
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
     * Several parts sit strictly inside — or flush against — a bigger part
     * that still casts: the mask inside the head, the knee pads on the legs,
     * the pouches on the plate carrier. A directional light casts a contained
     * solid's shadow inside its container's, so those are draws in the shadow
     * pass that produce no pixels.
     *
     * The helmet is not in this list any more and is not meant to be: since
     * V2 it is a worn item (`head:helmet`) hanging off `headGear` rather than
     * a fixed part of the body, so what it does with shadows is decided by
     * wearables.js and checked with the rest of the wardrobe.
     */
    const u = entities.get(4).group.userData;
    const casting = u.solid.filter((p) => p.castShadow).length;
    const silent = u.solid.filter((p) => !p.castShadow).length;
    info(`${casting} caster(s), ${silent} carried by a bigger part`);
    return u.torso.castShadow && u.head.castShadow
      && u.legL.castShadow && u.bootR.castShadow
      && !u.mask.castShadow && !u.pouchC.castShadow && !u.kneeL.castShadow
      && silent > 0 && casting === u.solid.length - silent;
  })());

  check('the wardrobe is worn on the body and fades with it', (() => {
    const u = entities.get(4).group.userData;
    // A default operator still has a helmet, a balaclava and a day pack on —
    // the three items every account owns without being given them.
    const worn = u.wornMeshes.length;
    const inFade = u.wornMeshes.every((m) => u.fadeParts.includes(m));
    info(`${worn} worn mesh(es), all fadeable: ${inFade}`);
    return worn > 0 && inFade && u.headGear && u.faceGear && u.backGear;
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

  /* ── The panel rail ──────────────────────────────────────────────────── */

  suite('Client — the menu rail');

  check('every rail entry has an icon, a label, a title and a subtitle', (() => {
    const tabs = document.querySelectorAll('.tab');
    const bad = tabs.filter((t) => !t.dataset.icon || !t.dataset.label
      || !t.dataset.title || !t.dataset.sub || !t.innerHTML.includes('<svg'));
    info(`${tabs.length} entries · ${tabs.map((t) => t.dataset.label).join(', ')}`);
    return tabs.length >= 12 && bad.length === 0;
  })());

  check('every rail entry sits in a named group', (() => {
    const groups = document.querySelectorAll('.pn-group');
    const loose = document.querySelectorAll('.tab').filter((t) => !t.parentElement?.classList.contains('pn-group'));
    info(groups.map((g) => g.dataset.group).join(' · '));
    return groups.length >= 4 && groups.every((g) => g.dataset.group) && loose.length === 0;
  })());

  check('opening a page names it in the header', (() => {
    menu.openTab('clans');
    const named = document.getElementById('panelTitle').textContent === 'Clans'
      && document.getElementById('panelSub').textContent.length > 8;
    menu.openTab('classes');
    return named && document.getElementById('panelTitle').textContent === 'Loadout';
  })());

  check('the filter box narrows the rail and puts it back', (() => {
    const box = document.getElementById('tabSearch');
    const visible = () => document.querySelectorAll('.tab').filter((t) => !t.classList.contains('hidden'));
    const all = visible().length;
    box.value = 'clan';
    box.fire('input');
    const narrowed = visible();
    box.value = 'zzzz';
    box.fire('input');
    const none = visible().length === 0 && !document.getElementById('tabSearchNone').classList.contains('hidden');
    box.value = '';
    box.fire('input');
    info(`${all} → ${narrowed.length} on "clan" → 0 on "zzzz" → ${visible().length}`);
    return narrowed.length === 1 && narrowed[0].dataset.tab === 'clans'
      && none && visible().length === all;
  })());

  check('the filter matches a subtitle, not only a name', (() => {
    // "sensitivity" is nowhere in the word SETTINGS — it is in what the page
    // is for, which is the half people actually remember.
    const box = document.getElementById('tabSearch');
    box.value = 'crosshair';
    box.fire('input');
    const hit = document.querySelectorAll('.tab').filter((t) => !t.classList.contains('hidden'));
    box.value = '';
    box.fire('input');
    return hit.length === 1 && hit[0].dataset.tab === 'settings';
  })());

  /* ── The player card ─────────────────────────────────────────────────── */

  suite('Client — the player card');

  /** One profile payload, shaped exactly the way /players/:name answers. */
  const profile = (over = {}) => ({
    user: {
      id: 'u9', username: 'Grunk', level: 24, xp: 1200, levelXp: 1000, nextLevelXp: 2000,
      verified: true, avatar: null, clan: 'DEV', clanVerified: true, role: 'player',
      createdAt: 1700000000, streak: { days: 5 },
      card: K.normaliseCard({
        pattern: 'rays', accentMode: 'custom', accent: '#4d9bff', layout: 'showcase',
        frame: 'glow', title: 'Quickscoper. Allegedly.', bio: 'Here since season one.',
        featured: ['kd', 'headshots', 'wins'],
      }),
      stats: {
        kills: 900, deaths: 400, kd: 2.25, wins: 60, headshots: 210, accuracy: 31.2,
        damage: 91000, matches: 120, bestStreak: 14, playtime: 40000, score: 51000, assists: 40,
      },
      ...over.user,
    },
    relation: 'none',
    hidden: [],
    recent: [{ won: true, map: 'Subzero', mode: 'tdm', kills: 20, deaths: 8, score: 900, started_at: 1 }],
    can: { add: true, join: false, seePresence: true },
    pending: { outgoing: false, incoming: false },
    presence: null,
    ...over,
  });

  /** Answers the next fetch with one payload, so the card can be opened. */
  const serve = (payload) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, ...payload }) }); };

  const cardBody = () => document.getElementById('playerCardBody');
  const shell = () => cardBody().querySelector('.pc-shell');

  serve(profile());
  await menu.openPlayerCard('Grunk');

  check('the card wears its owner\'s colour, pattern, frame and layout', (() => {
    const el = shell();
    info(el?.getAttribute('style') ?? '(no shell)');
    return !!el && el.getAttribute('data-pattern') === 'rays'
      && el.getAttribute('data-layout') === 'showcase'
      && el.getAttribute('data-frame') === 'glow'
      && (el.getAttribute('style') ?? '').includes('#4d9bff');
  })());

  check('a card on auto takes its colour from the name when there is no picture', await (async () => {
    serve(profile({ user: { card: K.normaliseCard({ accentMode: 'auto' }) } }));
    await menu.openPlayerCard('Grunk');
    const style = shell()?.getAttribute('style') ?? '';
    // Not the stored default, and not empty: derived from the name.
    info(style);
    return /--pc-accent:#[0-9a-f]{6}/.test(style) && !style.includes('#f5a623');
  })());

  check('the pinned stats are the ones its owner pinned', await (async () => {
    serve(profile());
    await menu.openPlayerCard('Grunk');
    const html = cardBody().innerHTML;
    // Only the band: every one of these names also appears in the career grid
    // underneath, which is exactly the point — pinning promotes a figure, it
    // does not remove it from the card.
    const band = html.slice(html.indexOf('pc-headline'), html.indexOf('pc-actions'));
    return cardBody().querySelectorAll('.pc-big').length === 3
      && band.includes('K/D') && band.includes('HEADSHOTS') && band.includes('WINS')
      && !band.includes('ASSISTS') && !band.includes('PLAYTIME');
  })());

  check('a stranger who may be added is offered ADD FRIEND', (() => {
    const html = cardBody().innerHTML;
    return html.includes('data-card-act="add"') && html.includes('ADD FRIEND')
      && !html.includes('data-card-act="unfriend"');
  })());

  check('somebody already asked is offered CANCEL, never a second request', await (async () => {
    serve(profile({ can: { add: false, join: false, seePresence: true }, pending: { outgoing: true, incoming: false } }));
    await menu.openPlayerCard('Grunk');
    const html = cardBody().innerHTML;
    return html.includes('data-card-act="cancel"') && !html.includes('data-card-act="add"');
  })());

  check('somebody who asked us is offered ACCEPT and DECLINE', await (async () => {
    serve(profile({ can: { add: false, join: false, seePresence: true }, pending: { outgoing: false, incoming: true } }));
    await menu.openPlayerCard('Grunk');
    const html = cardBody().innerHTML;
    return html.includes('data-card-act="accept"') && html.includes('data-card-act="decline"');
  })());

  check('a friend in a joinable room gets JOIN, and the way to remove them', await (async () => {
    serve(profile({
      relation: 'friend',
      can: { add: false, join: true, seePresence: true },
      presence: { online: true, playing: true, room: 'FRA:7K2Q', map: 'Subzero', mode: 'Team Deathmatch', full: false },
    }));
    await menu.openPlayerCard('Grunk');
    const join = cardBody().querySelectorAll('button[data-card-act=join]');
    const html = cardBody().innerHTML;
    return join.length === 1 && join[0].dataset.arg === 'FRA:7K2Q'
      && html.includes('IN A MATCH') && html.includes('data-card-act="unfriend"');
  })());

  check('JOIN from the card drops straight into their match', (() => {
    played.length = 0;
    menu.cardAction('join', 'FRA:7K2Q');
    return played.length === 1 && played[0].room === 'FRA:7K2Q';
  })());

  check('a hidden section says so rather than reading as an empty career', await (async () => {
    serve(profile({
      hidden: ['showStats', 'showMatches'],
      recent: [],
      user: { stats: null },
    }));
    await menu.openPlayerCard('Grunk');
    const html = cardBody().innerHTML;
    info(cardBody().querySelectorAll('.pc-cell').length + ' stat cells drawn');
    return cardBody().querySelectorAll('.pc-cell').length === 0
      && html.includes('keeps their career stats private')
      && html.includes('keeps their match history private');
  })());

  check('your own card offers the editor rather than a friend request', await (async () => {
    serve(profile({ relation: 'self', can: { add: false, join: false, seePresence: true } }));
    await menu.openPlayerCard('Grunk');
    const html = cardBody().innerHTML;
    return html.includes('data-card-act="edit"') && html.includes('data-card-act="privacy"')
      && !html.includes('data-card-act="add"');
  })());

  /* ── The card editor and the privacy switches ────────────────────────── */

  /* ── The creator tab ─────────────────────────────────────────────────────
   *
   * One page with four states, and the whole risk is that a perk is drawn for
   * a discipline that was not granted it — which is the same failure the server
   * gates against, one layer up. Every block below is checked *present* for the
   * discipline that earns it and *absent* for one that does not.
   * ────────────────────────────────────────────────────────────────────────── */

  suite('Client — the creator tab');

  /** The exact shape /creator answers with. */
  const creatorRules = () => ({
    enabled: true, minLevel: K.CREATOR_MIN_LEVEL, needEmail: false, reapplyDays: 14,
    pitchMin: K.CREATOR_PITCH_MIN, pitchMax: K.CREATOR_PITCH_MAX, linksMax: K.CREATOR_LINKS_MAX,
    kinds: K.CREATOR_KINDS,
    platforms: K.CREATOR_PLATFORMS.map((p) => ({
      id: p.id, name: p.name, prefix: p.prefix ?? null, suffix: p.suffix ?? null,
      placeholder: p.placeholder,
    })),
    anthem: {
      maxSeconds: K.ANTHEM_MAX_SECONDS, minSeconds: K.ANTHEM_MIN_SECONDS,
      sampleRate: K.ANTHEM_SAMPLE_RATE, maxBytes: K.ANTHEM_MAX_BYTES,
      titleMax: K.ANTHEM_TITLE_MAX, targetDb: K.ANTHEM_TARGET_RMS_DB,
    },
    skinRequest: {
      nameMax: K.SKIN_REQUEST_NAME_MAX, briefMin: K.SKIN_REQUEST_BRIEF_MIN,
      briefMax: K.SKIN_REQUEST_BRIEF_MAX, paletteMax: K.SKIN_REQUEST_PALETTE_MAX,
      openMax: K.SKIN_REQUEST_OPEN_MAX, slots: [{ id: 'primary', name: 'Primary' }],
    },
  });
  const asCreator = (over) => {
    menu.creatorState = {
      rules: creatorRules(),
      apply: { can: true, why: null, retryAt: 0 },
      dev: { allowed: true, pro: false, need: 10, level: 12, panels: ['perf', 'net'] },
      skinRequests: [],
      creator: null,
      ...over,
    };
    menu.renderCreator();
    return (id) => document.getElementById(id);
  };
  const shown = (el, id) => !el(id).classList.contains('hidden');

  check('an operator who closed the programme closes the whole tab', (() => {
    /*
     * CREATORS_ENABLED=false. The routes have always refused; what was left was
     * a rail entry leading to a page whose every button answered 403, which is
     * the interface advertising something this server does not do.
     */
    menu.applyCreatorRules({ ...creatorRules(), enabled: false });
    const tab = document.querySelector('.tab[data-tab="creator"]');
    const closed = document.getElementById('creatorClosed');
    const body = document.getElementById('creatorBody');
    const hidden = tab.classList.contains('hidden') && tab.dataset.locked === '1'
      && !closed.classList.contains('hidden') && body.classList.contains('hidden');
    // …and switching it back on gives the entry back rather than needing a reload.
    menu.applyCreatorRules(creatorRules());
    const back = !tab.classList.contains('hidden') && tab.dataset.locked === '0';
    info(`off: entry ${hidden ? 'gone' : 'STILL THERE'} · on: entry ${back ? 'back' : 'MISSING'}`);
    return hidden && back;
  })());

  check('the four discipline cards are the picker, and are reachable', (() => {
    // Reading what a discipline earns and choosing it used to be two gestures a
    // screen apart, which is how somebody applies as whichever one the select
    // happened to open on. `tabindex` is what makes a card a keyboard and a
    // controller can reach at all — see PAD_CARDS in menu.js.
    const el = asCreator({});
    const cards = [...document.querySelectorAll('#crKinds .cr-kind')];
    const reachable = cards.every((c) => c.getAttribute('tabindex') === '0');
    const select = document.getElementById('crKind');
    const wanted = K.CREATOR_KINDS[K.CREATOR_KINDS.length - 1].id;
    menu._pickCreatorKind(cards.find((c) => c.dataset.kind === wanted));
    const moved = select.value === wanted;
    const lit = cards.find((c) => c.dataset.kind === wanted).classList.contains('chosen');
    info(`${cards.length} cards · picking ${wanted} moved the select: ${moved}`);
    return reachable && moved && lit && el('crKinds').classList.contains('picking');
  })());

  check('nothing irreversible asks through a window a pad cannot close', await (async () => {
    /*
     * `window.confirm()` opens an operating-system window, and no controller
     * gesture dismisses one — so every irreversible action in the game had a
     * door a pad could open and then not close. The question is asked in the
     * page now, out of the same two buttons every other card is built from.
     */
    const asked = menu.confirm({ body: 'Delete it?', ok: 'DELETE IT', danger: true });
    const modal = document.getElementById('confirmModal');
    const up = !modal.classList.contains('hidden')
      && document.getElementById('confirmYes').textContent === 'DELETE IT'
      && document.getElementById('confirmYes').className === 'btn-danger';
    document.getElementById('confirmNo').click();
    const no = await asked;

    const again = menu.confirm({ body: 'Sure?' });
    document.getElementById('confirmYes').click();
    const yes = await again;
    info(`up: ${up} · CANCEL → ${no} · CONFIRM → ${yes} · closed: ${modal.classList.contains('hidden')}`);
    return up && no === false && yes === true && modal.classList.contains('hidden');
  })());

  check('the link editor counts, stops at the limit and shows what it will store', (() => {
    const el = asCreator({});
    const max = K.CREATOR_LINKS_MAX;
    for (let i = 0; i < max + 3; i++) menu.addCreatorLinkRow('crLinks');
    menu.syncCreatorLinks();
    const rows = el('crLinks').querySelectorAll('.cr-link').length;
    const btn = el('crAddLink');
    // The preview is built by the same function the server stores the address
    // with, so it is the real answer rather than an illustration of one.
    const row = el('crLinks').querySelector('.cr-link');
    row.querySelector('.cr-link-platform').value = 'bandcamp';
    const handle = row.querySelector('.cr-link-handle');
    handle.value = '@melodie';
    handle.dispatchEvent(new Event('input'));
    const url = row.querySelector('.cr-link-url').textContent;
    info(`${rows} rows · ${el('crLinkCount').textContent} · preview "${url}"`);
    return rows === max && btn.disabled === true
      && el('crLinkCount').textContent === `${max} / ${max}`
      && url === K.creatorLinkUrl({ platform: 'bandcamp', handle: 'melodie' });
  })());

  check('never applied: the form is up and no perk is', (() => {
    const el = asCreator({});
    return el('crStanding').innerHTML.includes('NOT A CREATOR')
      && shown(el, 'crApplyForm')
      && (el('crKinds').innerHTML.match(/cr-kind/g) ?? []).length >= K.CREATOR_KINDS.length
      && !shown(el, 'crAnthemPerk') && !shown(el, 'crSkinPerk') && !shown(el, 'crLinksPerk');
  })());

  check('waiting on a decision: no form, and still nothing granted', (() => {
    const el = asCreator({
      creator: { kind: 'music', kindName: 'Music', status: 'pending', links: [], grants: [] },
    });
    return el('crStanding').innerHTML.includes('IN THE QUEUE')
      && !shown(el, 'crApplyForm') && !shown(el, 'crAnthemPerk') && !shown(el, 'crLinksPerk');
  })());

  check('turned down: the reason is what the page says, and applying reopens', (() => {
    const el = asCreator({
      creator: {
        kind: 'art', kindName: 'Art', status: 'rejected', links: [], grants: [],
        verdict: 'Nothing here is yours yet — send us work you made.',
      },
      apply: { can: false, why: 'you can apply again in 9 days', retryAt: 0 },
    });
    return el('crStanding').innerHTML.includes('send us work you made')
      && shown(el, 'crApplyForm')
      // The button is greyed with the sentence the route would have refused with.
      && el('crSubmit').disabled === true
      && el('crSubmit').textContent.includes('9 DAYS');
  })());

  check('a music creator gets the anthem and nothing an artist gets', (() => {
    const el = asCreator({
      creator: {
        kind: 'music', kindName: 'Music', status: 'approved', since: 1780000000,
        anthem: '/avatars/anthems/x.wav', anthemTitle: 'Overdrive', grants: ['anthem'],
        links: [{
          platform: 'bandcamp', handle: 'melodie',
          label: 'melodie.bandcamp.com', url: 'https://melodie.bandcamp.com',
        }],
      },
    });
    info(`anthem ${shown(el, 'crAnthemPerk')} · briefs ${shown(el, 'crSkinPerk')} `
      + `· links ${shown(el, 'crLinksPerk')} · resign ${shown(el, 'crResignPerk')}`);
    return shown(el, 'crAnthemPerk') && !shown(el, 'crSkinPerk')
      && shown(el, 'crLinksPerk') && shown(el, 'crResignPerk')
      && el('crAnthemState').innerHTML.includes('Overdrive')
      && el('crCardLinks').querySelectorAll('.cr-link').length === 1;
  })());

  check('and an art creator gets the briefs and nothing a musician gets', (() => {
    const el = asCreator({
      creator: {
        kind: 'art', kindName: 'Art', status: 'approved', since: 1780000000,
        links: [], grants: ['skinRequest', 'frame'],
      },
      skinRequests: [{
        id: 'r1', name: 'Neon Drift', slot: 'primary', brief: 'x'.repeat(60),
        palette: ['#ff00aa'], status: 'open', createdAt: 1780000000,
      }],
    });
    return shown(el, 'crSkinPerk') && !shown(el, 'crAnthemPerk')
      && el('crBriefs').innerHTML.includes('Neon Drift');
  })());

  check('the link editor never offers a URL field, only a platform and a handle', (() => {
    // The whole safety property of these links, drawn: there is nowhere on this
    // page to type a destination. See CREATOR_PLATFORMS in shared/constants.js.
    const el = asCreator({
      creator: {
        kind: 'music', kindName: 'Music', status: 'approved', links: [], grants: ['anthem'],
      },
    });
    menu.addCreatorLinkRow('crCardLinks');
    const row = el('crCardLinks').querySelectorAll('.cr-link')[0];
    const inputs = row.querySelectorAll('input');
    const options = row.querySelectorAll('.cr-link-platform option');
    info(`${options.length} platforms · ${inputs.length} text field (the handle)`);
    return options.length === K.CREATOR_PLATFORMS.length && inputs.length === 1
      && inputs[0].classList.contains('cr-link-handle')
      && inputs[0].type !== 'url';
  })());

  check('reading the editor back drops blank rows and folds pasted URLs', (() => {
    const el = asCreator({
      creator: { kind: 'music', kindName: 'Music', status: 'approved', links: [], grants: ['anthem'] },
    });
    el('crCardLinks').innerHTML = '';
    menu.addCreatorLinkRow('crCardLinks', { platform: 'twitch', handle: 'https://twitch.tv/CoolPerson/' });
    menu.addCreatorLinkRow('crCardLinks', { platform: 'youtube', handle: '' });
    const read = menu.readCreatorLinks('crCardLinks');
    const clean = K.normaliseCreatorLinks(read);
    info(`${read.length} row(s) with a handle → ${JSON.stringify(clean)}`);
    return read.length === 1 && clean.length === 1 && clean[0].handle === 'coolperson';
  })());

  check('signing out takes the developer page away with the session', (() => {
    // The tab used to appear only after a match, because the *join handshake*
    // was the one thing that carried the answer. It rides on the session
    // restore now, so `refreshAccount` is what puts it up and takes it down —
    // and a signed-out browser must not be left holding a page for an account
    // it no longer has.
    const tab = () => document.querySelector('.tab[data-tab="developer"]');
    menu.setDevAccess({ allowed: true, pro: false, need: 10, level: 12, panels: ['perf'] });
    const up = !tab().classList.contains('hidden');
    menu.setDevAccess(null);                    // what a signed-out `api.devAccess` is
    return up && tab().classList.contains('hidden') && tab().dataset.locked === '1';
  })());

  check('the developer rail entry follows the server\'s answer, both ways', (() => {
    const tab = () => document.querySelector('.tab[data-tab="developer"]');
    menu.setDevAccess({ allowed: true, pro: true, need: 10, level: 12, panels: [...K.DEV_PANEL_IDS] });
    const open = !tab().classList.contains('hidden')
      && tab().dataset.locked === '0'
      && document.getElementById('dvPanels').innerHTML.includes('CODE CREATOR');
    const listed = document.getElementById('dvPanels').querySelectorAll('.dv-panel').length;
    // …and a demotion mid-session takes the page away rather than waiting for
    // a reload, without the search box being able to hand it back.
    menu.setDevAccess({ allowed: false, pro: false, panels: [] });
    const shut = tab().classList.contains('hidden') && tab().dataset.locked === '1';
    const box = document.getElementById('tabSearch');
    box.value = 'developer';
    box.fire('input');
    const stillShut = tab().classList.contains('hidden');
    box.value = '';
    box.fire('input');
    info(`${listed} panels listed for a code creator · hidden after demotion: ${shut}`);
    return open && listed === K.DEV_PANELS.length && shut && stillShut
      && tab().classList.contains('hidden');
  })());

  suite('Client — customising the card');

  check('the editor is built from the shared catalogue, not a hard-coded list', (() => {
    menu.buildCardEditor();
    const host = document.getElementById('cardEditor');
    const chips = host.querySelectorAll('.ce-chip');
    const values = chips.map((c) => c.dataset.value);
    info(`${chips.length} chips · ${host.querySelectorAll('.ce-block').length} blocks`);
    return K.CARD_PATTERNS.every((p) => values.includes(p.id))
      && K.CARD_FRAMES.every((f) => values.includes(f.id))
      && K.CARD_LAYOUTS.every((l) => values.includes(l.id))
      && K.CARD_STATS.every((st) => values.includes(st.id));
  })());

  check('picking a fourth pinned stat drops the oldest rather than refusing', (() => {
    menu.cardDraft = { ...K.CARD_DEFAULTS, featured: ['kd', 'kills', 'wins'] };
    menu.setCardField('featured', 'damage');
    const after = menu.cardDraft.featured;
    info(after.join(', '));
    return after.length === K.CARD_FEATURED_MAX && after.includes('damage') && !after.includes('kd');
  })());

  check('the band can never be emptied', (() => {
    menu.cardDraft = { ...K.CARD_DEFAULTS, featured: ['kd'] };
    menu.setCardField('featured', 'kd');
    return menu.cardDraft.featured.length === 1;
  })());

  check('picking a colour switches the card off auto', (() => {
    menu.cardDraft = { ...K.CARD_DEFAULTS, accentMode: 'auto' };
    menu.setCardField('accent', '#b07cff');
    // Both halves: a colour stored while the card still follows the picture is
    // a colour that never shows up anywhere.
    return menu.cardDraft.accent === '#b07cff' && menu.cardDraft.accentMode === 'custom';
  })());

  check('the server has the last word on what a card may say', (() => {
    // Whatever the editor sends, this is the shape that can be stored — the
    // route runs exactly this function before it writes.
    const cleaned = K.normaliseCard({
      pattern: 'not-a-pattern', layout: 'nope', frame: 12, accent: 'javascript:x',
      featured: ['kd', 'made-up', 'wins', 'kills', 'score'],
      title: `  spaced   out  ${'x'.repeat(200)}`,
      glow: false,
    });
    info(`${cleaned.pattern} · ${cleaned.accent} · ${cleaned.featured.length} pinned · title ${cleaned.title.length}`);
    return cleaned.pattern === K.CARD_DEFAULTS.pattern && cleaned.layout === K.CARD_DEFAULTS.layout
      && cleaned.frame === K.CARD_DEFAULTS.frame && cleaned.accent === K.CARD_DEFAULTS.accent
      && cleaned.featured.length === K.CARD_FEATURED_MAX
      && !cleaned.featured.includes('made-up')
      && cleaned.title.length === K.CARD_TITLE_MAX && cleaned.glow === false;
  })());

  check('a tagline cannot carry newlines or invisible characters', (() => {
    const cleaned = K.normaliseCard({ title: 'one two\nthree​four‮' });
    info(JSON.stringify(cleaned.title));
    return cleaned.title === 'one two three four' ;
  })());

  check('every privacy switch is drawn with all of its answers', (() => {
    menu.buildPrivacyForm();
    const host = document.getElementById('privacyForm');
    const rows = host.querySelectorAll('.pv-row');
    const values = host.querySelectorAll('.pv-opt').map((b) => `${b.dataset.priv}:${b.dataset.value}`);
    info(`${rows.length} rows · ${values.length} answers`);
    return rows.length === K.PRIVACY_FIELDS.length + 1
      && K.PRIVACY_FIELDS.every((f) => f.options.every((o) => values.includes(`${f.id}:${o}`)))
      && values.includes('listed:true') && values.includes('listed:false');
  })());

  check('exactly one answer per switch is marked', (() => {
    const host = document.getElementById('privacyForm');
    const rows = host.querySelectorAll('.pv-row').length;
    const marked = host.querySelectorAll('.pv-opt.on');
    // One per row, and each on a different switch: two marks on one row would
    // otherwise pass a plain count.
    const switches = new Set(marked.map((b) => b.dataset.priv));
    info(`${marked.length} marked across ${rows} rows`);
    return marked.length === rows && switches.size === rows;
  })());

  /* ── The sound engine ────────────────────────────────────────────────── */

  /* ── The kill cam, as a camera ───────────────────────────────────────────
   *
   * The overlay is tested above; this is the part that decides where you are
   * looking and for how long. What matters is that it never becomes a rule the
   * *match* has to honour: it holds the respawn by declining to ask for one,
   * exactly like the pause menu, and a client that skipped every frame of it
   * would be no better off than one that watched.
   * ────────────────────────────────────────────────────────────────────────── */

  suite('Client — the kill cam');

  /** One DEATH message, shaped exactly the way room.js sends it. */
  const deathMsg = (over = {}) => ({
    by: 'Nemesis', byId: 7, byClan: 'GRUN', byClanVerified: true, byLevel: 34,
    byVerified: false, byCreator: 'music', anthem: null, anthemTitle: null,
    weapon: 'ar', head: true, respawnIn: K.RESPAWN_TIME, killerHealth: 8, distance: 41,
    cam: { seconds: K.KILLCAM_SECONDS, skipAfter: K.KILLCAM_SKIP_AFTER, director: 0 },
    ...over,
  });
  /** Just enough of an EntityManager for the cam to find a body to orbit. */
  const bodies = (id, pos) => ({ get: (n) => (n === id ? { pos } : undefined) });

  /**
   * A snapshot ring holding `seconds` of one player walking in a straight line
   * and turning as they go — enough for the replay to have something to play.
   *
   * It answers `sampleAt` the way the real EntityManager does, because that is
   * the whole of what the cam asks a ring for; `get` is still the orbit's door,
   * so one object stands in for both halves of the cam.
   */
  const history = (id, seconds, { end = 100000, rate = 20 } = {}) => ({
    earliestTime: end - seconds * 1000,
    latestTime: end,
    get: (n) => (n === id ? { pos: { x: 40, y: 0, z: 0 } } : undefined),
    sampleAt(n, t) {
      if (n !== id) return null;
      if (t < this.earliestTime - 1 || t > this.latestTime + 1) return null;
      // Quantised to the snapshot rate, so this is a ring and not a formula.
      const step = Math.round((t - this.earliestTime) / (1000 / rate));
      return {
        x: step * 0.25, y: 0, z: 0,
        yaw: step * 0.02, pitch: 0.1,
        height: K.PLAYER_HEIGHT, alive: true,
      };
    },
  });

  check('the world killing you gets the plain death screen, not a cam', (() => {
    // A fall, the void, your own rocket. There is nobody to look at, so there
    // is nothing to look at — and `begin` answering null is what makes the
    // fallback one branch in main.js rather than a list of conditions.
    const cam = new KillCam();
    settings.killCam = true;
    const none = cam.begin(deathMsg({ byId: 0, cam: { seconds: 0, skipAfter: 3 } }));
    const off = (() => {
      settings.killCam = false;
      const r = cam.begin(deathMsg());
      settings.killCam = true;
      return r;
    })();
    return none === null && off === null && !cam.active;
  })());

  check('it holds the respawn for three seconds and then lets go', (() => {
    const cam = new KillCam();
    cam.begin(deathMsg());
    const ents = bodies(7, { x: 10, y: 0, z: 4 });
    const early = cam.canSkip;                       // t = 0
    cam.update(1.0, ents, { x: 0, y: 0, z: 0 });
    const stillHeld = !cam.canSkip && cam.holding;
    cam.update(2.2, ents, { x: 0, y: 0, z: 0 });     // t = 3.2
    const nowFree = cam.canSkip;
    const skipped = cam.skip();
    info(`skip at 0s: ${early} · at 1s: ${!stillHeld ? 'yes' : 'no'} · at 3.2s: ${nowFree}`);
    return !early && stillHeld && nowFree && skipped && !cam.active && !cam.holding;
  })());

  check('and a skip before it lights up changes nothing at all', (() => {
    const cam = new KillCam();
    cam.begin(deathMsg());
    cam.update(1.0, bodies(7, { x: 1, y: 0, z: 1 }), { x: 0, y: 0, z: 0 });
    const refused = cam.skip() === false;
    return refused && cam.active && cam.holding;
  })());

  check('it ends itself at ten seconds whether or not anybody pressed anything', (() => {
    const cam = new KillCam();
    cam.begin(deathMsg());
    const ents = bodies(7, { x: 10, y: 0, z: 4 });
    let frames = 0;
    while (cam.active && frames < 2000) { cam.update(1 / 60, ents, { x: 0, y: 0, z: 0 }); frames++; }
    const seconds = frames / 60;
    info(`ran ${seconds.toFixed(2)}s of a ${K.KILLCAM_SECONDS}s cam`);
    return !cam.active && Math.abs(seconds - K.KILLCAM_SECONDS) < 0.2;
  })());

  check('turning the hold off ends it the moment the skip would have lit up', (() => {
    const cam = new KillCam();
    settings.killCamHold = false;
    cam.begin(deathMsg());
    let frames = 0;
    while (cam.active && frames < 2000) {
      cam.update(1 / 60, bodies(7, { x: 5, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
      frames++;
    }
    settings.killCamHold = true;
    info(`ran ${(frames / 60).toFixed(2)}s with the hold off`);
    return !cam.active && Math.abs(frames / 60 - K.KILLCAM_SKIP_AFTER) < 0.2;
  })());

  check('the camera eases out of the body and orbits the killer', (() => {
    const cam = new KillCam();
    cam.begin(deathMsg());
    const killer = { x: 20, y: 0, z: 0 };
    const fell = { x: 0, y: 0, z: 0 };
    const ents = bodies(7, killer);

    const first = cam.update(1 / 60, ents, fell);
    // One frame in, the shot is still essentially where the body fell — which
    // is what makes it read as one continuous camera rather than a teleport.
    const startsHome = Math.hypot(first.from.x - fell.x, first.from.z - fell.z) < 2;
    const looksAtKiller = Math.abs(first.at.x - killer.x) < 0.01;

    let settled = first;
    for (let i = 0; i < 120; i++) settled = cam.update(1 / 60, ents, fell);
    // Two seconds later it is in orbit: a fixed distance out, above the head.
    const radius = Math.hypot(settled.from.x - killer.x, settled.from.z - killer.z);
    const above = settled.from.y > killer.y + 1;
    info(`t=0 ${Math.hypot(first.from.x - fell.x, first.from.z - fell.z).toFixed(2)}u from the body `
      + `→ t=2 ${radius.toFixed(2)}u from the killer`);
    return startsHome && looksAtKiller && above && radius > 3 && radius < 7;
  })());

  check('a killer who leaves mid-cam does not take the camera with them', (() => {
    // The last place they were seen, not the origin: a cam that has lost its
    // subject should get out of the way, and one that snaps to (0,0,0) is a
    // camera under a map.
    const cam = new KillCam();
    cam.begin(deathMsg());
    const seen = cam.update(0.5, bodies(7, { x: 30, y: 2, z: 12 }), { x: 0, y: 0, z: 0 });
    const gone = cam.update(0.5, bodies(99, { x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
    return seen && gone && Math.abs(gone.at.x - 30) < 0.01 && Math.abs(gone.at.z - 12) < 0.01;
  })());

  check('the camera never ends up inside the map', (() => {
    /*
     * The one failure every orbiting death camera has: a killer with their back
     * to a wall, and a quarter of the orbit spent looking at the inside of it.
     *
     * Swept over every orbit position on every map in the game, so this is a
     * measurement rather than a spot check — and it is stated as a *rate*
     * because a corner under a low ceiling has genuinely nowhere to put a
     * camera, and pretending otherwise would mean a threshold nobody could
     * ever meet. What it holds down is that the answer is rare and that the
     * fallback never puts the shot inside the body it is filming.
     */
    const cam = new KillCam();
    let sampled = 0, clipped = 0, tooClose = 0, unfixed = 0;
    for (const id of ALL_MAP_IDS) {
      const map = getMap(id);
      const world = new World(map);
      const solid = (p) => world.query(p.x - 0.05, p.y - 0.05, p.z - 0.05,
        p.x + 0.05, p.y + 0.05, p.z + 0.05).length > 0;
      const half = (map.ground?.size ?? map.size ?? 128) / 2;
      for (let x = -half + 6; x < half - 6; x += 11) {
        for (let z = -half + 6; z < half - 6; z += 11) {
          const killer = { x, y: 0, z };
          if (solid({ x, y: 1.2, z })) continue;          // killer in a wall: not a case
          cam.begin(deathMsg());
          const ents = bodies(7, killer);
          // Two full turns of the orbit, at the rate it really drifts.
          for (let i = 0; i < 90; i++) {
            const shot = cam.update(0.14, ents, { x: x + 3, y: 0, z }, world);
            if (!shot) break;
            sampled++;
            if (solid(shot.from)) clipped++;
            const d = Math.hypot(shot.from.x - shot.at.x, shot.from.y - shot.at.y,
              shot.from.z - shot.at.z);
            if (d < 1) tooClose++;
            // What it would have been with no world at all, for the contrast.
            const naive = cam.update(0, ents, null, null);
            if (naive && solid(naive.from)) unfixed++;
          }
          cam.end();
        }
      }
    }
    const pct = (n) => `${((n / sampled) * 100).toFixed(2)}%`;
    info(`${sampled} shots over ${ALL_MAP_IDS.length} maps · inside geometry ${pct(clipped)} `
      + `(${pct(unfixed)} without the raycast) · closer than 1u ${pct(tooClose)}`);
    return sampled > 5000 && clipped / sampled < 0.01 && tooClose / sampled < 0.005
      && clipped < unfixed;
  })());

  /* ── The replay ─────────────────────────────────────────────────────────
   *
   * The cam is a replay of the ten seconds before the death, seen from inside
   * the killer's head, and the orbit above is what runs when there is no
   * history to replay. These check the seam between the two.
   * ────────────────────────────────────────────────────────────────────── */

  check('with history, the cam is the killer\u2019s own eyes and not an orbit', (() => {
    const cam = new KillCam();
    const ring = history(7, K.KILLCAM_SECONDS);
    cam.begin(deathMsg(), ring);
    const shot = cam.update(1 / 60, ring, { x: 0, y: 0, z: 0 });
    const sample = ring.sampleAt(7, cam.replayTime);
    // The eye, exactly: their feet plus their height, less the eye offset.
    const atEye = Math.abs(shot.from.y - (sample.y + sample.height - K.EYE_OFFSET)) < 1e-6;
    info(`replay ${shot.replay} · rot ${shot.rot ? 'yes' : 'no'} · eye y=${shot.from.y.toFixed(3)}`);
    return shot.replay === true && !!shot.rot && atEye
      && Math.abs(shot.rot.pitch - 0.1) < 1e-9;
  })());

  check('it starts ten seconds before the death and runs at real time', (() => {
    const cam = new KillCam();
    const ring = history(7, K.KILLCAM_SECONDS);
    cam.begin(deathMsg(), ring);
    const opened = cam.replayTime;
    for (let i = 0; i < 60 * 5; i++) cam.update(1 / 60, ring, { x: 0, y: 0, z: 0 });
    const halfway = cam.replayTime;
    const startsBack = Math.abs(opened - (ring.latestTime - K.KILLCAM_SECONDS * 1000)) < 1;
    const realTime = Math.abs((halfway - opened) - 5000) < 40;
    info(`opens at \u2212${((ring.latestTime - opened) / 1000).toFixed(1)}s, `
      + `5s later it is at \u2212${((ring.latestTime - halfway) / 1000).toFixed(1)}s`);
    return startsBack && realTime;
  })());

  check('a full ring is replayed for the whole cam, with no orbit tacked on', (() => {
    // Ten seconds of cam over ten seconds of history: the replay *is* the cam,
    // it ends on the frame you died, and the orbit never runs. That is the
    // ordinary case and the one the setting describes.
    const cam = new KillCam();
    const ring = history(7, K.KILLCAM_SECONDS);
    cam.begin(deathMsg(), ring);
    let replayFrames = 0, orbitFrames = 0, frames = 0;
    while (cam.active && frames < 2000) {
      const shot = cam.update(1 / 60, ring, { x: 0, y: 0, z: 0 });
      frames++;
      if (shot?.replay) replayFrames++; else if (shot) orbitFrames++;
    }
    info(`${(replayFrames / 60).toFixed(2)}s replay + ${(orbitFrames / 60).toFixed(2)}s orbit`);
    return Math.abs(replayFrames / 60 - K.KILLCAM_SECONDS) < 0.2 && orbitFrames === 0;
  })());

  check('and a short ring hands the camera to the orbit when it runs out', (() => {
    // Four seconds of history under a ten-second cam — somebody who joined
    // mid-match, or a director's cut, which is longer than the ring is deep.
    // The replay plays what there is and the orbit finishes the shot.
    const cam = new KillCam();
    const ring = history(7, 4);
    cam.begin(deathMsg(), ring);
    let replayFrames = 0, last = null, frames = 0;
    while (cam.active && frames < 2000) {
      last = cam.update(1 / 60, ring, { x: 0, y: 0, z: 0 });
      frames++;
      if (last?.replay) replayFrames++;
    }
    const seconds = replayFrames / 60;
    info(`${seconds.toFixed(2)}s of replay, then ${((frames - replayFrames) / 60).toFixed(2)}s of orbit`);
    return Math.abs(seconds - 4) < 0.2 && frames - replayFrames > 60 * 5;
  })());

  check('too little history is the orbit, not a two-frame replay', (() => {
    // Dying four seconds after spawning. A cut in, a shot and a cut out landing
    // on top of each other reads as a glitch, so under a second and a half the
    // cam is simply the orbit, which needs no history at all.
    const cam = new KillCam();
    const ring = history(7, 0.6);
    cam.begin(deathMsg(), ring);
    const shot = cam.update(1 / 60, ring, { x: 0, y: 0, z: 0 });
    return cam.replayTime === null && shot && shot.replay === false && !shot.rot;
  })());

  check('a client with no ring at all still gets the cam it always had', (() => {
    // Every one of the orbit checks above passes `begin` no history, which is
    // the same path a build before the replay existed took.
    const cam = new KillCam();
    const shot = cam.begin(deathMsg());
    return shot !== null && shot.replay === false && cam.replayTime === null;
  })());

  check('turning the replay off leaves the orbit and nothing else', (() => {
    const cam = new KillCam();
    settings.killCamReplay = false;
    const ring = history(7, K.KILLCAM_SECONDS);
    cam.begin(deathMsg(), ring);
    const off = cam.replayTime === null;
    settings.killCamReplay = true;
    cam.end();
    cam.begin(deathMsg(), ring);
    const on = cam.replayTime !== null;
    return off && on;
  })());

  check('the overlay counts down to the death rather than up from the start', (() => {
    const cam = new KillCam();
    const ring = history(7, K.KILLCAM_SECONDS);
    cam.begin(deathMsg(), ring);
    cam.update(2, ring, { x: 0, y: 0, z: 0 });
    const v = cam.view();
    info(`at 2s: ${v.replayAt.toFixed(1)}s in, ${v.replayLeft.toFixed(1)}s to go`);
    return v.replay === true && Math.abs(v.replayAt - 2) < 0.01
      && Math.abs(v.replayLeft - (K.KILLCAM_SECONDS - 2)) < 0.01;
  })());

  check('a killer who leaves mid-replay falls back rather than freezing', (() => {
    // Their half of the ring goes with them, so `sampleAt` answers null. The
    // orbit cannot find them either; both say so, and the death screen takes
    // over — which is what a cam that has lost its subject should do.
    const cam = new KillCam();
    const ring = history(7, K.KILLCAM_SECONDS);
    cam.begin(deathMsg(), ring);
    cam.update(1, ring, { x: 0, y: 0, z: 0 });
    const empty = { ...history(99, K.KILLCAM_SECONDS), get: () => undefined };
    const gone = cam.update(1 / 60, empty, null);
    return gone === null;
  })());

  check('a video creator is offered a longer shot, never a longer wait', (() => {
    // The director's cut holds the frame for longer if they keep it. The skip
    // still lights up at the same three seconds as everybody else's — a perk
    // that made a death screen harder to leave would be a punishment.
    const cam = new KillCam();
    const msg = deathMsg({ cam: { seconds: K.KILLCAM_SECONDS, skipAfter: K.KILLCAM_SKIP_AFTER,
      director: K.KILLCAM_DIRECTOR_SECONDS } });
    const shot = cam.begin(msg);
    return shot.seconds === K.KILLCAM_DIRECTOR_SECONDS
      && shot.skipAfter === K.KILLCAM_SKIP_AFTER
      && cam.view().director === true;
  })());

  check('every fact on the cam comes off the message, not out of the client', (() => {
    const cam = new KillCam();
    cam.begin(deathMsg());
    const v = cam.view();
    return v.name === 'Nemesis' && v.clan === 'GRUN' && v.clanVerified === true
      && v.level === 34 && v.creator === 'music' && v.distance === 41 && v.health === 8
      && v.head === true;
  })());

  /* ── Developer mode ─────────────────────────────────────────────────────── */

  suite('Client — developer mode');

  check('the client never decides for itself what it may open', (() => {
    // The level and the creator status both live on the server; a client that
    // worked the answer out locally would be one that could be told to work it
    // out differently.
    const dev = new DevMode();
    const shutByDefault = !dev.access.allowed && !dev.toggle(true);
    dev.setAccess({ allowed: true, pro: false, need: 10, level: 12, panels: ['perf', 'net'] });
    const opens = dev.toggle(true);
    // …and a demotion mid-session closes it rather than waiting for a reload.
    dev.setAccess({ allowed: false, panels: [] });
    return shutByDefault && opens && !dev.open;
  })());

  check('a panel the server did not grant cannot be switched on locally', (() => {
    const dev = new DevMode();
    dev.setAccess({ allowed: true, pro: false, need: 10, level: 12, panels: ['perf', 'net'] });
    settings.devPanels = [...K.DEV_PANEL_IDS];         // ask for all seven
    const got = dev.panels;
    settings.devPanels = ['perf', 'net'];
    info(`asked for ${K.DEV_PANEL_IDS.length}, got ${got.length}: ${got.join(', ')}`);
    return got.length === 2 && K.DEV_PRO_PANEL_IDS.every((id) => !got.includes(id));
  })());

  check('and an access answer naming a panel that does not exist is ignored', (() => {
    const dev = new DevMode();
    dev.setAccess({ allowed: true, panels: ['perf', 'wallhack', 'net'] });
    return !dev.access.panels.includes('wallhack') && dev.access.panels.length === 2;
  })());

  check('the samplers cost nothing while the mode is shut', (() => {
    // They sit in the render loop and on the reconciliation path, so "returns
    // on its first line" is the only acceptable behaviour when it is off.
    const dev = new DevMode();
    for (let i = 0; i < 500; i++) {
      dev.sampleFrame(16.7);
      dev.sampleRecon(0.01, 3);
      dev.samplePacket('in', 'sn', 800);
    }
    return dev.frames.length === 0 && dev.recon.length === 0 && dev.wire.size === 0;
  })());

  check('and hold a bounded window once it is open', (() => {
    const dev = new DevMode();
    dev.setAccess({ allowed: true, pro: true, panels: [...K.DEV_PANEL_IDS] });
    for (let i = 0; i < 5000; i++) {
      dev.sampleFrame(10 + (i % 30));
      dev.sampleRecon(0.02, 2);
      dev.samplePacket(i % 2 ? 'in' : 'out', 'sn', 400);
    }
    info(`${dev.frames.length} frames · ${dev.recon.length} corrections · ${dev.wire.size} opcodes`);
    return dev.frames.length <= 600 && dev.recon.length <= 160 && dev.wire.size === 2;
  })());

  check('every panel renders from real samples without throwing', (() => {
    const dev = new DevMode();
    dev.setAccess({ allowed: true, pro: true, panels: [...K.DEV_PANEL_IDS] });
    dev.open = true;
    dev.el = document.getElementById('devOverlay');
    settings.devPanels = [...K.DEV_PANEL_IDS];
    for (let i = 0; i < 200; i++) {
      dev.sampleFrame(8 + Math.random() * 30);
      dev.sampleRecon(Math.random() * 0.4, i % 7);
      dev.samplePacket(i % 2 ? 'in' : 'out', i % 3 ? 'sn' : 'in', 200 + i);
    }
    try {
      dev.drawAt = 0;
      dev.update({
        gfx: { renderer: { info: { render: { calls: 41, triangles: 90210 }, memory: {}, programs: [] } } },
        net: { rtt: 0.042, rttSamples: [0.04, 0.045, 0.041], clockOffset: -3.2 },
        entities: { buffer: [{ t: 1000 }, { t: 1100 }] },
        pending: [1, 2, 3],
        local: { x: 1, y: 2, z: 3, vx: 4, vy: 0, vz: 5, onGround: true, height: 1.8 },
        input: { yaw: 1.2, pitch: -0.1 },
        health: 100, tick: 4200,
      });
    } catch (err) { info(String(err)); return false; }
    const drawn = dev.el.innerHTML;
    settings.devPanels = ['perf', 'net'];
    return K.DEV_PANELS.every((p) => drawn.includes(p.name)) && drawn.includes('dev-toggle');
  })());

  suite('Client — audio');

  // Order matters here. The voice budget is a real ceiling and the shim never
  // advances the clock, so nothing is ever released during a run: every check
  // that *measures* voices has to come before the one that spends them all.
  check('the graph builds on the first gesture and is built only once', (() => {
    const first = audio.initAudio();
    const second = audio.initAudio();
    return !!first && first === second;
  })());

  check('distance decides the mix, not just the level', (() => {
    // The same weapon, near and far. Far has to cost fewer voices: the crack
    // and the mechanism are gone, which is the whole distance model.
    const spec = getClass('triggerman').primary.sound;
    const before = audio.voiceCount();
    audio.sfx.shot(spec, null, null);
    const near = audio.voiceCount() - before;
    const mid = audio.voiceCount();
    audio.sfx.shot(spec, { x: 300, y: 0, z: 300 }, listener);
    const far = audio.voiceCount() - mid;
    info(`${near} voices near · ${far} far`);
    return near > 0 && far < near;
  })());

  check('a surface marked silent makes no sound at all', (() => {
    // There is one, and the whole point of it is that it is not heard.
    const silent = Object.keys(K.SURFACE_FX).find((s) => K.SURFACE_FX[s].silent);
    if (!silent) { info('no silent surface in this build'); return true; }
    const before = audio.voiceCount();
    audio.sfx.impact({ x: 1, y: 1, z: 1 }, listener, silent);
    audio.sfx.footstep(false, silent);
    return audio.voiceCount() === before;
  })());

  check('every sound the game asks for exists and survives being played', (() => {
    // The catalogue is called from six files; a recipe that throws takes the
    // frame it was played on with it.
    const calls = [
      () => audio.sfx.shot(getClass('triggerman').primary.sound, null, null),
      () => audio.sfx.shot(getClass('marksman').primary.sound, { x: 40, y: 2, z: 30 }, listener),
      () => audio.sfx.whizz(0.3, 0.8),
      () => audio.sfx.hitmarker(true, false),
      () => audio.sfx.hitmarker(false, true),
      () => audio.sfx.kill(),
      () => audio.sfx.hurt(45),
      () => audio.sfx.fleshHit(),
      () => audio.sfx.die(),
      () => audio.sfx.explosion({ x: 3, y: 1, z: 2, r: 7 }, listener),
      () => audio.sfx.impact({ x: 2, y: 1, z: 1 }, listener, 'metal'),
      () => audio.sfx.impact({ x: 2, y: 1, z: 1 }, listener, 'snow'),
      () => audio.sfx.shell(),
      () => audio.sfx.reload('out'), () => audio.sfx.reload('in'), () => audio.sfx.reload('charge'),
      () => audio.sfx.cycle(), () => audio.sfx.dryFire(), () => audio.sfx.switchWeapon(),
      () => audio.sfx.footstep(true, 'metal'), () => audio.sfx.jump(),
      () => audio.sfx.land(true, 'snow'), () => audio.sfx.slide(), () => audio.sfx.spawn(),
      () => audio.sfx.ui('click'), () => audio.sfx.ui('hover'),
      () => audio.sfx.ui('ok'), () => audio.sfx.ui('error'),
      () => audio.sfx.levelUp(), () => audio.sfx.unlock(), () => audio.sfx.matchEnd(),
      () => audio.sfx.points(true), () => audio.sfx.sting(1.2),
      () => audio.sfx.tick(true), () => audio.sfx.siren(false), () => audio.sfx.nuke(),
    ];
    for (const call of calls) {
      try { call(); } catch (e) { info(String(e)); return false; }
    }
    info(`${calls.length} recipes played`);
    return true;
  })());

  check('a firefight cannot outrun the voice budget', (() => {
    const spec = getClass('spraynpray').primary.sound;
    for (let i = 0; i < 400; i++) audio.sfx.shot(spec, null, null);
    const used = audio.voiceCount();
    info(`${used} voices live after 400 shots in one frame`);
    return used <= audio.MAX_VOICES;
  })());

  check('turning the effects down to nothing stops making them', (() => {
    const was = settings.sfxVolume;
    settings.sfxVolume = 0;
    const before = audio.voiceCount();
    for (let i = 0; i < 10; i++) audio.sfx.ui('click');
    const quiet = audio.voiceCount() === before;
    settings.sfxVolume = was;
    return quiet;
  })());
}
