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

const KEY = 'og.settings.v2';
const LEGACY_KEY = 'og.settings.v1';

export const DEFAULTS = {
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
  hitSound: true,
  announcer: true,

  /* Video */
  quality: 'high',          // low | medium | high | ultra
  shadows: true,
  particles: true,
  particleAmount: 1.0,
  dynamicLights: true,
  postProcessing: true,
  bloom: 0.6,
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

  crosshairColor: '#ffffff',
  crosshairSize: 9,
  crosshairGap: 5,
  crosshairThickness: 2,
  crosshairDot: true,
  crosshairDynamic: true,
  crosshairOutline: true,
};

/** Live settings object — mutate through `set()` so listeners fire. */
export const settings = { ...DEFAULTS, ...load() };

const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
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
  const incoming = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
  const patch = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in DEFAULTS)) continue;
    if (typeof v !== typeof DEFAULTS[k]) continue;
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
    group: 'Aim', icon: '🎯', items: [
      { key: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.05, max: 4, step: 0.01, fmt: (v) => v.toFixed(2) },
      { key: 'adsSensitivity', label: 'Aim sensitivity multiplier', type: 'range', min: 0.1, max: 2, step: 0.02, fmt: (v) => v.toFixed(2) },
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
      { key: 'postProcessing', label: 'Post-processing', type: 'bool', hint: 'Bloom, tone mapping, grade and vignette.' },
      { key: 'bloom', label: 'Bloom strength', type: 'range', min: 0, max: 1.4, step: 0.05, fmt: (v) => v.toFixed(2) },
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
      { key: 'hitSound', label: 'Hitmarker sound', type: 'bool' },
      { key: 'announcer', label: 'Killstreak & objective stings', type: 'bool' },
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
