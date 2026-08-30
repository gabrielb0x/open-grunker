/**
 * Open Grunker — user settings.
 *
 * The browser is the home of these, not the server: every write lands in
 * localStorage immediately, so a guest who has never signed in keeps their
 * sensitivity, their crosshair and their video preset across sessions exactly
 * like anybody else. An account only *syncs* them between devices — it has
 * never been what makes them stick — and `exportText`/`importText` below are
 * the version of that which needs no account at all.
 */

import { LANGUAGE_IDS, languageName, detect as detectLanguage } from './languages.js';

const KEY = 'og.settings.v2';
const LEGACY_KEY = 'og.settings.v1';

export const DEFAULTS = {
  /**
   * Which language the interface is in.
   *
   * `auto` is the browser's own preference, which is the answer for almost
   * everybody and the only one that is right before anybody has opened a menu.
   * Anything else is a deliberate choice and outranks it — including English,
   * which is why 'auto' and 'en' are two different values rather than one.
   */
  language: 'auto',

  /* Aim */
  sensitivity: 1.0,
  adsSensitivity: 0.72,
  fov: 100,
  invertY: false,
  toggleAds: false,
  toggleCrouch: false,
  autoReload: true,
  recoilRecovery: true,
  mouseAcceleration: false,

  /* Controller */
  gamepad: true,
  gamepadLookX: 1.0,
  gamepadLookY: 0.85,
  gamepadDeadzone: 0.18,
  gamepadResponse: 2.0,
  gamepadInvertY: false,
  gamepadAimAssist: 0.55,
  gamepadVibration: true,

  /* Audio */
  masterVolume: 0.7,
  sfxVolume: 1.0,
  /**
   * How loud other players' anthems are, on their own fader.
   *
   * Separate from the effects volume on purpose: an anthem is somebody else's
   * music playing on your screen, and "I want the game but not that" is a
   * completely reasonable thing to want without turning the game down too.
   * Zero is the same as having no anthem at all — the cam just runs silent.
   */
  anthemVolume: 0.8,
  hitSound: true,
  announcer: true,

  /* Kill cam */
  killCam: true,
  /**
   * Whether the cam replays the fight from the killer's eyes or simply orbits
   * their body.
   *
   * The replay is the cam; the orbit is what runs when there is no history to
   * replay — somebody who died four seconds after spawning, or to a player who
   * has since left. This switch is for anyone who finds ten seconds of
   * somebody else's mouse hard to watch, which is a real thing to find.
   */
  killCamReplay: true,
  /**
   * Whether the cam holds for its full ten seconds or ends the moment it may be
   * skipped. Off is the escape hatch for anyone who finds ten seconds long —
   * the skip is still there either way, this only decides what happens when
   * nobody presses it.
   */
  killCamHold: true,

  /* Video */
  quality: 'high',          // low | medium | high | ultra
  shadows: true,
  particles: true,
  particleAmount: 1.0,
  dynamicLights: true,
  /**
   * How much post-processing, from none to all of it.
   *
   * It was a switch. A switch is the wrong control for this: the chain is five
   * effects of very different cost and taste — bloom, the grade, the vignette,
   * the grain and the lens fringing — and "on" was one answer to all five.
   * Somebody on a laptop wants less of it, not none of it, and somebody who
   * finds the bloom heavy wants it quieter rather than gone.
   *
   * So it is an amount now. 1 is the look every map was painted against, 0 is
   * the chain switched off outright — which is still a real answer and still
   * the fastest the game gets — and everything between scales the four that
   * can be scaled. The grade is not one of them: see `_applyToneMapping` in
   * world.js for why tone mapping is never faded. A build that stored
   * `true`/`false` is migrated on load; see `migrate` below.
   */
  postProcessing: 1,
  bloom: 0.6,
  /**
   * The colour grade, as multipliers on the game's own look rather than as raw
   * shader values — 1.00 is exactly what the maps were painted against, so a
   * player who has never opened this pays nothing and sees no difference.
   *
   * Applied in the post chain's composite when post-processing is on, where it
   * happens in linear light before the vignette and the grain. With post off
   * there is no composite to put it in, so world.js hands the same two numbers
   * to the compositor as a CSS filter instead — the same control either way,
   * which is what stops it from being a slider that silently does nothing.
   */
  saturation: 1.0,
  contrast: 1.0,
  vignette: true,
  filmGrain: true,
  chromatic: true,
  brightness: 0.0,
  decals: true,
  tracers: true,
  shells: true,
  viewBob: true,
  screenShake: true,
  fpsLimit: 0,              // 0 = unlimited

  /* Viewmodel */
  viewmodelFov: 64,
  viewmodelX: 0,
  viewmodelY: 0,
  viewmodelZ: 0,
  leftHanded: false,
  hideWeaponAds: false,

  /* HUD */
  nametags: true,
  nametagScale: 1.4,
  showFps: true,
  showMinimap: true,
  minimapZoom: 1.0,
  showDamageNumbers: true,
  showKillfeed: true,
  showLiveScore: true,
  showPointsFeed: true,
  showSpeed: false,
  hudScale: 1.0,

  /* Spectator (local to this browser — the camera is not part of the match) */
  specXray: false,
  specThirdPerson: false,

  /*
   * Developer mode.
   *
   * Which overlays are on, and whether the mode itself is. Both are stored here
   * rather than on the account because they are a preference about this screen,
   * not a permission — the permission is a level and a creator status, both of
   * which the server answers and neither of which this file can influence.
   * A panel listed here that the account may not open is simply not drawn.
   */
  devMode: false,
  devPanels: ['perf', 'net'],

  crosshairColor: '#ffffff',
  crosshairSize: 9,
  crosshairGap: 5,
  crosshairThickness: 2,
  crosshairDot: true,
  crosshairDynamic: true,
  crosshairOutline: true,
};

