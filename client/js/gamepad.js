/**
 * Open Grunker — controller support.
 *
 * A gamepad is polled, not evented: the browser hands out a snapshot of every
 * axis and button and nothing tells you when one changed. So this class is
 * driven once per frame from the input layer, diffs the buttons against the
 * previous frame, and turns the differences into exactly the same
 * press/release calls a key produces. Everything downstream — the action table,
 * the rebinding panel, the HUD hints — therefore works on a pad without
 * knowing one exists.
 *
 * Two things a keyboard does not need:
 *
 *   • **The look stick is a rate, not a delta.** A mouse reports how far it
 *     moved; a stick reports how far it is pushed. Holding it at 60 % has to
 *     turn the view at a constant speed, which means the deflection is scaled
 *     by the frame time and shaped by a response curve, or the first 20 % of
 *     travel is unusable and the last 20 % is uncontrollable.
 *
 *   • **Aim assist, and only the honest kind.** The stick slows down while the
 *     crosshair is over an enemy — nothing is pulled anywhere, nothing snaps.
 *     A pad cannot make the micro-corrections a wrist makes, and slowing the
 *     turn is what gives it the time to; magnetism would be aiming *for* the
 *     player, which is a different thing wearing the same name.
 */
import {
  binds, PAD_SLOT, PAD_MENU, PAD_LABELS, isPadCode, actionsFor,
} from './keybinds.js';
import { settings } from './settings.js';

/** W3C standard-mapping axes. */
const AX_MOVE_X = 0, AX_MOVE_Y = 1, AX_LOOK_X = 2, AX_LOOK_Y = 3;
/** Analogue triggers report as buttons 6 and 7; this is where they count as held. */
const TRIGGER_POINT = 0.42;
/** How far a stick has to be pushed before it counts as a direction held. */
const MOVE_GATE = 0.45;
/** Menu navigation repeats at this rate while a stick or the d-pad is held. */
const NAV_FIRST_MS = 380;
const NAV_REPEAT_MS = 130;
/** …and the triggers, which scroll a page at a time, repeat more slowly. */
const PAGE_FIRST_MS = 420;
const PAGE_REPEAT_MS = 260;

/**
 * What each button means with the interface up rather than a match.
 *
 * The same buttons the game uses, pointed at the other thing on screen. It is
 * a table rather than a chain of `else if` because it is a *layout*: it wants
 * to be read in one place, next to the labels the hint bar draws from it, and
 * anything that is not in it is deliberately dead in the menu.
 *
 *   A / B      the two every interface has: press this, go back
 *   Y          the filter box over the tab rail, which is the fastest way
 *              across twenty tabs and is otherwise unreachable without typing
 *   LB / RB    the tab either side of this one
 *   LT / RT    a page of whatever is scrolling
 */
export const PAD_MENU_ACTIONS = {
  Pad0: 'accept',
  Pad1: 'back',
  Pad3: 'search',
  Pad4: 'tab-prev',
  Pad5: 'tab-next',
};
/** Held rather than tapped, so these repeat on their own clock. */
const PAD_MENU_HELD = { Pad6: 'page-up', Pad7: 'page-down' };

/** Deadzone, then a curve that keeps small movements small. */
function shape(v, deadzone, exponent) {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const t = (a - deadzone) / (1 - deadzone);
  return Math.sign(v) * t ** exponent;
}

export class GamepadInput {
  /**
   * @param {object} o
   * @param {function(string):void} o.onPress    a button went down
   * @param {function(string):void} o.onRelease  …and back up
   * @param {function():void}       o.onMenu     START, i.e. Escape
   * @param {function(string):void} [o.onNav]    menu navigation: up|down|left|right|accept|back
   * @param {function(boolean, object):void} [o.onConnect] pad appeared or vanished
   */
  constructor({ onPress, onRelease, onMenu, onNav = null, onConnect = null } = {}) {
    this.onPress = onPress;
    this.onRelease = onRelease;
    this.onMenu = onMenu;
    this.onNav = onNav;
    this.onConnect = onConnect;

    /** Codes held on the previous poll, so a poll can diff against it. */
    this.held = new Set();
    /** Left stick, shaped. Read by the movement sample. */
    this.move = { x: 0, y: 0 };
    /** Right stick, shaped. Read by the look pass. */
    this.look = { x: 0, y: 0 };
    /** The pad the game is listening to, or null. */
    this.pad = null;
    this.name = '';
    /** True once a real input has arrived from a pad — what turns hints on. */
    this.active = false;
    this.lastInputAt = 0;
    /** While set, the next button press is captured for rebinding, not played. */
    this.captureFor = null;
    /** Milliseconds left before a held direction repeats. See `_repeat`. */
    this._navAt = 0;
    this._navCode = '';
    this._pageAt = 0;
    this._pageCode = '';
    this._rumbleUntil = 0;

    // The connect events are only used for the toast: a pad that was already
    // plugged in when the page loaded fires nothing, so `poll` finds it anyway.
    window.addEventListener('gamepadconnected', (e) => this._announce(true, e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => this._announce(false, e.gamepad));
  }

  _announce(on, pad) {
    if (!on) {
      this.held.clear();
      this.move.x = this.move.y = this.look.x = this.look.y = 0;
      this.active = false;
      this.pad = null;
    }
    this.name = pad?.id ? String(pad.id).slice(0, 60) : '';
    this.onConnect?.(on, pad ?? null);
  }

  get enabled() { return settings.gamepad !== false; }
  get connected() { return !!this.pad; }

  /** Starts capturing the next controller button for a rebind. */
  captureBinding(onCapture) { this.captureFor = onCapture; }
  cancelCapture() { this.captureFor = null; }

  /**
   * The first pad the browser will admit to.
   *
   * `getGamepads()` returns a sparse array with holes where a pad has been
   * unplugged, and Firefox has been known to report a phantom entry with no
   * axes at all — hence both guards.
   */
  _find() {
    if (!this.enabled || typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected && p.axes?.length >= 2) return p;
    }
    return null;
  }

