/**
 * Open Grunker — anthem storage.
 *
 * One levelled WAV per music creator, on the same machinery as a profile
 * picture (util/filestore.js): named after a hash of its own bytes, one per
 * owner, replaced by sweeping the old one away.
 *
 * The content hash matters more here than it does for a picture. An anthem is
 * fetched by whoever the creator just killed, in the middle of a match, at the
 * moment the kill cam wants it — so it has to come out of the browser's cache
 * the second time and every time after. A name that changes only when the bytes
 * change is what makes a one-year immutable cache header honest.
 *
 * Nothing reaches this store that server/util/audio.js has not measured and
 * rewritten, which is what makes it safe to serve these back at whatever volume
 * the listener has set.
 *
 * ── Why an audio file is served from under /avatars/ ────────────────────────
 *
 * Because that is where new kinds of user content go, and the reason is written
 * down in util/avatar.js next to `clanAvatars`: the nginx vhost proxies
 * `^~ /avatars/` wholesale, and `^~` stops nginx before its regex locations —
 * so everything under that prefix reaches this server, including a path nginx
 * has never heard of. A prefix of its own would fall through to the
 * static-asset regex instead, be looked for under the client root, and 404 on
 * every deployment whose nginx config had not been reinstalled.
 *
 * Serving a new kind of user content must not require an nginx change. The
 * prefix reads oddly for a sound file; a silent 404 on somebody else's server
 * reads worse.
 */
import createStore from './filestore.js';
import config from '../config.js';

/** Mono 16-bit PCM in a RIFF wrapper. There is deliberately only one. */
const ANTHEM_TYPES = { wav: 'audio/wav' };

export const anthems = createStore(() => config.anthemDir, '/avatars/anthems', ANTHEM_TYPES);

export const { save, remove, pathFor, urlFor, mimeFor, usage, FILE_RE } = anthems;

export default { save, remove, pathFor, urlFor, mimeFor, usage, FILE_RE };
