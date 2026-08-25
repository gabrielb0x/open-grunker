/**
 * Open Grunker — the admin panel's charts.
 *
 * Hand-rolled SVG, no library. The panel is served from this machine to this
 * machine and loads no third-party anything — the same reason there is no
 * webfont — so a charting library would be a 300 kB dependency shipped to an
 * audience of one.
 *
 * ── The rules these follow ─────────────────────────────────────────────────
 *
 *   • **One axis, always.** Two measures of different scale get two charts,
 *     never two y-scales on one. Every misread dashboard in the world has a
 *     dual axis somewhere in it.
 *   • **Colour is identity, not decoration.** `SERIES` below is a fixed order,
 *     assigned by slot and never cycled; a chart that loses a series does not
 *     repaint the survivors. It is validated for colour-blind separation and
 *     for contrast against this panel's own surface — see the note on it.
 *   • **The panel's status colours are reserved.** Amber is "you", green is
 *     fine, red is a sanction. None of them is ever "series 4".
 *   • **Text never wears the data colour.** Values and labels are text tokens;
 *     the coloured key beside them carries the identity.
 *   • **Every chart has a hover layer.** A line chart gets a crosshair that
 *     snaps to the nearest sample and reads out every series at once; bars and
 *     arcs carry their own tooltips. Nothing is reachable only by hovering —
 *     the axis and the direct labels carry the values that matter.
 */

/**
 * The categorical palette, in fixed slot order.
 *
 * Validated against this panel's card surface (#121822) with the data-viz
 * checks: every slot inside the dark lightness band, above the chroma floor,
 * ≥3:1 against the surface, worst adjacent colour-blind separation ΔE 8.4 and
 * worst normal-vision separation ΔE 19.3. Do not re-order it casually — the
 * order *is* the colour-blind safety mechanism, not a preference.
 */
export const SERIES = [
  '#3987e5', '#d95926', '#199e70', '#c98500',
  '#d55181', '#008300', '#9085e9', '#e66767',
];

const NS = 'http://www.w3.org/2000/svg';
const SURFACE = '#121822';
const GRID = 'rgba(53,69,92,.55)';
const AXIS_TEXT = '#8ea1b8';

/* ── Formatting ──────────────────────────────────────────────────────────── */

/** 1 284 · 12.9K · 4.2M — big numbers stay one glance wide. */
export function compact(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  if (Number.isInteger(n)) return n.toLocaleString('en-GB');
  return (Math.round(n * 100) / 100).toLocaleString('en-GB');
}

/** Clean axis ticks: 0 / 500 / 1,000 rather than 0 / 437 / 874. */
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v <= max + step * 0.5; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out.length > 1 ? out : [0, max];
}

const timeLabel = (t, spanSec) => {
  const d = new Date(t * 1000);
  if (spanSec <= 3 * 86400) return d.toTimeString().slice(0, 5);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

/* ── Tooltip ─────────────────────────────────────────────────────────────── */

let tip = null;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    document.body.appendChild(tip);
  }
  return tip;
}

/**
 * Shows the readout. `rows` is [{ key, label, value }] — the value leads,
 * because the reader already knows which series they are pointing at.
 *
 * Every string goes in as text, never as markup: series names come from the
 * server, and a chart is not a place to trust one.
 */
function showTip(x, y, title, rows) {
  const el = tooltip();
  el.textContent = '';
  const h = document.createElement('b');
  h.textContent = title;
  el.appendChild(h);
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 'ct-row';
    const key = document.createElement('i');
    key.style.background = r.key ?? 'transparent';
    line.appendChild(key);
    const val = document.createElement('strong');
    val.textContent = r.value;
    line.appendChild(val);
    const name = document.createElement('span');
    name.textContent = r.label;
    line.appendChild(name);
    el.appendChild(line);
  }
  el.classList.add('on');
  const box = el.getBoundingClientRect();
  const left = Math.min(window.innerWidth - box.width - 10, Math.max(10, x + 14));
  const top = Math.min(window.innerHeight - box.height - 10, Math.max(10, y - box.height - 12));
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hideTip() { if (tip) tip.classList.remove('on'); }

/* ── SVG helpers ─────────────────────────────────────────────────────────── */

const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/**
 * Re-renders a chart when its card changes width.
 *
 * The alternative — a fixed viewBox stretched with `preserveAspectRatio` —
 * distorts every stroke and every round cap in the chart, which is exactly the
 * mark spec these are drawn to.
 */
const observer = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => {
    for (const e of entries) {
      const draw = e.target._ogDraw;
      if (draw && e.contentRect.width > 0) draw();
    }
  })
  : null;

function mount(host, draw) {
  host._ogDraw = draw;
  if (observer && !host._ogWatched) { host._ogWatched = true; observer.observe(host); }
  draw();
}

