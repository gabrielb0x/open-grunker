/**
 * Open Grunker — rebindable controls.
 *
 * Every in-game action resolves through this table, so nothing in the input
 * layer hard-codes a key. Bindings hold three slots each — primary, alternate
 * and **gamepad** — and accept mouse buttons, the wheel and controller buttons
 * as well as keyboard codes, which is why the codes are strings rather than
 * `KeyboardEvent.code` values only.
 *
 * The pad gets a slot of its own rather than sharing the alternate one because
 * half the alternates are already spoken for (`KeyC` for crouch, `KeyT` for
 * chat) and because a controller layout is a layout: it wants to be rebound,
 * reset and read as a set, not as leftovers between keyboard keys.
 */

const STORE_KEY = 'og.keybinds.v1';

/** How many slots each action holds: primary, alternate, gamepad. */
export const SLOTS = 3;
/** The slot the controller layout lives in. */
export const PAD_SLOT = 2;

/**
 * Pseudo-codes for pointer input, matched by the input layer.
 *
 * The index is `MouseEvent.button` and the code is what the panel draws, so the
 * two have to line up: 0 is the left button, 1 the middle one and 2 the right
 * one — the same order the browser reports and the same order `keyLabel` names
 * (LMB, MMB, RMB). They used to be crossed, which put "aim" on the middle
 * button while the panel insisted it was on RMB.
 */
export const MOUSE = {
  0: 'Mouse0', 1: 'Mouse1', 2: 'Mouse2', 3: 'Mouse3', 4: 'Mouse4',
};
export const WHEEL_UP = 'WheelUp';
export const WHEEL_DOWN = 'WheelDown';

/**
 * Controller buttons, in the W3C "standard gamepad" order every modern pad
 * reports. The code is the index — `Pad7` is the right trigger on an Xbox pad,
 * R2 on a DualSense — and the label below is what the panel draws.
 */
export const PAD = Object.fromEntries(
  Array.from({ length: 17 }, (_, i) => [i, `Pad${i}`]));
export const PAD_LABELS = {
  Pad0: 'A', Pad1: 'B', Pad2: 'X', Pad3: 'Y',
  Pad4: 'LB', Pad5: 'RB', Pad6: 'LT', Pad7: 'RT',
  Pad8: 'BACK', Pad9: 'START', Pad10: 'L3', Pad11: 'R3',
  Pad12: 'D↑', Pad13: 'D↓', Pad14: 'D←', Pad15: 'D→', Pad16: 'GUIDE',
};
/** True for any controller code, whatever the pad reports it as. */
export const isPadCode = (code) => typeof code === 'string' && /^Pad\d+$/.test(code);

/**
 * The full action list, in the order the settings panel shows it.
 * `hold` actions are polled every tick; the rest fire once per press.
 */
