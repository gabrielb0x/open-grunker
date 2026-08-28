/**
 * Open Grunker — the colour a profile picture is "about".
 *
 * A player card is painted in its owner's own colour, and the colour it uses by
 * default is pulled out of their profile picture rather than picked from a
 * list: a card that matches the face on it looks like it belongs to somebody,
 * and a card whose owner has never opened the editor still does.
 *
 * The method is deliberately not "average the pixels" — averaging a photograph
 * gives you brown, every time, because the mean of a colour wheel is grey.
 * Instead the picture is shrunk to a thumbnail, its pixels are dropped into
 * coarse hue/saturation/lightness buckets, and each bucket is scored on how
 * much of the picture it covers *and* how colourful it is. That is what makes a
 * red logo on a white field come back red instead of off-white.
 *
 * Avatars are served from this origin, so the canvas is never tainted and
 * `getImageData` is allowed. A picture from anywhere else fails the read, and
 * the caller falls back to the name-derived colour it would have used anyway.
 */

/** Extraction is not free and an avatar URL is content-addressed, so cache it. */
const cache = new Map();
/** In-flight reads, so ten rows drawing the same face do one decode. */
const pending = new Map();

const THUMB = 40;

/** How coarse the buckets are. 24 hue steps is 15° each — a shade, not a tint. */
const HUE_STEPS = 24;
const SAT_STEPS = 4;
const LIGHT_STEPS = 5;

export function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

export function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Reads the picture and returns the hue/saturation/lightness it is built on.
 *
 * Fully transparent pixels are skipped and near-black and near-white ones are
 * scored down rather than dropped: a picture that really is a white square
 * should still come back white, it just should not beat the one splash of
 * colour in a picture that has one.
 */
function dominantFrom(imageData) {
  const { data } = imageData;
  const buckets = new Map();
  let best = null;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);

    const hi = Math.min(HUE_STEPS - 1, Math.floor(h * HUE_STEPS));
    const si = Math.min(SAT_STEPS - 1, Math.floor(s * SAT_STEPS));
    const li = Math.min(LIGHT_STEPS - 1, Math.floor(l * LIGHT_STEPS));
    const key = (hi * SAT_STEPS + si) * LIGHT_STEPS + li;

    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { n: 0, h: 0, s: 0, l: 0, hx: 0, hy: 0 }));
    bucket.n++;
    // Hue is an angle, so it is averaged on the circle. Averaging the number
    // makes 350° and 10° meet at 180°, which is the wrong side of the wheel.
    bucket.hx += Math.cos(h * Math.PI * 2);
    bucket.hy += Math.sin(h * Math.PI * 2);
    bucket.s += s;
    bucket.l += l;
  }

  for (const bucket of buckets.values()) {
    const s = bucket.s / bucket.n;
    const l = bucket.l / bucket.n;
    // Coverage decides most of it; being colourful is worth a lot on top, and
    // sitting at either end of the lightness range costs you.
    const usable = 1 - Math.abs(l - 0.5) * 1.35;
    const score = bucket.n * (0.35 + s * 1.9) * Math.max(0.08, usable);
    if (!best || score > best.score) {
      best = {
        score,
        h: (Math.atan2(bucket.hy, bucket.hx) / (Math.PI * 2) + 1) % 1,
        s,
        l,
      };
    }
  }
  return best;
}

/**
 * The card colour for one picture: a hex string, or null if it cannot be read.
 *
 * The result is pushed towards something a card can actually be painted in —
 * a nearly-grey picture would otherwise hand back a colour that reads as a
 * rendering fault, and a neon one would hand back something nothing is legible
 * against. Both ends are clamped rather than rejected, so every picture gets a
 * colour and none of them get an unusable one.
 *
 * @param {string} url same-origin image URL
 * @returns {Promise<string|null>}
 */
export function avatarAccent(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (pending.has(url)) return pending.get(url);

  const job = (async () => {
    try {
      const img = new Image();
      // Same-origin in practice, but asking keeps a CDN-served avatar readable
      // instead of silently tainting the canvas.
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = url;
      await (img.decode ? img.decode() : new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('image failed'));
      }));

      const canvas = document.createElement('canvas');
      canvas.width = THUMB;
      canvas.height = THUMB;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, THUMB, THUMB);
      const found = dominantFrom(ctx.getImageData(0, 0, THUMB, THUMB));
      if (!found) return null;

      const s = Math.max(0.34, Math.min(0.9, found.s * 1.18));
      const l = Math.max(0.4, Math.min(0.66, found.l * 0.9 + 0.12));
      return hslToHex(found.h, s, l);
    } catch {
      // A tainted canvas, a 404, a format the browser will not decode. All of
      // them mean the same thing to the caller: use the fallback.
      return null;
    }
  })();

  pending.set(url, job);
  job.then((hex) => { cache.set(url, hex); }).finally(() => pending.delete(url));
  return job;
}

/**
 * The same answer for an account with no picture: a stable colour from the
 * name, so a card without a photograph is still that player's card and not a
 * grey one shared with everybody else.
 */
export function nameAccent(name) {
  const label = String(name || 'G');
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return hslToHex((h % 360) / 360, 0.58, 0.52);
}

export default avatarAccent;