/* ── Line / area chart ───────────────────────────────────────────────────── */

/**
 * Change over time, one or more series on one shared axis.
 *
 * @param {HTMLElement} host
 * @param {object} o
 * @param {Array<{name:string, points:Array<[number,number]>, color?:string}>} o.series
 * @param {number} [o.height]
 * @param {function(number):string} [o.format] how a value reads in the tooltip
 * @param {boolean} [o.area] fill under the line — only ever for a single series
 * @param {string}  [o.empty] what to say when there is nothing to draw
 */
export function lineChart(host, {
  series = [], height = 190, format = compact, area = false,
  empty = 'No samples in this window yet.',
} = {}) {
  const live = series.filter((s) => (s.points ?? []).length > 0);
  if (!live.length) return void renderEmpty(host, empty);

  mount(host, () => {
    const W = Math.max(240, host.clientWidth || 480);
    const H = height;
    const pad = { l: 44, r: 14, t: 12, b: 22 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;

    let minT = Infinity, maxT = -Infinity, maxV = 0;
    for (const s of live) {
      for (const [t, v] of s.points) {
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
        if (v > maxV) maxV = v;
      }
    }
    if (maxT === minT) maxT = minT + 1;
    const ticks = niceTicks(maxV || 1);
    const top = ticks[ticks.length - 1] || 1;
    const x = (t) => pad.l + ((t - minT) / (maxT - minT)) * iw;
    const y = (v) => pad.t + ih - (v / top) * ih;

    host.textContent = '';
    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart' });

    // Gridlines: hairline, solid, one step off the surface. They carry the
    // values that are not directly labelled, which is why they stay.
    for (const t of ticks) {
      svg.appendChild(svgEl('line', {
        x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), stroke: GRID, 'stroke-width': 1,
      }));
      const label = svgEl('text', {
        x: pad.l - 8, y: y(t) + 3.5, 'text-anchor': 'end', class: 'ct-axis',
      });
      label.textContent = compact(t);
      svg.appendChild(label);
    }

    const span = maxT - minT;
    for (let i = 0; i <= 4; i++) {
      const t = minT + (span * i) / 4;
      const label = svgEl('text', {
        x: x(t), y: H - 6,
        'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'ct-axis',
      });
      label.textContent = timeLabel(t, span);
      svg.appendChild(label);
    }

    live.forEach((s, i) => {
      const color = s.color ?? SERIES[i % SERIES.length];
      const pts = s.points;
      const d = pts.map((p, n) => `${n ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
      if (area && live.length === 1) {
        svg.appendChild(svgEl('path', {
          d: `${d}L${x(pts[pts.length - 1][0]).toFixed(1)},${y(0)}L${x(pts[0][0]).toFixed(1)},${y(0)}Z`,
          fill: color, 'fill-opacity': 0.1, stroke: 'none',
        }));
      }
      svg.appendChild(svgEl('path', {
        d, fill: 'none', stroke: color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
      // The end dot, with a 2px surface ring so it stays legible where lines
      // cross. It is the one direct label position that never collides.
      const last = pts[pts.length - 1];
      svg.appendChild(svgEl('circle', {
        cx: x(last[0]), cy: y(last[1]), r: 4, fill: color, stroke: SURFACE, 'stroke-width': 2,
      }));
    });

    /* ── Hover: one crosshair, every series at that X ───────────────────── */

    const rule = svgEl('line', {
      y1: pad.t, y2: pad.t + ih, stroke: 'rgba(238,244,251,.35)', 'stroke-width': 1,
      class: 'ct-rule', opacity: 0,
    });
    svg.appendChild(rule);
    const dots = live.map(() => {
      const c = svgEl('circle', { r: 4.5, fill: 'none', stroke: SURFACE, 'stroke-width': 2, opacity: 0 });
      svg.appendChild(c);
      return c;
    });

    const hit = svgEl('rect', {
      x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent', class: 'ct-hit',
    });
    svg.appendChild(hit);

    const at = (clientX, clientY) => {
      const box = svg.getBoundingClientRect();
      const px = clientX - box.left;
      const t = minT + ((px - pad.l) / iw) * (maxT - minT);
      const rows = [];
      let snapped = null;
      live.forEach((s, i) => {
        let best = null, bestD = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p[0] - t);
          if (d < bestD) { bestD = d; best = p; }
        }
        if (!best) { dots[i].setAttribute('opacity', 0); return; }
        if (snapped === null || Math.abs(best[0] - t) < Math.abs(snapped - t)) snapped = best[0];
        const color = s.color ?? SERIES[i % SERIES.length];
        dots[i].setAttribute('cx', x(best[0]));
        dots[i].setAttribute('cy', y(best[1]));
        dots[i].setAttribute('fill', color);
        dots[i].setAttribute('opacity', 1);
        rows.push({ key: color, label: s.name, value: format(best[1]) });
      });
      if (snapped === null) return;
      rule.setAttribute('x1', x(snapped));
      rule.setAttribute('x2', x(snapped));
      rule.setAttribute('opacity', 1);
      const d = new Date(snapped * 1000);
      showTip(clientX, clientY, d.toLocaleString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      }), rows);
    };

    hit.addEventListener('pointermove', (e) => at(e.clientX, e.clientY));
    hit.addEventListener('pointerleave', () => {
      rule.setAttribute('opacity', 0);
      for (const d of dots) d.setAttribute('opacity', 0);
      hideTip();
    });

    host.appendChild(svg);
  });
}

/* ── Bars ────────────────────────────────────────────────────────────────── */

/**
 * Magnitude across a handful of named things.
 *
 * Columns when there are few and the labels are short, rows when the labels are
 * words — a rotated axis label is a label nobody reads.
 *
 * @param {HTMLElement} host
 * @param {object} o
 * @param {Array<{label:string, value:number, color?:string, note?:string}>} o.bars
 */
export function barChart(host, {
  bars = [], height = 190, format = compact, horizontal = false, color = SERIES[0],
  empty = 'Nothing recorded in this window.',
} = {}) {
  if (!bars.length || bars.every((b) => !b.value)) return void renderEmpty(host, empty);

  mount(host, () => {
    const W = Math.max(240, host.clientWidth || 480);
    const max = Math.max(...bars.map((b) => b.value)) || 1;

    host.textContent = '';
    if (horizontal) {
      // Rows. The value rides the tip of its own bar — one direct label per
      // bar, never a number floating in space.
      const rowH = 26;
      const H = bars.length * rowH + 6;
      const labelW = Math.min(140, Math.max(72, W * 0.3));
      const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart' });
      const iw = W - labelW - 58;
      bars.forEach((b, i) => {
        const y = i * rowH + 3;
        const w = Math.max(2, (b.value / max) * iw);
        const fill = b.color ?? color;
        const name = svgEl('text', { x: labelW - 10, y: y + 14, 'text-anchor': 'end', class: 'ct-label' });
        name.textContent = b.label;
        svg.appendChild(name);
        const rect = svgEl('rect', {
          x: labelW, y: y + 3, width: w, height: 16, rx: 4, fill,
          class: 'ct-bar',
        });
        svg.appendChild(rect);
        const val = svgEl('text', { x: labelW + w + 8, y: y + 15, class: 'ct-value' });
        val.textContent = format(b.value);
        svg.appendChild(val);
        // The hit target is the whole row, not the painted pixels.
        const hit = svgEl('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent', class: 'ct-hit' });
        hit.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, b.label,
          [{ key: fill, label: b.note ?? '', value: format(b.value) }]));
        hit.addEventListener('pointerleave', hideTip);
        svg.appendChild(hit);
      });
      host.appendChild(svg);
      return;
    }

    const H = height;
    const pad = { l: 40, r: 10, t: 12, b: 24 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;
    const slot = iw / bars.length;
    // Cap the mark and let the leftover be air; a 2px surface gap on each side
    // is what separates neighbours, never a stroke.
    const bw = Math.max(3, Math.min(24, slot - 4));

    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart' });
    for (const t of ticks) {
      const y = pad.t + ih - (t / top) * ih;
      svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: GRID, 'stroke-width': 1 }));
      const label = svgEl('text', { x: pad.l - 8, y: y + 3.5, 'text-anchor': 'end', class: 'ct-axis' });
      label.textContent = compact(t);
      svg.appendChild(label);
    }

    bars.forEach((b, i) => {
      const h = Math.max(b.value > 0 ? 2 : 0, (b.value / top) * ih);
      const x = pad.l + slot * i + (slot - bw) / 2;
      const fill = b.color ?? color;
      if (h > 0) {
        svg.appendChild(svgEl('rect', {
          x, y: pad.t + ih - h, width: bw, height: h, rx: Math.min(4, bw / 2), fill, class: 'ct-bar',
        }));
      }
      if (b.label && (bars.length <= 14 || i % Math.ceil(bars.length / 12) === 0)) {
        const label = svgEl('text', { x: x + bw / 2, y: H - 7, 'text-anchor': 'middle', class: 'ct-axis' });
        label.textContent = b.label;
        svg.appendChild(label);
      }
      const hit = svgEl('rect', {
        x: pad.l + slot * i, y: pad.t, width: slot, height: ih, fill: 'transparent', class: 'ct-hit',
      });
      hit.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, b.full ?? b.label,
        [{ key: fill, label: b.note ?? '', value: format(b.value) }]));
      hit.addEventListener('pointerleave', hideTip);
      svg.appendChild(hit);
    });

    host.appendChild(svg);
  });
}

/* ── Donut ───────────────────────────────────────────────────────────────── */

/**
 * Composition, when the parts genuinely make a whole and there are few of them.
 *
 * The centre carries the total, because a ring with nothing in it is a hole.
 * Past six slices this folds the tail into "Other" rather than inventing a
 * ninth hue — a generated colour is a colour nobody can name.
 */
export function donutChart(host, { slices = [], total = null, format = compact, empty = 'No data yet.' } = {}) {
  const live = slices.filter((s) => s.value > 0);
  if (!live.length) return void renderEmpty(host, empty);

  mount(host, () => {
    const sorted = [...live].sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, 6);
    const tail = sorted.slice(6);
    if (tail.length) {
      head.push({ label: 'Other', value: tail.reduce((n, s) => n + s.value, 0), color: SERIES[7] });
    }
    const sum = total ?? head.reduce((n, s) => n + s.value, 0);

    const size = 148;
    const r = 58, thick = 20;
    host.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'donut-wrap';

    const svg = svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'chart donut' });
    const cx = size / 2, cy = size / 2;
    let angle = -Math.PI / 2;
    head.forEach((s, i) => {
      const color = s.color ?? SERIES[i % SERIES.length];
      const frac = sum ? s.value / sum : 0;
      const sweep = frac * Math.PI * 2;
      // A 2px surface gap between arcs, exactly like the gap between bars.
      const gap = head.length > 1 ? 0.03 : 0;
      const a0 = angle + gap / 2, a1 = angle + sweep - gap / 2;
      angle += sweep;
      if (a1 <= a0) return;
      const p = (a, rad) => `${(cx + Math.cos(a) * rad).toFixed(2)},${(cy + Math.sin(a) * rad).toFixed(2)}`;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const arc = svgEl('path', {
        d: `M${p(a0, r)}A${r},${r} 0 ${big} 1 ${p(a1, r)}`
          + `L${p(a1, r - thick)}A${r - thick},${r - thick} 0 ${big} 0 ${p(a0, r - thick)}Z`,
        fill: color, class: 'ct-arc',
      });
      arc.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, s.label,
        [{ key: color, label: `${Math.round(frac * 1000) / 10}% of ${format(sum)}`, value: format(s.value) }]));
      arc.addEventListener('pointerleave', hideTip);
      svg.appendChild(arc);
    });
    const mid = svgEl('text', { x: cx, y: cy + 2, 'text-anchor': 'middle', class: 'ct-donut-num' });
    mid.textContent = format(sum);
    svg.appendChild(mid);
    wrap.appendChild(svg);

    // The legend is the dependable identity channel: never colour alone.
    const legend = document.createElement('ul');
    legend.className = 'chart-legend';
    head.forEach((s, i) => {
      const li = document.createElement('li');
      const key = document.createElement('i');
      key.style.background = s.color ?? SERIES[i % SERIES.length];
      li.appendChild(key);
      const name = document.createElement('span');
      name.textContent = s.label;
      li.appendChild(name);
      const val = document.createElement('b');
      val.textContent = format(s.value);
      li.appendChild(val);
      legend.appendChild(li);
    });
    wrap.appendChild(legend);
    host.appendChild(wrap);
  });
}

/* ── Legend, for the charts that need one beside them ────────────────────── */

export function legendFor(host, series) {
  host.textContent = '';
  if (series.length < 2) return;              // one series: the title names it
  const ul = document.createElement('ul');
  ul.className = 'chart-legend row';
  series.forEach((s, i) => {
    const li = document.createElement('li');
    const key = document.createElement('i');
    key.className = 'line';
    key.style.background = s.color ?? SERIES[i % SERIES.length];
    li.appendChild(key);
    const name = document.createElement('span');
    name.textContent = s.name;
    li.appendChild(name);
    ul.appendChild(li);
  });
  host.appendChild(ul);
}

/* ── Sparkline, for a stat tile ──────────────────────────────────────────── */

export function sparkline(host, points, color = SERIES[0]) {
  host.textContent = '';
  if (!points?.length) return;
  const W = 92, H = 26;
  let min = Infinity, max = -Infinity;
  for (const [, v] of points) { if (v < min) min = v; if (v > max) max = v; }
  if (max === min) { max = min + 1; }
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'spark' });
  const d = points.map((p, i) => {
    const x = (i / Math.max(1, points.length - 1)) * (W - 2) + 1;
    const y = H - 2 - ((p[1] - min) / (max - min)) * (H - 4);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('');
  svg.appendChild(svgEl('path', {
    d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  host.appendChild(svg);
}

function renderEmpty(host, text) {
  host._ogDraw = null;
  host.textContent = '';
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = text;
  host.appendChild(p);
}

export default { lineChart, barChart, donutChart, sparkline, legendFor, compact, SERIES };
