/**
 * Open Grunker — the language list.
 *
 * Its own module, and a module that imports nothing, for one reason: both
 * settings.js and i18n.js need it, and each of those already imports the other.
 * A list sitting in either one of them makes that pair a cycle, and a cycle
 * whose first evaluated half reads a `const` out of its second half is a
 * ReferenceError that depends on which file the bundler happened to put first.
 */

/**
 * The languages that ship, in the order the picker draws them.
 *
 * `native` is what the picker shows: somebody looking for their own language is
 * looking for the word they call it, not the word English calls it.
 */
export const LANGUAGES = [
  { id: 'en', native: 'English', english: 'English' },
  { id: 'fr', native: 'Français', english: 'French' },
  { id: 'es', native: 'Español', english: 'Spanish' },
  { id: 'de', native: 'Deutsch', english: 'German' },
  { id: 'pt', native: 'Português (BR)', english: 'Portuguese' },
  { id: 'it', native: 'Italiano', english: 'Italian' },
  { id: 'ru', native: 'Русский', english: 'Russian' },
  { id: 'zh', native: '简体中文', english: 'Chinese (Simplified)' },
];

export const LANGUAGE_IDS = LANGUAGES.map((l) => l.id);

export const languageName = (id) => LANGUAGES.find((l) => l.id === id)?.native ?? id;

/**
 * The language a browser is asking for, if the game speaks it.
 *
 * `navigator.languages` is in preference order and its entries are tags like
 * `pt-BR`; only the primary subtag is matched, so `fr-CA` finds French and
 * `pt-PT` finds the Brazilian Portuguese this ships, which is a great deal
 * closer to Portuguese than English is.
 */
export function detect() {
  const nav = globalThis.navigator;
  const want = Array.isArray(nav?.languages) && nav.languages.length
    ? nav.languages : [nav?.language ?? 'en'];
  for (const tag of want) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LANGUAGE_IDS.includes(base)) return base;
  }
  return 'en';
}

export default LANGUAGES;