  /**
   * One poll. Call once per frame, before the look and the movement sample.
   * @param {number} dt seconds since the previous frame
   * @param {boolean} inGame true while the match owns the input
   */
  poll(dt, inGame) {
    const pad = this._find();
    const had = !!this.pad;
    this.pad = pad;
    if (!pad) {
      if (had) this._releaseAll();
      return;
    }

    const dead = Math.min(0.6, Math.max(0.02, settings.gamepadDeadzone ?? 0.18));
    const curve = Math.min(4, Math.max(1, settings.gamepadResponse ?? 2));

    /* ── Sticks ─────────────────────────────────────────────────────────── */

    const ax = pad.axes;
    this.move.x = shape(ax[AX_MOVE_X] ?? 0, dead, curve);
    this.move.y = shape(ax[AX_MOVE_Y] ?? 0, dead, curve);
    this.look.x = shape(ax[AX_LOOK_X] ?? 0, dead, curve);
    this.look.y = shape(ax[AX_LOOK_Y] ?? 0, dead, curve);

    if (this.move.x || this.move.y || this.look.x || this.look.y) this._touch();

    /* ── Buttons ────────────────────────────────────────────────────────── */

    const now = this.held;
    const next = this._next ?? (this._next = new Set());
    next.clear();
    for (let i = 0; i < pad.buttons.length; i++) {
      const b = pad.buttons[i];
      const down = typeof b === 'object' ? (b.pressed || (b.value ?? 0) > TRIGGER_POINT) : b > TRIGGER_POINT;
      if (down) next.add(`Pad${i}`);
    }

    // A rebind swallows the whole press: it is being recorded, not played.
    if (this.captureFor) {
      for (const code of next) {
        if (now.has(code)) continue;
        const fn = this.captureFor;
        this.captureFor = null;
        this._swap(next);
        this._touch();
        fn(code);
        return;
      }
      this._swap(next);
      return;
    }

    for (const code of next) {
      if (now.has(code)) continue;
      this._touch();
      if (code === PAD_MENU) this.onMenu?.();
      else if (inGame) this.onPress?.(code);
      // Out of the match the same buttons are the interface's, not the game's.
      // Nothing is bound twice — `inGame` is what decides which of the two a
      // press means — and the layout is PAD_MENU_ACTIONS above.
      else if (PAD_MENU_ACTIONS[code]) this.onNav?.(PAD_MENU_ACTIONS[code]);
    }
    for (const code of now) {
      if (next.has(code)) continue;
      if (code !== PAD_MENU) this.onRelease?.(code);
    }
    this._swap(next);

    if (!inGame) this._navigate(dt);
  }

  /** Swaps the held set for the freshly built one without allocating. */
  _swap(next) {
    const old = this.held;
    this.held = next;
    old.clear();
    this._next = old;
  }

  _releaseAll() {
    for (const code of this.held) this.onRelease?.(code);
    this.held.clear();
    this.move.x = this.move.y = this.look.x = this.look.y = 0;
    this.active = false;
  }

  _touch() {
    this.active = true;
    this.lastInputAt = performance.now();
  }

