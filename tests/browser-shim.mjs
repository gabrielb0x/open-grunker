/**
 * Open Grunker — a browser just large enough to boot the client in Node.
 *
 * There is no headless browser in this project's toolchain, so instead of
 * shipping client code that has only ever been type-checked, this file stands
 * up the handful of DOM, canvas and storage APIs the client actually touches.
 * The real `index.html` is parsed for its element tree, and the real three.js
 * runs on top — only the WebGL renderer is stubbed, because that is the one
 * piece that genuinely needs a GPU.
 *
 * It catches exactly the class of bug that is otherwise invisible here: a
 * missing element id, a renamed field, a constructor that throws.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ── Element ─────────────────────────────────────────────────────────────── */

class ClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { for (const x of c) if (x) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
  get value() { return [...this.set].join(' '); }
  toString() { return this.value; }
}

class Style {
  constructor() { this._props = new Map(); }
  setProperty(k, v) { this._props.set(k, v); }
  getPropertyValue(k) { return this._props.get(k) ?? ''; }
  removeProperty(k) { this._props.delete(k); }
}

let idCounter = 0;

export class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.classList = new ClassList(this);
    this.style = new Proxy(new Style(), {
      get: (t, k) => (k in t ? t[k] : t._props.get(k) ?? ''),
      set: (t, k, v) => { t._props.set(k, v); return true; },
    });
    this.dataset = {};
    this._text = '';
    this._html = '';
    this._listeners = new Map();
    this._uid = ++idCounter;
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.width = 300;
    this.height = 150;
    // The built client opens with Vite's modulepreload polyfill, which asks a
    // throwaway <link> whether the browser needs it. A browser new enough to
    // run this game says no, and the polyfill returns without touching the
    // MutationObserver nothing here has.
    if (this.tagName === 'LINK') this.relList = { supports: () => true };
  }

  get id() { return this.attributes.get('id') ?? ''; }
  set id(v) { this.attributes.set('id', v); doc._index.set(v, this); }

  get className() { return this.classList.value; }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
    if (k === 'id') doc._index.set(String(v), this);
    if (k === 'class') this.className = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  removeAttribute(k) { this.attributes.delete(k); }

  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ''); this.children.length = 0; }

  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v ?? '');
    this.children.length = 0;
    // Good enough for the client's use: it only ever queries elements it made
    // itself out of innerHTML by class, and those queries are exercised below.
    for (const m of this._html.matchAll(/<(\w+)([^>]*)>/g)) {
      const child = new El(m[1]);
      const attrs = m[2];
      for (const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(a[1], a[2]);
      child.parentElement = this;
      this.children.push(child);
    }
  }

  get firstChild() { return this.children[0] ?? null; }
  /**
   * A `<select>`'s own view of its children.
   *
   * Standard DOM, and code that fills a dropdown once reads it to know whether
   * it has already done so — `if (!select.options.length)`. Without it that is
   * a TypeError here and works everywhere else, which is exactly the shape of
   * gap this file exists to close. Recursive, because an `<option>` inside an
   * `<optgroup>` is still one of a select's options.
   */
  get options() {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.tagName === 'OPTION') out.push(child);
        else if (child.tagName === 'OPTGROUP') walk(child);
      }
    };
    walk(this);
    return out;
  }
  get offsetWidth() { return 100; }
  get offsetHeight() { return 100; }
  /** A card wide enough that a chart lays out rather than collapsing. */
  get clientWidth() { return 520; }
  get clientHeight() { return 200; }

  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  appendChild(node) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove() {
    const p = this.parentElement;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentElement = null;
  }
  removeChild(node) { node.remove(); return node; }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) ?? []) fn(ev);
    return true;
  }

  /**
   * Test helper: fire an event and let it bubble, the way a real one does.
   *
   * Bubbling is not a detail here: the client delegates whole families of
   * clicks — every nickname in the game opens a profile through one listener on
   * the document — and a shim that only ever called the listener on the element
   * itself would report those as working when nothing was bound at all.
   */
  fire(type, ev = {}) {
    let stopped = false;
    const event = {
      type,
      preventDefault() {},
      target: this,
      ...ev,
      stopPropagation() { stopped = true; },
    };
    for (let node = this; node && !stopped; node = node.parentElement) node.dispatchEvent(event);
    if (!stopped) doc.dispatchEvent(event);
    return event;
  }

  /** Nearest self-or-ancestor matching `sel`, or null. */
  closest(sel) {
    const matches = matcher(sel);
    for (let node = this; node; node = node.parentElement) if (matches(node)) return node;
    return null;
  }

  focus() {} blur() {} click() { this.fire('click'); }
  requestPointerLock() { return undefined; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0 }; }

  /** Depth-first search over this element and everything under it. */
  _walk(fn) {
    for (const c of this.children) { fn(c); c._walk(fn); }
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    const out = [];
    const matches = matcher(sel);
    this._walk((el) => { if (matches(el)) out.push(el); });
    return out;
  }

  getContext(kind) {
    if (kind === '2d') return canvas2d(this);
    return null;
  }
  toDataURL() { return 'data:image/png;base64,'; }
}

