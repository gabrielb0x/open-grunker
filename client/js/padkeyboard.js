/**
 * Open Grunker — the on-screen keyboard.
 *
 * The one thing a controller genuinely cannot do is spell. Everything else in
 * this interface is a button, a slider or a card, and a stick reaches all of
 * them; a nickname, a password, a clan tag and a chat line are letters, and
 * there is no stick gesture that is a letter. So the letters come to the pad.
 *
 * ── Why it is buttons and nothing else ──────────────────────────────────────
 *
 * Every key here is a real `<button>` in the document. That is not decoration:
 * the pad's focus walker in menu.js finds buttons and presses them, so this
 * file writes no navigation, no focus model and no key-repeat of its own — a
 * grid of buttons *is* a keyboard as far as that walker is concerned, and the
 * one already knows about held directions, wrap-around and the sound a moved
 * selection makes. It is also, for free, usable with a mouse, a touchscreen
 * and the Tab key.
 *
 * ── Why it writes through events ────────────────────────────────────────────
 *
 * A key sets `value` and dispatches `input`. Everything downstream — the tab
 * filter, the character counters, the live validation on the sign-up form — is
 * already listening for that, because that is what a person typing produces.
 * Calling the handlers directly would be a second way to type that could fall
 * out of step with the first, and the first is the one that has to keep
 * working.
 */

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '_', '@'],
];

/**
 * The row a password and an email need and a nickname does not.
 *
 * Drawn always rather than per field: a keyboard whose keys move depending on
 * what is being filled in is a keyboard nobody learns the shape of.
 */
const SYMBOLS = ['!', '?', '#', '$', '%', '&', '*', '+', '/', ':', ';', "'"];

/** What the shift key does to a character. Digits and symbols are unshifted. */
const SHIFTED = {
  '1': '!', '2': '"', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '.': '>', '_': '-', '@': '~', '/': '\\', ':': ';', ';': ':', "'": '"',
};

export class PadKeyboard {
  /**
   * @param {object} o
   * @param {function(string=):void} [o.sound] the interface's own click
   * @param {function():void} [o.onOpen]  the scope changed; refocus
   * @param {function():void} [o.onClose]
   */
  constructor({ sound = null, onOpen = null, onClose = null } = {}) {
    this.sound = sound;
    this.onOpen = onOpen;
    this.onClose = onClose;
    /** The field being typed into, or null. */
    this.target = null;
    this.onDone = null;
    this.shift = false;
    this.element = null;
  }

  get open_() { return !!this.target; }

  /**
   * Builds the overlay on first use.
   *
   * Lazily, because most sessions never plug a controller in and a hundred and
   * twenty buttons nobody will press is a hundred and twenty elements the
   * browser lays out on every menu resize for nothing.
   */
  _build() {
    if (this.element) return this.element;
    const root = document.createElement('div');
    root.id = 'padKeyboard';
    root.className = 'hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'On-screen keyboard');

    const head = document.createElement('div');
    head.className = 'pk-head';
    this.label = document.createElement('span');
    this.label.className = 'pk-label';
    this.preview = document.createElement('b');
    this.preview.className = 'pk-preview';
    head.append(this.label, this.preview);

    const grid = document.createElement('div');
    grid.className = 'pk-grid';
    this.keys = [];
    for (const row of [...ROWS, SYMBOLS]) {
      const line = document.createElement('div');
      line.className = 'pk-row';
      for (const ch of row) line.appendChild(this._key(ch));
      grid.appendChild(line);
    }

    const foot = document.createElement('div');
    foot.className = 'pk-row pk-actions';
    foot.append(
      this._action('SHIFT', () => this._toggleShift(), 'pk-shift'),
      this._action('SPACE', () => this._type(' '), 'pk-space'),
      this._action('⌫', () => this._backspace(), 'pk-back'),
      this._action('CLEAR', () => this._clear()),
      this._action('DONE', () => this._done(), 'pk-done'),
    );

    root.append(head, grid, foot);
    document.body.appendChild(root);
    this.element = root;
    return root;
  }

  _key(ch) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pk-key';
    b.dataset.ch = ch;
    b.textContent = ch;
    b.addEventListener('click', () => this._type(this._face(ch)));
    this.keys.push(b);
    return b;
  }

  _action(label, fn, cls = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pk-key pk-fn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  /** What a key types right now, given the shift state. */
  _face(ch) {
    if (!this.shift) return ch;
    return SHIFTED[ch] ?? ch.toUpperCase();
  }

  _toggleShift() {
    this.shift = !this.shift;
    this.element.classList.toggle('shifted', this.shift);
    for (const b of this.keys) b.textContent = this._face(b.dataset.ch);
    this.sound?.();
  }

  /**
   * Opens the keyboard over a field.
   *
   * @param {HTMLInputElement|HTMLTextAreaElement} input
   * @param {{done?:function():void}} [o] what DONE means here, when it means
   *   more than "put the keyboard away" — sending a chat line, say.
   */
  open(input, { done = null } = {}) {
    if (!input) return;
    this._build();
    this.target = input;
    this.onDone = done;
    this.shift = false;
    this.element.classList.remove('shifted', 'hidden');
    for (const b of this.keys) b.textContent = this._face(b.dataset.ch);
    // The field's own label, or its placeholder, or nothing — whichever of
    // them exists. What it must never say is the field's id.
    const named = input.getAttribute('aria-label')
      ?? input.closest('label')?.querySelector('span')?.textContent
      ?? input.placeholder ?? '';
    this.label.textContent = String(named).trim().slice(0, 40) || 'TYPING';
    this._paint();
    this.onOpen?.();
    // Focus lands on the first letter rather than the first digit: the first
    // thing anybody types is almost never a number.
    this.keys[ROWS[0].length]?.focus({ preventScroll: true });
  }

  /**
   * Puts it away. Returns true if it was open, so a Back press can be swallowed
   * by it rather than closing whatever is behind it as well.
   */
  close(commit = true) {
    if (!this.target) return false;
    const input = this.target;
    this.target = null;
    this.onDone = null;
    this.element.classList.add('hidden');
    if (commit) input.dispatchEvent(new Event('change', { bubbles: true }));
    try { input.focus({ preventScroll: true }); } catch { /* gone from the page */ }
    this.onClose?.();
    return true;
  }

  /** DONE: whatever the caller said it meant, then away. */
  _done() {
    const fn = this.onDone;
    this.close(true);
    fn?.();
  }

  _paint() {
    if (!this.target) return;
    const v = this.target.value ?? '';
    const masked = this.target.type === 'password' ? '•'.repeat(v.length) : v;
    // The tail, not the head: what somebody wants to see while typing is the
    // end of what they have typed.
    this.preview.textContent = masked.slice(-38) || '—';
  }

  _write(next) {
    const input = this.target;
    if (!input) return;
    const max = input.maxLength;
    input.value = max > 0 ? next.slice(0, max) : next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    this._paint();
  }

  _type(ch) {
    if (!this.target) return;
    this._write((this.target.value ?? '') + ch);
    this.sound?.();
    // Shift is a shift, not a caps lock: one capital, then back to lower case.
    if (this.shift) this._toggleShift();
  }

  _backspace() {
    if (!this.target) return;
    this._write((this.target.value ?? '').slice(0, -1));
    this.sound?.();
  }

  _clear() {
    this._write('');
    this.sound?.('error');
  }
}

export default PadKeyboard;
