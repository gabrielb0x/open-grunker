/**
 * Rebindable controls. The module is browser code but pure logic, so it runs
 * here behind a two-line localStorage stand-in.
 */
import { suite, check } from './harness.mjs';

export default async function run() {
  // keybinds.js persists through localStorage; give it somewhere to write.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const keys = await import('../client/js/keybinds.js');

  suite('Key bindings');

  check('every action ships with a default binding',
    keys.ACTIONS.every((a) => Array.isArray(keys.binds[a.id]) && keys.binds[a.id].length === keys.SLOTS),
    `${keys.ACTIONS.length} actions × ${keys.SLOTS} slots`);

  const duplicates = [];
  const seen = new Map();
  for (const a of keys.ACTIONS) {
    for (const code of keys.binds[a.id].filter(Boolean)) {
      if (seen.has(code)) duplicates.push(`${code}: ${seen.get(code)} + ${a.id}`);
      seen.set(code, a.id);
    }
  }
  check('no default key drives two actions at once', duplicates.length === 0, duplicates.join(', '));

  check('a code resolves back to its action',
    keys.actionsFor('KeyW').includes('forward') && keys.actionsFor('Mouse0').includes('fire'),
    'KeyW -> forward, Mouse0 -> fire');

  // Rebinding steals the key from whoever had it.
  keys.bind('jump', 0, 'KeyW');
  check('binding a key that belonged to another action takes it away',
    keys.actionsFor('KeyW').length === 1 && keys.actionsFor('KeyW')[0] === 'jump'
      && keys.binds.forward[0] === '',
    `KeyW -> ${keys.actionsFor('KeyW').join(', ')}, forward is now "${keys.binds.forward[0]}"`);

  check('Escape can never be rebound', keys.bind('jump', 0, 'Escape').ok === false);

  check('mouse buttons and the wheel are valid bindings',
    keys.bind('melee', 0, 'Mouse1').ok && keys.bind('nextWeapon', 0, 'WheelDown').ok
      && keys.actionsFor('Mouse1').includes('melee'));

  keys.clearBinding('melee', 0);
  check('a binding can be cleared', keys.actionsFor('Mouse1').length === 0);

  keys.resetAll();
  check('resetting restores every default',
    keys.binds.forward[0] === 'KeyW' && keys.binds.jump[0] === 'Space'
      && keys.binds.melee[0] === 'KeyV');

  keys.apply({ fire: ['Mouse0', 'KeyZ'], reload: ['KeyG', ''] });
  check('an account profile can replace the whole scheme',
    keys.binds.fire[1] === 'KeyZ' && keys.binds.reload[0] === 'KeyG'
      && keys.actionsFor('KeyZ').includes('fire'));

  check('labels are readable', keys.keyLabel('KeyW') === 'W' && keys.keyLabel('Space') === 'SPACE'
    && keys.keyLabel('Mouse2') === 'RMB' && keys.keyLabel('') === '—',
    `W / SPACE / RMB / ${keys.keyLabel('WheelDown')}`);

  check('bindings survive a round trip through storage',
    JSON.parse(store.get('og.keybinds.v1')).fire[1] === 'KeyZ');

  keys.resetAll();
  delete globalThis.localStorage;
}
