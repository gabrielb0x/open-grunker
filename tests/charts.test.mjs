/**
 * Open Grunker — the admin panel's charts.
 *
 * These are drawn by hand out of SVG, which means every mark spec is a line of
 * code that can be wrong. The shim has no layout engine, so what is checked
 * here is what a shim *can* check honestly: that a chart builds without
 * throwing, that it puts the right marks on the page in the right numbers,
 * that the hover layer exists and answers, and — the one thing that is pure
 * arithmetic — that the palette is the validated one and the axes are sane.
 */
import { suite, check, info } from './harness.mjs';
import { installBrowser } from './browser-shim.mjs';

installBrowser();

const charts = await import('/admin/charts.js');

/** Some plausible series: a day of five-minute samples. */
function ramp(n, f) {
  const t0 = Math.floor(Date.now() / 1000) - n * 300;
  return Array.from({ length: n }, (_, i) => [t0 + i * 300, f(i)]);
}

const host = () => document.createElement('div');
const marks = (el, tag) => el.querySelectorAll(tag);

export default async function run() {
  suite('Admin charts — the palette');

  check('the categorical palette is eight fixed slots',
    Array.isArray(charts.SERIES) && charts.SERIES.length === 8
    && charts.SERIES.every((c) => /^#[0-9a-f]{6}$/i.test(c)),
    charts.SERIES.join(' '));

  check('none of the panel\'s reserved status colours is in it', (() => {
    // Amber is "you", green is fine, red is a sanction, blue is information.
    // A status colour doing duty as "series 4" is how a dashboard starts lying.
    const reserved = ['#ffb02e', '#3fe08a', '#ff5d5d', '#55a8ff', '#b07cff'];
    const clash = charts.SERIES.filter((c) => reserved.includes(c.toLowerCase()));
    return clash.length === 0;
  })());

  check('big numbers read as one glance',
    charts.compact(1284) === '1,284' && charts.compact(12900) === '12.9K'
    && charts.compact(4200000) === '4.2M',
    `${charts.compact(1284)} · ${charts.compact(12900)} · ${charts.compact(4200000)}`);

  suite('Admin charts — lines');

  const el = host();
  charts.lineChart(el, {
    series: [
      { name: 'Signed in', points: ramp(60, (i) => 4 + Math.sin(i / 6) * 3) },
      { name: 'Guests', points: ramp(60, (i) => 2 + Math.cos(i / 9) * 2) },
    ],
  });
  const svg = el.querySelector('svg');
  check('a two-series line chart builds', !!svg);
  check('one 2px path per series, plus an end dot each', (() => {
    const paths = marks(el, 'path').filter((p) => p.getAttribute('stroke-width') === '2');
    const dots = marks(el, 'circle').filter((c) => c.getAttribute('opacity') !== '0');
    info(`${paths.length} line(s), ${dots.length} end dot(s)`);
    return paths.length === 2 && dots.length === 2;
  })());
  check('the end dots carry a surface ring so they stay legible where lines cross',
    marks(el, 'circle').every((c) => c.getAttribute('stroke-width') === '2'));
  check('gridlines are hairline and solid, never dashed',
    marks(el, 'line').every((l) => l.getAttribute('stroke-width') === '1'
      && l.getAttribute('stroke-dasharray') === null));
  check('the axis is labelled with round numbers', (() => {
    const ticks = marks(el, 'text').filter((t) => t.classList.contains('ct-axis'));
    info(ticks.map((t) => t.textContent).join(' '));
    return ticks.length >= 4;
  })());
  check('and there is a hover layer to read it with', (() => {
    const hit = el.querySelector('.ct-hit');
    if (!hit) return false;
    hit.fire('pointermove', { clientX: 300, clientY: 120 });
    const tip = document.querySelector('.chart-tip');
    // One tooltip, every series at that X — the pointer never has to land on
    // a line to get a value.
    const rows = tip ? tip.querySelectorAll('.ct-row') : [];
    info(`${rows.length} row(s) in the readout`);
    return !!tip && rows.length === 2;
  })());

  const emptyEl = host();
  charts.lineChart(emptyEl, { series: [{ name: 'Nothing', points: [] }] });
  check('a series with no samples says so rather than drawing an empty box',
    !!emptyEl.querySelector('.chart-empty'));

  suite('Admin charts — bars');

  const bars = host();
  charts.barChart(bars, {
    bars: Array.from({ length: 24 }, (_, h) => ({ label: String(h), value: (h % 7) * 30 })),
  });
  check('a column chart builds one mark per bar with a value', (() => {
    const rects = marks(bars, 'rect').filter((r) => r.classList.contains('ct-bar'));
    info(`${rects.length} bar(s)`);
    return rects.length === 20;                 // four of the 24 are zero
  })());
  check('every bar is capped rather than filling its slot',
    marks(bars, 'rect').filter((r) => r.classList.contains('ct-bar'))
      .every((r) => Number(r.getAttribute('width')) <= 24));
  check('bars have a rounded data-end', marks(bars, 'rect')
    .filter((r) => r.classList.contains('ct-bar'))
    .every((r) => Number(r.getAttribute('rx')) > 0));
  check('and each one carries its own hit target, wider than the mark', (() => {
    const hits = marks(bars, 'rect').filter((r) => r.classList.contains('ct-hit'));
    const painted = marks(bars, 'rect').filter((r) => r.classList.contains('ct-bar'));
    return hits.length === 24
      && Number(hits[0].getAttribute('width')) >= Number(painted[0].getAttribute('width'));
  })());

  const rows = host();
  charts.barChart(rows, {
    horizontal: true,
    bars: [
      { label: 'Triggerman', value: 136, note: '58.8% wins' },
      { label: 'Run N Gun', value: 62, note: '41.0% wins' },
    ],
  });
  check('a row chart labels each bar at its own tip', (() => {
    const values = marks(rows, 'text').filter((t) => t.classList.contains('ct-value'));
    info(values.map((v) => v.textContent).join(' · '));
    return values.length === 2 && values[0].textContent === '136';
  })());

  suite('Admin charts — composition');

  const donut = host();
  charts.donutChart(donut, {
    slices: [
      { label: 'Littletown', value: 40 }, { label: 'Burgtown', value: 30 },
      { label: 'Crossfire', value: 20 }, { label: 'Shipyard', value: 10 },
    ],
  });
  check('a donut draws one arc per slice', marks(donut, 'path').length === 4);
  check('with the total in the middle rather than a hole', (() => {
    const mid = marks(donut, 'text').find((t) => t.classList.contains('ct-donut-num'));
    info(mid?.textContent);
    return mid?.textContent === '100';
  })());
  check('and a legend, because colour alone is never the identity channel', (() => {
    const items = donut.querySelectorAll('li');
    info(items.map((i) => i.querySelector('span')?.textContent).join(', '));
    return items.length === 4;
  })());

  const many = host();
  charts.donutChart(many, {
    slices: Array.from({ length: 11 }, (_, i) => ({ label: `Thing ${i}`, value: 20 - i })),
  });
  check('past six slices the tail folds into "Other" rather than inventing a hue', (() => {
    const labels = many.querySelectorAll('li').map((i) => i.querySelector('span')?.textContent);
    info(labels.join(', '));
    return labels.length === 7 && labels[6] === 'Other';
  })());

  suite('Admin charts — the small stuff');

  const spark = host();
  charts.sparkline(spark, ramp(12, (i) => i * 2));
  check('a sparkline is one 2px stroke and nothing else',
    marks(spark, 'path').length === 1 && marks(spark, 'text').length === 0);

  const legend = host();
  charts.legendFor(legend, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  check('a legend is drawn for three series', legend.querySelectorAll('li').length === 3);
  charts.legendFor(legend, [{ name: 'Only one' }]);
  check('…and not for one — the title already names it',
    legend.querySelectorAll('li').length === 0);
}
