/**
 * Open Grunker — the translations.
 *
 * The key in every dictionary is the English sentence exactly as it appears in
 * the source, which makes this suite possible and makes it necessary: a key
 * that no longer matches any string in the game is a translation that will
 * never be drawn, and the day somebody rewrites a button's label is the day it
 * silently goes back to English in eight languages at once.
 *
 * So this checks both directions. Every key must still be findable in the
 * client, and every language must cover the same ground as the first one — a
 * file that has drifted a hundred entries behind is a half-translated menu,
 * which reads worse than an English one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, check, info } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** How the runtime keys a string: whitespace collapsed, ends trimmed. */
const key = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Everything the client could put on screen, as one haystack.
 *
 * Entities are unescaped because the browser hands the runtime a text node, not
 * markup: `&amp;` in the file is `&` by the time anything is translated. The
 * settings hints are assembled from adjacent string literals, so the
 * concatenation is undone here rather than in a hundred source files.
 */
function haystack() {
  const files = [
    'client/index.html', 'client/js/menu.js', 'client/js/hud.js', 'client/js/main.js',
    'client/js/settings.js', 'client/js/keybinds.js', 'client/js/wardrobe.js',
    'client/js/padkeyboard.js', 'client/js/killcam.js', 'client/js/devmode.js',
    'client/js/api.js', 'shared/constants.js',
  ];
  return files.map(read).join('\n')
    .replace(/&amp;/g, '&').replace(/&rsquo;/g, '’').replace(/&mdash;/g, '—')
    .replace(/&times;/g, '×').replace(/&#9776;/g, '☰').replace(/&ndash;/g, '–')
    // "one string'\n + 'and its other half" is one sentence on screen, and the
    // two halves do not have to be quoted the same way — a fragment holding an
    // apostrophe is written with double quotes right next to one that is not.
    .replace(/['"]\s*\+\s*['"]/g, '')
    // \uXXXX inside a source literal is one character on screen.
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ');
}

export default async function run() {
  suite('Languages');

  const { LANGUAGES, LANGUAGE_IDS } = await import('/js/languages.js');
  const hay = haystack();

  check('the picker names every language in its own language',
    LANGUAGES.every((l) => l.id && l.native && l.english),
    LANGUAGES.map((l) => `${l.id}=${l.native}`).join(' · '));

  check('English is first and is the fallback everything else is measured against',
    LANGUAGES[0].id === 'en');

  const dicts = new Map();
  for (const id of LANGUAGE_IDS) {
    if (id === 'en') continue;                 // there is no en.js, on purpose
    dicts.set(id, (await import(`/js/i18n/${id}.js`)).default);
  }

  check('every language that is offered ships a dictionary',
    dicts.size === LANGUAGE_IDS.length - 1, `${dicts.size} files`);

  // The reference is whichever is largest: it is the one somebody has finished.
  let base = null;
  for (const [id, dict] of dicts) {
    if (!base || Object.keys(dict).length > Object.keys(dicts.get(base)).length) base = id;
  }
  const baseKeys = Object.keys(dicts.get(base));

  /*
   * A key that matches nothing in the client is dead weight — usually because
   * the English it was written against has since been reworded, which is
   * exactly the failure this file exists to catch.
   */
  /*
   * Case is not part of the question.
   *
   * A handful of labels are re-cased on the way to the screen — the quality
   * preset is stored as `medium` and drawn as "Medium" — and a key that
   * matched the words but not the capitals would be reported as dead when it
   * is the one thing this check exists not to do: cry wolf.
   */
  const flat = hay.toLowerCase();
  const dead = baseKeys.filter((k) => !flat.includes(key(k).toLowerCase()));
  check('every key still matches a string the client can actually draw',
    dead.length === 0, dead.length ? dead.slice(0, 8).map((k) => JSON.stringify(k)).join(' · ') : `${baseKeys.length} keys`);

  for (const [id, dict] of dicts) {
    const keys = Object.keys(dict);
    const missing = baseKeys.filter((k) => !(k in dict));
    check(`${id} covers the same ground as ${base}`,
      missing.length === 0,
      missing.length ? `${missing.length} missing, first: ${JSON.stringify(missing[0])}` : `${keys.length} strings`);

    // A "translation" identical to its key is either a word that genuinely does
    // not change — Chat, Ultra, GR — or an entry somebody forgot to finish.
    // Some is expected; most of the file being untouched is not.
    const same = keys.filter((k) => dict[k] === k).length;
    check(`${id} is a translation rather than a copy`,
      same < keys.length * 0.25, `${same} of ${keys.length} identical to the English`);

    check(`${id} has no empty strings`, keys.every((k) => String(dict[k]).trim().length > 0));
  }

  info(`${baseKeys.length} strings × ${dicts.size} languages`);

  /* ── The pass itself ────────────────────────────────────────────────────
   *
   * The dictionaries above are data; this is the code that puts them on the
   * screen. It runs against a document of exactly the shape the walker uses —
   * text nodes, elements, attributes and a `createTreeWalker` — rather than
   * against the shared browser shim, whose elements hold their text as a plain
   * string and so have no text nodes to translate.
   * ─────────────────────────────────────────────────────────────────────── */

  suite('Languages — the pass');

  const saved = {};
  const stub = (name, value) => {
    saved[name] = globalThis[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  /** The three node kinds the walker knows about. */
  const TEXT = 3, ELEMENT = 1, DOCUMENT = 9;

  class T {
    constructor(v) { this.nodeType = TEXT; this.nodeValue = v; this.parentElement = null; }
    get isConnected() { return true; }
  }
  class E {
    constructor(tag, attrs = {}) {
      this.nodeType = ELEMENT;
      this.tagName = tag.toUpperCase();
      this.attrs = new Map(Object.entries(attrs));
      this.kids = [];
      this.parentElement = null;
    }
    add(...kids) {
      for (const k of kids) { k.parentElement = this; this.kids.push(k); }
      return this;
    }
    hasAttribute(k) { return this.attrs.has(k); }
    getAttribute(k) { return this.attrs.get(k) ?? null; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    get isConnected() { return true; }
  }

  /** Depth-first, honouring FILTER_REJECT the way the real walker does. */
  const walker = (root, _what, filter) => {
    const out = [];
    (function walk(node) {
      for (const kid of node.kids ?? []) {
        const verdict = filter.acceptNode(kid);
        if (verdict === 2) continue;                    // FILTER_REJECT
        out.push(kid);
        walk(kid);
      }
    }(root));
    let i = 0;
    return { nextNode: () => (i < out.length ? out[i++] : null) };
  };

  stub('Node', { TEXT_NODE: TEXT, ELEMENT_NODE: ELEMENT, DOCUMENT_NODE: DOCUMENT });
  stub('NodeFilter', { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 });
  stub('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
  stub('requestAnimationFrame', (fn) => fn());
  if (!globalThis.localStorage) {
    stub('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  }
  if (!globalThis.navigator) stub('navigator', { language: 'en', languages: ['en'] });

  const page = new E('body');
  const button = new E('button');
  const heading = new E('h4');
  const chat = new E('div', { 'data-i18n-skip': '' });
  const field = new E('input', { placeholder: 'Say something…' });
  const spaced = new E('p');
  page.add(
    button.add(new T('CANCEL')),
    heading.add(new T('\n      Loadout\n    ')),
    chat.add(new T('CANCEL')),                        // a player called CANCEL
    field,
    spaced.add(new T(' Press '), new E('kbd').add(new T('Y')), new T(' to chat ')),
  );
  stub('document', {
    documentElement: new E('html'),
    body: page,
    createTreeWalker: walker,
  });

  const i18n = await import('/js/i18n.js');
  const text = (n) => n.kids[0].nodeValue;

  await i18n.setLanguage('fr');
  check('a language switch redraws what is already on the page', (() => {
    info(`${text(button)} · ${text(heading).trim()} · ${field.getAttribute('placeholder')}`);
    return text(button) === 'ANNULER' && text(heading).trim() === 'Équipement'
      && field.getAttribute('placeholder') === 'Dites quelque chose…';
  })());

  check('the markup\u2019s own whitespace is left where it was', (() => {
    // "Press <kbd>Y</kbd> to chat" is three nodes; eating the spaces around the
    // key would render "AppuyezYpour discuter".
    const [a, , b] = spaced.kids;
    info(JSON.stringify(a.nodeValue) + ' … ' + JSON.stringify(b.nodeValue));
    return a.nodeValue === ' Appuyez sur ' && b.nodeValue === ' pour discuter '
      && text(heading) === '\n      Équipement\n    ';
  })());

  check('nothing a player wrote is touched, even when it collides with a key',
    text(chat) === 'CANCEL', 'a player called CANCEL stays CANCEL');

  await i18n.setLanguage('de');
  check('switching again translates the English, not the French', (() => {
    info(`${text(button)} · ${text(heading).trim()}`);
    return text(button) === 'ABBRECHEN' && text(heading).trim() === 'Ausrüstung';
  })());

  await i18n.setLanguage('en');
  check('and going back to English restores every original', (() => {
    info(`${text(button)} · ${text(heading).trim()} · ${field.getAttribute('placeholder')}`);
    return text(button) === 'CANCEL' && text(heading) === '\n      Loadout\n    '
      && field.getAttribute('placeholder') === 'Say something…'
      && spaced.kids[0].nodeValue === ' Press ';
  })());

  check('a string the game assembles is filled in rather than looked up whole', (() => {
    // `t()` and `tf()` are the door for anything with a number in the middle of
    // it, and the holes are named because word order is what a translation
    // changes.
    const before = i18n.tf('SKIP IN {n}', { n: 2 });
    return before === 'SKIP IN 2';
  })());

  await i18n.setLanguage('ru');
  check('…in every language, with the hole where that language puts it', (() => {
    const ru = i18n.tf('SKIP IN {n}', { n: 2 });
    const missing = i18n.t('a sentence nobody has translated');
    info(`${ru} · untranslated falls through: "${missing}"`);
    return ru === 'ПРОПУСК ЧЕРЕЗ 2' && missing === 'a sentence nobody has translated';
  })());
  await i18n.setLanguage('en');

  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
}
