/**
 * Open Grunker — the interface's icon set.
 *
 * One stroked 24×24 grid, drawn from path data rather than shipped as files or
 * pulled from a font: an icon is two hundred bytes of `d` attribute, the menu
 * needs about thirty of them, and neither a sprite sheet nor a webfont is worth
 * a network request the rest of the client does not make.
 *
 * Everything is stroke-only and inherits `currentColor`, so an icon is coloured
 * by whatever it sits inside and needs no variant per state. `stroke-width` is
 * fixed at 1.6 across the set — mixing weights is what makes a hand-assembled
 * icon set read as a hand-assembled icon set.
 */

/** Path data, keyed by name. Multiple subpaths are separated by a space. */
const PATHS = {
  /* ── Navigation ─────────────────────────────────────────────────────── */
  loadout: 'M4 7h9M4 12h5M4 17h7 M14.5 11.5l5.5-5.5M18 4l2 2M15.5 14.5l4 4M20 16l-2 2',
  crosshair: 'M12 3v4M12 17v4M3 12h4M17 12h4 M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
  target: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z M12 16.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z M12 13.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4Z M8 5.5H5.5v1.5a3 3 0 0 0 3 3M16 5.5h2.5v1.5a3 3 0 0 1-3 3M12 13v3.5M9 20h6M10 16.5h4l.6 3.5h-5.2Z',
  users: 'M9.5 11.5a3.25 3.25 0 1 1 0-6.5 3.25 3.25 0 0 1 0 6.5Z M3.5 19.5c0-3 2.7-4.75 6-4.75s6 1.75 6 4.75 M16 5.6a3.25 3.25 0 0 1 0 6.3M17.5 14.9c1.9.55 3 1.9 3 4.1',
  shield: 'M12 3.5 19 6v5.5c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6l7-2.5Z M9.2 12l2 2 3.6-3.8',
  globe: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z M3.4 9.5h17.2M3.4 14.5h17.2 M12 3c-2.4 2.4-3.6 5.4-3.6 9s1.2 6.6 3.6 9c2.4-2.4 3.6-5.4 3.6-9S14.4 5.4 12 3Z',
  palette: 'M12 21a9 9 0 1 1 0-18c4.7 0 8.4 3 8.4 6.5 0 2.3-1.9 3.6-3.9 3.6h-1.7c-1.3 0-2.2.9-2.2 2 0 .5.2.9.5 1.4.3.4.4.8.4 1.2 0 .8-.6 1.3-1.5 1.3Z M8 8.6h.01M12.2 6.9h.01M15.9 9.1h.01M7.4 13h.01',
  user: 'M12 12.2a4.1 4.1 0 1 1 0-8.2 4.1 4.1 0 0 1 0 8.2Z M4.6 20.5c0-3.7 3.3-5.9 7.4-5.9s7.4 2.2 7.4 5.9',
  keyboard: 'M4 6.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 13h.01M10 13h.01M13.5 13h.01M17 13h.01M8.5 15.6h7',
  sliders: 'M5 5v6M5 15v4M12 5v3M12 12v7M19 5v9M19 18v1 M3 13h4M10 10h4M17 16h4',
  book: 'M4 5.2c2.6-.9 5.3-.9 8 0v14c-2.7-.9-5.4-.9-8 0V5.2Z M12 5.2c2.7-.9 5.4-.9 8 0v14c-2.6-.9-5.3-.9-8 0',
  notes: 'M6 3.5h8.5L19 8v12.5H6V3.5Z M14 3.6V8.2h4.6M9 12.5h7M9 16h5',
  server: 'M4.5 4.5h15v5h-15v-5ZM4.5 14.5h15v5h-15v-5Z M7.5 7h.01M7.5 17h.01M11 7h4M11 17h4',
  spark: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9L12 3.5Z M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z',

  /* ── Actions ────────────────────────────────────────────────────────── */
  userPlus: 'M10 12.2a4.1 4.1 0 1 1 0-8.2 4.1 4.1 0 0 1 0 8.2Z M2.6 20.5c0-3.7 3.3-5.9 7.4-5.9 1.4 0 2.7.25 3.8.72 M18.5 12.5v6M15.5 15.5h6',
  userCheck: 'M10 12.2a4.1 4.1 0 1 1 0-8.2 4.1 4.1 0 0 1 0 8.2Z M2.6 20.5c0-3.7 3.3-5.9 7.4-5.9 1.4 0 2.7.25 3.8.72 M15.6 16.2l2 2 3.9-4.1',
  userClock: 'M10 12.2a4.1 4.1 0 1 1 0-8.2 4.1 4.1 0 0 1 0 8.2Z M2.6 20.5c0-3.7 3.3-5.9 7.4-5.9 1 0 2 .13 2.9.4 M18 12.6a3.9 3.9 0 1 1 0 7.8 3.9 3.9 0 0 1 0-7.8Z M18 14.6v2l1.3 1',
  userX: 'M10 12.2a4.1 4.1 0 1 1 0-8.2 4.1 4.1 0 0 1 0 8.2Z M2.6 20.5c0-3.7 3.3-5.9 7.4-5.9 1.4 0 2.7.25 3.8.72 M16.2 14.2l4.6 4.6M20.8 14.2l-4.6 4.6',
  play: 'M8.5 5.4 18.6 12 8.5 18.6V5.4Z',
  flag: 'M6 21V4.2h11l-2 3.4 2 3.4H6',
  pencil: 'M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10v3Z M14.5 7.5l3 3',
  check: 'M5 12.8 9.4 17.2 19 7.6',
  close: 'M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6',
  eye: 'M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12Z M12 14.8a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6Z',
  eyeOff: 'M9.4 6.3A8.6 8.6 0 0 1 12 5.8c5.8 0 9.4 6.2 9.4 6.2a17 17 0 0 1-2.7 3.5M6 8a17 17 0 0 0-3.4 4S6.2 18.2 12 18.2c1.2 0 2.3-.26 3.3-.7 M10 10.1a2.8 2.8 0 0 0 4 3.9 M4 4l16 16',
  lock: 'M6.5 10.5h11v9.5h-11v-9.5Z M8.8 10.4V7.9a3.2 3.2 0 0 1 6.4 0v2.5M12 14.3v2.4',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9 M20 4v4.4h-4.4',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z M16.2 16.2 21 21',
  chevron: 'M9.5 6.5 15 12l-5.5 5.5',
  clock: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z M12 7.2V12l3.1 1.9',
  bolt: 'M13.4 3 5.8 13.4h5.1L10.6 21l7.6-10.4h-5.1L13.4 3Z',
  fire: 'M12 21c3.6 0 6-2.4 6-5.6 0-4.2-4.3-5.6-3.6-11.4-2.5 1.2-4 3.5-4 6 0 .9-.6 1.5-1.3 1.5s-1.2-.5-1.3-1.4C6.6 11.4 6 13 6 15.4 6 18.6 8.4 21 12 21Z',
  medal: 'M9 3.5 12 9l3-5.5 M12 21a5.6 5.6 0 1 1 0-11.2A5.6 5.6 0 0 1 12 21Z M12 13.1l.8 1.6 1.8.26-1.3 1.3.3 1.8-1.6-.85-1.6.85.3-1.8-1.3-1.3 1.8-.26.8-1.6Z',
  link: 'M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.5 1.5 M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.5-1.5',
  logout: 'M14 7V4.5H4.5v15H14V17 M9.5 12h11M17.2 8.4 20.8 12l-3.6 3.6',
  shuffle: 'M3.5 6.5h3.2l3 4M20.5 6.5h-3.6l-9 11H3.5M20.5 17.5h-3.6 M18 4.2l2.6 2.3-2.6 2.3M18 15.2l2.6 2.3-2.6 2.3',
  gift: 'M4.5 10.5h15V20h-15v-9.5ZM3.5 7.5h17v3h-17v-3ZM12 7.5V20 M12 7.5S10.6 3.8 8.6 4.2C6.8 4.6 7 7.5 9.4 7.5h2.6ZM12 7.5s1.4-3.7 3.4-3.3c1.8.4 1.6 3.3-.8 3.3H12Z',

  /* ── Creators ───────────────────────────────────────────────────────────
     One per discipline, plus the badge the four of them share. `palette` up in
     the navigation set is the art one — it is already drawn and already means
     exactly this, and a second paintbrush would be a second paintbrush. */
  note: 'M9 18.2a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z M11.6 15.6V4.8l7.4-1.6v10.4 M19 16.4a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z',
  film: 'M3.5 5h17v14h-17V5Z M8 5v14M16 5v14M3.5 9.5h4.5M3.5 14.5h4.5M16 9.5h4.5M16 14.5h4.5',
  terminal: 'M3.5 5h17v14h-17V5Z M7 9.5l2.6 2.5L7 14.5M12.5 15h4.5',
  badge: 'M12 3.2l2.4 1.7 2.9-.2 1 2.8 2.3 1.8-1.1 2.7 1.1 2.7-2.3 1.8-1 2.8-2.9-.2L12 20.8l-2.4-1.7-2.9.2-1-2.8-2.3-1.8L4.5 12 3.4 9.3l2.3-1.8 1-2.8 2.9.2L12 3.2Z M9.4 12l1.9 1.9 3.5-3.7',
  link: 'M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 1 0-5.1-5.1l-1.4 1.4 M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 1 0 5.1 5.1l1.4-1.4',
  wave: 'M3 12h2l1.6-5.5L9.2 18l2.4-9 2.2 6.5L15.6 12H21',
  camera: 'M4.5 7.5h3l1.3-2.2h6.4L16.5 7.5h3v11h-15v-11Z M12 16.2a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z',
  gauge: 'M4 17.5a9 9 0 1 1 16 0 M12 12.8 16.2 8.6 M12 14.2a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Z',

  /* ── Perks ─────────────────────────────────────────────────────
     One per entry in PERKS, and each is named after the perk's own id rather
     than after what it draws — `icon(perk.id)` is then the whole of the lookup,
     in the picker, on the HUD card and anywhere else a perk is shown. A perk
     added to shared/constants.js without a path here draws nothing rather than
     the wrong thing, which is what `hasIcon` is for at the call site. */
  trooper: 'M6 8.6 12 5.2l6 3.4M6 13 12 9.6l6 3.4M6 17.4 12 14l6 3.4',
  runner: 'M14.8 6.5a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2Z M16.4 8.5 12.6 10.6l2.3 2.7-1.3 5.4 M14.9 13.3 10.9 15.4l-1.5 3.9 M12.6 10.6 9.4 9.1M16.4 8.5l3 1.4 M2.6 8.2h3.2M2 12h4.2M3 15.8h3',
  juggernaut: 'M12 3.4 19 6v5.6c0 4.3-2.9 7.5-7 9.1-4.1-1.6-7-4.8-7-9.1V6l7-2.6Z M5.4 11.2h13.2M12 3.6v17',
  marksman: 'M12 20a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z M12 2.2v4M12 17.8v4M2.2 12h4M17.8 12h4 M12 13.4a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Z',
  medic: 'M6.6 4.6h10.8a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2H6.6a2 2 0 0 1-2-2V6.6a2 2 0 0 1 2-2Z M12 8.2v7.6M8.2 12h7.6',
  berserker: 'M12 21c3.5 0 5.9-2.4 5.9-5.5 0-4.2-4.2-5.6-3.5-11.3-2.5 1.2-4 3.5-4 6 0 .9-.6 1.5-1.3 1.5s-1.2-.5-1.3-1.4C6.7 11.5 6.1 13.1 6.1 15.5 6.1 18.6 8.5 21 12 21Z M9.9 16.6c0 1.2.9 2.1 2.1 2.1s2.1-.9 2.1-2.1c0-1.5-1.5-2.1-1.3-4-.9.5-1.5 1.4-1.5 2.3 0 .5-.6.6-.8.2-.4.4-.6 1-.6 1.5Z',
  scavenger: 'M7.4 8.4h6.2a1.4 1.4 0 0 1 1.4 1.4v10.4H6V9.8a1.4 1.4 0 0 1 1.4-1.4Z M8.8 8.4V5.5h3.4v2.9 M8.1 12.3h4.8M8.1 15.6h4.8 M18.4 4.4v5.4M15.7 7.1h5.4',
};

/**
 * One icon, as SVG markup.
 *
 * Returned as a string rather than a node because almost every caller is
 * building HTML: the menu redraws whole panels with `innerHTML`, and a helper
 * that made elements would only be turned back into text at every call site.
 *
 * @param {string} name  a key of PATHS; unknown names draw nothing
 * @param {string} [cls] extra classes on the <svg>
 */
export function icon(name, cls = '') {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="18" height="18" `
    + 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" '
    + `stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/** Whether an icon exists, so callers can fall back rather than draw a hole. */
export const hasIcon = (name) => name in PATHS;

export default icon;
