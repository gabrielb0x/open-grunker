/**
 * Open Grunker — admin panel.
 *
 * Talks to /api/v1/admin, which only answers requests that arrived on loopback
 * without proxy headers. The token lives in sessionStorage, so closing the tab
 * ends the session.
 */

import { lineChart, barChart, donutChart, sparkline, legendFor, compact, SERIES } from './charts.js';

const API = '/api/v1/admin';
const TOKEN_KEY = 'og.admin.token';

const $ = (id) => document.getElementById(id);
/**
 * A UUID is the id, but nobody reads one off a screen. Rows and headings show
 * the first block; the full value stays in `data-id` and in every request, and
 * hangs off the element's title for anyone who needs to copy it.
 */
const shortId = (id) => (id ? String(id).split('-')[0] : '—');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let page = 0, pageSize = 25, total = 0;
let selected = null;
let logTimer = null, lastLogId = 0;
/* The reports queue keeps its own paging and selection. */
let rPage = 0, rTotal = 0, rSelected = null;
/* So does the clan list. */
let cSelected = null;
/* The stats tab: one window, one timer, shared by every card on the page. */
let statHours = 24, statTimer = null, statBusy = false;

/* ── Transport ───────────────────────────────────────────────────────────── */

async function call(method, path, body) {
  const headers = { 'x-admin-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok || data?.ok === false) {
    if (res.status === 401) signOut();
    throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  }
  return data ?? {};
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast-item ${kind}`;
  el.textContent = message;
  $('toast').appendChild(el);
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 350); }, 2800);
}

/* ── Session ─────────────────────────────────────────────────────────────── */

function signOut() {
  token = '';
  sessionStorage.removeItem(TOKEN_KEY);
  clearInterval(logTimer);
  $('app').classList.add('hidden');
  $('gate').classList.remove('hidden');
}

$('gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('gateMsg');
  msg.classList.add('hidden');
  try {
    const password = new FormData(e.target).get('password');
    const res = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || data.error || 'sign-in failed');
    token = data.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    e.target.reset();
    start();
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.remove('hidden');
  }
});

$('btnSignOut').addEventListener('click', () => {
  call('POST', '/logout').catch(() => {});
  signOut();
});

/* ── Tabs ────────────────────────────────────────────────────────────────── */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.panel')) {
      p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
    }
    if (tab.dataset.tab === 'logs') loadLogs(true);
    if (tab.dataset.tab === 'reports') loadReports();
    if (tab.dataset.tab === 'clans') loadClans();
    if (tab.dataset.tab === 'stats') loadStats();
  });
}

/* ── Overview ────────────────────────────────────────────────────────────── */

async function loadOverview() {
  try {
    const o = await call('GET', '/overview');
    /** Fills one header tile: the figure, then the caption under it. */
    const tile = (id, value, label) => {
      const el = $(id);
      if (!el) return;
      el.querySelector('b').textContent = value;
      el.querySelector('small').textContent = label;
    };
    tile('statOnline', o.online, 'ONLINE');
    tile('statUsers', o.db.users, 'ACCOUNTS');
    tile('statClans', o.db.clans ?? 0, 'CLANS');
    const h = Math.floor(o.uptime / 3600), m = Math.floor((o.uptime % 3600) / 60);
    tile('statUptime', h >= 1 ? `${h}h ${m}m` : `${m}m`, `${o.memoryMb} MB`);
    setReportBadge(o.openReports ?? 0);
  } catch { /* the toast on the failing action is enough */ }
}

/* ── Players ─────────────────────────────────────────────────────────────── */

async function loadPlayers() {
  const q = $('search').value.trim();
  const sort = $('sort').value;
  try {
    const res = await call('GET',
      `/players?q=${encodeURIComponent(q)}&limit=${pageSize}&offset=${page * pageSize}&sort=${sort}`);
    total = res.total;
    $('playerCount').textContent = `${res.total} account${res.total === 1 ? '' : 's'}`;
    $('pageInfo').textContent = `${Math.min(total, page * pageSize + 1)}–${Math.min(total, (page + 1) * pageSize)} of ${total}`;
    $('btnPrev').disabled = page === 0;
    $('btnNext').disabled = (page + 1) * pageSize >= total;

    $('playerRows').innerHTML = res.players.map((p) => `
      <tr data-id="${p.id}" class="${selected?.id === p.id ? 'sel' : ''}">
        <td title="${p.id}">${shortId(p.id)}</td>
        <td><span class="p-name">${esc(p.username)}
          ${p.verified ? '<img src="/check.png" width="13" height="13" alt="verified">' : ''}
          ${p.clan ? `<span class="p-clan">[${esc(p.clan)}]</span>` : ''}</span></td>
        <td>${p.level}</td>
        <td>${p.gr}</td>
        <td>${p.stats.kd}</td>
        <td>${statusTag(p)}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No accounts match.</td></tr>';

    for (const row of $('playerRows').querySelectorAll('tr[data-id]')) {
      row.addEventListener('click', () => selectPlayer(row.dataset.id));
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

const statusTag = (p) => (p.banned
  ? '<span class="tag ban">BANNED</span>'
  : p.role !== 'player' ? `<span class="tag admin">${p.role.toUpperCase()}</span>`
    : '<span class="tag ok">ACTIVE</span>');

async function selectPlayer(id) {
  try {
    const res = await call('GET', `/players/${id}`);
    selected = res.player;
    renderDetail(res);
    for (const row of $('playerRows').querySelectorAll('tr[data-id]')) {
      row.classList.toggle('sel', row.dataset.id === id);
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function renderDetail({ player: p, matches, sessions, liveIps = [], reports = null }) {
  $('detailEmpty').classList.add('hidden');
  const body = $('detailBody');
  body.classList.remove('hidden');

  const s = p.stats;
  const openAgainst = (reports?.against ?? []).filter((r) => r.status === 'open').length;
  body.innerHTML = `
    <div class="subject">
      ${p.avatar
        ? `<img class="pic" src="${esc(p.avatar)}" alt="">`
        : `<div class="pic letter">${esc(p.username[0].toUpperCase())}</div>`}
      <div class="who"><b>${esc(p.username)}</b>
        ${p.verified ? '<img src="/check.png" width="15" height="15" alt="verified">' : ''}
        ${p.clan ? `<span class="p-clan">[${esc(p.clan)}]</span>` : ''}
        <div>${p.avatar ? 'has a profile picture' : 'no profile picture'}</div></div>
    </div>
    <div class="sub" title="${p.id}">#${shortId(p.id)} · joined ${fmtDate(p.createdAt)} · last seen ${fmtDate(p.lastLogin)}
      · ${sessions} active session${sessions === 1 ? '' : 's'} · ${esc(p.lastIp ?? 'no ip')}${
        liveIps?.length ? ` · online from ${esc(liveIps.join(', '))}` : ''}</div>

    <h3>ACCOUNT</h3>
    <div class="field"><label>USERNAME</label><input id="fName" value="${esc(p.username)}" maxlength="16"></div>
    <div class="field"><label>EMAIL</label><input id="fEmail" value="${esc(p.email ?? '')}" placeholder="none"></div>
    <div class="field inline"><label>EMAIL CONFIRMED</label>
      <input type="checkbox" id="fEmailVerified" ${p.emailVerified ? 'checked' : ''}></div>
    <div class="field"><label>CLAN</label>
      <span style="font-size:12px">${p.clan
    ? `<button class="linkish" id="btnOpenClan"><span class="p-clan${p.clanVerified ? ' gold' : ''}">[${
      esc(p.clan)}]</span></button>${p.clanVerified ? ' verified' : ''}`
    : 'none'}</span></div>
    ${p.clan ? `<div class="hint">A clan tag is a membership row, not a free-text field:
      it is set by joining a clan and cleared by leaving one. Removing this account from its
      clan strips the tag everywhere, including from the match they are in right now.</div>
      <div class="row"><button class="btn" id="btnLeaveClan">REMOVE FROM CLAN</button></div>` : ''}
    <div class="field"><label>ROLE</label><select id="fRole">
      ${['player', 'mod', 'admin'].map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}
    </select></div>
    <div class="field inline"><label>VERIFIED</label>
      <input type="checkbox" id="fVerified" ${p.verified ? 'checked' : ''}></div>

    <h3>PROGRESSION</h3>
    <div class="field"><label>GR</label><input id="fGr" type="number" min="0" value="${p.gr}"></div>
    <div class="field"><label>LEVEL</label><input id="fLevel" type="number" min="1" max="999" value="${p.level}"></div>
    <div class="field"><label>XP</label><input id="fXp" type="number" min="0" value="${p.xp}"></div>

    <h3>STATS</h3>
    <div class="grid2">
      ${statField('fKills', 'KILLS', s.kills)}
      ${statField('fDeaths', 'DEATHS', s.deaths)}
      ${statField('fAssists', 'ASSISTS', s.assists)}
      ${statField('fHeadshots', 'HEADSHOTS', s.headshots)}
      ${statField('fWins', 'WINS', s.wins)}
      ${statField('fLosses', 'LOSSES', s.losses)}
      ${statField('fMatches', 'MATCHES', s.matches)}
      ${statField('fScore', 'SCORE', s.score)}
      ${statField('fDamage', 'DAMAGE', s.damage)}
      ${statField('fStreak', 'BEST STREAK', s.bestStreak)}
    </div>
    <div class="grid2" style="margin-top:8px">
      <div class="mini"><b>${s.kd}</b><span>K/D</span></div>
      <div class="mini"><b>${s.accuracy}%</b><span>ACCURACY</span></div>
    </div>

    <div class="row"><button class="btn primary" id="btnSave">SAVE CHANGES</button></div>

    <h3>MODERATION</h3>
    ${p.banned
      ? `<div class="field"><label>STATUS</label><span class="tag ban">BANNED${p.bannedUntil > 0 ? ` until ${fmtDate(p.bannedUntil)}` : ' permanently'}</span></div>
         ${p.banReason ? `<div class="field"><label>REASON</label><span style="font-size:12px">${esc(p.banReason)}</span></div>` : ''}
         ${ipBanList(p.ipBans)}
         <div class="row"><button class="btn" id="btnUnban">LIFT BAN</button></div>`
      : `<div class="field"><label>DURATION</label><input id="fBanDays" type="number" min="0" step="1" value="0" placeholder="0 = permanent"></div>
         <div class="field"><label>REASON</label><input id="fBanReason" placeholder="cheating, chat abuse…"></div>
         <div class="field inline"><label>ALSO BAN IP</label>
           <input type="checkbox" id="fBanIp" checked></div>
         <div class="hint">Bans the account and every address it plays from. Anyone mid-match is
           told in chat, shown the ban screen and disconnected on the spot.</div>
         ${ipBanList(p.ipBans)}
         <div class="row"><button class="btn danger" id="btnBan">BAN ACCOUNT</button>
           <button class="btn" id="btnKick">KICK FROM MATCH</button></div>`}

    ${reports ? `
    <h3>REPORTS</h3>
    <div class="field"><label>ABOUT THEM</label>
      <span style="font-size:12px">${reports.against.length} filed${
        openAgainst ? ` · <b style="color:var(--accent)">${openAgainst} open</b>` : ''}</span></div>
    <div class="field"><label>BY THEM</label>
      <span style="font-size:12px">${reports.filed.length} filed</span></div>
    ${reports.against.slice(0, 5).map((rep) => `<div class="history-line">
      ${fmtDate(rep.at)} · <b>${esc(rep.reasonLabel ?? rep.reason)}</b> by ${esc(rep.reporter)}
      · ${esc(rep.statusLabel ?? rep.status)}</div>`).join('')}
    ${reports.against.length ? '<div class="row"><button class="btn" id="btnSeeReports">OPEN THE QUEUE</button></div>' : ''}` : ''}

    ${p.avatar ? `
    <h3>PROFILE PICTURE</h3>
    <div class="hint">User content on the public leaderboard and in the report queue —
      a mute does not reach it. Removing it is its own action, not part of a ban.</div>
    <div class="row"><button class="btn danger" id="btnRemoveAvatar">REMOVE PICTURE</button></div>` : ''}

    <h3>CHAT BAN</h3>
    ${p.muted
      ? `<div class="field"><label>STATUS</label><span class="tag ban">MUTED${
        p.chatBan.until > 0 ? ` until ${fmtDate(p.chatBan.until)}` : ' permanently'}</span></div>
         ${p.chatBan.reason ? `<div class="field"><label>REASON</label><span style="font-size:12px">${esc(p.chatBan.reason)}</span></div>` : ''}
         <div class="row"><button class="btn" id="btnUnmute">LIFT CHAT BAN</button></div>`
      : `<div class="field"><label>MINUTES</label><input id="fMuteMins" type="number" min="0" step="5" value="60" placeholder="0 = permanent"></div>
         <div class="field"><label>REASON</label><input id="fMuteReason" placeholder="chat abuse, spam…"></div>
         <div class="hint">Takes nobody out of a match: they keep playing, they just cannot
           write into the chat. It lands in the room they are in right now and survives a reconnect.</div>
         <div class="row"><button class="btn danger" id="btnMute">MUTE</button></div>`}

    <h3>REPORT BAN</h3>
    ${p.reportsBlocked
      ? `<div class="field"><label>STATUS</label><span class="tag ban">CANNOT REPORT${
        p.reportBan.until > 0 ? ` until ${fmtDate(p.reportBan.until)}` : ' indefinitely'}</span></div>
         ${p.reportBan.reason ? `<div class="field"><label>REASON</label><span style="font-size:12px">${esc(p.reportBan.reason)}</span></div>` : ''}
         <div class="row"><button class="btn" id="btnReportUnban">LET THEM REPORT AGAIN</button></div>`
      : `<div class="field"><label>MINUTES</label><input id="fReportBanMins" type="number" min="0" step="60" value="0" placeholder="0 = indefinite"></div>
         <div class="field"><label>REASON</label><input id="fReportBanReason" placeholder="false reports, using the queue as a weapon…"></div>
         <div class="hint">Switches the REPORT button off for this account and nothing else: they
           keep playing and keep talking. The button stays on their scoreboard, greyed, carrying
           this reason — so they are told what happened rather than finding it broken.</div>
         <div class="row"><button class="btn danger" id="btnReportBan">BLOCK REPORTING</button></div>`}

    <h3>PASSWORD</h3>
    <div class="field"><label>NEW</label><input id="fPassword" type="text" placeholder="at least 6 characters"></div>
    <div class="row"><button class="btn" id="btnPassword">RESET PASSWORD</button></div>

    <h3>RECENT MATCHES</h3>
    ${matches.length
      ? `<div style="font:12px var(--mono);color:var(--muted);line-height:1.8">${matches.slice(0, 8).map((m) =>
        `${fmtDate(m.started_at)} · ${esc(m.map)} · ${m.kills}/${m.deaths} · ${m.score} pts · +${m.gr ?? 0} GR${m.won ? ' · WON' : ''}`).join('<br>')}</div>`
      : '<div style="font-size:12px;color:var(--muted)">No matches recorded.</div>'}

    <div class="danger-zone">
      <div class="row"><button class="btn danger" id="btnDelete">DELETE ACCOUNT PERMANENTLY</button></div>
    </div>`;

  $('btnSave').addEventListener('click', () => savePlayer(p.id));
  $('btnPassword').addEventListener('click', () => resetPassword(p.id));
  $('btnDelete').addEventListener('click', () => deletePlayer(p));
  $('btnBan')?.addEventListener('click', () => banPlayer(p.id));
  $('btnUnban')?.addEventListener('click', () => action(p.id, 'unban', 'Ban lifted'));
  $('btnKick')?.addEventListener('click', () => action(p.id, 'kick', 'Kicked'));
  $('btnMute')?.addEventListener('click', () => mutePlayer(p.id));
  $('btnUnmute')?.addEventListener('click', () => action(p.id, 'unmute', 'Chat ban lifted'));
  $('btnReportBan')?.addEventListener('click', () => blockReporting(p.id));
  $('btnReportUnban')?.addEventListener('click', () => action(p.id, 'report-unban', 'Reporting restored'));
  $('btnRemoveAvatar')?.addEventListener('click', () => removeAvatar(p.id, () => selectPlayer(p.id)));
  $('btnOpenClan')?.addEventListener('click', () => openClan(p.clan));
  $('btnLeaveClan')?.addEventListener('click', async () => {
    if (!confirm(`Remove ${p.username} from [${p.clan}]?`)) return;
    try {
      await call('PATCH', `/players/${p.id}`, { clan: null });
      toast(`${p.username} left [${p.clan}]`, 'good');
      await selectPlayer(p.id);
      await loadPlayers();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  $('btnSeeReports')?.addEventListener('click', () => {
    document.querySelector('.tab[data-tab=reports]').click();
    $('reportStatus').value = '';
    $('reportSearch').value = p.username;
    rPage = 0;
    loadReports();
  });
}

async function mutePlayer(id) {
  const minutes = Number($('fMuteMins').value) || 0;
  const reason = $('fMuteReason').value.trim();
  const span = minutes > 0 ? `for ${minutes} minute(s)` : 'permanently';
  if (!confirm(`Ban this account from the chat ${span}?`)) return;
  try {
    const res = await call('POST', `/players/${id}/mute`, { minutes, reason });
    toast(`Muted ${span}${res.live ? ` · ${res.live} live session(s)` : ''}`, 'good');
    await selectPlayer(id);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/** Switches the REPORT button off for one account, with a reason they are shown. */
async function blockReporting(id) {
  const minutes = Number($('fReportBanMins').value) || 0;
  const reason = $('fReportBanReason').value.trim();
  const span = minutes > 0 ? `for ${minutes} minute(s)` : 'indefinitely';
  if (!confirm(`Block this account from filing reports ${span}?`)) return;
  try {
    const res = await call('POST', `/players/${id}/report-ban`, { minutes, reason });
    toast(`Reporting blocked ${span}${res.live ? ` · ${res.live} live session(s)` : ''}`, 'good');
    await selectPlayer(id);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/** Address bans currently attached to this account. */
const ipBanList = (rows) => (rows?.length
  ? `<div class="field"><label>IP BANS</label><span style="font-size:12px;font-family:var(--mono)">${
    rows.map((b) => `${esc(b.ip)}${b.until > 0 ? ` (until ${fmtDate(b.until)})` : ''}`).join('<br>')
  }</span></div>`
  : '');

const statField = (id, label, value) =>
  `<div class="field" style="grid-template-columns:92px 1fr"><label>${label}</label>
    <input id="${id}" type="number" min="0" value="${value}"></div>`;

const numOf = (id) => Math.max(0, Number($(id).value) || 0);

async function savePlayer(id) {
  try {
    const res = await call('PATCH', `/players/${id}`, {
      username: $('fName').value.trim(),
      email: $('fEmail').value.trim(),
      emailVerified: $('fEmailVerified').checked,
      role: $('fRole').value,
      verified: $('fVerified').checked,
      gr: numOf('fGr'),
      level: numOf('fLevel'),
      xp: numOf('fXp'),
      stats: {
        kills: numOf('fKills'), deaths: numOf('fDeaths'), assists: numOf('fAssists'),
        headshots: numOf('fHeadshots'), wins: numOf('fWins'), losses: numOf('fLosses'),
        matches: numOf('fMatches'), score: numOf('fScore'), damage_dealt: numOf('fDamage'),
        best_streak: numOf('fStreak'),
      },
    });
    selected = res.player;
    toast(`${res.player.username} saved`, 'good');
    await loadPlayers();
    await selectPlayer(id);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function banPlayer(id) {
  const days = Number($('fBanDays').value) || 0;
  const reason = $('fBanReason').value.trim();
  const ip = $('fBanIp').checked;
  const span = days > 0 ? `for ${days} day(s)` : 'permanently';
  if (!confirm(`Ban this account ${span}${ip ? ', and every IP it plays from' : ''}?`)) return;
  try {
    const res = await call('POST', `/players/${id}/ban`, { days, reason, ip });
    const bits = ['Account banned'];
    if (res.ipBans?.length) bits.push(`${res.ipBans.length} address(es)`);
    if (res.dropped) bits.push(`${res.dropped} session(s) dropped`);
    toast(bits.join(' · '), 'good');
    await loadPlayers();
    await selectPlayer(id);
  } catch (err) { toast(err.message, 'bad'); }
}

async function action(id, path, okMessage) {
  try {
    await call('POST', `/players/${id}/${path}`);
    toast(okMessage, 'good');
    await loadPlayers();
    await selectPlayer(id);
  } catch (err) { toast(err.message, 'bad'); }
}

async function resetPassword(id) {
  const password = $('fPassword').value;
  if (password.length < 6) return toast('Password must be at least 6 characters', 'bad');
  try {
    await call('POST', `/players/${id}/password`, { password });
    $('fPassword').value = '';
    toast('Password reset — all sessions signed out', 'good');
  } catch (err) { toast(err.message, 'bad'); }
}

async function deletePlayer(p) {
  if (!confirm(`Delete ${p.username} (#${shortId(p.id)}) and every trace of them? This cannot be undone.`)) return;
  try {
    await call('DELETE', `/players/${p.id}`);
    selected = null;
    $('detailBody').classList.add('hidden');
    $('detailEmpty').classList.remove('hidden');
    toast('Account deleted', 'good');
    await loadPlayers();
  } catch (err) { toast(err.message, 'bad'); }
}

/* ── Reports ─────────────────────────────────────────────────────────────── */

function setReportBadge(open) {
  const badge = $('reportBadge');
  badge.textContent = String(open);
  badge.classList.toggle('hidden', !open);
}

async function loadReports() {
  const q = $('reportSearch').value.trim();
  const status = $('reportStatus').value;
  try {
    const res = await call('GET',
      `/reports?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`
      + `&limit=${pageSize}&offset=${rPage * pageSize}`);
    rTotal = res.total;
    setReportBadge(res.open ?? 0);
    $('reportCount').textContent = `${res.total} report${res.total === 1 ? '' : 's'}`
      + (res.open ? ` · ${res.open} open` : '');
    $('reportPageInfo').textContent =
      `${Math.min(rTotal, rPage * pageSize + 1)}–${Math.min(rTotal, (rPage + 1) * pageSize)} of ${rTotal}`;
    $('btnReportPrev').disabled = rPage === 0;
    $('btnReportNext').disabled = (rPage + 1) * pageSize >= rTotal;

    $('reportRows').innerHTML = res.reports.map((rep) => `
      <tr data-id="${rep.id}" class="${rSelected?.id === rep.id ? 'sel' : ''}${rep.status === 'open' ? ' unread' : ''}">
        <td title="${rep.id}">${shortId(rep.id)}</td>
        <td><span class="p-name">${esc(rep.target)}${rep.targetId ? '' : ' <span class="tag">GUEST</span>'}</span></td>
        <td class="r-reason">${esc(rep.reasonLabel ?? rep.reason)}</td>
        <td>${esc(rep.reporter)}</td>
        <td class="r-when">${fmtAgo(rep.at)}</td>
        <td><span class="tag ${esc(rep.status)}">${esc(rep.statusLabel ?? rep.status)}</span></td>
      </tr>`).join('')
      || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Nothing in the queue.</td></tr>';

    for (const row of $('reportRows').querySelectorAll('tr[data-id]')) {
      row.addEventListener('click', () => selectReport(row.dataset.id));
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function selectReport(id) {
  try {
    const res = await call('GET', `/reports/${id}`);
    rSelected = res.report;
    renderReport(res);
    for (const row of $('reportRows').querySelectorAll('tr[data-id]')) {
      row.classList.toggle('sel', row.dataset.id === id);
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/**
 * One report, with everything needed to settle it without leaving the pane:
 * who was reported and what state their account is already in, what the
 * reporter said, what was being said in the chat at the time, and what else
 * has been filed about the same player.
 */
function renderReport({ report: rep, target, reporter, chatLog = [], history = [], online }) {
  $('reportDetailEmpty').classList.add('hidden');
  const body = $('reportDetailBody');
  body.classList.remove('hidden');

  const pic = target?.avatar
    ? `<img class="pic" src="${esc(target.avatar)}" alt="">`
    : `<div class="pic letter">${esc((rep.target || '?')[0].toUpperCase())}</div>`;

  body.innerHTML = `
    <div class="subject">
      ${pic}
      <div class="who">
        <b>${esc(rep.target)}</b>
        ${target?.banned ? '<span class="tag ban">BANNED</span>' : ''}
        ${target?.muted ? '<span class="tag ban">MUTED</span>' : ''}
        ${online ? '<span class="tag ok">ONLINE</span>' : ''}
        <div>${target ? `#${shortId(target.id)} · level ${target.level} · K/D ${target.stats.kd}` : 'no account — guest'}
          ${rep.targetIp ? ` · ${esc(rep.targetIp)}` : ''}</div>
      </div>
    </div>
    <div class="sub" title="${rep.id}">Report #${shortId(rep.id)} · ${esc(rep.reasonLabel ?? rep.reason)} ·
      filed by <b>${esc(rep.reporter)}</b> ${fmtAgo(rep.at)} · ${fmtDate(rep.at)}<br>
      ${esc([rep.mode?.toUpperCase(), rep.map, rep.room].filter(Boolean).join(' · ')) || 'no match recorded'}</div>

    ${rep.detail ? `<h3>WHAT THEY SAID</h3><div class="quote">${esc(rep.detail)}</div>` : ''}

    <h3>CHAT AT THE TIME</h3>
    ${chatLog.length
      ? `<div class="chat-snapshot">${chatLog.map((line) => `
          <div><span class="t">${fmtTime(line.at)}</span>
            <span class="who${line.name === rep.target ? ' target' : ''}">${esc(line.name)}:</span>
            ${esc(line.text)}</div>`).join('')}</div>`
      : '<div class="snap-empty">Nothing had been said in that match.</div>'}

    ${rep.status === 'open' ? `
      <h3>VERDICT</h3>
      <div class="field"><label>ACTION</label><select id="fReportAction">
        <option value="none">none — nothing was broken</option>
        <option value="warned" selected>warned</option>
        <option value="muted">muted</option>
        <option value="banned">banned</option>
      </select></div>
      <div class="field"><label>TO REPORTER</label>
        <input id="fReportOutcome" placeholder="What ${esc(rep.reporter)} will read"></div>
      <div class="hint">The reporter reads this line in their own account panel. It is the
        only thing they ever hear back, so a sentence beats silence.</div>
      <div class="row">
        <button class="btn primary" id="btnReportActioned">CLOSE · ACTION TAKEN</button>
        <button class="btn" id="btnReportRejected">CLOSE · NO ACTION</button>
      </div>`
    : `
      <h3>VERDICT</h3>
      <div class="field"><label>STATUS</label>
        <span class="tag ${esc(rep.status)}">${esc(rep.statusLabel ?? rep.status)}</span></div>
      <div class="field"><label>ACTION</label><span style="font-size:12px">${esc(rep.action ?? '—')}</span></div>
      <div class="field"><label>TOLD THEM</label><span style="font-size:12px">${esc(rep.outcome ?? '—')}</span></div>
      <div class="field"><label>CLOSED</label><span style="font-size:12px">${
        esc(rep.resolver ?? '—')} · ${fmtDate(rep.resolvedAt)}</span></div>
      <div class="row"><button class="btn" id="btnReportReopen">REOPEN</button></div>`}

    ${target ? `
      <h3>ACT ON ${esc(rep.target).toUpperCase()}</h3>
      <div class="field"><label>MUTE (MIN)</label><input id="fQuickMute" type="number" min="0" step="5" value="60"></div>
      <div class="field"><label>BAN (DAYS)</label><input id="fQuickBan" type="number" min="0" step="1" value="0"></div>
      <div class="hint">Both use the report's reason as their own, and both leave the
        verdict above for you to close. 0 means permanent.</div>
      <div class="row">
        <button class="btn" id="btnQuickMute">MUTE</button>
        <button class="btn danger" id="btnQuickBan">BAN</button>
        ${target.avatar ? '<button class="btn" id="btnQuickAvatar">REMOVE PICTURE</button>' : ''}
        <button class="btn" id="btnOpenPlayer">OPEN ACCOUNT</button>
      </div>` : ''}

    ${history.length ? `
      <h3>ALSO REPORTED (${history.length})</h3>
      ${history.slice(0, 10).map((h) => `<div class="history-line">
        ${fmtDate(h.at)} · <b>${esc(h.reasonLabel ?? h.reason)}</b> by ${esc(h.reporter)}
        · ${esc(h.statusLabel ?? h.status)}</div>`).join('')}` : ''}

    ${reporter ? `<h3>REPORTER</h3>
      <div class="history-line"><b>${esc(reporter.username)}</b> · #${shortId(reporter.id)}
        · level ${reporter.level} · ${reporter.banned ? 'BANNED' : 'active'}${
  reporter.reportsBlocked ? ' · <b style="color:var(--accent)">CANNOT REPORT</b>' : ''}</div>
      <div class="hint">Reached from the queue because this is where you find out someone is
        filing on whoever beat them. It only takes the REPORT button away — they keep
        playing and keep talking.</div>
      <div class="row">${reporter.reportsBlocked
    ? '<button class="btn" id="btnReporterUnban">LET THEM REPORT AGAIN</button>'
    : '<button class="btn" id="btnReporterBan">BLOCK THEIR REPORTING</button>'
}<button class="btn" id="btnOpenReporter">OPEN ACCOUNT</button></div>` : ''}

    <div class="danger-zone">
      <div class="row"><button class="btn danger" id="btnReportDelete">DELETE THIS REPORT</button></div>
    </div>`;

  $('btnReportActioned')?.addEventListener('click', () => resolveReport(rep.id, 'actioned'));
  $('btnReportRejected')?.addEventListener('click', () => resolveReport(rep.id, 'rejected'));
  $('btnReportReopen')?.addEventListener('click', async () => {
    try {
      await call('POST', `/reports/${rep.id}/reopen`);
      toast('Report reopened', 'good');
      await loadReports();
      await selectReport(rep.id);
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('btnReportDelete')?.addEventListener('click', () => deleteReport(rep));
  $('btnQuickMute')?.addEventListener('click', () => quickAct(rep, target, 'mute'));
  $('btnQuickBan')?.addEventListener('click', () => quickAct(rep, target, 'ban'));
  $('btnQuickAvatar')?.addEventListener('click', () => removeAvatar(target.id, () => selectReport(rep.id)));
  $('btnOpenPlayer')?.addEventListener('click', () => {
    document.querySelector('.tab[data-tab=players]').click();
    selectPlayer(target.id);
  });
  $('btnReporterBan')?.addEventListener('click', async () => {
    const why = prompt(`Why can ${reporter.username} no longer file reports?`,
      `false report on ${rep.target}`);
    if (why === null) return;
    try {
      const res = await call('POST', `/players/${reporter.id}/report-ban`, { minutes: 0, reason: why.trim() });
      toast(`${reporter.username} can no longer report${res.live ? ` · ${res.live} live` : ''}`, 'good');
      await selectReport(rep.id);
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('btnReporterUnban')?.addEventListener('click', async () => {
    try {
      await call('POST', `/players/${reporter.id}/report-unban`);
      toast(`${reporter.username} can report again`, 'good');
      await selectReport(rep.id);
    } catch (err) { toast(err.message, 'bad'); }
  });
  $('btnOpenReporter')?.addEventListener('click', () => {
    document.querySelector('.tab[data-tab=players]').click();
    selectPlayer(reporter.id);
  });
}

async function resolveReport(id, status) {
  const action = $('fReportAction')?.value ?? (status === 'rejected' ? 'none' : 'warned');
  const outcome = $('fReportOutcome')?.value.trim() ?? '';
  try {
    await call('POST', `/reports/${id}/resolve`, { status, action, outcome });
    toast(status === 'actioned' ? 'Closed — action taken' : 'Closed — no action', 'good');
    await loadReports();
    await selectReport(id);
  } catch (err) { toast(err.message, 'bad'); }
}

/** Mute or ban the reported account, using the report itself as the reason. */
async function quickAct(rep, target, kind) {
  const reason = `report #${shortId(rep.id)}: ${rep.reasonLabel ?? rep.reason}`;
  try {
    if (kind === 'mute') {
      const minutes = Number($('fQuickMute').value) || 0;
      if (!confirm(`Mute ${target.username} ${minutes > 0 ? `for ${minutes} minute(s)` : 'permanently'}?`)) return;
      const res = await call('POST', `/players/${target.id}/mute`, { minutes, reason });
      toast(`Muted${res.live ? ` · ${res.live} live session(s)` : ''}`, 'good');
    } else {
      const days = Number($('fQuickBan').value) || 0;
      if (!confirm(`Ban ${target.username} ${days > 0 ? `for ${days} day(s)` : 'permanently'}, and every IP they play from?`)) return;
      const res = await call('POST', `/players/${target.id}/ban`, { days, reason, ip: true });
      toast(`Banned${res.dropped ? ` · ${res.dropped} session(s) dropped` : ''}`, 'good');
    }
    await selectReport(rep.id);
  } catch (err) { toast(err.message, 'bad'); }
}

async function deleteReport(rep) {
  if (!confirm(`Delete report #${shortId(rep.id)} against ${rep.target}? The reporter will never hear back.`)) return;
  try {
    await call('DELETE', `/reports/${rep.id}`);
    rSelected = null;
    $('reportDetailBody').classList.add('hidden');
    $('reportDetailEmpty').classList.remove('hidden');
    toast('Report deleted', 'good');
    await loadReports();
  } catch (err) { toast(err.message, 'bad'); }
}

/** Takes an account's profile picture away — its own action, not part of a ban. */
async function removeAvatar(id, after) {
  if (!confirm('Remove this account\'s profile picture?')) return;
  try {
    const res = await call('DELETE', `/players/${id}/avatar`);
    toast(res.removed ? 'Profile picture removed' : 'Nothing was stored', 'good');
    await after?.();
  } catch (err) { toast(err.message, 'bad'); }
}

/* ── Clans ───────────────────────────────────────────────────────────────── */

/** Switches to a tab by name, exactly as clicking it would. */
const openTab = (name) => document.querySelector(`.tab[data-tab="${name}"]`)?.click();

/** Jumps to one clan from anywhere in the panel. */
async function openClan(tag) {
  if (!tag) return;
  openTab('clans');
  $('clanSearch').value = '';
  await loadClans();
  await selectClan(tag);
}

/** …and back the other way, from a clan's roster to one of its members. */
async function openPlayer(id) {
  openTab('players');
  $('search').value = '';
  page = 0;
  await loadPlayers();
  await selectPlayer(id);
}

async function loadClans() {
  const q = $('clanSearch').value.trim();
  try {
    const res = await call('GET', `/clans?q=${encodeURIComponent(q)}&limit=200`);
    $('clanCount').textContent = `${res.total} clan${res.total === 1 ? '' : 's'}`;
    $('clanRows').innerHTML = res.clans.map((c) => `
      <tr data-tag="${esc(c.tag)}" class="${cSelected?.tag === c.tag ? 'sel' : ''}">
        <td title="${c.id}">${shortId(c.id)}</td>
        <td><span class="p-clan${c.verified ? ' gold' : ''}">[${esc(c.tag)}]</span></td>
        <td>${esc(c.ownerName ?? '—')}</td>
        <td>${c.members}</td>
        <td>${c.score}</td>
        <td>${c.verified ? '<span class="tag ok">VERIFIED</span>' : '<span class="tag">PLAIN</span>'}</td>
      </tr>`).join('')
      || '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No clans yet.</td></tr>';

    for (const row of $('clanRows').querySelectorAll('tr[data-tag]')) {
      row.addEventListener('click', () => selectClan(row.dataset.tag));
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function selectClan(tag) {
  try {
    const res = await call('GET', `/clans/${encodeURIComponent(tag)}`);
    cSelected = res.clan;
    renderClanDetail(res);
    for (const row of $('clanRows').querySelectorAll('tr[data-tag]')) {
      row.classList.toggle('sel', row.dataset.tag === tag);
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function renderClanDetail({ clan: c, members = [], invites = [] }) {
  $('clanDetailEmpty').classList.add('hidden');
  const body = $('clanDetailBody');
  body.classList.remove('hidden');

  body.innerHTML = `
    <div class="subject">
      ${c.avatar
    ? `<img class="pic" src="${esc(c.avatar)}" alt="">`
    : `<div class="pic letter">${esc(c.tag[0])}</div>`}
      <div class="who"><b class="p-clan${c.verified ? ' gold' : ''}">[${esc(c.tag)}]</b>
        <div>${members.length} member${members.length === 1 ? '' : 's'}
          · owned by ${esc(c.ownerName ?? '—')}</div></div>
    </div>
    <div class="sub" title="${c.id}">#${shortId(c.id)} · founded ${fmtDate(c.createdAt)} by ${esc(c.createdBy ?? '—')}
      · ${c.score} score · ${c.kills} kills</div>

    <h3>VERIFICATION</h3>
    <div class="hint">A verified clan's tag is drawn in gold instead of grey, everywhere a
      nickname appears — the scoreboard, the chat, the killfeed, the leaderboard and the
      nametags out in the world. That is the entirety of what it does.</div>
    <div class="row">
      ${c.verified
    ? '<button class="btn" id="btnUnverifyClan">REMOVE VERIFICATION</button>'
    : '<button class="btn primary" id="btnVerifyClan">VERIFY THIS CLAN</button>'}
    </div>

    ${c.avatar ? `
    <h3>CLAN PICTURE</h3>
    <div class="hint">User content next to every member's name. Removing it is its own action,
      exactly as for an account's.</div>
    <div class="row"><button class="btn danger" id="btnClanAvatar">REMOVE PICTURE</button></div>` : ''}

    <h3>MEMBERS</h3>
    <div style="font:12px var(--mono);color:var(--muted);line-height:1.9">${members.map((m) =>
    `${m.role === 'owner' ? '★ ' : '&nbsp;&nbsp;'}<button class="linkish" data-player="${m.id}">${
      esc(m.username)}</button> · LVL ${m.level} · `
    + `${m.kills} kills · joined ${fmtAgo(m.joinedAt)}`).join('<br>') || 'nobody'}</div>

    ${invites.length ? `<h3>OUTSTANDING INVITES</h3>
    <div style="font:12px var(--mono);color:var(--muted);line-height:1.9">${invites.map((i) =>
    `${esc(i.username)} · LVL ${i.level} · invited ${fmtAgo(i.createdAt)} by ${esc(i.invitedBy ?? '—')}`)
    .join('<br>')}</div>` : ''}

    <div class="danger-zone">
      <div class="hint">Disbanding strips the tag from every member on the spot, including
        anyone mid-match.</div>
      <div class="row"><button class="btn danger" id="btnDisbandClan">DISBAND [${esc(c.tag)}]</button></div>
    </div>`;

  const verify = async (on) => {
    try {
      const res = await call('POST', `/clans/${c.id}/verify`, { verified: on });
      toast(`[${c.tag}] ${on ? 'verified' : 'unverified'}${res.live ? ` · ${res.live} live` : ''}`, 'good');
      await loadClans();
      await selectClan(c.tag);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  for (const link of body.querySelectorAll('button[data-player]')) {
    link.addEventListener('click', () => openPlayer(Number(link.dataset.player)));
  }

  $('btnVerifyClan')?.addEventListener('click', () => verify(true));
  $('btnUnverifyClan')?.addEventListener('click', () => verify(false));

  $('btnClanAvatar')?.addEventListener('click', async () => {
    if (!confirm(`Remove the picture on [${c.tag}]?`)) return;
    try {
      await call('DELETE', `/clans/${c.id}/avatar`);
      toast('Picture removed', 'good');
      await selectClan(c.tag);
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('btnDisbandClan').addEventListener('click', async () => {
    if (!confirm(`Disband [${c.tag}]? Every member loses the tag. This cannot be undone.`)) return;
    try {
      const res = await call('DELETE', `/clans/${c.id}`);
      toast(`[${c.tag}] disbanded · ${res.members} member(s)`, 'good');
      cSelected = null;
      $('clanDetailBody').classList.add('hidden');
      $('clanDetailEmpty').classList.remove('hidden');
      await loadClans();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

/* ── Logs ────────────────────────────────────────────────────────────────── */

async function loadLogs(reset = false) {
  if (reset) { lastLogId = 0; $('logBox').innerHTML = ''; }
  try {
    const level = $('logLevel').value;
    const res = await call('GET', `/logs?limit=400&auditLimit=120${level ? `&level=${level}` : ''}`);

    const box = $('logBox');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    // Newest first from the API; render oldest first so it reads like a tail.
    const fresh = res.lines.filter((l) => l.id > lastLogId).reverse();
    if (fresh.length) {
      lastLogId = Math.max(lastLogId, ...fresh.map((l) => l.id));
      box.insertAdjacentHTML('beforeend', fresh.map(logLine).join(''));
      while (box.children.length > 600) box.firstChild.remove();
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
    $('logCount').textContent = `${res.lines.length} lines buffered`;

    $('auditBox').innerHTML = res.audit.map((a) => `
      <div class="audit-line">
        <span class="t">${fmtTime(a.at * 1000)}</span>
        <span><span class="a">${esc(a.action)}</span>
          <span class="d">${esc(a.target ?? '')} ${esc(a.detail ?? '')}</span></span>
      </div>`).join('') || '<div style="color:var(--muted);font-size:12px">No admin actions yet.</div>';
  } catch (err) {
    toast(err.message, 'bad');
  }
}

const logLine = (l) => `
  <div class="log-line ${l.level}">
    <span class="t">${fmtTime(l.at)}</span>
    <span class="l">${l.level.toUpperCase()}</span>
    <span class="m">${l.ns ? `<span class="ns">[${esc(l.ns)}]</span> ` : ''}${esc(l.message)}</span>
  </div>`;

/* ── Wiring ──────────────────────────────────────────────────────────────── */

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 0; loadPlayers(); }, 220);
});
$('sort').addEventListener('change', () => { page = 0; loadPlayers(); });
$('btnReload').addEventListener('click', () => { loadPlayers(); loadOverview(); });
$('btnPrev').addEventListener('click', () => { if (page > 0) { page--; loadPlayers(); } });
$('btnNext').addEventListener('click', () => { if ((page + 1) * pageSize < total) { page++; loadPlayers(); } });
let reportSearchTimer = null;
$('reportSearch').addEventListener('input', () => {
  clearTimeout(reportSearchTimer);
  reportSearchTimer = setTimeout(() => { rPage = 0; loadReports(); }, 220);
});
$('reportStatus').addEventListener('change', () => { rPage = 0; loadReports(); });
$('btnReportReload').addEventListener('click', () => loadReports());
$('btnReportPrev').addEventListener('click', () => { if (rPage > 0) { rPage--; loadReports(); } });
$('btnReportNext').addEventListener('click', () => {
  if ((rPage + 1) * pageSize < rTotal) { rPage++; loadReports(); }
});
let clanSearchTimer = null;
$('clanSearch').addEventListener('input', () => {
  clearTimeout(clanSearchTimer);
  clanSearchTimer = setTimeout(() => loadClans(), 220);
});
$('btnClanReload').addEventListener('click', () => loadClans());
$('logLevel').addEventListener('change', () => loadLogs(true));
$('btnLogReload').addEventListener('click', () => loadLogs(true));

/* ── Stats ───────────────────────────────────────────────────────────────
   One request, one window, every card. The alternative — a fetch per chart —
   paints the page in fourteen stages, each showing a slightly different
   moment, and two figures that disagree on a dashboard are worse than no
   dashboard at all.
   ─────────────────────────────────────────────────────────────────────── */

/** A stat tile: label, the figure, a note under it, an optional sparkline. */
function tileCard({ label, value, note = '', kind = '', spark = null, color = SERIES[0] }) {
  const el = document.createElement('div');
  el.className = 'tile';
  const l = document.createElement('span');
  l.className = 't-label';
  l.textContent = label;
  const v = document.createElement('b');
  v.className = 't-value';
  v.textContent = value;
  const n = document.createElement('span');
  n.className = `t-note ${kind}`;
  n.textContent = note;
  el.append(l, v, n);
  if (spark?.length) {
    const host = document.createElement('div');
    host.className = 'spark-host';
    el.appendChild(host);
    sparkline(host, spark, color);
  }
  return el;
}

/** A labelled proportion bar. Used where a percentage is the whole story. */
function meter(host, { label, value, of, note = '', format = compact }) {
  const pct = of > 0 ? Math.max(0, Math.min(1, value / of)) : 0;
  const wrap = document.createElement('div');
  wrap.className = 'meter';
  const top = document.createElement('div');
  top.className = 'meter-top';
  const name = document.createElement('span');
  name.textContent = label;
  const num = document.createElement('b');
  num.textContent = of > 0 && of !== value ? `${format(value)} / ${format(of)}` : format(value);
  top.append(name, num);
  const track = document.createElement('div');
  track.className = 'meter-track';
  const fill = document.createElement('i');
  fill.className = 'meter-fill';
  fill.style.width = `${(pct * 100).toFixed(1)}%`;
  track.appendChild(fill);
  wrap.append(top, track);
  if (note) {
    const n = document.createElement('span');
    n.className = 'meter-note';
    n.textContent = note;
    wrap.appendChild(n);
  }
  host.appendChild(wrap);
}

/**
 * The label for a mix row.
 *
 * The server resolves map, mode and class names from the same modules the game
 * builds them out of and sends them on the row — this is only the fallback for
 * anything it did not name, and for the event kinds, which are ours.
 */
const titleCase = (s) => String(s ?? '').replace(/[_.-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const rowName = (r) => r.name ?? titleCase(r.key);

async function loadStats() {
  if (statBusy) return;
  statBusy = true;
  const panel = document.querySelector('.panel[data-panel=stats]');
  panel.classList.add('loading');
  try {
    const s = await call('GET', `/stats?hours=${statHours}`);
    renderStats(s);
    const from = new Date(s.window.since * 1000);
    $('statWindow').textContent = s.live.sampling
      ? `since ${from.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      : 'sampling is off (METRICS_ENABLED=false)';
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    statBusy = false;
    panel.classList.remove('loading');
  }
}

export function renderStats(s) {
  const g = s.live.game;
  const series = (name) => s.series[name] ?? [];
  const sum = (rows) => rows.reduce((n, r) => n + r[1], 0);
  const peak = (rows) => rows.reduce((n, r) => Math.max(n, r[1]), 0);

  /* ── Right now ───────────────────────────────────────────────────────── */

  const tiles = $('statTiles');
  tiles.textContent = '';
  const uptimeH = Math.floor(s.live.uptime / 3600);
  const uptimeM = Math.floor((s.live.uptime % 3600) / 60);
  const tickMs = g.lastTickMs ?? 0;
  tiles.append(
    tileCard({
      label: 'Players online', value: compact(g.players),
      note: `${compact(g.watching)} watching · ${compact(g.bots)} bots`,
      spark: series('players.online'), color: SERIES[0],
    }),
    tileCard({
      label: 'Rooms open', value: `${g.rooms}`,
      note: g.dynamicRooms > 0
        ? `${g.dynamicRooms} opened by demand · ceiling ${g.maxRooms}`
        : `floor only · ceiling ${g.maxRooms}`,
      kind: g.dynamicRooms > 0 ? 'good' : '',
      spark: series('rooms.open'), color: SERIES[2],
    }),
    tileCard({
      label: 'Free seats', value: compact(g.freeSeats),
      note: g.freeSeats <= 2 ? 'about to open another room' : 'nobody is being turned away',
      kind: g.freeSeats <= 2 ? 'warn' : 'good',
      spark: series('rooms.freeSeats'), color: SERIES[3],
    }),
    tileCard({
      label: 'Peak in window', value: compact(peak(series('players.online'))),
      note: `all-time peak ${compact(g.peakPlayers)}`,
    }),
    tileCard({
      label: 'Matches in window', value: compact(sum(s.game.matches)),
      note: `${compact(s.live.db.matches)} ever`,
      spark: s.game.matches, color: SERIES[1],
    }),
    tileCard({
      label: 'New accounts', value: compact(sum(s.game.signups)),
      note: `${compact(s.live.db.users)} in total`,
      spark: s.game.signups, color: SERIES[4],
    }),
    tileCard({
      label: 'Kills in window', value: compact(sum(series('game.kills'))),
      note: `${compact(sum(series('game.headshots')))} headshots`,
      spark: series('game.kills'), color: SERIES[7],
    }),
    tileCard({
      label: 'Tick cost', value: `${tickMs.toFixed(2)} ms`,
      note: g.overloadDrops > 0 ? `${g.overloadDrops} overload drop(s)` : `${uptimeH}h ${uptimeM}m up · ${s.live.memoryMb} MB`,
      kind: tickMs > 12 ? 'bad' : tickMs > 6 ? 'warn' : 'good',
      spark: series('server.tickMs'), color: SERIES[5],
    }),
  );

  /* ── Who is here ─────────────────────────────────────────────────────── */

  const population = [
    { name: 'Signed in', points: series('players.accounts'), color: SERIES[0] },
    { name: 'Guests', points: series('players.guests'), color: SERIES[1] },
    { name: 'Spectating', points: series('players.watching'), color: SERIES[2] },
    { name: 'Bots', points: series('players.bots'), color: SERIES[3] },
  ];
  legendFor($('lgPopulation'), population);
  lineChart($('chPopulation'), { series: population, height: 210 });

  const rooms = [
    { name: 'Rooms open', points: series('rooms.open'), color: SERIES[2] },
    { name: 'Opened by demand', points: series('rooms.dynamic'), color: SERIES[3] },
  ];
  legendFor($('lgRooms'), rooms);
  lineChart($('chRooms'), { series: rooms });
  lineChart($('chSeats'), {
    series: [{ name: 'Free seats', points: series('rooms.freeSeats'), color: SERIES[0] }],
    area: true,
  });

  /* ── What they did ───────────────────────────────────────────────────── */

  const combat = [
    { name: 'Kills', points: series('game.kills'), color: SERIES[0] },
    { name: 'Headshots', points: series('game.headshots'), color: SERIES[1] },
    { name: 'Deaths', points: series('game.deaths'), color: SERIES[2] },
  ];
  legendFor($('lgCombat'), combat);
  lineChart($('chCombat'), { series: combat, height: 210 });
  lineChart($('chShots'), {
    series: [{ name: 'Rounds fired', points: series('game.shots'), color: SERIES[1] }],
    area: true,
  });
  barChart($('chMatches'), { bars: bucketsToBars(s.game.matches, s.window), color: SERIES[2] });

  /* ── Accounts ────────────────────────────────────────────────────────── */

  barChart($('chSignups'), { bars: bucketsToBars(s.game.signups, s.window, true), color: SERIES[4] });
  barChart($('chLogins'), { bars: bucketsToBars(s.events.logins, s.window, true), color: SERIES[0] });
  barChart($('chActive'), { bars: bucketsToBars(s.game.activePlayers, s.window, true), color: SERIES[2] });

  /* ── Retention & the ladder ──────────────────────────────────────────── */

  const ret = s.population.retention;
  const rHost = $('stRetention');
  rHost.textContent = '';
  meter(rHost, {
    label: 'Ever finished a match', value: ret.played, of: ret.cohort,
    note: `${ret.playedPct}% of every account made`,
  });
  meter(rHost, {
    label: 'Came back on a later day', value: ret.returned, of: ret.cohort,
    note: `${ret.returnedPct}% — the number the daily streak is for`,
  });
  meter(rHost, {
    label: 'Holding a streak right now', value: ret.streaking, of: ret.cohort,
    note: 'two days or more in a row',
  });
  if (s.population.newRetention.cohort > 0) {
    meter(rHost, {
      label: 'Signed up in this window', value: s.population.newRetention.played,
      of: s.population.newRetention.cohort,
      note: `${s.population.newRetention.playedPct}% of them played at least once`,
    });
  }

  barChart($('chLevels'), {
    bars: s.population.levels.map((b) => ({
      label: `${b.band}+`, full: `Levels ${b.band}–${b.band + 4}`, value: b.n, note: 'accounts',
    })),
    color: SERIES[3], format: (v) => compact(v),
  });

  const ec = s.population.economy;
  const eHost = $('stEconomy');
  eHost.textContent = '';
  meter(eHost, {
    label: `${s.live.currency} held by players`, value: ec.grHeld, of: Math.max(ec.grHeld, ec.grPaidOut),
    note: `${compact(ec.grPaidOut)} paid out by matches all told`,
  });
  meter(eHost, {
    label: 'Average level', value: ec.avgLevel, of: Math.max(1, ec.avgLevel),
    note: `${compact(ec.xpTotal)} XP across ${compact(ec.accounts)} account(s)`,
    format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
  });

  /* ── What gets played ────────────────────────────────────────────────── */

  donutChart($('chMaps'), {
    slices: s.game.maps.map((m, i) => ({ label: rowName(m), value: m.n, color: SERIES[i % SERIES.length] })),
  });
  donutChart($('chModes'), {
    slices: s.game.modes.map((m, i) => ({ label: rowName(m), value: m.n, color: SERIES[i % SERIES.length] })),
  });
  barChart($('chClasses'), {
    horizontal: true,
    bars: s.game.classes.map((c) => ({
      label: rowName(c), value: c.n,
      note: `${c.winRate}% wins · ${c.kd} K/D`,
      color: SERIES[0],
    })),
    empty: 'No matches with a recorded class yet.',
  });

  /* ── When, and how the machine held up ───────────────────────────────── */

  barChart($('chHours'), {
    bars: s.game.hourOfDay.map((h) => ({
      label: String(h.hour).padStart(2, '0'), full: `${String(h.hour).padStart(2, '0')}:00 UTC`,
      value: h.n, note: 'matches started',
    })),
    color: SERIES[0], height: 170,
  });

  const tick = [
    { name: 'Average', points: series('server.tickMs'), color: SERIES[0] },
    { name: 'Worst in interval', points: series('server.tickMaxMs'), color: SERIES[1] },
  ];
  legendFor($('lgTick'), tick);
  lineChart($('chTick'), { series: tick, format: (v) => `${v.toFixed(2)} ms` });
  lineChart($('chMemory'), {
    series: [{ name: 'Memory', points: series('server.memMb'), color: SERIES[2] }],
    area: true, format: (v) => `${Math.round(v)} MB`,
  });

  /* ── The journal ─────────────────────────────────────────────────────── */

  donutChart($('chEventMix'), {
    slices: s.events.mix.map((e, i) => ({
      label: titleCase(e.kind), value: e.n, color: SERIES[i % SERIES.length],
    })),
    empty: 'Nothing has happened in this window.',
  });
  loadEvents();
}

/**
 * Turns [[unixSeconds, n], …] into labelled bars.
 * @param {boolean} daily label with a date rather than a clock
 */
export function bucketsToBars(rows, window, daily = false) {
  return (rows ?? []).map(([t, n]) => {
    const d = new Date(t * 1000);
    return {
      label: daily || window.hours > 48
        ? `${d.getDate()}/${d.getMonth() + 1}`
        : d.toTimeString().slice(0, 5),
      full: d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      value: n,
    };
  });
}

/** The raw journal, for the things a chart cannot answer. */
async function loadEvents() {
  const box = $('eventBox');
  if (!box) return;
  try {
    const { events } = await call('GET', '/stats/events?limit=120');
    box.textContent = '';
    if (!events.length) {
      const p = document.createElement('p');
      p.className = 'chart-empty';
      p.textContent = 'Nothing recorded yet.';
      box.appendChild(p);
      return;
    }
    for (const e of events) {
      const row = document.createElement('div');
      const family = e.kind.split('.')[0];
      row.className = `event-row ${family}`;
      const at = document.createElement('span');
      at.className = 'e-at';
      at.textContent = fmtTime(e.at * 1000);
      const kind = document.createElement('span');
      kind.className = 'e-kind';
      kind.textContent = e.kind;
      const what = document.createElement('span');
      what.className = 'e-what';
      // Every field here is written by players or by a moderator; it goes in
      // as text, never as markup.
      what.textContent = [
        e.name, e.value !== null && e.value !== undefined ? `= ${e.value}` : '',
        e.map ? `· ${e.map}` : '', e.room ? `· ${e.room}` : '', e.detail ?? '',
      ].filter(Boolean).join(' ');
      row.append(at, kind, what);
      box.appendChild(row);
    }
  } catch { /* the tab's own toast already said so */ }
}

for (const b of document.querySelectorAll('#statRange .rg')) {
  b.addEventListener('click', () => {
    statHours = Number(b.dataset.hours) || 24;
    for (const o of document.querySelectorAll('#statRange .rg')) o.classList.toggle('active', o === b);
    loadStats();
  });
}
$('btnStatReload').addEventListener('click', () => loadStats());

function fmtDate(ts) { return ts ? new Date(ts * 1000).toLocaleString() : '—'; }
function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
function fmtTime(ms) { return new Date(ms).toTimeString().slice(0, 8); }

async function start() {
  $('gate').classList.add('hidden');
  $('app').classList.remove('hidden');
  await loadOverview();
  await loadPlayers();
  await loadLogs(true);
  clearInterval(logTimer);
  logTimer = setInterval(() => {
    loadOverview();
    if ($('logFollow').checked && document.querySelector('.panel[data-panel=logs]').classList.contains('active')) {
      loadLogs();
    }
    // The stats page refreshes on the same timer, and only while it is the
    // page being looked at — a dashboard nobody has open is a query nobody
    // asked for.
    if ($('statFollow').checked && document.querySelector('.panel[data-panel=stats]').classList.contains('active')) {
      loadStats();
    }
  }, 4000);
}

/* Resume an existing session if the token still works. */
(async () => {
  if (!token) return;
  try {
    const s = await fetch(`${API}/status`, { headers: { 'x-admin-token': token } }).then((r) => r.json());
    if (s.authed) start();
  } catch { /* stay on the gate */ }
})();
