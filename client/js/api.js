/** Open Grunker — REST client for /api/v1. */

import { API_VERSION } from '/shared/constants.js';

const BASE = `/api/${API_VERSION}`;
const TOKEN_KEY = 'og.token';

export let token = localStorage.getItem(TOKEN_KEY) || null;
export let account = null;
/** Weapon mastery and today's challenges, refreshed alongside the account. */
export let mastery = {};
export let challenges = null;
/**
 * Address-verification state for the signed-in account:
 * `{ required, enforced, verified, email }`, or null when signed out.
 */
export let verification = null;
/**
 * What this account may open in developer mode: `{ allowed, pro, need, panels }`.
 *
 * Answered by the server and never worked out here — it is a level plus a
 * creator status, both of which live over there. Restored with the session so
 * the rail entry exists from the menu rather than only after a match.
 */
export let devAccess = null;

function setToken(t) {
  token = t || null;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}

/** Thrown for any non-2xx response; `code` is the machine-readable API error. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(BASE + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch (err) {
    throw new ApiError(0, 'network', 'cannot reach the server');
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok || data?.ok === false) {
    throw new ApiError(res.status, data?.error ?? 'http_error', data?.message ?? data?.error);
  }
  return data ?? {};
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  del: (p) => request('DELETE', p),

  health: () => request('GET', '/health'),
  meta: () => request('GET', '/meta'),
  servers: () => request('GET', '/servers'),
  globalStats: () => request('GET', '/stats/global'),
  leaderboard: (sort = 'kills', limit = 50) => request('GET', `/leaderboard?sort=${encodeURIComponent(sort)}&limit=${limit}`),
  player: (name) => request('GET', `/players/${encodeURIComponent(name)}`),
  loadout: () => request('GET', '/loadout'),
  matches: (name, limit = 10) => request('GET', `/players/${encodeURIComponent(name)}/matches?limit=${limit}`),

  /** @param {string} [turnstileToken] the solved challenge from the sign-up widget */
  async register(username, password, email, turnstileToken) {
    const r = await request('POST', '/auth/register', {
      username, password, email: email || undefined, turnstileToken,
    });
    setToken(r.token);
    account = r.user;
    verification = r.verification ?? null;
    // A sign-up whose confirmation mail bounced still made the account; the
    // caller shows this so the player knows to press "resend" rather than
    // assume the address was wrong.
    return { user: r.user, verification, reward: r.reward ?? null, mailError: r.mailError ?? null };
  },

  /**
   * @param {string} [turnstileToken] the solved challenge from the sign-in widget
   * @param {string} [code] the second factor — six digits, or a recovery code
   * @throws {ApiError} with `code === 'totp_required'` when the account has
   *   two-factor on and no code was given. That is not a failure to sign in; it
   *   is the form's cue to ask the second question.
   */
  async login(username, password, turnstileToken, code) {
    const r = await request('POST', '/auth/login', {
      username, password, turnstileToken, code: code || undefined,
    });
    setToken(r.token);
    account = r.user;
    verification = r.verification ?? null;
    return r.user;
  },

  async logout() {
    try { await request('POST', '/auth/logout'); } catch { /* token may already be gone */ }
    setToken(null);
    account = null;
    verification = null;
  },

  /** Spends the token from a confirmation link. Works signed out. */
  verifyEmail(verifyToken) { return request('POST', '/auth/verify', { token: verifyToken }); },

  /** Asks for a fresh confirmation link. */
  resendVerification() { return request('POST', '/auth/verify/resend'); },

  /** Corrects the address on the account, which sends a new link to it. */
  async changeEmail(email, password) {
    const r = await request('POST', '/auth/email', { email, password });
    verification = r.verification ?? verification;
    if (account) account.email = r.email;
    return r;
  },

  /* ── Two-factor authentication ─────────────────────────────────────────
     The secret is drawn here, shown as a QR code, and only becomes real once a
     code derived from it has been checked — so a setup card that is opened and
     abandoned leaves the account exactly as it was. ──────────────────────── */

  /** A fresh secret and the `otpauth://` URI behind the QR code. Stores nothing. */
  totpSetup: () => request('POST', '/auth/totp/setup'),

  /** Turns it on. Resolves to the recovery codes, which are shown exactly once. */
  async totpEnable(secret, code, password) {
    const r = await request('POST', '/auth/totp/enable', { secret, code, password });
    account = r.user ?? account;
    return r.recovery ?? [];
  },

  async totpDisable(password, code) {
    const r = await request('POST', '/auth/totp/disable', { password, code });
    account = r.user ?? account;
    return r;
  },

  /** A new set of recovery codes. The old ones stop working immediately. */
  async totpRecovery(password, code) {
    const r = await request('POST', '/auth/totp/recovery', { password, code });
    return r.recovery ?? [];
  },

  totpState: () => request('GET', '/auth/totp'),

  /** Buys a new nickname. Costs GR unless it is only a change of spelling. */
  async changeUsername(username) {
    const r = await request('POST', '/auth/username', { username });
    account = r.user;
    return r;
  },

  /** Restores the session on page load; resolves to null when signed out. */
  async me() {
    if (!token) {
      account = null; mastery = {}; challenges = null; verification = null; devAccess = null;
      return null;
    }
    try {
      const r = await request('GET', '/auth/me');
      account = r.user;
      if (r.wardrobe) account.wardrobe = r.wardrobe;
      mastery = r.mastery ?? {};
      challenges = r.challenges ?? null;
      verification = r.verification ?? null;
      devAccess = r.dev ?? null;
      return r.user;
    } catch (err) {
      if (err.status === 401) setToken(null);
      account = null;
      mastery = {};
      challenges = null;
      verification = null;
      devAccess = null;
      return null;
    }
  },

  /**
   * Live view of the module's own session state.
   *
   * Without these the object simply had no `token` or `account` property, so
   * every `api.token` in the client read `undefined` — which meant the realtime
   * handshake never carried the session. Everyone connected as a guest, and
   * nothing that needs an account (stats, GR, XP, mastery, dailies, the
   * verified badge, equipped skins) was ever recorded or shown.
   */
  get token() { return token; },
  get account() { return account; },

  /** Mastery and challenge state, without re-fetching the whole account. */
  get mastery() { return mastery; },
  get challenges() { return challenges; },
  get verification() { return verification; },

  /** Signed in, but the address on the account has not been confirmed yet. */
  get needsVerification() {
    return !!account && !!verification?.enforced && !verification.verified;
  },

  async refreshProgress() {
    if (!token) return null;
    try {
      const [m, c] = await Promise.all([request('GET', '/mastery'), request('GET', '/challenges')]);
      mastery = m.mastery ?? {};
      challenges = c ?? null;
      return { mastery, challenges };
    } catch { return null; }
  },

  /**
   * Changes the password and signs every session out (including this one).
   *
   * `code` is the second factor, required when the account has one: signing
   * every device out is what turns a borrowed session into a stolen account,
   * so it is the one password-protected action that also costs a code.
   */
  async changePassword(current, next, code) {
    const r = await request('POST', '/auth/password', { current, next, code: code || undefined });
    setToken(null);
    account = null;
    return r;
  },

  /**
   * Replaces the account's profile picture.
   *
   * The blob has already been squared, scaled and re-encoded by the picker —
   * see menu.js — so this posts the bytes as they are, with no form and no
   * base64 envelope. The server measures them again anyway.
   * @param {Blob} blob
   */
  async uploadAvatar(blob) {
    if (!token) throw new ApiError(401, 'unauthorized', 'sign in first');
    let res;
    try {
      res = await fetch(`${BASE}/avatar`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'application/octet-stream', authorization: `Bearer ${token}` },
        body: blob,
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'network', 'cannot reach the server');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok || data?.ok === false) {
      throw new ApiError(res.status, data?.error ?? 'upload_failed', data?.message ?? data?.error);
    }
    if (data?.user) account = data.user;
    return data;
  },

  /** Drops the picture and goes back to the initials. */
  async removeAvatar() {
    const r = await request('DELETE', '/avatar');
    if (r?.user) account = r.user;
    return r;
  },

  /** Every report this account has filed, and what a moderator made of each. */
  myReports() { return request('GET', '/reports/mine'); },

  /* ── Creators ──────────────────────────────────────────────────────────── */

  /** The whole CREATOR tab in one request: rules, standing, briefs, dev access. */
  creator() { return request('GET', '/creator'); },

  /** @param {{kind:string, pitch:string, links:Array<{platform:string,handle:string}>}} body */
  applyAsCreator(body) { return request('POST', '/creator/apply', body); },

  /** Withdraws a pending application, or resigns an approved status. */
  resignCreator() { return request('DELETE', '/creator'); },

  setCreatorLinks(links) { return request('PUT', '/creator/links', { links }); },

  /**
   * Uploads an anthem.
   *
   * Posts the WAV bytes as they are, with no form and no base64 envelope —
   * exactly like an avatar, and for the same reason: the server is going to
   * read the header itself either way, so wrapping the bytes in anything only
   * costs a third more of them on the wire.
   *
   * The title rides in the query string rather than the body because the body
   * *is* the file. Sending it as a header would work too, and would put a
   * user-typed string somewhere far more surprising.
   *
   * @param {ArrayBuffer} wav mono 16-bit PCM — see encodeWav in menu.js
   * @param {string} title
   */
  async uploadAnthem(wav, title = '') {
    if (!token) throw new ApiError(401, 'unauthorized', 'sign in first');
    let res;
    try {
      res = await fetch(`${BASE}/creator/anthem?title=${encodeURIComponent(title.slice(0, 64))}`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', authorization: `Bearer ${token}` },
        body: wav,
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'network', 'cannot reach the server');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok || data?.ok === false) {
      throw new ApiError(res.status, data?.error ?? 'upload_failed', data?.message ?? data?.error);
    }
    return data ?? {};
  },

  removeAnthem() { return request('DELETE', '/creator/anthem'); },
  renameAnthem(title) { return request('PUT', '/creator/anthem', { title }); },

  skinRequests() { return request('GET', '/creator/skin-requests'); },
  fileSkinRequest(body) { return request('POST', '/creator/skin-requests', body); },
  withdrawSkinRequest(id) { return request('DELETE', `/creator/skin-requests/${encodeURIComponent(id)}`); },

  /* ── Friends ───────────────────────────────────────────────────────────── */

  /**
   * The list, both request queues and who is online, in one request.
   *
   * Every one of these returns the same whole payload rather than the row it
   * changed, because a friend list is a live thing — accepting a request moves
   * a name from one column to another and may bring a room code with it, and
   * two round trips to draw that is a panel that flickers.
   */
  friends() { return request('GET', '/friends'); },
  addFriend: (username) => request('POST', '/friends/requests', { username }),
  acceptFriend: (id) => request('POST', `/friends/requests/${encodeURIComponent(id)}/accept`, {}),
  /** Declining theirs and cancelling ours are the same row, so the same call. */
  dropFriendRequest: (id) => request('DELETE', `/friends/requests/${encodeURIComponent(id)}`),
  removeFriend: (id) => request('DELETE', `/friends/${encodeURIComponent(id)}`),

  /* ── The profile card, and who it is for ───────────────────────────────
     The card is styling and the privacy answers are not, so they save
     separately — a player fiddling with a colour must never be able to
     accidentally publish something they had closed. ─────────────────────── */

  /** This account's card, its privacy answers and everything pickable. */
  social() { return request('GET', '/profile/social'); },

  /** Saves the styling. Resolves to the card as the server actually stored it. */
  async saveCard(card) {
    const r = await request('PUT', '/profile/card', { card });
    if (account) account.card = r.card;
    return r.card;
  },

  /** Saves the answers. Same contract: what comes back is what is now true. */
  async savePrivacy(privacy) {
    const r = await request('PUT', '/profile/privacy', { privacy });
    if (account) account.privacy = r.privacy;
    return r.privacy;
  },

  /* ── Clans ─────────────────────────────────────────────────────────────── */

  /**
   * This account's clan, its outstanding invitations and what it may do — one
   * request, because the clan panel cannot draw anything without all three.
   */
  myClan() { return request('GET', '/clans/mine'); },
  clans(q = '', limit = 40) {
    return request('GET', `/clans?q=${encodeURIComponent(q)}&limit=${limit}`);
  },
  clan(tag) { return request('GET', `/clans/${encodeURIComponent(tag)}`); },

  /** Founding one. Costs level and GR; the server is what actually checks. */
  async createClan(tag) {
    const r = await request('POST', '/clans', { tag });
    if (account) { account.gr = r.gr ?? account.gr; account.clan = r.clan?.tag ?? account.clan; }
    return r;
  },

  inviteToClan: (tag, username) => request('POST', `/clans/${encodeURIComponent(tag)}/invites`, { username }),
  cancelClanInvite: (tag, username) =>
    request('DELETE', `/clans/${encodeURIComponent(tag)}/invites/${encodeURIComponent(username)}`),
  joinClan: (tag) => request('POST', `/clans/${encodeURIComponent(tag)}/join`, {}),
  declineClan: (tag) => request('POST', `/clans/${encodeURIComponent(tag)}/decline`, {}),
  leaveClan: (tag) => request('POST', `/clans/${encodeURIComponent(tag)}/leave`, {}),
  kickFromClan: (tag, username) =>
    request('DELETE', `/clans/${encodeURIComponent(tag)}/members/${encodeURIComponent(username)}`),
  transferClan: (tag, username) =>
    request('POST', `/clans/${encodeURIComponent(tag)}/transfer`, { username }),
  disbandClan: (tag) => request('DELETE', `/clans/${encodeURIComponent(tag)}`),

  /**
   * Replaces the clan's picture. Same shape as an account avatar: the blob has
   * already been squared and re-encoded by the picker, so this posts the bytes
   * as they are and lets the server measure them again.
   * @param {Blob} blob
   */
  async uploadClanAvatar(tag, blob) {
    if (!token) throw new ApiError(401, 'unauthorized', 'sign in first');
    let res;
    try {
      res = await fetch(`${BASE}/clans/${encodeURIComponent(tag)}/avatar`, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'application/octet-stream', authorization: `Bearer ${token}` },
        body: blob,
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'network', 'cannot reach the server');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok || data?.ok === false) {
      throw new ApiError(res.status, data?.error ?? 'upload_failed', data?.message ?? data?.error);
    }
    return data;
  },

  removeClanAvatar: (tag) => request('DELETE', `/clans/${encodeURIComponent(tag)}/avatar`),

  async saveLoadout(payload) {
    if (!token) return null;
    const r = await request('PUT', '/loadout', payload);
    if (account) {
      account.loadout = r.loadout;
      if (r.wardrobe) account.wardrobe = r.wardrobe;
    }
    return r.loadout;
  },

  /* ── The wardrobe ────────────────────────────────────────────────────────
   *
   * Every one of these hands back the whole wardrobe rather than a delta, and
   * every one of them stores it on the account. That is deliberate: an
   * economy has half a dozen ways to change what you own — a case, a purchase,
   * a sale, a trade somebody else accepted, a moderator's revoke — and a
   * client that patched its own copy after each of them would drift out of
   * step with the server on the first one it did not think of. One shape
   * arrives, one shape is stored, and the screen redraws from it.
   */

  /** Adopts a wardrobe from any response that carried one. */
  _wardrobe(r) {
    if (account && r?.wardrobe) {
      account.wardrobe = r.wardrobe;
      account.gr = r.wardrobe.gr ?? r.gr ?? account.gr;
    }
    return r;
  },

  get wardrobe() { return account?.wardrobe ?? null; },

  async loadWardrobe() {
    if (!token) return null;
    return (await api._wardrobe(await request('GET', '/wardrobe'))).wardrobe;
  },

  /** Buys one item outright at catalogue price. */
  async buyItem(itemId) {
    return api._wardrobe(await request('POST', '/shop/buy', { itemId }));
  },

  /** Kept so an older cached bundle can still buy a primary finish by name. */
  buySkin(skinId) { return api.buyItem(`primary:${skinId}`); },

  /** Hands a duplicate back to the game for a fraction of its worth. */
  async scrap(unitId) {
    return api._wardrobe(await request('POST', '/wardrobe/scrap', { unitId }));
  },

  /* ── Cases ─────────────────────────────────────────────────────────────── */

  async openCase(caseId) {
    return api._wardrobe(await request('POST', '/cases/open', { caseId }));
  },
  recentDrops: (limit = 24) => request('GET', `/cases/recent?limit=${limit | 0}`),
  caseHistory: () => request('GET', '/cases/history'),

  /* ── The market ────────────────────────────────────────────────────────── */

  marketBoard(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, String(v));
    return request('GET', `/market?${q.toString()}`);
  },
  marketItem: (itemId) => request('GET', `/market/item?id=${encodeURIComponent(itemId)}`),
  marketMine: () => request('GET', '/market/mine'),
  async marketList(unitId, price) {
    return api._wardrobe(await request('POST', '/market/list', { unitId, price }));
  },
  async marketCancel(listingId) {
    return api._wardrobe(await request('POST', '/market/cancel', { listingId }));
  },
  async marketBuy(listingId) {
    return api._wardrobe(await request('POST', '/market/buy', { listingId }));
  },

  /* ── Trades ────────────────────────────────────────────────────────────── */

  trades: () => request('GET', '/trades'),
  offerTrade: (offer) => request('POST', '/trades', offer),
  async acceptTrade(id) {
    return api._wardrobe(await request('POST', '/trades/accept', { id }));
  },
  async closeTrade(id) {
    return api._wardrobe(await request('POST', '/trades/close', { id }));
  },

  get isAuthed() { return !!token && !!account; },
};

export default api;
