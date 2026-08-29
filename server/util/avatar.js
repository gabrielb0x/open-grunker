/**
 * Open Grunker — picture storage for accounts and for clans.
 *
 * Two stores over the same machinery — see util/filestore.js, which owns the
 * naming rule, the traversal guard and the sweep-on-replace that both of these
 * and the anthem store share. A clan picture is user content with exactly the
 * same shape and exactly the same risks as an account's, so it gets exactly the
 * same handling rather than a second, subtly different implementation of it.
 *
 * What lives here is only what is specific to pictures: which three formats are
 * storable, and which two directories they go in.
 */
import createStore from './filestore.js';
import config from '../config.js';

/** What may be stored, and what each is served as. */
const PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/* ── The two stores ──────────────────────────────────────────────────────── */

/**
 * Clan pictures: `/avatars/clans/<file>`, stored under data/clans.
 *
 * A *sub-path* of the account prefix rather than a prefix of its own, and that
 * is deliberate. The nginx vhost proxies `^~ /avatars/`, and `^~` tells nginx
 * to stop before its regex locations — so everything under that prefix reaches
 * this server, including a path it has never heard of. A separate
 * `/clan-avatars/` prefix instead fell straight through to the static-image
 * regex, which looked for the file under the client root and 404'd every clan
 * picture on any deployment whose nginx config had not been reinstalled.
 *
 * Serving a new kind of user content must not require an nginx change.
 */
export const clanAvatars = createStore(() => config.clanAvatarDir, '/avatars/clans', PICTURE_TYPES);

const accounts = createStore(() => config.avatarDir, '/avatars', PICTURE_TYPES);

/*
 * Account pictures keep their flat exports: they are `avatars.save(...)` in a
 * dozen callers, and renaming those would be churn for nothing.
 */
export const { save, remove, pathFor, urlFor, mimeFor, usage, FILE_RE } = accounts;

export default { save, remove, pathFor, urlFor, mimeFor, usage, FILE_RE, clanAvatars };