export const ACTIONS = [
  // Movement has no pad button: the left stick is the movement control, and
  // binding a face button to "strafe left" would be a worse one.
  { id: 'forward', group: 'Movement', label: 'Move forward', hold: true, keys: ['KeyW', 'ArrowUp', ''] },
  { id: 'back', group: 'Movement', label: 'Move back', hold: true, keys: ['KeyS', 'ArrowDown', ''] },
  { id: 'left', group: 'Movement', label: 'Strafe left', hold: true, keys: ['KeyA', 'ArrowLeft', ''] },
  { id: 'right', group: 'Movement', label: 'Strafe right', hold: true, keys: ['KeyD', 'ArrowRight', ''] },
  { id: 'jump', group: 'Movement', label: 'Jump / bunny hop', hold: true, keys: ['Space', '', 'Pad0'] },
  { id: 'crouch', group: 'Movement', label: 'Crouch / slide', hold: true, keys: ['ShiftLeft', 'KeyC', 'Pad1'] },

  { id: 'fire', group: 'Combat', label: 'Fire', hold: true, keys: ['Mouse0', '', 'Pad7'] },
  { id: 'ads', group: 'Combat', label: 'Aim / scope', hold: true, keys: ['Mouse2', '', 'Pad6'] },
  { id: 'reload', group: 'Combat', label: 'Reload', keys: ['KeyR', '', 'Pad2'] },
  { id: 'melee', group: 'Combat', label: 'Quick melee', keys: ['KeyV', 'Mouse3', 'Pad11'] },
  // Only ever live for the few seconds somebody is twelve kills into a run.
  { id: 'nuke', group: 'Combat', label: 'Launch nuke (killstreak)', keys: ['KeyN', '', 'Pad10'] },

  { id: 'slot1', group: 'Weapons', label: 'Primary', keys: ['Digit1', '', 'Pad12'] },
  { id: 'slot2', group: 'Weapons', label: 'Sidearm', keys: ['Digit2', '', 'Pad13'] },
  { id: 'slot3', group: 'Weapons', label: 'Knife', keys: ['Digit3', '', 'Pad14'] },
  { id: 'lastWeapon', group: 'Weapons', label: 'Last weapon', keys: ['KeyQ', '', 'Pad3'] },
  { id: 'nextWeapon', group: 'Weapons', label: 'Next weapon', keys: ['WheelDown', '', 'Pad5'] },
  { id: 'prevWeapon', group: 'Weapons', label: 'Previous weapon', keys: ['WheelUp', '', 'Pad4'] },

  { id: 'scoreboard', group: 'Interface', label: 'Scoreboard', hold: true, keys: ['Tab', '', 'Pad8'] },
  // No pad default: writing a chat line needs a keyboard anyway, so a button
  // that opened an input nobody could type into would be a dead end.
  { id: 'chat', group: 'Interface', label: 'Chat', keys: ['Enter', 'KeyT', ''] },
  { id: 'classMenu', group: 'Interface', label: 'Change class', keys: ['KeyB', '', 'Pad15'] },
  { id: 'toggleMinimap', group: 'Interface', label: 'Toggle minimap', keys: ['KeyM', '', ''] },
  { id: 'toggleFps', group: 'Interface', label: 'Toggle FPS counter', keys: ['KeyF', '', ''] },
];

export const ACTION_IDS = ACTIONS.map((a) => a.id);
const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

/**
 * Escape always opens the menu and can never be rebound away. START is its
 * controller twin for exactly the same reason: a pad with no way back to the
 * menu is a pad that cannot leave the match.
 */
export const RESERVED = new Set(['Escape', 'F5', 'F11', 'F12', 'Pad9', 'Pad16']);
/** The controller button that stands in for Escape. */
export const PAD_MENU = 'Pad9';

export const defaults = () => Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys]]));

/** Live bindings — `binds[action] = [primary, alternate, pad]`. */
export const binds = load();

const listeners = new Set();
/** action -> Set(code), rebuilt whenever a binding changes. */
let index = new Map();

/**
 * Widens a saved binding to the current slot count.
 *
 * Anything stored before the controller slot existed is two long; a missing
 * third slot takes the default rather than blank, so an existing player picks
 * up the whole pad layout the first time they plug one in instead of finding
 * every button unbound.
 */
function widen(id, v) {
  const base = BY_ID.get(id)?.keys ?? [];
  const out = [];
  for (let i = 0; i < SLOTS; i++) {
    out[i] = i < v.length ? String(v[i] ?? '') : String(base[i] ?? '');
  }
  return out;
}

function load() {
  const base = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    for (const id of ACTION_IDS) {
      const v = saved[id];
      if (Array.isArray(v)) base[id] = widen(id, v);
    }
  } catch { /* corrupt or unavailable storage: defaults are fine */ }
  return base;
}

function reindex() {
  index = new Map();
  for (const id of ACTION_IDS) {
    index.set(id, new Set(binds[id].filter(Boolean)));
  }
}

