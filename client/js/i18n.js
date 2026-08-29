/**
 * Open Grunker — languages.
 *
 * ── Why the English *is* the key ────────────────────────────────────────────
 *
 * The usual shape for this is a table of symbolic keys — `menu.play.button` —
 * and one file per language including English. That shape has one failure this
 * codebase could not afford: the English lives in two places, the markup and
 * `en.js`, and the day somebody edits the markup without editing `en.js` the
 * button silently goes back to whatever it used to say. With six hundred
 * strings across sixteen hundred lines of HTML, that day is every day.
 *
 * So the key is the English sentence itself. There is no `en.js`, there is
 * nothing to keep in step, and a string nobody has translated yet renders as
 * the English somebody actually wrote — which is the correct fallback and the
 * only one that cannot rot. Editing the markup is editing the key: the new
 * sentence is untranslated until somebody adds it, which is honest, rather than
 * translated into the old sentence, which is a lie.
 *
 * ── Why it is a DOM pass and not a call site ────────────────────────────────
 *
 * Nearly every string in this game reaches the screen as a text node, and most
 * of them are written by `innerHTML` in menu.js and hud.js. Wrapping each one
 * in `t()` would be six hundred edits across nine files, and the six hundred
 * and first — written next week — would be the one nobody wrapped.
 *
 * Instead a `MutationObserver` watches for nodes arriving and translates them,
 * which means a panel drawn by code that has never heard of this file comes out
 * translated anyway. `t()` still exists, for the strings that are assembled
 * with a number in the middle and so can never match a table.
 *
 * ── What it costs an English player ─────────────────────────────────────────
 *
 * Nothing at all. No dictionary is fetched, no observer is created and no walk
 * of the document ever runs: `apply()` returns on its first line while the
 * language is English, which is what it is for everybody who has not chosen
 * otherwise.
 *
 * ── What is deliberately never translated ───────────────────────────────────
 *
 * Anything a player wrote. Nicknames, clan tags, chat lines and the names of
 * finishes people have listed are all short strings that could collide with a
 * table entry — a player called "SCORE" must not become "PUNTUACIÓN" — so the
 * subtrees they live in carry `data-i18n-skip` and the walk stops at them.
 */
import { settings, set as setSetting, onChange as onSettingsChange } from './settings.js';
import { LANGUAGES, LANGUAGE_IDS, languageName, detect } from './languages.js';

// Re-exported so a caller needs one import rather than two, and so the list
// stays in the one module both halves of the settings/i18n pair can read
// without either importing the other. See languages.js.
export { LANGUAGES, LANGUAGE_IDS, languageName, detect };

/** Attributes that hold something a person reads. */
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

/** The live table: English → this language. Empty while the language is English. */
let table = new Map();
let current = 'en';
let observer = null;
const listeners = new Set();

/**
 * Where a node's English came from.
 *
 * Without this, switching from French to German would translate the *French*,
 * find nothing, and leave the page in French for good. Every node this file
 * touches remembers what it said before it was touched, and every later pass
 * starts from that.
 */
const originals = new WeakMap();

/** Collapses runs of whitespace, which is what the markup is full of. */
const key = (s) => s.replace(/\s+/g, ' ').trim();

/** What `language: 'auto'` resolves to right now. */
export const resolved = () => (settings.language && settings.language !== 'auto'
  ? settings.language : detect());

export const language = () => current;

/** Fires whenever the page has just been re-translated. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * One string, translated. For text that is assembled rather than written —
 * anything with a number or a name in the middle of it.
 *
 * @param {string} english the sentence as it is written in the source
 * @returns {string} the translation, or the English when there is not one
 */
export function t(english) {
  if (!table.size) return english;
  return table.get(key(english)) ?? english;
}

/**
 * A sentence with holes in it: `tf('Level {n}+', { n: 5 })`.
 *
 * The holes are named rather than positional because word order is exactly
 * what a translation changes — "5 more kills" and "encore 5 éliminations" do
 * not put the number in the same place, and a positional `%s` would force them
 * to.
 */
export function tf(english, vars = {}) {
  return t(english).replace(/\{(\w+)\}/g, (m, name) =>
    (name in vars ? String(vars[name]) : m));
}

/* ── The DOM pass ─────────────────────────────────────────────────────────── */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CANVAS', 'TEXTAREA']);

/** True for a subtree this file must not touch — anything a player wrote. */
function skipped(node) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.hasAttribute?.('data-i18n-skip')) return true;
  }
  return false;
}

function translateText(node) {
  const before = originals.get(node);
  const source = before ?? node.nodeValue;
  const k = key(source);
  // Numbers, punctuation and single characters are not sentences. Checking here
  // rather than in the table keeps the table free of "—" and "0".
  if (k.length < 2 || !/[A-Za-z]/.test(k)) return;
  const hit = table.get(k);
  if (hit === undefined) {
    // Nothing for it in this language. If we translated it before — the player
    // has just switched languages — put the English back.
    if (before !== undefined) { node.nodeValue = before; originals.delete(node); }
    return;
  }
  if (before === undefined) originals.set(node, node.nodeValue);
  // The surrounding whitespace is the markup's, not the sentence's: it is what
  // keeps "Press <kbd>Y</kbd> to chat" from becoming "PressYto chat".
  const [, lead = '', , trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.nodeValue) ?? [];
  node.nodeValue = `${lead}${hit}${trail}`;
}

