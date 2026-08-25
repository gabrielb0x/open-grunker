/**
 * Open Grunker — controller support.
 *
 * The pad is polled, so it is testable without a pad: `navigator.getGamepads`
 * is the whole interface, and a plain object with the right shape is a
 * controller as far as every line of this code is concerned.
 */
import { suite, check, info, near } from './harness.mjs';
import { installBrowser } from './browser-shim.mjs';

installBrowser();

/** A W3C standard-mapping pad, with everything at rest. */
function makePad() {
  return {
    id: 'Test Controller (STANDARD GAMEPAD)',
    connected: true,
    index: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    vibrationActuator: null,
  };
}

export default async function run() {
  const pad = makePad();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads: () => [pad] },
  });

  const keys = await import('/js/keybinds.js');
  const { settings } = await import('/js/settings.js');
  const { GamepadInput } = await import('/js/gamepad.js');
  const { Input } = await import('/js/input.js');
  const { KEY } = await import('/shared/movement.js');

  suite('Controller — bindings');

  check('every action has three slots and the pad has its own',
    keys.SLOTS === 3 && keys.PAD_SLOT === 2);

  check('the defaults ship a complete pad layout', (() => {
    const bound = keys.ACTIONS.filter((a) => a.keys[keys.PAD_SLOT]);
    info(bound.map((a) => `${a.id}=${keys.keyLabel(a.keys[keys.PAD_SLOT])}`).join(' '));
    // Everything a thumb needs: fire, aim, jump, crouch, reload, melee, all
    // three slots, both cycles, last weapon, the board and the class menu.
    return bound.length >= 13
      && keys.binds.fire[keys.PAD_SLOT] === 'Pad7'
      && keys.binds.ads[keys.PAD_SLOT] === 'Pad6'
      && keys.binds.jump[keys.PAD_SLOT] === 'Pad0';
  })());

  check('no controller button drives two actions at once', (() => {
    const seen = new Map();
    const clashes = [];
    for (const a of keys.ACTIONS) {
      const code = keys.binds[a.id][keys.PAD_SLOT];
      if (!code) continue;
      if (seen.has(code)) clashes.push(`${code}: ${seen.get(code)} + ${a.id}`);
      seen.set(code, a.id);
    }
    return clashes.length === 0;
  })(), 'checked against the shipped layout');

  check('START can never be rebound away — a pad must be able to reach the menu',
    keys.bind('jump', keys.PAD_SLOT, 'Pad9').ok === false);
  check('a keyboard key is refused by the controller slot',
    keys.bind('jump', keys.PAD_SLOT, 'KeyJ').ok === false);
  check('and a controller button is refused by the keyboard slots',
    keys.bind('jump', 0, 'Pad3').ok === false);

  check('a pad button reads back with its face label',
    keys.keyLabel('Pad0') === 'A' && keys.keyLabel('Pad7') === 'RT' && keys.padLabel('fire') === 'RT');

  check('keyboard hints never quote a controller button',
    !keys.bindingLabel('fire').includes('RT'), keys.bindingLabel('fire'));

  suite('Controller — the stick and the buttons');

  const canvas = document.getElementById('view');
  const input = new Input(canvas);
  input.enabled = true;

  const fired = [];
  input.on('reload', () => fired.push('reload'));
  input.on('melee', () => fired.push('melee'));

  // A pad at rest does nothing at all.
  input.pollPad(0.016, true);
  check('an untouched pad presses nothing', input.down.size === 0 && input.sample() === 0);

  // X is reload by default.
  pad.buttons[2] = { pressed: true, value: 1 };
  input.pollPad(0.016, true);
  check('a button press fires its bound action', fired.includes('reload'), fired.join(', '));
  input.pollPad(0.016, true);
  check('and holding it does not fire it again',
    fired.filter((f) => f === 'reload').length === 1);
  pad.buttons[2] = { pressed: false, value: 0 };
  input.pollPad(0.016, true);
  check('releasing it clears the held set', !input.down.has('Pad2'));

  // The triggers are analogue: half-pressed is not pressed.
  pad.buttons[7] = { pressed: false, value: 0.2 };
  input.pollPad(0.016, true);
  check('a feathered trigger is not a trigger pull', !(input.sample() & KEY.FIRE), 'value 0.2');
  pad.buttons[7] = { pressed: false, value: 0.9 };
  input.pollPad(0.016, true);
  check('and a squeezed one is', !!(input.sample() & KEY.FIRE), 'value 0.9');
  pad.buttons[7] = { pressed: false, value: 0 };
  input.pollPad(0.016, true);

  // Movement: the left stick, thresholded into the mask the server replays.
  settings.gamepadDeadzone = 0.18;
  settings.gamepadResponse = 2;
  pad.axes = [0, -1, 0, 0];
  input.pollPad(0.016, true);
  check('the left stick pushed forward is the forward key',
    (input.sample() & KEY.FWD) !== 0 && (input.sample() & KEY.BACK) === 0);

  pad.axes = [0.9, 0.9, 0, 0];
  input.pollPad(0.016, true);
  check('a diagonal is both of its directions',
    (input.sample() & KEY.RIGHT) !== 0 && (input.sample() & KEY.BACK) !== 0);

  pad.axes = [0.1, 0.1, 0, 0];
  input.pollPad(0.016, true);
  check('and a stick inside the deadzone is no direction at all',
    (input.sample() & (KEY.FWD | KEY.BACK | KEY.LEFT | KEY.RIGHT)) === 0);

  suite('Controller — looking around');

  pad.axes = [0, 0, 0, 0];
  input.pollPad(0.016, true);
  input.pendingYaw = 0;
  input.pendingPitch = 0;

  pad.axes = [0, 0, 1, 0];
  settings.gamepadLookX = 1;
  input.pollPad(0.1, true);
  const slow = input.pendingYaw;
  input.pendingYaw = 0;
  input.pollPad(0.2, true);
  const fast = input.pendingYaw;
  check('the look stick turns at a rate, not by a distance',
    slow < 0 && near(fast / slow, 2, 0.01),
    `${slow.toFixed(4)} rad in 100 ms, ${fast.toFixed(4)} in 200 ms`);

  input.pendingYaw = 0;
  settings.gamepadLookX = 2;
  input.pollPad(0.1, true);
  check('and the sensitivity setting scales it',
    near(input.pendingYaw / slow, 2, 0.01), `${input.pendingYaw.toFixed(4)} at 2×`);
  settings.gamepadLookX = 1;

  input.pendingYaw = 0;
  input.aimAssist = 0.5;
  input.pollPad(0.1, true);
  check('aim assist slows the stick rather than moving it anywhere',
    input.pendingYaw < 0 && input.pendingYaw > slow,
    `${input.pendingYaw.toFixed(4)} vs ${slow.toFixed(4)} unassisted`);
  input.aimAssist = 0;

  // The curve: half a stick must not be half a turn.
  input.pendingYaw = 0;
  pad.axes = [0, 0, 0.5, 0];
  input.pollPad(0.1, true);
  const half = Math.abs(input.pendingYaw);
  check('the response curve keeps small deflections small',
    half < Math.abs(slow) * 0.35,
    `${(half / Math.abs(slow) * 100).toFixed(0)}% of full deflection at half a stick`);

  suite('Controller — the interface');

  pad.axes = [0, 0, 0, 0];
  input.pollPad(0.016, true);

  let menus = 0;
  const nav = [];
  input.on('escape', () => menus++);
  input.on('padnav', (d) => nav.push(d));

  pad.buttons[9] = { pressed: true, value: 1 };
  input.pollPad(0.016, true);
  pad.buttons[9] = { pressed: false, value: 0 };
  check('START opens the menu, in the match and out of it', menus === 1);

  // Out of the match A and B steer the interface instead of the player.
  pad.buttons[0] = { pressed: true, value: 1 };
  input.pollPad(0.016, false);
  pad.buttons[0] = { pressed: false, value: 0 };
  input.pollPad(0.016, false);
  check('A is a click when the menu is up, not a jump', nav.includes('accept'), nav.join(', '));

  pad.buttons[1] = { pressed: true, value: 1 };
  input.pollPad(0.016, false);
  pad.buttons[1] = { pressed: false, value: 0 };
  input.pollPad(0.016, false);
  check('and B steps back', nav.includes('back'));

  pad.axes = [0, -1, 0, 0];
  input.pollPad(0.016, false);
  check('the left stick walks the interface', nav.includes('up'), nav.join(', '));
  pad.axes = [0, 0, 0, 0];
  input.pollPad(0.016, false);

  suite('Controller — plugged out');

  let captured = null;
  input.capturePadBinding((code) => { captured = code; });
  pad.buttons[3] = { pressed: true, value: 1 };
  input.pollPad(0.016, true);
  pad.buttons[3] = { pressed: false, value: 0 };
  check('a rebind captures the button instead of playing it', captured === 'Pad3');

  pad.connected = false;
  input.pollPad(0.016, true);
  check('unplugging releases everything it was holding',
    input.down.size === 0 && input.sample() === 0 && !input.padActive);

  settings.gamepad = false;
  pad.connected = true;
  pad.axes = [0, -1, 0, 0];
  input.pollPad(0.016, true);
  check('and switching it off in the settings ignores it entirely',
    input.sample() === 0, 'gamepad = false');
  settings.gamepad = true;
  pad.axes = [0, 0, 0, 0];

  keys.resetAll();
}