/** Supports the selector shapes the client actually uses. */
function matcher(sel) {
  const parts = sel.trim().split(/\s+/);
  const one = (s) => (el) => {
    let ok = true;
    const tag = s.match(/^([a-zA-Z]+)/);
    if (tag) ok = ok && el.tagName === tag[1].toUpperCase();
    for (const m of s.matchAll(/\.([\w-]+)/g)) ok = ok && el.classList.contains(m[1]);
    const id = s.match(/#([\w-]+)/);
    if (id) ok = ok && el.id === id[1];
    for (const m of s.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
      const v = el.getAttribute(m[1]);
      ok = ok && (m[2] === undefined ? v !== null : v === m[2]);
    }
    return ok;
  };
  const last = one(parts[parts.length - 1]);
  if (parts.length === 1) return last;
  const ancestors = parts.slice(0, -1).map(one);
  return (el) => {
    if (!last(el)) return false;
    let node = el.parentElement;
    let i = ancestors.length - 1;
    while (node && i >= 0) {
      if (ancestors[i](node)) i--;
      node = node.parentElement;
    }
    return i < 0;
  };
}

/* ── Canvas 2D ───────────────────────────────────────────────────────────── */

function canvas2d(el) {
  const noop = () => {};
  return {
    canvas: el,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', globalAlpha: 1,
    textAlign: 'left', textBaseline: 'top', lineCap: 'butt', lineJoin: 'miter',
    globalCompositeOperation: 'source-over',
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
    ellipse: noop, rect: noop, fill: noop, stroke: noop, clip: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    fillText: noop, strokeText: noop, drawImage: noop, setTransform: noop, setLineDash: noop,
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    putImageData: noop,
  };
}

/* ── Document / window ───────────────────────────────────────────────────── */

class Doc {
  constructor() {
    this._index = new Map();
    this.documentElement = new El('html');
    this.body = new El('body');
    this.documentElement.appendChild(this.body);
    this.pointerLockElement = null;
    this._listeners = new Map();
  }
  createElement(tag) { return new El(tag); }
  /**
   * SVG lives in its own namespace, and the admin panel's charts are built
   * entirely out of it. Nothing here needs the namespace itself — an element is
   * an element — but the call has to exist or the charts throw before they draw.
   */
  createElementNS(_ns, tag) { return new El(tag); }
  getElementById(id) { return this._index.get(id) ?? null; }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(ev) {
    for (const fn of this._listeners.get(ev.type) ?? []) fn(ev);
    return true;
  }
  exitPointerLock() { this.pointerLockElement = null; }
  fire(type, ev = {}) {
    for (const fn of this._listeners.get(type) ?? []) {
      fn({ type, preventDefault() {}, stopPropagation() {}, ...ev });
    }
  }
}

let doc = new Doc();

/**
 * Builds the element tree from the project's real index.html, so every id the
 * client asks for is the id the shipped page actually has.
 */
function buildFromHtml(file = 'client/index.html') {
  const html = readFileSync(join(ROOT, file), 'utf8');
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  const stack = [doc.body];
  const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'path', 'use']);
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)\/?>/g;
  for (const m of body.matchAll(re)) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const tag = m[2].toLowerCase();
    const el = new El(tag);
    for (const a of (m[3] ?? '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      if (!a[1]) continue;
      el.setAttribute(a[1], a[2] ?? '');
    }
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(tag) && !m[0].endsWith('/>')) stack.push(el);
  }
}