/**
 * Settings whose control lives on a panel of its own rather than in SETTINGS.
 *
 * Everything a player can persist has to be adjustable *somewhere* — an option
 * that is stored and unreachable is a bug that only ever surfaces as "why is
 * this on". SCHEMA below is the usual answer to that, and these two are the
 * exceptions: they belong to the DEVELOPER tab, which is a level-10 unlock most
 * accounts never see, and putting a panel picker for overlays nobody can open
 * into the audio-and-video panel would be the wrong shape of honesty.
 *
 * The list is named rather than inferred so the invariant survives: a key can
 * only escape the settings panel by being written down here, and the test suite
 * checks both that nothing else escapes *and* that everything named here really
 * is somewhere else. Adding a key to this list to silence a failure is
 * therefore a thing somebody has to do on purpose.
 */
export const PANEL_OWNED_KEYS = ['devMode', 'devPanels'];

/** Live settings object — mutate through `set()` so listeners fire. */
export const settings = { ...DEFAULTS, ...load() };

const listeners = new Set();

/**
 * Settings whose stored *shape* has changed since a build that wrote them.
 *
 * Unknown keys are dropped and mistyped ones are ignored, which is the right
 * default and the wrong answer for a setting that has been rethought: somebody
 * who turned post-processing off two versions ago would silently have it turned
 * back on. So a value written by an older build is translated rather than
 * discarded, and the translation lives here rather than at the twenty places
 * that read it.
 */
function migrate(raw) {
  // Post-processing was a switch and is an amount. Off is one end of the range
  // rather than a different kind of answer, so the two map cleanly.
  if (typeof raw.postProcessing === 'boolean') raw.postProcessing = raw.postProcessing ? 1 : 0;
  return raw;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return {};
    const parsed = migrate(JSON.parse(raw));
    // Drop unknown keys so an old build can't inject junk.
    return Object.fromEntries(Object.entries(parsed).filter(([k]) => k in DEFAULTS));
  } catch {
    return {};
  }
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

export function set(key, value) {
  if (!(key in DEFAULTS)) return;
  settings[key] = value;
  save();
  for (const fn of listeners) fn(key, value);
}

export function apply(patch) {
  let changed = false;
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k in DEFAULTS && settings[k] !== v) { settings[k] = v; changed = true; }
  }
  if (changed) { save(); for (const fn of listeners) fn(null, null); }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reset() {
  Object.assign(settings, DEFAULTS);
  save();
  for (const fn of listeners) fn(null, null);
}

/* ── Import / export ─────────────────────────────────────────────────────── */

/**
 * Everything this browser is holding, as a file's worth of text.
 *
 * Key bindings travel with it. They are stored separately and read by a
 * different module, but nobody thinks of "my settings" as excluding which key
 * fires — so the caller passes them in and they come back out of `importText`
 * the same way.
 */
export function exportText(keybinds = null) {
  return `${JSON.stringify({
    app: 'open-grunker',
    kind: 'settings',
    version: 2,
    exported: new Date().toISOString(),
    settings: { ...settings },
    keybinds: keybinds ?? undefined,
  }, null, 2)}
`;
}