function translateAttrs(el) {
  for (const name of ATTRS) {
    if (!el.hasAttribute(name)) continue;
    const store = `__i18n_${name}`;
    const source = el[store] ?? el.getAttribute(name);
    const hit = table.get(key(source));
    if (hit === undefined) {
      if (el[store] !== undefined) { el.setAttribute(name, el[store]); delete el[store]; }
      continue;
    }
    if (el[store] === undefined) el[store] = el.getAttribute(name);
    el.setAttribute(name, hit);
  }
}

/**
 * Translates a subtree in place.
 *
 * Exported because the caller sometimes knows better than the observer does:
 * a panel that is rebuilt and measured in the same frame wants to be translated
 * before it is measured, not on the next animation frame.
 */
export function apply(root = document.body) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (!skipped(root)) translateText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (root.hasAttribute('data-i18n-skip') || SKIP_TAGS.has(root.tagName)) return;
    translateAttrs(root);
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return (SKIP_TAGS.has(node.tagName) || node.hasAttribute('data-i18n-skip'))
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n);
    else translateAttrs(n);
  }
}

/**
 * Watches for markup arriving and translates it.
 *
 * Batched into one animation frame: the menu redraws whole panels with a single
 * `innerHTML`, which is one mutation record per element in it, and translating
 * from the top of each of them would walk the same panel a hundred times.
 */
function watch() {
  if (observer) return;
  let queued = false;
  const pending = new Set();
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') pending.add(r.target);
      else for (const node of r.addedNodes) pending.add(node);
    }
    if (queued || !pending.size) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      for (const node of pending) {
        if (node.isConnected) apply(node);
      }
      pending.clear();
      /*
       * Drop the records our own writes just made.
       *
       * Without this a translated node is a mutation is a translation is a
       * mutation. `takeRecords` empties the queue without unsubscribing, which
       * is the difference between this and disconnecting: nothing anybody else
       * changed in the same frame is lost along with it.
       */
      observer.takeRecords();
    });
  });
  connect();
}

/**
 * What the observer watches.
 *
 * `characterData` as well as `childList`, because a good deal of this interface
 * is a node whose text is *replaced* rather than rebuilt — a button that reads
 * TURN ON and then TURN OFF is the same element throughout. The per-frame cost
 * of that during a match is a handful of records for the clock and the ammo
 * counter, every one of which `translateText` rejects on its first line for
 * having no letters in it. And none of it runs at all in English.
 */
function connect() {
  observer?.observe(document.body, {
    childList: true, subtree: true, characterData: true,
  });
}

function unwatch() {
  observer?.disconnect();
  observer = null;
}

/* ── Choosing one ─────────────────────────────────────────────────────────── */

/**
 * Loads a language and re-draws the page in it.
 *
 * Idempotent, and safe to call before the document exists. A dictionary that
 * fails to load — an offline browser, a chunk that 404s — leaves the game in
 * English rather than half-translated, and says nothing about it: a player who
 * asked for Italian and got English can see that for themselves.
 *
 * @param {string} id one of LANGUAGE_IDS, or 'auto'
 */
export async function setLanguage(id) {
  const want = id === 'auto' ? detect() : id;
  const next = LANGUAGE_IDS.includes(want) ? want : 'en';
  if (next === current && (next === 'en') === (table.size === 0)) return current;

  if (next === 'en') {
    current = 'en';
    const had = table;
    table = new Map();
    unwatch();
    // Every node this file touched remembers its English; one pass with an
    // empty table hands all of it back.
    if (had.size) apply(document.body);
    if (document.documentElement) document.documentElement.lang = 'en';
    for (const fn of listeners) fn('en');
    return current;
  }

  let dict = null;
  try {
    dict = (await import(`./i18n/${next}.js`)).default;
  } catch {
    return current;                       // stay where we are, in English
  }
  current = next;
  table = new Map(Object.entries(dict).map(([k, v]) => [key(k), v]));
  if (document.documentElement) document.documentElement.lang = next;
  apply(document.body);
  watch();
  for (const fn of listeners) fn(next);
  return current;
}

/**
 * Starts the language machinery.
 *
 * `serverDefault` comes from `/meta`: an operator running a server for one
 * country can say so in .env and every visitor who has not chosen otherwise
 * gets that language, rather than English plus a menu to go and find.
 */
export function init({ serverDefault = null } = {}) {
  if (settings.language === 'auto' && serverDefault
      && LANGUAGE_IDS.includes(serverDefault)
      // …but only when the browser itself has no opinion the game can honour.
      && detect() === 'en' && !String(navigator.language ?? '').toLowerCase().startsWith('en')) {
    setSetting('language', serverDefault);
  }
  onSettingsChange((k) => { if (k === null || k === 'language') setLanguage(resolved()); });
  return setLanguage(resolved());
}

export default { t, tf, apply, setLanguage, init, language, LANGUAGES };