/* ── Storage, audio and the rest ─────────────────────────────────────────── */

class Storage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

class FakeAudioParam {
  constructor(v = 0) { this.value = v; }
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  cancelScheduledValues() { return this; }
  setTargetAtTime() { return this; }
  setValueCurveAtTime() { return this; }
}

const audioNode = (extra = {}) => ({
  connect() { return this; }, disconnect() {}, start() {}, stop() {},
  gain: new FakeAudioParam(1), pan: new FakeAudioParam(0),
  frequency: new FakeAudioParam(440), Q: new FakeAudioParam(1),
  detune: new FakeAudioParam(0), playbackRate: new FakeAudioParam(1),
  threshold: new FakeAudioParam(-24), knee: new FakeAudioParam(30),
  ratio: new FakeAudioParam(12), attack: new FakeAudioParam(0.003),
  release: new FakeAudioParam(0.25), delayTime: new FakeAudioParam(0),
  type: 'sine', buffer: null, curve: null, oversample: 'none', onended: null,
  ...extra,
});

class FakeAudioContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.state = 'running'; this.destination = audioNode(); }
  createGain() { return audioNode(); }
  createStereoPanner() { return audioNode(); }
  createBiquadFilter() { return audioNode(); }
  createOscillator() { return audioNode(); }
  createBufferSource() { return audioNode(); }
  createConvolver() { return audioNode(); }
  createDynamicsCompressor() { return audioNode(); }
  createWaveShaper() { return audioNode(); }
  createDelay() { return audioNode(); }
  createChannelMerger() { return audioNode(); }
  createBuffer(ch, len) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { length: len, numberOfChannels: ch, getChannelData: (i) => data[i] };
  }
  resume() { return Promise.resolve(); }
}

/** Installs the shim on globalThis. Safe to call once per process. */
export function installBrowser() {
  if (globalThis.__ogBrowserShim) return { document: doc, window: globalThis.window };
  buildFromHtml();

  const win = {
    innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
    location: {
      protocol: 'http:', host: 'localhost:7420', hostname: 'localhost', port: '7420',
      pathname: '/', search: '', hash: '', origin: 'http://localhost:7420',
      href: 'http://localhost:7420/',
    },
    history: { replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame(fn) { return setTimeout(() => fn(performance.now()), 16); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    AudioContext: FakeAudioContext,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };

  globalThis.window = win;
  globalThis.document = doc;
  // The client reads these off the bare global the way page code does, so the
  // shim has to put them there too — `location` in particular is read by the
  // menu on construction, and a missing one surfaced as an unhandled rejection
  // rather than as a failed check.
  globalThis.location = win.location;
  globalThis.history = win.history;
  if (!globalThis.navigator?.getGamepads) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { ...(globalThis.navigator ?? {}), getGamepads: () => [] },
    });
  }
  globalThis.localStorage = new Storage();
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  globalThis.AudioContext = FakeAudioContext;
  globalThis.Image = class { constructor() { this.width = 0; this.height = 0; } set src(_v) {} };
  globalThis.HTMLInputElement = class {};
  globalThis.HTMLTextAreaElement = class {};
  globalThis.WebSocket = class {
    constructor() { this.readyState = 0; }
    addEventListener() {} send() {} close() {}
  };
  globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
  globalThis.__ogBrowserShim = true;
  return { document: doc, window: win };
}

/**
 * Throws the current page away and parses a different one in its place.
 *
 * The admin panel is a second page served from the same project, with its own
 * ids and its own module — and the alternative to this is 400 lines of stats
 * rendering that nothing ever executes. Whatever suite calls this owns the
 * document afterwards, so it has to be the last one to run.
 */
export function loadPage(file) {
  doc = new Doc();
  globalThis.document = doc;
  buildFromHtml(file);
  return doc;
}

export { doc as document };