/**
 * Reads a file written by `exportText` (or a bare settings object) and applies
 * whatever of it this build still understands.
 *
 * Unknown keys are dropped rather than merged: a file from a later build must
 * not be able to plant a value nothing validates. Nothing here throws — the
 * caller gets a count and a reason, which is what the panel shows.
 *
 * @returns {{ok:boolean, applied:number, keybinds:object|null, error?:string}}
 */
export function importText(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, applied: 0, keybinds: null, error: 'that is not a settings file' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, applied: 0, keybinds: null, error: 'that is not a settings file' };
  }
  // A bare settings object is accepted too: somebody who copied the inner half
  // out of a file should not be told their own settings are the wrong shape.
  const incoming = migrate(parsed.settings && typeof parsed.settings === 'object'
    ? parsed.settings : parsed);
  const patch = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in DEFAULTS)) continue;
    if (typeof v !== typeof DEFAULTS[k]) continue;
    // `typeof` alone is not enough for anything whose default is an object:
    // `typeof null` and `typeof []` are both 'object', so a file could plant a
    // null — or a plain object — where the code expects a list and reads
    // `.includes` off it. One array-valued setting exists (`devPanels`) and
    // that is one more than this check used to allow for.
    if (Array.isArray(DEFAULTS[k]) !== Array.isArray(v)) continue;
    if (v === null) continue;
    patch[k] = v;
  }
  const applied = Object.keys(patch).length;
  if (!applied) {
    return { ok: false, applied: 0, keybinds: null, error: 'no settings this build understands' };
  }
  Object.assign(settings, patch);
  save();
  for (const fn of listeners) fn(null, null);
  const keybinds = parsed.keybinds && typeof parsed.keybinds === 'object' ? parsed.keybinds : null;
  return { ok: true, applied, keybinds };
}

/** Keys that need the map rebuilt (textures, batching) rather than a re-render. */
export const HEAVY_KEYS = new Set(['quality']);

const pct = (v) => `${Math.round(v * 100)}%`;