  /**
   * Menu steering: the d-pad and the left stick move focus, A clicks, B backs
   * out, the bumpers change tab and the triggers scroll. Everything that can be
   * held repeats, with a first-press delay so a tap moves exactly one row.
   *
   * The right stick steers too, one row at a time — a thumb that has spent the
   * last ten minutes aiming with it reaches for it in a menu, and finding
   * nothing there reads as the pad having stopped working.
   */
  _navigate(dt) {
    if (!this.onNav) return;
    const y = this.move.y || this.look.y;
    const x = this.move.x || this.look.x;
    const dir = this.held.has('Pad12') || y < -0.5 ? 'up'
      : this.held.has('Pad13') || y > 0.5 ? 'down'
        : this.held.has('Pad14') || x < -0.5 ? 'left'
          : this.held.has('Pad15') || x > 0.5 ? 'right'
            : '';
    this._repeat(dt, 'nav', dir, NAV_FIRST_MS, NAV_REPEAT_MS);

    let page = '';
    for (const [code, action] of Object.entries(PAD_MENU_HELD)) {
      if (this.held.has(code)) { page = action; break; }
    }
    this._repeat(dt, 'page', page, PAGE_FIRST_MS, PAGE_REPEAT_MS);
  }

  /**
   * One auto-repeating control: fires on the change, then on a clock.
   *
   * The clock is the frame time this poll was handed, not `performance.now()`.
   * The two agree in a browser, and the frame time is the one that is also true
   * on a frame the tab spent in the background, in a test with no wall clock to
   * wait on, and under a frame cap — a repeat measured against the wall while
   * the poll runs on frames is a repeat that fires a different number of times
   * on a 60 Hz screen than on a 144 Hz one.
   *
   * `which` names the clock rather than sharing one, so holding a trigger to
   * scroll does not swallow the d-pad press that moves focus inside what has
   * just scrolled into view.
   */
  _repeat(dt, which, code, first, rate) {
    const leftKey = which === 'nav' ? '_navAt' : '_pageAt';
    const codeKey = which === 'nav' ? '_navCode' : '_pageCode';
    if (!code) { this[codeKey] = ''; this[leftKey] = 0; return; }
    if (code !== this[codeKey]) {
      this[codeKey] = code;
      this[leftKey] = first;
      this.onNav(code);
      return;
    }
    this[leftKey] -= dt * 1000;
    if (this[leftKey] > 0) return;
    this[leftKey] = rate;
    this.onNav(code);
  }

  /**
   * Movement, as the eight-way the simulation actually takes.
   *
   * The shared movement step reads a bitmask, and that mask is what the server
   * replays — so the stick is thresholded here rather than smuggled in as an
   * analogue magnitude the authority would not agree with. Nothing is lost that
   * the game uses: air-strafe acceleration comes from the *angle* between where
   * you are going and where you are pushing, never from how hard.
   */
  moveMask(KEY) {
    let keys = 0;
    if (!this.pad) return keys;
    if (this.move.y < -MOVE_GATE) keys |= KEY.FWD;
    if (this.move.y > MOVE_GATE) keys |= KEY.BACK;
    if (this.move.x < -MOVE_GATE) keys |= KEY.LEFT;
    if (this.move.x > MOVE_GATE) keys |= KEY.RIGHT;
    return keys;
  }

  /**
   * Yaw and pitch to add this frame, in radians.
   * @param {number} dt seconds
   * @param {number} assist 0-1: how much the stick is slowed by aim assist
   */
  lookDelta(dt, assist = 0) {
    if (!this.pad || (!this.look.x && !this.look.y)) return null;
    const slow = 1 - Math.min(0.85, assist);
    const base = 2.6 * dt * slow;
    const sx = (settings.gamepadLookX ?? 1) * base;
    const sy = (settings.gamepadLookY ?? 1) * base;
    const invert = settings.gamepadInvertY ?? settings.invertY;
    return {
      yaw: -this.look.x * sx,
      pitch: (invert ? this.look.y : -this.look.y) * sy,
    };
  }

  /** A short buzz, when the browser and the pad both support one. */
  rumble(strength = 0.4, ms = 90) {
    if (!this.pad || settings.gamepadVibration === false) return;
    const now = performance.now();
    if (now < this._rumbleUntil) return;
    this._rumbleUntil = now + ms;
    const fx = this.pad.vibrationActuator;
    if (!fx?.playEffect) return;
    try {
      fx.playEffect('dual-rumble', {
        duration: ms, startDelay: 0,
        weakMagnitude: Math.min(1, strength), strongMagnitude: Math.min(1, strength * 0.8),
      }).catch(() => {});
    } catch { /* not every pad has an actuator */ }
  }

  /** Every action this pad's layout can reach — for the help screen. */
  static layout() {
    const out = [];
    for (const [action, slots] of Object.entries(binds)) {
      const code = slots[PAD_SLOT];
      if (code && isPadCode(code)) out.push({ action, code, label: PAD_LABELS[code] ?? code });
    }
    return out;
  }

  /** True when `code` currently drives at least one action. */
  static bound(code) { return actionsFor(code).length > 0; }
}

export default GamepadInput;
