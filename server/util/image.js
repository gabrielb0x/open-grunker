/**
 * Open Grunker — image sniffing for uploaded profile pictures.
 *
 * There is no image library on this server and no intention of adding one: an
 * avatar is stored exactly as it arrives. That makes *reading the header
 * ourselves* the only thing standing between the disk and whatever a client
 * felt like sending, so this module answers two questions from the bytes alone
 * — what is this really, and how big is it — and the upload route refuses
 * anything it cannot answer for.
 *
 * The declared content-type is never trusted. It is a hint from the sender;
 * the magic bytes are the fact.
 */

/** What may be stored, mapped to the extension it is saved under. */
export const ACCEPTED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const be16 = (b, i) => (b[i] << 8) | b[i + 1];
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** PNG: an 8-byte signature, then IHDR carries the two dimensions. */
function png(buf) {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { type: 'image/png', width: be32(buf, 16), height: be32(buf, 20) };
}

/**
 * JPEG: no fixed header, so the segment chain is walked to the first frame
 * marker. Anything that runs off the end of the buffer is malformed, not an
 * image, and is refused rather than guessed at.
 */
function jpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }              // resync over fill bytes
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    // Standalone markers carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = be16(buf, i + 2);
    if (len < 2) return null;
    // SOF0-SOF15, minus the three that are not frame headers (DHT, JPG, DAC).
    const isFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 >= buf.length) return null;
      return { type: 'image/jpeg', height: be16(buf, i + 5), width: be16(buf, i + 7) };
    }
    if (marker === 0xda) return null;                    // scan data, no frame seen
    i += 2 + len;
  }
  return null;
}

/**
 * WebP: three sub-formats behind one RIFF container, and each one puts its
 * dimensions somewhere else. All three are accepted — the client encodes to
 * lossy VP8, but a picture dropped in from elsewhere may be any of them.
 */
function webp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('latin1', 12, 16);

  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte frame tag, the 3-byte start code, then 14-bit dimensions.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      type: 'image/webp',
      width: (buf[26] | (buf[27] << 8)) & 0x3fff,
      height: (buf[28] | (buf[29] << 8)) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
    return {
      type: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X') {
    // Extended (animation, alpha, ICC): the canvas size is stored minus one.
    return { type: 'image/webp', width: le24(buf, 24) + 1, height: le24(buf, 27) + 1 };
  }
  return null;
}

/**
 * What these bytes actually are.
 * @param {Buffer} buf
 * @returns {{type: string, width: number, height: number}|null} null when the
 *   buffer is not one of the accepted formats, or is too damaged to measure.
 */
export function identify(buf) {
  if (!buf || buf.length < 16) return null;
  const hit = png(buf) ?? jpeg(buf) ?? webp(buf);
  if (!hit) return null;
  if (!Number.isFinite(hit.width) || !Number.isFinite(hit.height)) return null;
  if (hit.width < 1 || hit.height < 1) return null;
  return hit;
}

/**
 * Is this buffer storable as somebody's profile picture?
 *
 * @param {Buffer} buf raw upload
 * @param {{maxBytes:number, maxDimension:number, minDimension?:number}} limits
 * @returns {{ok: true, type: string, ext: string, width: number, height: number}
 *          |{ok: false, code: string, message: string}}
 */
export function validateAvatar(buf, { maxBytes, maxDimension, minDimension = 16 }) {
  if (!buf?.length) {
    return { ok: false, code: 'empty_upload', message: 'no image was sent' };
  }
  if (buf.length > maxBytes) {
    return {
      ok: false,
      code: 'image_too_large',
      message: `that picture is ${Math.ceil(buf.length / 1024)} KB — the limit is ${Math.floor(maxBytes / 1024)} KB`,
    };
  }
  const info = identify(buf);
  if (!info) {
    return {
      ok: false,
      code: 'unsupported_image',
      message: 'that file is not a PNG, JPEG or WebP image',
    };
  }
  const ext = ACCEPTED[info.type];
  if (!ext) {
    return { ok: false, code: 'unsupported_image', message: `${info.type} pictures are not accepted` };
  }
  if (info.width > maxDimension || info.height > maxDimension) {
    return {
      ok: false,
      code: 'image_too_big',
      message: `that picture is ${info.width}×${info.height} — the limit is ${maxDimension}×${maxDimension}`,
    };
  }
  if (info.width < minDimension || info.height < minDimension) {
    return {
      ok: false,
      code: 'image_too_small',
      message: `that picture is ${info.width}×${info.height} — at least ${minDimension}×${minDimension} please`,
    };
  }
  return { ok: true, type: info.type, ext, width: info.width, height: info.height };
}

export default { identify, validateAvatar, ACCEPTED };