/** Schema that drives the settings UI. */
export const SCHEMA = [
  {
    group: 'Language', icon: '\u{1F310}', items: [
      {
        key: 'language', label: 'Language', type: 'select',
        options: ['auto', ...LANGUAGE_IDS],
        fmt: (v) => (v === 'auto'
          ? `Automatic (${languageName(detectLanguage())})`
          : languageName(v)),
        hint: 'Automatic follows your browser. Everything a player wrote — names, '
          + 'clan tags, chat — is always left exactly as they wrote it.',
      },
    ],
  },
  {
    group: 'Aim', icon: '🎯', items: [
      { key: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.05, max: 4, step: 0.01, fmt: (v) => v.toFixed(2) },
      {
        key: 'adsSensitivity', label: 'Sensitivity while aiming', type: 'range',
        min: 0.1, max: 2, step: 0.02, fmt: (v) => `${v.toFixed(2)}\u00d7`,
        hint: 'A multiplier on the sensitivity above, applied only while the sights '
          + 'are up. Below 1 the view slows down when you aim, which is what a scope '
          + 'wants; 1.00 keeps the same speed everywhere. It steers a controller '
          + 'stick as well as a mouse.',
      },
      { key: 'fov', label: 'Field of view', type: 'range', min: 70, max: 130, step: 1, fmt: (v) => `${v}°` },
      { key: 'invertY', label: 'Invert vertical look', type: 'bool' },
      { key: 'toggleAds', label: 'Toggle aim (instead of hold)', type: 'bool' },
      { key: 'toggleCrouch', label: 'Toggle crouch/slide', type: 'bool' },
      { key: 'autoReload', label: 'Reload automatically when empty', type: 'bool' },
      {
        key: 'recoilRecovery', label: 'Recoil recovery', type: 'bool',
        hint: 'The view walks back down to where you were aiming after a burst.',
      },
      {
        key: 'mouseAcceleration', label: 'Mouse acceleration', type: 'bool',
        hint: 'Off asks the browser for raw mouse input, so the same physical '
          + 'movement is always the same number of degrees. On lets the pointer '
          + "acceleration from your operating system's mouse settings through.",
      },
    ],
  },
  {
    group: 'Controller', icon: '🎮', items: [
      {
        key: 'gamepad', label: 'Enable controller', type: 'bool',
        hint: 'A pad is picked up the moment it is plugged in. Buttons are rebindable '
          + 'under CONTROLS, in the third column.',
      },
      { key: 'gamepadLookX', label: 'Look speed — horizontal', type: 'range', min: 0.2, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
      { key: 'gamepadLookY', label: 'Look speed — vertical', type: 'range', min: 0.2, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
      {
        key: 'gamepadResponse', label: 'Stick response curve', type: 'range', min: 1, max: 3.5, step: 0.1,
        fmt: (v) => v.toFixed(1),
        hint: 'Higher means the first half of the stick turns you more slowly, so small '
          + 'corrections are possible without the far edge becoming unusable.',
      },
      {
        key: 'gamepadDeadzone', label: 'Stick deadzone', type: 'range', min: 0.02, max: 0.5, step: 0.01,
        fmt: pct, hint: 'How far a worn stick has to move before the game believes it.',
      },
      {
        key: 'gamepadAimAssist', label: 'Aim assist', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct,
        hint: 'Slows the look stick while the crosshair is already on an enemy. Nothing '
          + 'is ever pulled toward a target — this buys the time a thumb needs, it does not aim for you.',
      },
      { key: 'gamepadInvertY', label: 'Invert vertical look (controller)', type: 'bool' },
      { key: 'gamepadVibration', label: 'Vibration', type: 'bool' },
    ],
  },
  {
    group: 'Video', icon: '🖥', items: [
      { key: 'quality', label: 'Quality preset', type: 'select', options: ['low', 'medium', 'high', 'ultra'] },
      { key: 'shadows', label: 'Shadows', type: 'bool' },
      {
        key: 'postProcessing', label: 'Post-processing', type: 'range', min: 0, max: 1, step: 0.05,
        fmt: (v) => (v <= 0 ? 'Off' : pct(v)),
        hint: 'Bloom, tone mapping, grade, vignette and grain — and how much of them. '
          + '100% is what the maps were painted against. Off skips the whole chain, '
          + 'which is the fastest the game gets and the flattest it looks.',
      },
      { key: 'bloom', label: 'Bloom strength', type: 'range', min: 0, max: 1.4, step: 0.05, fmt: (v) => v.toFixed(2) },
      {
        key: 'saturation', label: 'Saturation', type: 'range', min: 0, max: 2, step: 0.02,
        fmt: pct, hint: '100% is the colour the maps were painted at. Zero is greyscale.',
      },
      {
        key: 'contrast', label: 'Contrast', type: 'range', min: 0.6, max: 1.6, step: 0.01,
        fmt: pct, hint: 'Pushes the darks down and the lights up around mid-grey. '
          + 'Works with post-processing on or off.',
      },
      { key: 'brightness', label: 'Brightness', type: 'range', min: -0.35, max: 0.6, step: 0.01,
        hint: 'Raises exposure and opens the shadows. Positive values lift dark corners first.',
        fmt: (v) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2)) },
      { key: 'vignette', label: 'Vignette', type: 'bool' },
      { key: 'filmGrain', label: 'Film grain', type: 'bool' },
      { key: 'chromatic', label: 'Lens fringing', type: 'bool' },
      { key: 'dynamicLights', label: 'Muzzle flash & explosion lights', type: 'bool' },
      { key: 'particles', label: 'Particle effects', type: 'bool' },
      { key: 'particleAmount', label: 'Particle amount', type: 'range', min: 0.2, max: 1.5, step: 0.1, fmt: pct },
      { key: 'decals', label: 'Bullet holes & blood', type: 'bool' },
      { key: 'tracers', label: 'Tracers', type: 'bool' },
      { key: 'shells', label: 'Shell casings', type: 'bool' },
      { key: 'viewBob', label: 'View bob', type: 'bool' },
      { key: 'screenShake', label: 'Screen shake', type: 'bool' },
      { key: 'fpsLimit', label: 'FPS limit', type: 'select', options: [0, 60, 75, 120, 144, 240], fmt: (v) => (v ? `${v}` : 'Unlimited') },
    ],
  },
  {
    group: 'Weapon', icon: '🔫', items: [
      { key: 'viewmodelFov', label: 'Viewmodel FOV', type: 'range', min: 50, max: 80, step: 1, fmt: (v) => `${v}°` },
      { key: 'viewmodelX', label: 'Viewmodel offset X', type: 'range', min: -0.12, max: 0.12, step: 0.005, fmt: (v) => v.toFixed(3) },
      { key: 'viewmodelY', label: 'Viewmodel offset Y', type: 'range', min: -0.12, max: 0.12, step: 0.005, fmt: (v) => v.toFixed(3) },
      { key: 'viewmodelZ', label: 'Viewmodel offset Z', type: 'range', min: -0.15, max: 0.15, step: 0.005, fmt: (v) => v.toFixed(3) },
      { key: 'leftHanded', label: 'Left-handed', type: 'bool' },
      {
        key: 'hideWeaponAds', label: 'Hide the weapon while aiming', type: 'bool',
        hint: 'Clears the gun out of the bottom of the screen the moment you aim. '
          + 'Yours only — everyone else still sees you holding it.',
      },
    ],
  },
  {
    group: 'Audio', icon: '🔊', items: [
      { key: 'masterVolume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { key: 'sfxVolume', label: 'Effects volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      {
        key: 'anthemVolume', label: 'Player anthems', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct,
        hint: 'Music creators\u2019 tracks, played over the kill cam of whoever they kill. '
          + 'Every one is levelled by the server, so none can be louder than another.',
      },
      { key: 'hitSound', label: 'Hitmarker sound', type: 'bool' },
      { key: 'announcer', label: 'Killstreak & objective stings', type: 'bool' },
    ],
  },
  {
    group: 'Kill cam', icon: '\ud83c\udfa5', items: [
      {
        key: 'killCam', label: 'Show the kill cam', type: 'bool',
        hint: 'Ten seconds looking at whoever killed you, skippable after three. '
          + 'Off goes straight back to the plain death screen.',
      },
      {
        key: 'killCamReplay', label: 'Replay the fight from their eyes', type: 'bool',
        hint: 'The last ten seconds before you died, played back through the killer\u2019s '
          + 'own view. Off circles their body instead \u2014 which is also what happens '
          + 'when there is no history to replay, such as dying moments after spawning.',
      },
      {
        key: 'killCamHold', label: 'Hold it for the full ten seconds', type: 'bool',
        hint: 'Off ends the cam the moment the skip lights up, without you pressing anything.',
      },
    ],
  },
  {
    group: 'HUD', icon: '📊', items: [
      {
        key: 'nametagScale', label: 'Nametag size', type: 'range', min: 0.5, max: 3, step: 0.1,
        fmt: (v) => `${v.toFixed(1)}×`, hint: 'How large enemy name plates are drawn in the world.',
      },
      { key: 'nametags', label: 'Nametags (only for enemies in sight)', type: 'bool' },
      { key: 'hudScale', label: 'HUD scale', type: 'range', min: 0.75, max: 1.5, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
      { key: 'showDamageNumbers', label: 'Damage numbers', type: 'bool' },
      { key: 'showPointsFeed', label: 'Score popups (+50 HEADSHOT…)', type: 'bool' },
      { key: 'showLiveScore', label: 'Live scoreboard (top right)', type: 'bool' },
      { key: 'showKillfeed', label: 'Killfeed', type: 'bool' },
      { key: 'showMinimap', label: 'Minimap', type: 'bool' },
      { key: 'minimapZoom', label: 'Minimap zoom', type: 'range', min: 0.5, max: 2, step: 0.1, fmt: (v) => `${v.toFixed(1)}×` },
      { key: 'showSpeed', label: 'Speedometer', type: 'bool', hint: 'For anyone learning to bunny-hop.' },
      { key: 'showFps', label: 'FPS / ping counter', type: 'bool' },
    ],
  },
  {
    group: 'Spectator', icon: '◉', items: [
      {
        key: 'specThirdPerson', label: 'Watch from behind the player', type: 'bool',
        hint: 'Off puts the camera behind their eyes. The same switch is on the '
          + 'spectator bar under V, so it can be changed mid-match.',
      },
      {
        key: 'specXray', label: 'See players through walls while watching', type: 'bool',
        hint: 'Spectator only — you have no body in the match, so there is nothing '
          + 'to gain from it but a view of the fight. On the bar under X.',
      },
    ],
  },
  {
    group: 'Crosshair', icon: '✛', items: [
      { key: 'crosshairColor', label: 'Colour', type: 'color' },
      { key: 'crosshairSize', label: 'Length', type: 'range', min: 0, max: 24, step: 1, fmt: (v) => `${v}px` },
      { key: 'crosshairGap', label: 'Gap', type: 'range', min: 0, max: 20, step: 1, fmt: (v) => `${v}px` },
      { key: 'crosshairThickness', label: 'Thickness', type: 'range', min: 1, max: 6, step: 1, fmt: (v) => `${v}px` },
      { key: 'crosshairDot', label: 'Centre dot', type: 'bool' },
      { key: 'crosshairOutline', label: 'Outline', type: 'bool' },
      { key: 'crosshairDynamic', label: 'Follows spread', type: 'bool' },
    ],
  },
];

export default settings;
