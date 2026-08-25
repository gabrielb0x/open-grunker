/**
 * Open Grunker — keyboard, mouse, pointer lock and gamepad.
 *
 * Continuous state (movement keys, fire, aim) is polled by the fixed-step
 * prediction loop; discrete actions (reload, weapon switch, chat) are emitted
 * as events so the game layer stays free of DOM handling.
 *
 * Nothing here names a physical key: every lookup goes through keybinds.js,
 * so the whole scheme is rebindable from the settings panel.
 *
 * A controller is folded into exactly the same two places a key is — the `down`
 * set and the press/release dispatch — so every action, every rebinding and
 * every HUD hint works on a pad without a second code path. Only the two
 * things a stick genuinely is not a key survive separately: the left stick
 * contributes to the movement mask, and the right stick adds to the look delta
 * as a *rate* rather than a movement.
 */
import { KEY } from '/shared/movement.js';
import { settings } from './settings.js';
import { binds, actionsFor, MOUSE, WHEEL_UP, WHEEL_DOWN } from './keybinds.js';
import { GamepadInput } from './gamepad.js';

const HALF_PI = Math.PI / 2 - 0.001;

/** Keys the browser would otherwise act on while we hold pointer lock. */
const SWALLOW = new Set(['Tab', 'Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Backspace', 'Quote', 'Slash']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();               // raw codes currently held (keys + mouse)
    this.mouse = { left: false, right: false };
    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.enabled = false;
    this.adsToggled = false;
    this.crouchToggled = false;
    this.listeners = new Map();
    this.pendingYaw = 0;
    this.pendingPitch = 0;
    this.sensScale = 1;                  // ADS multiplier, set by the game layer
    /**
     * Accumulated recoil the view still owes back. Firing adds to it; the
     * recovery pass walks it off; pulling down against it cancels it, so the
     * game never fights a player who is compensating manually.
     */
    this.recoilDebt = { pitch: 0, yaw: 0 };
    /** Look delta applied on the last frame — the viewmodel lags behind it. */
    this.lookDelta = { yaw: 0, pitch: 0 };
    /** While set, the next input is captured for rebinding instead of played. */
    this.captureFor = null;
    /**
     * How much the look stick is slowed this frame, 0-1.
     *
     * Written by the game layer, which is the only thing that knows whether the
     * crosshair is over an enemy. Kept here rather than queried from here so
     * the input module never needs to know what an entity is.
     */
    this.aimAssist = 0;

    this.gamepad = new GamepadInput({
      onPress: (code) => this._padDown(code),
      onRelease: (code) => this._padUp(code),
      onMenu: () => this.emit('escape'),
      onNav: (dir) => this.emit('padnav', dir),
      onConnect: (on, pad) => this.emit('padconnect', on, pad),
    });

    this._bind();
  }

  /* ── Gamepad ───────────────────────────────────────────────────────────── */

  /** True once a controller has actually been used — what turns pad hints on. */
  get padActive() { return this.gamepad.connected && this.gamepad.active; }

  /**
   * One controller poll, plus its share of the look.
   *
   * Called once per frame from the game loop, before `applyLook`, so the stick
   * lands in the same pending delta the mouse writes into — which is what makes
   * recoil compensation work identically on both.
   */
  pollPad(dt, inGame) {
    const pad = this.gamepad;
    pad.poll(dt, inGame && this.enabled);
    if (!inGame || !this.enabled) return;
    const d = pad.lookDelta(dt * (this.sensScale || 1), this.aimAssist);
    if (!d) return;
    this.pendingYaw += d.yaw;
    this.pendingPitch += d.pitch;
  }

  _padDown(code) {
    if (this.down.has(code)) return;
    this.down.add(code);
    this._press(code, null);
  }

  _padUp(code) {
    if (!this.down.delete(code)) return;
    this._release(code);
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (set) for (const fn of set) fn(...args);
  }

  /* ── Binding lookups ───────────────────────────────────────────────────── */

  /** True while any code bound to `action` is held — key, button or pad. */
  held(action) {
    const slots = binds[action];
    if (!slots) return false;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && this.down.has(slots[i])) return true;
    }
    return false;
  }

  /** Starts capturing the next key or button press for a rebind. */
  captureBinding(onCapture) {
    this.captureFor = onCapture;
  }

  /** …and the same for a controller button, which the pad poll delivers. */
  capturePadBinding(onCapture) {
    this.gamepad.captureBinding(onCapture);
  }

  cancelCapture() {
    this.captureFor = null;
    this.gamepad.cancelCapture();
  }

  _capture(code, e) {
    const fn = this.captureFor;
    this.captureFor = null;
    e?.preventDefault?.();
    e?.stopPropagation?.();
    fn?.(code);
    return true;
  }

  /* ── Pointer lock ──────────────────────────────────────────────────────── */

  /**
   * Grabs the mouse.
   *
   * Chrome refuses `requestPointerLock()` for about a second after the user
   * dismissed a lock with Escape, and the rejection is silent — which is what
   * made "press Escape, click to come back" feel broken. Every failure is
   * retried on a short timer until it takes or the caller unlocks again.
   */
  lock() {
    if (this.locked) return;
    clearTimeout(this._lockRetry);
    this._lockWanted = true;
    this._tryLock(0);
  }

  _tryLock(attempt) {
    if (!this._lockWanted || this.locked || !document.contains(this.canvas)) return;
    let p;
    try {
      p = this.canvas.requestPointerLock?.(this._lockOptions());
    } catch {
      p = null;
    }
    const again = () => {
      if (attempt >= 8) return;
      clearTimeout(this._lockRetry);
      this._lockRetry = setTimeout(() => this._tryLock(attempt + 1), 180);
    };
    // Chrome returns a promise when unadjustedMovement is requested; older
    // engines return undefined and just lock. Fall back on rejection.
    if (p?.catch) {
      p.catch(() => {
        try { this.canvas.requestPointerLock(); } catch { /* retried below */ }
        again();
      });
    } else if (!document.pointerLockElement) {
      again();
    }
  }

  unlock() {
    this._lockWanted = false;
    clearTimeout(this._lockRetry);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /**
   * What to ask pointer lock for, given the player's acceleration preference.
   *
   * `unadjustedMovement` is the browser's name for raw input: the deltas arrive
   * exactly as the mouse reported them, with none of the pointer acceleration
   * the operating system applies to a desktop cursor. That is what an aimer
   * wants by default — the same flick is the same number of degrees every time
   * — but it is not what everybody is used to, so it is a switch rather than a
   * decision, and turning it on simply stops asking.
   */
  _lockOptions() {
    return settings.mouseAcceleration ? {} : { unadjustedMovement: true };
  }

  /**
   * Re-asks for the lock we already hold, with the current options.
   *
   * Chrome takes a second `requestPointerLock` on the element that already owns
   * the lock as a request to change its options, so flipping acceleration lands
   * on the very next mouse movement instead of on the next time the player
   * happens to alt-tab. Anywhere it is not supported the promise rejects and
   * the setting takes effect at the next lock, which is the old behaviour.
   */
  refreshLockOptions() {
    if (!this.locked || document.pointerLockElement !== this.canvas) return;
    try {
      this.canvas.requestPointerLock?.(this._lockOptions())?.catch?.(() => {});
    } catch { /* older engine: it lands at the next lock */ }
  }

  _bind() {
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) { this._lockWanted = false; clearTimeout(this._lockRetry); }
      if (was && !this.locked) {
        this.down.clear();
        this.mouse.left = this.mouse.right = false;
        // The pad's own held set has to be dropped with it, or a trigger that
        // was down when the lock broke never fires a press again.
        this.gamepad._releaseAll();
        this.emit('unlock');
      } else if (!was && this.locked) {
        this.emit('lock');
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      const s = settings.sensitivity * this.sensScale * 0.0022;
      this.pendingYaw -= e.movementX * s;
      this.pendingPitch += (settings.invertY ? e.movementY : -e.movementY) * s;
    });

    window.addEventListener('mousedown', (e) => {
      const code = MOUSE[e.button];
      if (this.captureFor) return void this._capture(code ?? `Mouse${e.button}`, e);
      if (!this.enabled || !this.locked) return;
      e.preventDefault();
      if (!code) return;
      this.down.add(code);
      this._press(code, e);
    });

    window.addEventListener('mouseup', (e) => {
      const code = MOUSE[e.button];
      if (!code) return;
      this.down.delete(code);
      this._release(code);
    });

    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); });

    window.addEventListener('wheel', (e) => {
      const code = e.deltaY > 0 ? WHEEL_DOWN : WHEEL_UP;
      if (this.captureFor) return void this._capture(code, e);
      if (!this.locked || !this.enabled) return;
      // The wheel has no "up" event; treat it as a tap.
      this._press(code, e);
    }, { passive: true });

    window.addEventListener('keydown', (e) => {
      if (this.captureFor) {
        // Escape cancels the rebind; the callback gets null and puts the old key back.
        return void this._capture(e.code === 'Escape' ? null : e.code, e);
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.code === 'Escape') e.target.blur();
        return;
      }
      // Never swallow the browser's own shortcuts.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Swallow first, before any early return: a held Tab repeats, and an
      // unprevented repeat is what used to move focus out of the canvas and
      // drop the player out of the game.
      if (this.enabled && (SWALLOW.has(e.code) || actionsFor(e.code).length)) e.preventDefault();

      if (!e.repeat) this.emit('keydown', e.code);
      if (this.down.has(e.code)) return;
      this.down.add(e.code);
      if (!this.enabled) return;
      if (e.code === 'Escape') { this.emit('escape'); return; }
      this._press(e.code, e);
    });

    window.addEventListener('keyup', (e) => {
      if (this.enabled && (SWALLOW.has(e.code) || actionsFor(e.code).length)) e.preventDefault();
      this.down.delete(e.code);
      this._release(e.code);
    });

    window.addEventListener('blur', () => {
      // Releasing everything on blur keeps a held key from sticking on return.
      for (const code of [...this.down]) this._release(code);
      this.down.clear();
      this.mouse.left = this.mouse.right = false;
      // …and the pad has to forget what it was holding too, or the next poll
      // sees no *change* and the button stays silently released for good.
      this.gamepad._releaseAll();
    });
  }

  /* ── Action dispatch ───────────────────────────────────────────────────── */

  _press(code, e) {
    for (const action of actionsFor(code)) {
      switch (action) {
        case 'fire': this.mouse.left = true; this.emit('fire'); break;
        case 'ads':
          if (settings.toggleAds) this.adsToggled = !this.adsToggled;
          else this.mouse.right = true;
          this.emit('ads', this.ads);
          break;
        case 'reload': this.emit('reload'); break;
        case 'melee': this.emit('melee'); break;
        case 'nuke': this.emit('nuke'); break;
        case 'slot1': this.emit('slot', 0); break;
        case 'slot2': this.emit('slot', 1); break;
        case 'slot3': this.emit('slot', 2); break;
        case 'lastWeapon': this.emit('lastWeapon'); break;
        case 'nextWeapon': this.emit('switch', 1); break;
        case 'prevWeapon': this.emit('switch', -1); break;
        case 'scoreboard': this.emit('scoreboard', true); break;
        case 'chat': e?.preventDefault?.(); this.emit('chat'); break;
        case 'classMenu': this.emit('classMenu'); break;
        case 'toggleMinimap': this.emit('toggleMinimap'); break;
        case 'toggleFps': this.emit('toggleFps'); break;
        case 'crouch':
          if (settings.toggleCrouch) this.crouchToggled = !this.crouchToggled;
          break;
        default: break;
      }
    }
  }

  _release(code) {
    for (const action of actionsFor(code)) {
      if (action === 'fire') this.mouse.left = false;
      else if (action === 'ads' && !settings.toggleAds) { this.mouse.right = false; this.emit('ads', this.ads); }
      else if (action === 'scoreboard') this.emit('scoreboard', false);
    }
  }

  /* ── State ─────────────────────────────────────────────────────────────── */

  get ads() { return settings.toggleAds ? this.adsToggled : this.mouse.right; }
  get crouch() { return settings.toggleCrouch ? this.crouchToggled : this.held('crouch'); }
  get strafeAxis() { return (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0); }

  /** Flushes accumulated mouse movement into yaw/pitch. Call once per frame. */
  applyLook() {
    const dy = this.pendingPitch, dx = this.pendingYaw;
    // Compensating by hand pays down the debt instead of stacking with it.
    if (dy < 0 && this.recoilDebt.pitch > 0) {
      this.recoilDebt.pitch = Math.max(0, this.recoilDebt.pitch + dy);
    }
    if (this.recoilDebt.yaw !== 0 && Math.sign(dx) === -Math.sign(this.recoilDebt.yaw)) {
      const paid = Math.min(Math.abs(dx), Math.abs(this.recoilDebt.yaw));
      this.recoilDebt.yaw -= Math.sign(this.recoilDebt.yaw) * paid;
    }

    this.yaw += dx;
    this.pitch += dy;
    this.lookDelta.yaw = dx;
    this.lookDelta.pitch = dy;
    this.pendingYaw = 0;
    this.pendingPitch = 0;
    if (this.pitch > HALF_PI) this.pitch = HALF_PI;
    if (this.pitch < -HALF_PI) this.pitch = -HALF_PI;
  }

  /** Adds recoil to the view — the server reads whatever angle we send. */
  addRecoil(pitchKick, yawKick) {
    this.pitch = Math.min(HALF_PI, this.pitch + pitchKick);
    this.yaw += yawKick;
    this.recoilDebt.pitch += pitchKick;
    this.recoilDebt.yaw += yawKick;
  }

  /**
   * Walks the view back down toward where the player was actually aiming.
   * `rate` is radians per second; call it once the trigger has been released
   * long enough that the recovery cannot fight an ongoing spray.
   */
  recoverRecoil(dt, rate) {
    const d = this.recoilDebt;
    if (d.pitch <= 0 && d.yaw === 0) return;
    const step = rate * dt;
    if (d.pitch > 0) {
      const take = Math.min(d.pitch, step);
      d.pitch -= take;
      this.pitch -= take;
    }
    if (d.yaw !== 0) {
      const take = Math.min(Math.abs(d.yaw), step);
      const dir = Math.sign(d.yaw);
      d.yaw -= dir * take;
      this.yaw -= dir * take;
    }
  }

  clearRecoil() { this.recoilDebt.pitch = 0; this.recoilDebt.yaw = 0; }

  /** Bitmask for one simulation tick. */
  sample() {
    let keys = 0;
    if (this.held('forward')) keys |= KEY.FWD;
    if (this.held('back')) keys |= KEY.BACK;
    if (this.held('left')) keys |= KEY.LEFT;
    if (this.held('right')) keys |= KEY.RIGHT;
    if (this.held('jump')) keys |= KEY.JUMP;
    if (this.crouch) keys |= KEY.CROUCH;
    if (this.ads) keys |= KEY.ADS;
    if (this.mouse.left) keys |= KEY.FIRE;
    // The left stick is the pad's movement control; it has no keys of its own.
    keys |= this.gamepad.moveMask(KEY);
    return keys;
  }

  reset(yaw = 0, pitch = 0) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.pendingYaw = 0;
    this.pendingPitch = 0;
    this.adsToggled = false;
    this.crouchToggled = false;
    this.clearRecoil();
  }
}

export default Input;