/** Puts the controller layout back to its defaults, leaving the keyboard alone. */
export function resetPad() {
  for (const a of ACTIONS) binds[a.id][PAD_SLOT] = a.keys[PAD_SLOT] ?? '';
  changed();
}
reindex();

export function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(binds)); } catch { /* private mode */ }
}

function changed() {
  reindex();
  save();
  for (const fn of listeners) fn();
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True when `code` is currently bound to `action`. */
export const isBound = (action, code) => index.get(action)?.has(code) ?? false;

/** Every action a raw code triggers (usually zero or one). */
export function actionsFor(code) {
  const out = [];
  for (const [id, set] of index) if (set.has(code)) out.push(id);
  return out;
}

/**
 * Binds `code` to one slot of an action, clearing it from anywhere else so a
 * key never drives two things at once.
 * @returns {{ok:boolean, reason?:string, stolenFrom?:string}}
 */
export function bind(action, slot, code) {
  if (!BY_ID.has(action) || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS) {
    return { ok: false, reason: 'unknown action' };
  }
  if (code && RESERVED.has(code)) return { ok: false, reason: `${code} is reserved` };
  // A controller button belongs in the controller slot and nowhere else, and a
  // keyboard key does not belong in it — otherwise "reset the pad layout"
  // stops meaning anything.
  if (code && isPadCode(code) !== (slot === PAD_SLOT)) {
    return { ok: false, reason: slot === PAD_SLOT ? 'that slot is for a controller button' : 'that is a controller button' };
  }

  let stolenFrom = null;
  if (code) {
    for (const id of ACTION_IDS) {
      for (let i = 0; i < SLOTS; i++) {
        if ((id !== action || i !== slot) && binds[id][i] === code) {
          binds[id][i] = '';
          stolenFrom = id;
        }
      }
    }
  }
  binds[action][slot] = code ?? '';
  changed();
  return { ok: true, stolenFrom };
}

export function clearBinding(action, slot) {
  return bind(action, slot, '');
}

export function resetAll() {
  Object.assign(binds, defaults());
  changed();
}

/** Replaces every binding at once (used when an account's profile loads). */
export function apply(saved) {
  if (!saved || typeof saved !== 'object') return;
  let touched = false;
  for (const id of ACTION_IDS) {
    const v = saved[id];
    if (!Array.isArray(v)) continue;
    const next = widen(id, v);
    if (next.some((code, i) => code !== binds[id][i])) { binds[id] = next; touched = true; }
  }
  if (touched) changed();
}

/** Human-readable name for a binding code. */
export function keyLabel(code) {
  if (!code) return '—';
  if (PAD_LABELS[code]) return PAD_LABELS[code];
  if (isPadCode(code)) return `PAD ${code.slice(3)}`;
  const named = {
    Space: 'SPACE', Tab: 'TAB', Enter: 'ENTER', Escape: 'ESC', Backspace: '⌫',
    ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
    AltLeft: 'L ALT', AltRight: 'R ALT', CapsLock: 'CAPS', ArrowUp: '↑', ArrowDown: '↓',
    ArrowLeft: '←', ArrowRight: '→', Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB',
    Mouse3: 'MOUSE 4', Mouse4: 'MOUSE 5', WheelUp: 'WHEEL ↑', WheelDown: 'WHEEL ↓',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
    Quote: "'", Backquote: '`', Backslash: '\\', Comma: ',', Period: '.', Slash: '/',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  return code.toUpperCase();
}

/**
 * "W / ↑" for the help screen — keyboard and mouse only.
 *
 * The pad slot is deliberately left out: these strings end up on HUD hints that
 * say "press SPACE to respawn", and a player on a keyboard does not need to be
 * told what the A button does.
 */
export const bindingLabel = (action) =>
  binds[action].slice(0, PAD_SLOT).filter(Boolean).map(keyLabel).join(' / ') || '—';

/** "A" — the controller button for an action, for a HUD with a pad attached. */
export const padLabel = (action) => keyLabel(binds[action]?.[PAD_SLOT] ?? '');

export default binds;
