// Kompas APL Tracker – single page front end.

// The Kompas mark (four triangles, as in the company logo), coloured from the theme tokens.
const LOGO_MARK = `<svg class="wordmark-mark" viewBox="0 0 660 660" aria-hidden="true">
  <polygon class="lm-2" points="336,0 429,323 336,323"/><polygon class="lm-3" points="1,323 326,231 326,323"/>
  <polygon class="lm-1" points="234,338 326,338 326,658"/><polygon class="lm-4" points="336,338 659,338 336,430"/></svg>`;
// Screens: Login → Dashboard → Register activity → Activities (filter, export) → Administration.
// The UI hides what a role cannot do, but every rule is enforced again on the server.
import { transport } from './transport.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => Number(n || 0).toLocaleString('da-DK');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const fmtDate = (iso, short = false) => {
  const [y, m, d] = String(iso).split('-');
  return short ? `${d}.${m}.${y.slice(2)}` : `${d}.${m}.${y}`;
};
// Optional times, 24-hour clock: "09:00–12:00", "kl. 09:00" or "".
const timeText = (a) => (a.start_time ? (a.end_time ? `${a.start_time}–${a.end_time}` : `kl. ${a.start_time}`) : '');
const withTime = (a, sep = ' · ') => (timeText(a) ? `${sep}${timeText(a)}` : '');
const timeSub = (a) => (timeText(a) ? `<div class="muted small nowrap">${timeText(a)}</div>` : '');
// What people type in the time fields: "9", "930", "9.30", "9,30" -> "09:30". Unknown input is left as typed.
const normClock = (v) => {
  const s = String(v || '').trim().replace(/^kl\.?\s*/i, '');
  const m = /^(\d{1,2})(?:[:.,]?(\d{2}))?$/.exec(s);
  if (!m || +m[1] > 23 || +(m[2] || 0) > 59) return s;
  return `${m[1].padStart(2, '0')}:${m[2] || '00'}`;
};
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const store = {
  get(k, fallback = null) { try { return JSON.parse(localStorage.getItem(`apl.${k}`)) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(`apl.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const api = {
  get: (p) => transport.request('GET', p),
  post: (p, b) => transport.request('POST', p, b),
  put: (p, b) => transport.request('PUT', p, b),
  del: (p) => transport.request('DELETE', p),
};
const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); });
  const s = p.toString();
  return s ? `?${s}` : '';
};

const state = {
  me: null,
  options: null,
  view: 'dashboard',
  editing: null, // activity being edited
  prefill: null, // values from a calendar event
  calEvents: null,
  calShowAll: false,
  signupMunicipality: '',
  dashFilters: { year: String(new Date().getFullYear()), reseller: '' },
  listFilters: { q: '', status: '', year: String(new Date().getFullYear()), from: '', to: '', reseller: '', municipality: '', consultant: '', type: '', reschedule: '' },
  importResult: null,
  adminTab: 'consultants',
  demoUsers: [],
};
const isAdmin = () => state.me?.role === 'admin';
// Admins and read-only viewers (e.g. Apple) see all resellers; only admins can change anything.
const seesAll = () => ['admin', 'viewer'].includes(state.me?.role);
const roleLabel = (u) => (u.role === 'admin' ? 'Kompas-administrator' : u.role === 'viewer' ? 'Læseadgang · alle resellere' : `Reseller · ${esc(u.reseller)}`);

// --- Toast ---------------------------------------------------------------------------------
let toastTimer;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// --- Navigation ----------------------------------------------------------------------------
const VIEWS = ['dashboard', 'activities', 'register', 'import', 'calendar', 'signup', 'messages', 'admin', 'password'];

function go(view, { editing = null, prefill = null, copyOf = null } = {}) {
  if (!isAdmin() && ['register', 'admin', 'import', 'signup', 'messages'].includes(view)) view = 'dashboard';
  state.view = view;
  state.editing = editing;
  state.prefill = prefill;
  state.copyOf = copyOf;
  if (location.hash.slice(1) !== view) { try { history.replaceState(null, '', `#${view}`); } catch { /* sandboxed frame */ } }
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (state.me && VIEWS.includes(v) && v !== state.view) go(v);
});

// --- Shell ---------------------------------------------------------------------------------
function renderShell() {
  const me = state.me;
  const nav = [['dashboard', 'Overblik'], ['activities', 'Aktiviteter']];
  nav.push(['calendar', 'Kalender']);
  if (isAdmin()) nav.push(['signup', 'Tilmelding'], ['messages', 'Beskeder'], ['admin', 'Administration']);
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="wordmark" href="#dashboard" data-go="dashboard" aria-label="Kompas APL Tracker, overblik">
          ${LOGO_MARK}<span class="wordmark-text"><span class="wordmark-kompas">KOMPAS</span> APL Tracker</span>
        </a>
        <nav class="mainnav" aria-label="Hovedmenu">
          ${nav.map(([v, l]) => `<a href="#${v}" data-go="${v}" class="${state.view === v || (v === 'activities' && state.view === 'register' && !isAdmin()) ? 'active' : ''}">${l}</a>`).join('')}
        </nav>
        <div class="userbox">
          ${isAdmin() ? '<button class="btn btn-primary btn-sm hide-sm" data-go="register" type="button">+ Registrér aktivitet</button>' : ''}
          <div class="userchip" title="${esc(me.email)}">
            <span class="role-dot ${isAdmin() ? 'is-admin' : ''}" aria-hidden="true"></span>
            <span class="userchip-text"><span class="userchip-name">${esc(me.name)}</span>
            <span class="userchip-role">${roleLabel(me)}</span></span>
          </div>
        </div>
      </div>
    </header>
    ${me.viewed_by ? `<div class="demobar viewas-bar" role="region" aria-label="Se som"><div class="demobar-inner">
      <span><b>Du ser systemet som ${esc(me.name)}</b> · ${roleLabel(me)} · kun visning, du kan ikke ændre noget</span><span class="spacer"></span>
      <button type="button" class="btn btn-sm" id="viewas-end">Afslut visning</button><button type="button" class="linkbtn" id="logout">Log ud</button></div></div>` : state.demoUsers.length ? `
    <div class="demobar" role="region" aria-label="Skift demobruger">
      <div class="demobar-inner">
        <span class="demobar-label">Demo · vis som</span>
        <div class="seg seg-demo" role="group">
          ${state.demoUsers.map((u) => `<button type="button" class="${u.id === me.id ? 'on' : ''}" data-demo-user="${u.id}" aria-pressed="${u.id === me.id}">${esc(u.name)}</button>`).join('')}
        </div>
        <button type="button" class="linkbtn" id="logout">Log ud</button>
      </div>
    </div>` : `<div class="demobar"><div class="demobar-inner"><span class="demobar-label">${esc(me.email)}</span><span class="spacer"></span><a href="#password" data-go="password" class="small">Skift adgangskode</a><button type="button" class="linkbtn" id="logout">Log ud</button></div></div>`}
    <main id="view" class="page" tabindex="-1"></main>
    ${state.version ? `<footer class="app-version">Version ${esc(state.version)}</footer>` : ''}
    ${isAdmin() && state.view !== 'register' ? '<button class="fab show-sm" data-go="register" type="button" aria-label="Registrér aktivitet">+ Registrér</button>' : ''}
  `;
  $('#logout').onclick = async () => { transport.viewAs = null; await transport.auth.logout(); state.me = null; boot(); };
  $('#viewas-end')?.addEventListener('click', () => viewAs(null));
  $$('[data-demo-user]').forEach((b) => { b.onclick = () => switchUser(Number(b.dataset.demoUser)); });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go]');
  if (!t) return;
  e.preventDefault();
  go(t.dataset.go);
});

async function switchUser(id) {
  transport.viewAs = null;
  await transport.auth.login(id);
  state.listFilters.reseller = '';
  state.dashFilters.reseller = '';
  await loadSession();
  go('dashboard');
}

// --- Login ---------------------------------------------------------------------------------
async function renderLogin() {
  let users = [];
  let demo = false;
  let password = false;
  try {
    ({ demo, password } = await transport.auth.config());
    if (demo) users = await transport.auth.demoUsers();
  } catch { /* shown below */ }
  const describe = (u) => (u.role === 'admin' ? 'Kompas · alle resellere, registrering og administration'
    : u.role === 'viewer' ? 'Læseadgang · ser alle resellere, ændrer intet' : `Reseller · ser kun ${esc(u.reseller)}s aktiviteter`);
  $('#app').innerHTML = `
    <main class="login splash">
      <section class="splash-brand" aria-label="Kompas APL Tracker">
        <div class="splash-mark">${LOGO_MARK}</div>
        <p class="splash-name"><span class="wordmark-kompas">KOMPAS</span> APL Tracker</p>
        <h2 class="splash-head">Alle APL-kurser samlet ét sted</h2>
        <ul class="splash-points">
          <li>Afholdte og kommende kurser</li>
          <li>Kalender</li>
          <li>Hver reseller kan se de kurser, der vedrører dem</li>
        </ul>
        <p class="splash-foot">Kompas ApS · Praksisnær kompetenceudvikling</p>
      </section>
      <section class="login-card">
        <h1>Log ind</h1>
        <p class="muted">Velkommen. Log ind med den e-mail, Kompas har oprettet dig med.</p>
        ${password ? `
          <form id="login-form" class="login-form" novalidate>
            <label class="field"><span>E-mail</span><input id="l-email" type="email" autocomplete="username" required></label>
            <label class="field"><span>Adgangskode</span><input id="l-pass" type="password" autocomplete="current-password" required></label>
            <p class="form-error" id="l-err" role="alert" hidden></p>
            <button class="btn btn-primary btn-lg" type="submit">Log ind</button>
            <p class="muted small">Har du ikke en adgangskode, eller har du glemt den? Kontakt Kompas, så får du en ny.</p>
          </form>` : ''}
        ${demo ? `
          <p class="eyebrow">Demo-login · vælg en bruger</p>
          <div class="login-users">
            ${users.map((u) => `
              <button type="button" class="login-user" data-login="${u.id}">
                <span class="role-dot ${u.role === 'admin' ? 'is-admin' : ''}" aria-hidden="true"></span>
                <span><b>${esc(u.name)}</b><span class="muted small">${describe(u)}</span></span>
                <span class="chev" aria-hidden="true">→</span>
              </button>`).join('')}
          </div>
          <p class="muted small">Demo-login er kun til afprøvning og er slået fra på den rigtige server.</p>`
        : ''}
      </section>
    </main>`;
  if ($('#login-form')) {
    $('#l-email').focus();
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const err = $('#l-err');
      try {
        await transport.auth.passwordLogin($('#l-email').value, $('#l-pass').value);
        await loadSession();
        go(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    };
  }
  $$('[data-login]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      await transport.auth.login(Number(b.dataset.login));
      await loadSession();
      go(VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard');
    };
  });
}

// --- Change password -----------------------------------------------------------------------
function renderChangePassword(root, { forced }) {
  root.innerHTML = `
    <div class="pagehead"><div><p class="eyebrow">${esc(state.me.email)}</p><h1>${forced ? 'Vælg din adgangskode' : 'Skift adgangskode'}</h1>
      ${forced ? '<p class="muted">Du er logget ind med en engangskode. Vælg din egen adgangskode for at fortsætte.</p>' : ''}</div></div>
    <form id="pw-form" class="card form pw-form" novalidate>
      ${forced ? '' : '<label class="field"><span>Nuværende adgangskode</span><input id="pw-cur" type="password" autocomplete="current-password" required></label>'}
      <label class="field"><span>Ny adgangskode <small class="muted">· mindst 10 tegn</small></span><input id="pw-new" type="password" autocomplete="new-password" minlength="10" required></label>
      <label class="field"><span>Gentag ny adgangskode</span><input id="pw-new2" type="password" autocomplete="new-password" required></label>
      <p class="form-error" id="pw-err" role="alert" hidden></p>
      <div class="form-actions"><button class="btn btn-primary btn-lg" type="submit">Gem adgangskode</button>
        ${forced ? '' : '<button type="button" class="btn" data-go="dashboard">Annullér</button>'}</div>
    </form>`;
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#pw-err');
    const next = $('#pw-new').value;
    if (next !== $('#pw-new2').value) { err.textContent = 'De to adgangskoder er ikke ens.'; err.hidden = false; return; }
    try {
      await transport.auth.changePassword($('#pw-cur')?.value || '', next);
      state.me.must_change_password = false;
      toast('Adgangskode gemt');
      go('dashboard');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

// --- Dashboard -----------------------------------------------------------------------------
function yearOptions(selected, { all = true } = {}) {
  const years = new Set(state.options.years.map(String));
  years.add(String(new Date().getFullYear()));
  return `${all ? `<option value="" ${selected === '' ? 'selected' : ''}>Alle år</option>` : ''}${[...years].sort().reverse()
    .map((y) => `<option ${y === selected ? 'selected' : ''}>${y}</option>`).join('')}`;
}
function selectOptions(list, selected, emptyLabel) {
  return `${emptyLabel !== undefined ? `<option value="">${esc(emptyLabel)}</option>` : ''}${list
    .map((o) => `<option value="${o.id}" ${String(o.id) === String(selected) ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}`;
}

function chartSvg(monthly, year) {
  // Builds month buckets: Jan–Dec for a chosen year, otherwise first → last month with data.
  const map = Object.fromEntries(monthly.map((m) => [m.month, m]));
  let keys = [];
  if (year) keys = MONTHS.map((_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  else if (monthly.length) {
    let [y, m] = monthly[0].month.split('-').map(Number);
    const [ly, lm] = monthly[monthly.length - 1].month.split('-').map(Number);
    while (y < ly || (y === ly && m <= lm)) { keys.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  if (!keys.length) return '<p class="muted empty">Ingen aktiviteter i perioden.</p>';
  const held = keys.map((k) => map[k]?.held || 0);
  const planned = keys.map((k) => map[k]?.planned || 0);
  const values = keys.map((_, i) => held[i] + planned[i]);
  const max = Math.max(...values, 1);
  const top = Math.max(2, Math.ceil(max / 2) * 2);
  const W = window.innerWidth < 600 ? 380 : 640, H = window.innerWidth < 600 ? 220 : 200, padL = 28, padB = 26, padT = 18;
  const bw = (W - padL) / keys.length;
  const y = (v) => H - padB - ((H - padB - padT) * v) / top;
  const ticks = [0, top / 2, top];
  const showLabel = (i) => keys.length <= (W < 600 ? 12 : 14) || i % Math.ceil(keys.length / 12) === 0;
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Aktiviteter pr. måned">
      ${ticks.map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${padL - 8}" y="${y(t) + 4}" class="axis" text-anchor="end">${t}</text>`).join('')}
      ${values.map((v, i) => {
        const x = padL + i * bw + bw * 0.18;
        const w = bw * 0.64;
        const [ky, km] = keys[i].split('-');
        const label = year ? MONTHS[Number(km) - 1] : `${MONTHS[Number(km) - 1]} ${ky.slice(2)}`;
        const h = held[i];
        return `<g><title>${label}: ${h} afholdt${planned[i] ? `, ${planned[i]} planlagt` : ''}</title>
          ${v ? `${planned[i] ? `<rect x="${x}" y="${y(v)}" width="${w}" height="${y(h) - y(v)}" rx="3" class="bar-planned"/>` : ''}
                 ${h ? `<rect x="${x}" y="${y(h)}" width="${w}" height="${H - padB - y(h)}" rx="3" class="bar"/>` : ''}
                 <text x="${x + w / 2}" y="${y(v) - 5}" class="barval" text-anchor="middle">${v}</text>` : `<rect x="${x}" y="${H - padB - 1}" width="${w}" height="1" class="bar-zero"/>`}
          ${showLabel(i) ? `<text x="${x + w / 2}" y="${H - 8}" class="axis" text-anchor="middle">${label}</text>` : ''}</g>`;
      }).join('')}
    </svg>
    ${planned.some(Boolean) ? '<div class="legend"><span><i class="sw sw-held"></i>Afholdt</span><span><i class="sw sw-planned"></i>Kommende kurser</span></div>' : ''}`;
}

const participantsText = (a) => (a.status === 'planned' && !a.participants ? 'Deltagere ikke kendt endnu' : `${num(a.participants)} deltagere`);
// "Foreløbig" = has a date but awaits final approval from the school or municipality.
const statusPill = (a) => (a.pending ? '<span class="pill pill-pending" title="Foreløbig: Datoen er aftalt, men kurset er endnu ikke endeligt godkendt af skolen eller kommunen">Foreløbig</span>'
  : a.status === 'planned' ? '<span class="pill pill-planned">Planlagt</span>' : '<span class="pill pill-held">Afholdt</span>');
const rowState = (a) => (a.pending ? 'is-planned is-pending' : a.status === 'planned' ? 'is-planned' : '');

// Admins switch a coming course between "Planlagt" and "Foreløbig" by clicking its status in the list.
function statusCell(a) {
  if (!isAdmin() || a.status !== 'planned') return statusPill(a);
  const label = a.pending ? 'Foreløbig. Klik når kurset er godkendt' : 'Planlagt. Klik for at markere som foreløbig';
  return `<button type="button" class="pill-toggle" data-pending="${a.id}" title="${label}" aria-label="${label}">${statusPill(a)}</button>`;
}

// Has a user or a consultant started using the system? Shown in Administration.
const fmtSeen = (s) => new Date(`${String(s).replace(' ', 'T')}Z`).toLocaleString('da-DK', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const stateTag = (kind, text) => `<span class="state state-${kind}">${text}</span>`;
function userState(u) {
  if (u.last_login_at && !u.must_change_password) return stateTag('ok', `Aktiv · sidst set ${fmtSeen(u.last_seen_at || u.last_login_at)}`);
  if (u.last_login_at) return stateTag('wait', `Logget ind ${fmtSeen(u.last_login_at)} · mangler at vælge egen kode`);
  if (!u.has_password) return stateTag('none', 'Ingen adgang endnu · tryk Ny engangskode');
  return stateTag('wait', 'Har fået kode · ikke logget ind endnu');
}
function consultantState(c) {
  if (!c.has_link) return stateTag('none', 'Intet konsulentlink endnu');
  const parts = [];
  parts.push(c.page_seen_at ? `side sidst åbnet ${fmtSeen(c.page_seen_at)}` : 'har ikke åbnet siden endnu');
  if (c.feed_seen_at) parts.push(`kalender abonneret (hentet ${fmtSeen(c.feed_seen_at)})`);
  const text = parts.join(' · ');
  return stateTag(c.page_seen_at || c.feed_seen_at ? 'ok' : 'wait', text[0].toUpperCase() + text.slice(1));
}

// ★ = the course must be moved; it stays on its current date until a new one is found.
// Noter: a small speech bubble with the number of notes; the notes themselves are on the course page.
const NOTE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
// Admins click it to read and write notes without leaving the list; an empty, faint bubble means no notes yet.
const noteMark = (a) => {
  if (a.notes == null) return ''; // resellers and viewers never see notes
  const label = a.notes ? `${a.notes} ${a.notes === 1 ? 'note' : 'noter'}` : 'Skriv en note';
  return ` <button type="button" class="note-btn ${a.notes ? 'has-notes' : ''}" data-note-open="${a.id}" title="${label}" aria-label="${label}">${NOTE_ICON}${a.notes || ''}</button>`;
};
// ⚠ Dobbeltbooking: the consultant has another course the same day (admins only; a warning, never a block).
const dblMark = (a) => (a.double_booked ? ` <span class="dbl" title="${esc(a.consultant)} har ${a.double_booked === 1 ? 'et andet kursus' : `${a.double_booked} andre kurser`} samme dag" aria-label="Dobbeltbooking">⚠</span>` : '');
const durText = (a) => (a.duration === 'full' ? 'hel dag' : 'halv dag');
const star = (a) => (a.reschedule ? '<span class="star" title="Skal have ny dato. Står på den gamle dato, indtil en ny er fundet" aria-label="Skal have ny dato">★</span> ' : '');

// Short explanation of the three statuses, shown on Overblik and Aktiviteter.
function statusGuide() {
  const rows = [
    ['<span class="pill pill-held">Afholdt</span>', 'Kurset er gennemført: datoen er i dag eller passeret. Afholdte kurser tæller med i nøgletallene.'],
    ['<span class="pill pill-planned">Planlagt</span>', 'Kurset er godkendt og har en dato efter i dag. Det vises under Kommende kurser.'],
    ['<span class="star">★</span>', 'Kurset skal have en ny dato. Det står på den gamle dato, indtil en ny er fundet.'],
    ['<span class="pill pill-pending">Foreløbig</span>', 'Datoen er aftalt, men kurset er endnu ikke endeligt godkendt af skolen eller kommunen. Det vises under Kommende kurser og tæller ikke med som afholdt, før det er godkendt.'],
  ];
  return `<details class="howto status-guide"><summary>Hvad betyder Afholdt, Planlagt og Foreløbig?</summary>
    <dl class="guide-list">${rows.map(([pill, text]) => `<div><dt>${pill}</dt><dd>${text}</dd></div>`).join('')}</dl>
    ${isAdmin() ? '<p class="muted small">Du skifter mellem Planlagt og Foreløbig ved at klikke på mærket i listen eller med fluebenet i formularen.</p>' : ''}
  </details>`;
}

function bindPendingToggle(scope, onSaved) {
  $$('[data-pending]', scope).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pending = !btn.querySelector('.pill-pending');
      btn.disabled = true;
      try {
        const a = await api.put(`/api/activities/${btn.dataset.pending}/pending`, { pending });
        toast(a.pending ? 'Markeret som foreløbig' : 'Markeret som godkendt');
        onSaved?.(a);
      } catch (ex) { btn.disabled = false; toast(ex.message, 'err'); }
    });
    btn.addEventListener('keydown', (e) => e.stopPropagation());
  });
}

// Admins can change the number of participants straight from the lists (no need to open the form).
function participantsCell(a, label = false) {
  const shown = a.status === 'planned' && !a.participants ? '' : String(a.participants);
  if (!isAdmin()) return label ? participantsText(a) : (shown ? num(a.participants) : '–');
  return `<label class="pedit${label ? ' pedit-inline' : ''}"><input type="number" inputmode="numeric" min="0" step="1" class="pinput" data-pid="${a.id}"
    value="${shown}" placeholder="–" aria-label="Deltagere, ${esc(a.title)} ${esc(fmtDate(a.date))}">${label ? '<span>deltagere</span>' : ''}</label>`;
}

function bindParticipants(scope, onSaved) {
  $$('.pinput', scope).forEach((input) => {
    let saved = input.value;
    ['click', 'keydown', 'pointerdown'].forEach((t) => input.addEventListener(t, (e) => e.stopPropagation()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = saved; input.blur(); }
    });
    input.addEventListener('change', async () => {
      const value = input.value.trim();
      if (value === saved) return;
      if (!/^\d+$/.test(value)) { input.value = saved; toast('Skriv et helt tal', 'err'); return; }
      input.classList.add('is-saving');
      try {
        const a = await api.put(`/api/activities/${input.dataset.pid}/participants`, { participants: Number(value) });
        saved = value;
        input.classList.remove('is-saving'); input.classList.add('is-saved');
        setTimeout(() => input.classList.remove('is-saved'), 1200);
        onSaved?.(a);
      } catch (ex) { input.value = saved; input.classList.remove('is-saving'); toast(ex.message, 'err'); }
    });
  });
}

function activityLine(a) {
  return `
    <li class="latest-item ${rowState(a)}">
      <div class="latest-date">${fmtDate(a.date, true)}${a.start_time ? `<div class="muted small">${a.start_time}</div>` : ''}</div>
      <div class="latest-body">
        <div class="latest-title">${star(a)}${esc(a.apl_type)} · ${esc(a.title)}${a.pending ? ` ${statusPill(a)}` : ''}${a.notes ? noteMark(a) : ''}</div>
        <div class="muted">${esc(a.school || '–')}${a.municipality ? ` · ${esc(a.municipality)}` : ''}</div>
        <div class="latest-meta">
          <span>${participantsCell(a, true)}</span><span>${esc(a.consultant || '')}${dblMark(a)}</span>
          ${seesAll() ? `<span class="tag">${esc(a.reseller)}</span>` : ''}
        </div>
      </div>
    </li>`;
}

// Upcoming days where a consultant is on more than one course.
function doubleBookingCard(list) {
  if (!list.length) return '';
  return `<section class="card dbl-card" aria-label="Dobbeltbookinger">
    <div class="card-head"><h2><span class="dbl" aria-hidden="true">⚠</span> Dobbeltbookinger</h2><span class="muted small">Kommende dage, hvor en konsulent står på mere end ét kursus</span></div>
    <ul class="dbl-list">${list.map((g) => `<li>
      <b class="nowrap">${fmtDate(g.date)} · ${esc(g.consultant)}</b>
      <span>${g.courses.map((c) => `<button type="button" class="linkbtn" data-dbl-edit="${c.id}">${esc(c.title)}</button> <span class="muted">(${esc(c.school || c.municipality || '')}${c.school || c.municipality ? ', ' : ''}${timeText(c) ? `${timeText(c)}, ` : ''}${durText(c)}${c.pending ? ', foreløbig' : ''})</span>`).join('<span class="muted"> og </span>')}</span>
      ${g.courses.length === 2 && g.courses.every((c) => c.duration === 'half' && !(c.start_time && c.end_time)) ? '<span class="muted small">To halve dage, så det kan godt passe.</span>' : ''}
    </li>`).join('')}</ul>
  </section>`;
}

// Konsulentoverblik: how the courses are shared between the consultants (admins only).
function consultantOverview({ rows, unassigned }, year) {
  const sum = (r) => r.held + r.planned + r.pending;
  const sorted = [...rows].sort((x, y) => sum(y) - sum(x) || x.name.localeCompare(y.name, 'da'));
  const max = Math.max(1, ...rows.map(sum));
  const total = (key) => rows.reduce((n, r) => n + r[key], 0);
  const pct = (n) => `${(n / max) * 100}%`;
  return `<section class="card consult-card">
    <div class="card-head"><h2>Konsulentoverblik</h2><span class="muted small">Afholdt ${year ? `i ${esc(year)}` : 'i alt'} · kommende kurser på alle datoer</span></div>
    <div class="table-wrap consult-wrap"><table class="table consult-table">
      <thead><tr><th>Konsulent</th><th class="num">Afholdt</th><th class="num hide-sm">Apple-workshops</th><th class="num">Planlagt</th><th class="num">Foreløbig</th>
        <th class="hide-sm">Næste kursus</th><th class="consult-barcol"><span class="sr">Fordeling</span></th></tr></thead>
      <tbody>${sorted.map((r) => `<tr class="${sum(r) ? '' : 'is-empty'}">
        <td><button type="button" class="linkbtn consult-name" data-consultant="${r.id}" title="Se ${esc(r.name)}s kurser">${esc(r.name)}</button></td>
        <td class="num"><b>${num(r.held)}</b></td><td class="num hide-sm">${num(r.workshops)}</td>
        <td class="num">${num(r.planned)}</td><td class="num">${r.pending ? num(r.pending) : '<span class="muted">0</span>'}</td>
        <td class="nowrap hide-sm">${r.next ? fmtDate(r.next) : '<span class="muted">–</span>'}</td>
        <td class="consult-barcol"><div class="cbar" aria-hidden="true"><i class="cb-held" data-w="${pct(r.held)}"></i><i class="cb-planned" data-w="${pct(r.planned)}"></i><i class="cb-pending" data-w="${pct(r.pending)}"></i></div></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td>I alt</td><td class="num">${num(total('held'))}</td><td class="num hide-sm">${num(total('workshops'))}</td><td class="num">${num(total('planned'))}</td><td class="num">${num(total('pending'))}</td><td class="hide-sm"></td><td class="consult-barcol"></td></tr></tfoot>
    </table></div>
    <div class="legend"><span><i class="sw sw-held"></i>Afholdt</span><span><i class="sw sw-planned"></i>Planlagt</span><span><i class="sw sw-pending"></i>Foreløbig</span></div>
    ${unassigned ? `<p class="muted small">${num(unassigned)} ${unassigned === 1 ? 'kommende kursus har' : 'kommende kurser har'} ingen konsulent endnu (se <a href="#signup" data-go="signup">Tilmelding</a>).</p>` : ''}
    <p class="muted small">Foreløbige kurser tæller aldrig som afholdt. Klik på et navn for at se konsulentens kurser.</p>
  </section>`;
}

async function renderDashboard(root) {
  const f = state.dashFilters;
  root.innerHTML = `
    <div class="pagehead">
      <div>
        <p class="eyebrow">Kompas APL Tracker</p>
        <h1>Overblik over APL</h1>
        ${!seesAll() ? `<p class="muted">Aktiviteter gennemført af Kompas for ${esc(state.me.reseller)}.</p>` : ''}
      </div>
      ${isAdmin() ? '<button class="btn btn-primary" data-go="register" type="button">+ Registrér aktivitet</button>' : ''}
    </div>
    <div class="filters filters-inline">
      <label class="field field-compact"><span>År</span><select id="d-year">${yearOptions(f.year)}</select></label>
      ${seesAll() ? `<label class="field field-compact"><span>Reseller</span><select id="d-reseller">${selectOptions(state.options.resellers, f.reseller, 'Alle resellere')}</select></label>` : ''}
    </div>
    <div id="dash-body" aria-live="polite"><div class="loading">Indlæser…</div></div>`;
  $('#d-year').onchange = (e) => { f.year = e.target.value; renderDashboard(root); };
  if ($('#d-reseller')) $('#d-reseller').onchange = (e) => { f.reseller = e.target.value; renderDashboard(root); };

  const d = await api.get(`/api/dashboard${qs(f)}`);
  const k = d.kpi;
  $('#dash-body').innerHTML = `
    ${d.doubleBookings ? doubleBookingCard(d.doubleBookings) : ''}
    <p class="section-label">Afholdte kurser${f.year ? ` · ${esc(f.year)}` : ''}</p>
    <section class="kpis kpis-5" aria-label="Nøgletal for afholdte kurser">
      <div class="kpi"><div class="kpi-num">${num(k.experiences)}</div><div class="kpi-label">APL-aktiviteter</div></div>
      <div class="kpi"><div class="kpi-num">${num(k.participants)}</div><div class="kpi-label">Deltagere</div></div>
      <div class="kpi"><div class="kpi-num">${num(k.half_days)}</div><div class="kpi-label">Halve dage</div></div>
      <div class="kpi"><div class="kpi-num">${num(k.full_days)}</div><div class="kpi-label">Hele dage</div></div>
      <div class="kpi kpi-apple"><div class="kpi-num">${num(k.half_days + 2 * k.full_days)}</div><div class="kpi-label">Apple-workshops</div>
        <div class="kpi-sub">halv dag = 1 · hel dag = 2</div></div>
    </section>
    <div class="dash-grid">
      <section class="card">
        <div class="card-head"><h2>Aktiviteter over tid</h2><span class="muted small">${f.year ? `Pr. måned, ${esc(f.year)}` : 'Pr. måned, alle år'}</span></div>
        ${chartSvg(d.monthly, f.year)}
      </section>
      <section class="card">
        <div class="card-head"><h2>Seneste aktiviteter</h2><a href="#activities" data-go="activities" class="small">Se alle</a></div>
        ${d.latest.length ? `<ul class="latest">${d.latest.map(activityLine).join('')}</ul>` : '<p class="muted empty">Ingen aktiviteter i perioden.</p>'}
      </section>
    </div>
    <section class="card orderbook">
      <div class="card-head"><h2>Kommende kurser</h2><a href="#activities" data-go="activities" id="ob-all" class="small">Se alle kommende kurser</a></div>
      <div class="ob-stats">
        <div><b>${num(d.orderbook.courses)}</b><span>kommende kurser${d.orderbook.pending ? ` · heraf ${num(d.orderbook.pending)} foreløbige` : ''}</span></div>
        <div><b>${num(d.orderbook.half_days)}</b><span>halve dage</span></div>
        <div><b>${num(d.orderbook.full_days)}</b><span>hele dage</span></div>
      </div>
      ${d.upcoming.length ? `<ul class="latest latest-cols">${d.upcoming.map(activityLine).join('')}</ul>` : '<p class="muted empty">Ingen planlagte kurser i perioden.</p>'}
      ${statusGuide()}
    </section>
    ${d.consultants ? consultantOverview(d.consultants, f.year) : ''}`;
  bindParticipants(root, () => toast('Deltagere gemt'));
  // Set from script, as the page's security policy does not allow inline style attributes.
  $$('.cbar [data-w]', root).forEach((el) => { el.style.width = el.dataset.w; });
  $$('[data-consultant]', root).forEach((b) => {
    b.onclick = () => {
      Object.assign(state.listFilters, { q: '', status: '', year: '', from: '', to: '', municipality: '', type: '', reschedule: '', consultant: b.dataset.consultant });
      go('activities');
    };
  });
  $$('[data-dbl-edit]', root).forEach((b) => { b.onclick = async () => go('register', { editing: await api.get(`/api/activities/${b.dataset.dblEdit}`) }); });
  $('#ob-all').addEventListener('click', () => { Object.assign(state.listFilters, { status: 'planned', year: '', from: '', to: '' }); }, true);
}

// --- Activities ----------------------------------------------------------------------------
function activityFilters() {
  const f = state.listFilters;
  const o = state.options;
  return `
    <div class="filters">
      <div class="field field-status"><span id="st-label">Status</span>
        <div class="seg" role="radiogroup" aria-labelledby="st-label">
          ${[['', 'Alle'], ['held', 'Afholdt'], ['planned', 'Kommende kurser'], ['pending', 'Foreløbig']].map(([val, l]) => `<label><input type="radio" name="f-status" value="${val}" ${f.status === val ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
      </div>
      <label class="field field-search"><span>Søg</span><input id="f-q" type="search" placeholder="Emne, skole, kommune, konsulent…" value="${esc(f.q)}"></label>
      <label class="field"><span>År</span><select id="f-year">${yearOptions(f.year)}</select></label>
      <label class="field"><span>Fra dato</span><input id="f-from" type="date" value="${esc(f.from)}"></label>
      <label class="field"><span>Til dato</span><input id="f-to" type="date" value="${esc(f.to)}"></label>
      ${seesAll() ? `<label class="field"><span>Reseller</span><select id="f-reseller">${selectOptions(o.resellers, f.reseller, 'Alle')}</select></label>` : ''}
      <label class="field"><span>Kommune</span><select id="f-municipality">${selectOptions(o.municipalities, f.municipality, 'Alle')}</select></label>
      <label class="field"><span>Konsulent</span><select id="f-consultant">${selectOptions(o.consultants, f.consultant, 'Alle')}</select></label>
      <label class="field"><span>APL-type</span><select id="f-type">${selectOptions(o.aplTypes, f.type, 'Alle')}</select></label>
      <label class="field filter-check"><input type="checkbox" id="f-reschedule" ${f.reschedule ? 'checked' : ''}><span><span class="star">★</span> Skal have ny dato</span></label>
    </div>`;
}

async function renderActivities(root) {
  root.innerHTML = `
    <div class="pagehead">
      <div><p class="eyebrow">${seesAll() ? 'Alle resellere' : esc(state.me.reseller)}</p><h1>Aktiviteter</h1></div>
      <div class="pagehead-actions">
        ${isAdmin() ? '<button class="btn" data-go="import" type="button">Importér Excel/CSV</button>' : ''}
        <button class="btn" id="export-xlsx" type="button">Eksportér Excel</button>
        <button class="btn" id="export-csv" type="button">Eksportér CSV</button>
      </div>
    </div>
    ${activityFilters()}
    <div class="listbar"><span id="list-summary" class="muted" aria-live="polite"></span><button type="button" class="linkbtn" id="f-clear">Nulstil filtre</button></div>
    ${statusGuide()}
    <div id="list-body"></div>`;
  const f = state.listFilters;
  let timer;
  const bind = (id, key, ev = 'change') => {
    $(id).addEventListener(ev, (e) => {
      f[key] = e.target.value;
      if (key === 'from' || key === 'to') { if (f.from || f.to) { f.year = ''; $('#f-year').value = ''; } }
      if (key === 'year' && f.year) { f.from = ''; f.to = ''; $('#f-from').value = ''; $('#f-to').value = ''; }
      clearTimeout(timer);
      timer = setTimeout(loadList, ev === 'input' ? 200 : 0);
    });
  };
  bind('#f-q', 'q', 'input');
  ['year', 'from', 'to', 'municipality', 'consultant', 'type'].forEach((k) => bind(`#f-${k}`, k));
  $$('input[name="f-status"]').forEach((r) => {
    r.onchange = () => {
      f.status = r.value;
      // Coming and Foreløbig courses often fall in next year, so the year filter is cleared for them.
      if (['planned', 'pending'].includes(r.value) && f.year) { f.year = ''; $('#f-year').value = ''; }
      loadList();
    };
  });
  if (seesAll()) bind('#f-reseller', 'reseller');
  $('#f-reschedule').onchange = (e) => {
    f.reschedule = e.target.checked ? '1' : '';
    if (f.reschedule) { f.year = ''; $('#f-year').value = ''; }
    loadList();
  };
  $('#f-clear').onclick = () => {
    Object.assign(f, { q: '', status: '', year: '', from: '', to: '', reseller: '', municipality: '', consultant: '', type: '', reschedule: '' });
    renderActivities(root);
  };
  const exportAs = async (format, btn) => {
    btn.disabled = true;
    try {
      const name = await transport.download(`/api/activities/export${qs({ ...f, format })}`);
      if (name) toast(`Eksporteret: ${name}`);
    } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
  };
  $('#export-xlsx').onclick = (e) => exportAs('xlsx', e.currentTarget);
  $('#export-csv').onclick = (e) => exportAs('csv', e.currentTarget);
  await loadList();
}

async function loadList() {
  const rows = await api.get(`/api/activities${qs(state.listFilters)}`);
  const body = $('#list-body');
  if (!body) return;
  const total = rows.reduce((s, r) => s + r.participants, 0);
  const summary = (sum) => {
    const nPlanned = rows.filter((r) => r.status === 'planned').length;
    const nPending = rows.filter((r) => r.pending).length;
    return `${num(rows.length)} ${rows.length === 1 ? 'aktivitet' : 'aktiviteter'} · ${num(rows.length - nPlanned)} afholdt · ${num(nPlanned)} kommende${nPending ? ` (heraf ${num(nPending)} foreløbige)` : ''} · ${num(sum)} deltagere`;
  };
  $('#list-summary').textContent = summary(total);
  if (!rows.length) { body.innerHTML = '<div class="card"><p class="muted empty">Ingen aktiviteter matcher filtrene.</p></div>'; return; }
  const admin = isAdmin();
  body.innerHTML = `
    <div class="table-wrap card card-flush">
      <table class="table">
        <thead><tr><th>Dato</th><th>Status</th><th>APL-type</th><th>Titel/emne</th><th>Skole</th><th>Kommune</th>
          <th class="num">Deltagere</th><th>Varighed</th><th>Konsulent</th><th>Reseller</th><th>Betalt af</th>${admin ? '<th><span class="sr">Redigér</span></th>' : ''}</tr></thead>
        <tbody>${rows.map((a) => `
          <tr class="${rowState(a)} ${admin ? 'clickable' : ''}" ${admin ? `data-edit="${a.id}"` : ''}>
            <td class="nowrap">${fmtDate(a.date)}${timeSub(a)}</td><td>${statusCell(a)}</td><td>${esc(a.apl_type)}</td><td>${star(a)}<b>${esc(a.title)}</b>${noteMark(a)}</td>
            <td>${esc(a.school || '–')}</td><td>${esc(a.municipality || '–')}</td><td class="num">${participantsCell(a)}</td>
            <td class="nowrap">${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</td><td>${esc(a.consultant || '–')}${dblMark(a)}</td>
            <td><span class="tag">${esc(a.reseller)}</span></td><td>${esc(a.paid_by || '–')}</td>
            ${admin ? `<td><button type="button" class="linkbtn" data-edit="${a.id}">Redigér</button></td>` : ''}
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <ul class="cards-list">${rows.map((a) => `
      <li class="card act-card ${rowState(a)} ${admin ? 'clickable' : ''}" ${admin ? `data-edit="${a.id}" role="button" tabindex="0"` : ''}>
        <div class="act-top"><span class="act-date">${fmtDate(a.date)}${withTime(a)} ${statusCell(a)}</span><span class="tag">${esc(a.reseller)}</span></div>
        <div class="act-title">${star(a)}${esc(a.apl_type)} · ${esc(a.title)}${noteMark(a)}</div>
        <div class="muted">${esc(a.school || '–')}${a.municipality ? ` · ${esc(a.municipality)}` : ''}</div>
        <dl class="act-meta">
          <div><dt>Deltagere</dt><dd>${participantsCell(a)}</dd></div>
          <div><dt>Varighed</dt><dd>${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</dd></div>
          <div><dt>Konsulent</dt><dd>${esc(a.consultant || '–')}${dblMark(a)}</dd></div>
          <div><dt>Betalt af</dt><dd>${esc(a.paid_by || '–')}</dd></div>
        </dl>
      </li>`).join('')}</ul>`;
  if (admin) {
    bindParticipants(body, (saved) => {
      const r = rows.find((x) => x.id === saved.id);
      if (r) r.participants = saved.participants;
      $$(`.pinput[data-pid="${saved.id}"]`, body).forEach((el) => { el.value = String(saved.participants); });
      $('#list-summary').textContent = summary(rows.reduce((n, x) => n + x.participants, 0));
      toast('Deltagere gemt');
    });
    bindPendingToggle(body, () => loadList());
    const open = async (id) => go('register', { editing: await api.get(`/api/activities/${id}`) });
    $$('[data-edit]', body).forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); open(el.dataset.edit); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(el.dataset.edit); });
    });
  }
}

// --- Register / edit activity --------------------------------------------------------------
function renderRegister(root) {
  const o = state.options;
  const a = state.editing;
  const last = store.get('lastForm', {});
  const pre = !a ? state.prefill : null;
  const copy = !a ? state.copyOf : null;
  // A copy keeps everything except the consultant, who is picked again.
  const v = a || (copy && { ...copy, consultant_id: '' }) || {
    date: todayIso(), duration: 'half', apl_type_id: (o.aplTypes.find((t) => t.name === 'Workshop Fysisk') || o.aplTypes[0])?.id, title: '', school_id: '', school: '',
    municipality_id: '', participants: '', consultant_id: last.consultant_id || '', reseller_id: '', paid_by_id: '',
    ...(pre ? Object.fromEntries(Object.entries(pre).filter(([, x]) => x !== '' && x != null)) : {}),
  };
  const quickTitles = o.titles.slice(0, 8);
  root.innerHTML = `
    <div class="pagehead">
      <div><p class="eyebrow">${a ? 'Redigér aktivitet' : copy ? 'Kopi af kursus' : 'Ny aktivitet'}</p><h1>${a ? esc(a.title) : copy ? `Dublér: ${esc(copy.title)}` : 'Registrér aktivitet'}</h1></div>
      ${a || copy ? '<button type="button" class="btn" data-go="activities">Tilbage til aktiviteter</button>' : ''}
      ${pre ? '<button type="button" class="btn" data-go="calendar">Tilbage til kalender</button>' : ''}
    </div>
    ${copy ? '<p class="notice">Alle felter er kopieret. Vælg en eller flere konsulenter: der oprettes ét kursus pr. konsulent.</p>' : ''}
    ${pre?.eventTitle ? `<p class="notice">Udfyldt fra kalenderaftalen <b>${esc(pre.eventTitle)}</b>. Tjek felterne, og tilføj antal deltagere og reseller.</p>` : ''}
    <form id="act-form" class="card form" novalidate autocomplete="off">
      <div class="form-grid">
        <label class="field"><span>Dato</span><input id="a-date" name="date" type="date" required value="${esc(v.date)}"></label>
        <div class="field"><span id="time-label">Tidspunkt <small class="muted">· valgfrit, 24-timers ur</small></span>
          <div class="time-range" role="group" aria-labelledby="time-label">
            <input id="a-start" name="start_time" type="text" inputmode="decimal" maxlength="5" placeholder="09:00" value="${esc(v.start_time || '')}" aria-label="Starttidspunkt">
            <span aria-hidden="true">til</span>
            <input id="a-end" name="end_time" type="text" inputmode="decimal" maxlength="5" placeholder="12:00" value="${esc(v.end_time || '')}" aria-label="Sluttidspunkt">
          </div>
        </div>
        <div class="field"><span id="dur-label">Varighed</span>
          <div class="seg seg-lg" role="radiogroup" aria-labelledby="dur-label">
            <label><input type="radio" name="duration" value="half" ${v.duration !== 'full' ? 'checked' : ''}><span>Halv dag</span></label>
            <label><input type="radio" name="duration" value="full" ${v.duration === 'full' ? 'checked' : ''}><span>Hel dag</span></label>
          </div>
        </div>
        <label class="field"><span>Type af APL-aktivitet</span><select id="a-type" name="apl_type_id" required>${selectOptions(o.aplTypes, v.apl_type_id)}</select></label>
        <div class="field">
          <label for="a-title">Titel / emne</label>
          <input id="a-title" name="title" required list="titles" value="${esc(v.title)}" placeholder="fx Mac – module 1">
          <datalist id="titles">${o.titles.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <div class="chips" aria-label="Mest brugte emner">${quickTitles.map((t) => `<button type="button" class="chip" data-title="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        </div>
        <div class="field combo">
          <label for="a-school">Skole</label>
          <input id="a-school" type="text" role="combobox" aria-expanded="false" aria-controls="school-list" aria-autocomplete="list"
            value="${esc(v.school || '')}" placeholder="Begynd at skrive skolens navn">
          <input type="hidden" name="school_id" id="a-school-id" value="${esc(v.school_id || '')}">
          ${pre?.uid ? `<input type="hidden" name="calendar_uid" value="${esc(pre.uid)}">` : ''}
          <ul id="school-list" class="combo-list" role="listbox" hidden></ul>
          <small id="school-hint" class="hint"></small>
        </div>
        <label class="field"><span>Kommune</span><select id="a-muni" name="municipality_id">${selectOptions(o.municipalities, v.municipality_id, 'Vælg kommune')}</select></label>
        <label class="field"><span>Antal deltagere <small class="muted" id="p-hint"></small></span><input id="a-participants" name="participants" type="number" inputmode="numeric" min="0" step="1" required value="${esc(v.participants)}"></label>
        ${a ? `<label class="field"><span>Konsulent</span><select id="a-consultant" name="consultant_id" required>${selectOptions(o.consultants, v.consultant_id, 'Vælg konsulent')}</select></label>`
          : `<div class="field field-wide"><span id="cons-label">Konsulent <small class="muted">· vælg flere for at oprette ét kursus pr. konsulent</small></span>
          <div class="seg seg-lg seg-wrap" role="group" aria-labelledby="cons-label">
            ${o.consultants.map((c) => `<label><input type="checkbox" name="consultant_ids" value="${c.id}" ${String(c.id) === String(v.consultant_id) ? 'checked' : ''}><span>${esc(c.name)}</span></label>`).join('')}
          </div></div>`}
        <p id="same-day" class="dbl-warn field-wide" role="status" hidden></p>
        <div class="field"><span id="res-label">Reseller / partner <small class="muted">· styrer hvem der kan se den</small></span>
          <div class="seg seg-lg seg-wrap" role="radiogroup" aria-labelledby="res-label">
            ${o.resellers.map((r) => `<label><input type="radio" name="reseller_id" value="${r.id}" ${String(r.id) === String(v.reseller_id) ? 'checked' : ''}><span>${esc(r.name)}</span></label>`).join('')}
          </div>
        </div>
        <label class="field"><span>Betalt af</span><select id="a-paid" name="paid_by_id">${selectOptions(o.paidBy, v.paid_by_id, 'Vælg hvem der betalte')}</select></label>
        <label class="field field-wide check-field"><input type="checkbox" id="a-pending" name="pending" value="1" ${v.pending ? 'checked' : ''}>
          <span><b>Foreløbig</b><small class="muted">Datoen er aftalt, men kurset er endnu ikke endeligt godkendt af skolen eller kommunen.</small></span></label>
        <label class="field field-wide check-field check-star"><input type="checkbox" id="a-reschedule" name="reschedule" value="1" ${v.reschedule ? 'checked' : ''}>
          <span><b>★ Skal have ny dato</b><small class="muted">Kurset skal flyttes. Det bliver stående på datoen ovenfor, indtil du retter den, og vises med en stjerne.</small></span></label>
        ${a ? '' : `<label class="field field-wide"><span>Note <small class="muted">· valgfri, ses kun af Kompas og konsulenten</small></span>
          <textarea id="a-note" name="note" rows="2" maxlength="1000" placeholder="fx detaljer om kurset, noget man skal huske, eller en idé"></textarea></label>`}
      </div>
      <p id="form-error" class="form-error" role="alert" hidden></p>
      <p class="muted small form-tip">Mangler en konsulent, kommune, APL-type eller betaler i listerne? Tilføj den under <a href="#admin" data-go="admin">Administration</a>. Nye skoler kan skrives direkte i feltet.</p>
      <div class="form-actions">
        <button class="btn btn-primary btn-lg" type="submit">${a ? 'Gem ændringer' : 'Registrér aktivitet'}</button>
        ${a ? `<button type="button" class="btn btn-lg" id="dup">Dublér kursus</button>
          <span class="spacer"></span>
          <button type="button" class="btn btn-danger-ghost" id="del">Slet aktivitet</button>
          <span id="del-confirm" class="del-confirm" hidden>Slet aktiviteten permanent?
            <button type="button" class="btn btn-danger btn-sm" id="del-yes">Slet</button>
            <button type="button" class="btn btn-sm" id="del-no">Annullér</button></span>` : ''}
      </div>
    </form>
    ${a ? '<section class="card notes-card" id="notes" aria-live="polite"></section>' : ''}`;

  const form = $('#act-form');
  ['#a-start', '#a-end'].forEach((sel) => $(sel).addEventListener('blur', (e) => { e.target.value = normClock(e.target.value); }));
  const chosen = () => (a ? [] : $$('input[name="consultant_ids"]:checked').map((x) => x.value));
  const planHint = () => {
    const parts = [];
    if (chosen().length > 1) parts.push('pr. konsulent');
    if ($('#a-date').value > todayIso() || $('#a-pending').checked) parts.push('kan udfyldes senere (planlagt kursus)');
    $('#p-hint').textContent = parts.length ? `· ${parts.join(', ')}` : '';
    if (!a) {
      const n = chosen().length;
      form.querySelector('[type=submit]').textContent = n > 1 ? `Registrér ${n} kurser` : 'Registrér aktivitet';
    }
  };
  $$('input[name="consultant_ids"]').forEach((x) => x.addEventListener('change', planHint));
  $('#a-date').addEventListener('change', planHint);

  // Dobbeltbooking: warn (but allow saving) when a chosen consultant already has a course that day.
  let sameDayReq = 0;
  const checkSameDay = async () => {
    const box = $('#same-day');
    const ids = a ? [$('#a-consultant').value].filter(Boolean) : chosen();
    const date = $('#a-date').value;
    const req = ++sameDayReq;
    if (!date || !ids.length) { box.hidden = true; return; }
    let rows = [];
    const start = normClock($('#a-start').value);
    const end = normClock($('#a-end').value);
    try { rows = await api.get(`/api/activities/same-day${qs({ date, start, end, consultants: ids.join(','), exclude: a?.id || '' })}`); } catch { /* the warning is only a help */ }
    if (req !== sameDayReq) return;
    const byName = new Map();
    rows.forEach((r) => byName.set(r.consultant, [...(byName.get(r.consultant) || []), r]));
    box.innerHTML = [...byName].map(([name, list]) => `<span><b>⚠ ${esc(name)}</b> har allerede ${list.length === 1 ? 'et kursus' : `${list.length} kurser`} ${fmtDate(date)}:
      ${list.map((r) => `${esc(r.title)}${r.school ? `, ${esc(r.school)}` : ''} (${timeText(r) ? `${timeText(r)}, ` : ''}${durText(r)}${r.pending ? ', foreløbig' : ''})`).join('; ')}.</span>`).join('')
      + (rows.length ? `<span class="muted small">Du kan godt gemme alligevel, fx hvis det er to halve dage.${rows.some((r) => !(r.start_time && r.end_time)) || !(start && end) ? ' Skriv start- og sluttid på begge kurser, så advarer vi kun, når tiderne overlapper.' : ''}</span>` : '');
    box.hidden = !rows.length;
  };
  $$('input[name="consultant_ids"]').forEach((x) => x.addEventListener('change', checkSameDay));
  $('#a-consultant')?.addEventListener('change', checkSameDay);
  $('#a-date').addEventListener('change', checkSameDay);
  ['#a-start', '#a-end'].forEach((sel) => $(sel).addEventListener('change', checkSameDay));
  checkSameDay();
  $('#a-pending').addEventListener('change', planHint);
  planHint();
  $$('[data-title]').forEach((b) => { b.onclick = () => { $('#a-title').value = b.dataset.title; $('#a-school').focus(); }; });

  // Paid by follows the reseller until the user picks something else.
  let paidTouched = Boolean(a);
  $('#a-paid').onchange = () => { paidTouched = true; };
  $$('input[name="reseller_id"]').forEach((r) => {
    r.onchange = () => {
      if (paidTouched) return;
      const name = o.resellers.find((x) => String(x.id) === r.value)?.name;
      const match = o.paidBy.find((p) => p.name.toLowerCase() === String(name).toLowerCase());
      if (match) $('#a-paid').value = match.id;
    };
  });

  // School combobox: pick an existing school (fills municipality) or type a new one.
  const input = $('#a-school');
  const list = $('#school-list');
  const hidden = $('#a-school-id');
  const hint = $('#school-hint');
  let active = -1;
  let matches = [];
  const updateHint = () => {
    const name = input.value.trim();
    hint.textContent = name && !hidden.value ? 'Ny skole. Den bliver tilføjet til listen med den kommune, du vælger.' : '';
  };
  const pick = (s) => {
    input.value = s.name;
    hidden.value = s.id;
    if (s.municipality_id) $('#a-muni').value = s.municipality_id;
    close();
    updateHint();
    $('#a-participants').focus();
  };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const show = () => {
    const q = input.value.trim().toLowerCase();
    matches = o.schools.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.municipality || '').toLowerCase().includes(q)).slice(0, 8);
    list.innerHTML = matches.map((s, i) => `<li role="option" id="opt-${i}" data-i="${i}" class="${i === active ? 'active' : ''}">
        <b>${esc(s.name)}</b><span class="muted">${esc(s.municipality || '')}</span></li>`).join('');
    list.hidden = !matches.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };
  input.addEventListener('input', () => {
    hidden.value = '';
    const exact = o.schools.filter((s) => s.name.toLowerCase() === input.value.trim().toLowerCase());
    if (exact.length === 1) { hidden.value = exact[0].id; if (exact[0].municipality_id) $('#a-muni').value = exact[0].municipality_id; }
    active = -1;
    show();
    updateHint();
  });
  input.addEventListener('focus', show);
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, matches.length - 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { pick(matches[active]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); pick(matches[Number(li.dataset.i)]); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  updateHint();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.start_time = normClock(data.start_time);
    data.end_time = normClock(data.end_time);
    const consultantIds = a ? [data.consultant_id].filter(Boolean) : chosen();
    delete data.consultant_ids;
    const note = String(data.note || '').trim();
    delete data.note;
    if (!data.school_id) data.school_name = input.value.trim();
    const err = $('#form-error');
    const missing = [];
    if (!data.date) missing.push('dato');
    if (!data.title?.trim()) missing.push('titel / emne');
    if (data.participants === '' && data.date <= todayIso() && !data.pending) missing.push('antal deltagere');
    if (!consultantIds.length) missing.push('konsulent');
    if (!data.reseller_id) missing.push('reseller / partner');
    if (missing.length) { err.textContent = `Udfyld venligst: ${missing.join(', ')}.`; err.hidden = false; return; }
    err.hidden = true;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      if (a) {
        await api.put(`/api/activities/${a.id}`, data);
        // A note typed below but not added yet is saved together with the course.
        const pendingNote = $('#notes .note-form textarea')?.value.trim();
        if (pendingNote) await api.post(`/api/activities/${a.id}/notes`, { body: pendingNote });
      } else {
        // One course per consultant. The first call may create a new school; the rest reuse it.
        const first = await api.post('/api/activities', { ...data, consultant_id: consultantIds[0] });
        const ids = [first.id];
        for (const cid of consultantIds.slice(1)) {
          ids.push((await api.post('/api/activities', { ...data, school_id: first.school_id || '', school_name: first.school_id ? '' : data.school_name, consultant_id: cid })).id);
        }
        // The note goes on every course created, so each consultant sees it.
        if (note) for (const id of ids) await api.post(`/api/activities/${id}/notes`, { body: note });
      }
      store.set('lastForm', { consultant_id: consultantIds[0] });
      if (data.calendar_uid && state.calEvents) state.calEvents = state.calEvents.filter((ev) => ev.uid !== data.calendar_uid);
      state.options = await api.get('/api/options');
      toast(a ? 'Ændringer gemt' : consultantIds.length > 1 ? `${consultantIds.length} kurser registreret` : 'Aktivitet registreret');
      if (!a) {
        state.listFilters = { ...state.listFilters, q: '', year: data.date.slice(0, 4), from: '', to: '' };
      }
      go('activities');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  };

  if (a) {
    renderNotes($('#notes'), a.id);
    $('#dup').onclick = () => go('register', { copyOf: a });
    $('#del').onclick = () => { $('#del-confirm').hidden = false; $('#del').hidden = true; };
    $('#del-no').onclick = () => { $('#del-confirm').hidden = true; $('#del').hidden = false; };
    $('#del-yes').onclick = async () => {
      try {
        await api.del(`/api/activities/${a.id}`);
        state.options = await api.get('/api/options');
        toast('Aktivitet slettet');
        go('activities');
      } catch (ex) { toast(ex.message, 'err'); }
    };
  } else {
    $('#a-title').focus({ preventScroll: true });
  }
}

// --- Noter on a course ----------------------------------------------------------------------

async function renderNotes(box, activityId, notes = null, onChange = null) {
  if (!notes) notes = await api.get(`/api/activities/${activityId}/notes`);
  else if (onChange) onChange(notes);
  const again = (list) => renderNotes(box, activityId, list, onChange);
  box.innerHTML = `
    <div class="card-head"><h2>Noter</h2><span class="muted small">Ses kun af Kompas og konsulenten på kurset</span></div>
    ${notes.length ? `<ul class="note-list">${notes.map((n) => `<li class="note">
        <p class="note-body">${esc(n.body)}</p>
        <div class="note-meta muted small"><span>${esc(n.author)} · ${esc(fmtStamp(n.created_at))}</span>
          ${n.mine ? `<button type="button" class="linkbtn danger" data-del-note="${n.id}">Slet</button>` : ''}</div></li>`).join('')}</ul>`
      : '<p class="muted small note-empty">Ingen noter endnu. Skriv fx noget, man skal huske til næste gang, eller en idé.</p>'}
    <form class="note-form" novalidate>
      <textarea name="body" rows="2" maxlength="1000" placeholder="Skriv en kort note…" aria-label="Ny note"></textarea>
      <button class="btn" type="submit">Tilføj note</button>
    </form>`;
  const form = $('.note-form', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = form.body.value.trim();
    if (!body) { form.body.focus(); return; }
    try { again(await api.post(`/api/activities/${activityId}/notes`, { body })); toast('Note gemt'); }
    catch (ex) { toast(ex.message, 'err'); }
  };
  $$('[data-del-note]', box).forEach((b) => {
    b.onclick = async () => {
      try { again(await api.del(`/api/notes/${b.dataset.delNote}`)); toast('Note slettet'); }
      catch (ex) { toast(ex.message, 'err'); }
    };
  });
}

// Notes opened from the bubble in a list: a box over the list, so the overview stays where it is.
async function openNotesDialog(id) {
  let dlg = $('#notes-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'notes-dialog';
    dlg.className = 'dialog';
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click outside closes
  }
  try {
    const a = await api.get(`/api/activities/${id}`);
    dlg.innerHTML = `<div class="dlg-head"><div class="muted small">${fmtDate(a.date)}${withTime(a)} · ${esc(a.title)}${a.school ? ` · ${esc(a.school)}` : ''}${a.consultant ? ` · ${esc(a.consultant)}` : ''}</div>
        <button type="button" class="linkbtn" data-close>Luk</button></div><div class="notes-box"></div>`;
    $('[data-close]', dlg).onclick = () => dlg.close();
    await renderNotes($('.notes-box', dlg), a.id, null, (notes) => {
      $$(`[data-note-open="${a.id}"]`).forEach((b) => { b.outerHTML = noteMark({ id: a.id, notes: notes.length }).trim(); });
    });
    if (!dlg.open) dlg.showModal();
    $('textarea', dlg).focus();
  } catch (ex) { toast(ex.message, 'err'); }
}

// One listener for every note bubble; it runs before the row's own click, which opens the course.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-note-open]');
  if (!b) return;
  e.stopPropagation();
  e.preventDefault();
  openNotesDialog(b.dataset.noteOpen);
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest?.('[data-note-open]')) e.stopPropagation();
}, true);

// --- Bulk import ---------------------------------------------------------------------------
function cellToValue(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return typeof v === 'string' ? v.trim() : v;
}

async function readSpreadsheet(file) {
  if (!window.XLSX) throw new Error('Excel-læseren kunne ikke indlæses. Prøv at genindlæse siden.');
  let wb;
  if (/\.(csv|txt)$/i.test(file.name)) {
    // CSV: keep values as text so Danish dates (dd.mm.yyyy) are not read as US dates.
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(buf);
    wb = window.XLSX.read(text.replace(/^\uFEFF/, ''), { type: 'string', raw: true });
  } else {
    // Dates and times stay Excel numbers (days since 1900, a time is the fraction of a day); the server reads them.
    wb = window.XLSX.read(await file.arrayBuffer());
  }
  // Every sheet goes to the server as a raw grid; it finds the header rows and skips sheets without any.
  return wb.SheetNames.map((name) => ({
    name,
    table: window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true, blankrows: true })
      .map((cells) => cells.map(cellToValue)),
  }));
}

function renderImport(root) {
  root.innerHTML = `
    <div class="pagehead">
      <div><p class="eyebrow">Aktiviteter</p><h1>Importér kurser</h1>
        <p class="muted">Upload en Excel- eller CSV-fil med afholdte og planlagte kurser. Kurser med en dato efter i dag kommer under Kommende kurser.</p></div>
      <button type="button" class="btn" data-go="activities">Tilbage til aktiviteter</button>
    </div>
    <section class="card">
      <div class="import-pick">
        <label class="btn btn-primary" for="imp-file">Vælg fil</label>
        <input id="imp-file" type="file" accept=".xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
        <button type="button" class="btn" id="imp-template">Download skabelon</button>
        <span class="muted small" id="imp-name">Excel (.xlsx) eller CSV</span>
      </div>
      <div class="imp-defaults">
        <p class="small"><b>Udfyld tomme felter med</b> <span class="muted">(bruges kun, hvor filen ikke selv har en værdi)</span></p>
        <div class="imp-defaults-grid">
          <label class="field field-compact"><span>Reseller</span>
            <select id="imp-reseller" data-default="reseller">${selectOptions(state.options.resellers, '', 'Ingen (rækken springes over)')}</select>
            <small class="muted">Bruges også, hvis reselleren i filen ikke findes.</small></label>
          <label class="field field-compact"><span>Betalt af</span>
            <select data-default="paidBy">${selectOptions(state.options.paidBy, '', 'Ingen')}</select></label>
          <label class="field field-compact"><span>Kommune</span>
            <select data-default="municipality">${selectOptions(state.options.municipalities, '', 'Ingen')}</select>
            <small class="muted">Til nye skoler uden kommune.</small></label>
        </div>
      </div>
      <details class="howto"><summary>Kolonner der genkendes</summary>
        <p class="small">Dato · Varighed (Halv dag / Hel dag) · Type · Titel/emne · Skole · Kommune · Deltagere · Konsulent · Reseller · Betalt af.
        Engelske overskrifter (Date, Duration, Title, School …) virker også, og overskriftsrækken må gerne have en titel over sig.
        Kun Dato er påkrævet. Datoer kan skrives som 19.02.2026, 2026-02-19 eller 19. feb 2026.</p>
        <p class="small muted">Tomme eller uklare felter udfyldes, så vidt det er muligt, og det står i Bemærkning: manglende deltagere bliver 0, ukendt varighed bliver halv dag, manglende titel bliver APL-typen, og ukendte kommuner udelades.
        Nye skoler, konsulenter, APL-typer og betalere oprettes automatisk. Reseller gættes aldrig, fordi den styrer adgangen: vælg en reseller ovenfor til rækker uden.</p>
      </details>
      <p class="form-error" id="imp-err" role="alert" hidden></p>
    </section>
    <div id="imp-preview"></div>`;
  const err = $('#imp-err');
  const showErr = (m) => { err.textContent = m; err.hidden = !m; };
  let sheets = null;
  let mapping = {};
  let include = {};
  const defaults = () => Object.fromEntries($$('[data-default]').map((sel) => [sel.dataset.default, Number(sel.value) || null]));
  const body = (commit) => ({ sheets, mapping, include, defaults: defaults(), commit });
  const refresh = async () => {
    if (!sheets) return;
    try { showPreview(await api.post('/api/import', body(false))); } catch (ex) { showErr(ex.message); }
  };
  $$('[data-default]').forEach((sel) => { sel.onchange = refresh; });

  $('#imp-template').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { const n = await transport.download('/api/import/template'); if (n) toast(`Hentet: ${n}`); } catch (ex) { toast(ex.message, 'err'); }
    e.currentTarget.disabled = false;
  };
  $('#imp-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    showErr('');
    $('#imp-name').textContent = file.name;
    $('#imp-preview').innerHTML = '<div class="loading">Læser filen…</div>';
    try {
      sheets = await readSpreadsheet(file);
      mapping = {};
      include = {};
      const res = await api.post('/api/import', body(false));
      if (!res.rows.length) throw new Error('Filen indeholder ingen rækker.');
      showPreview(res);
    } catch (ex) { $('#imp-preview').innerHTML = ''; showErr(ex.message); }
  };

  function showPreview(res) {
    const sm = res.summary;
    const box = $('#imp-preview');
    showErr(res.missingColumns.length ? 'Der blev ikke fundet en kolonne med datoer. Vælg under "Hvilken kolonne er hvad?", hvilken kolonne der er Dato.' : '');
    const FIELD_LABELS = { date: 'Dato', start: 'Starttid', end: 'Sluttid', duration: 'Varighed', type: 'APL-type', title: 'Titel/emne', school: 'Skole', municipality: 'Kommune',
      participants: 'Deltagere', consultant: 'Konsulent', reseller: 'Reseller', paidBy: 'Betalt af', status: 'Status (foreløbig)' };
    const colPick = (f) => `<label class="field field-compact"><span>${FIELD_LABELS[f]}</span><select data-field="${f}">
      <option value="">(ikke i filen)</option>${res.headers.filter((h) => !/^Kolonne \d+$/.test(h) || h === res.columns[f])
        .map((h) => `<option ${res.columns[f] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
    const rowState = (r) => (r.errors.length ? 'err' : r.duplicate ? 'dup' : r.warnings.length ? 'warn' : 'ok');
    const note = (r) => (r.errors.length ? r.errors.join('. ') : r.duplicate ? 'Findes allerede, springes over' : r.warnings.join('. '));
    box.innerHTML = `
      <section class="card">
        <div class="import-summary">
          <div><b>${num(sm.ready)}</b><span>klar til import</span></div>
          <div><b>${num(sm.held)}</b><span>afholdte</span></div>
          <div><b>${num(sm.planned)}</b><span>kommende kurser${sm.pending ? ` · heraf ${num(sm.pending)} foreløbige` : ''}</span></div>
          <div class="${sm.duplicates ? 'is-warn' : ''}"><b>${num(sm.duplicates)}</b><span>dubletter springes over</span></div>
          <div class="${sm.errors ? 'is-err' : ''}"><b>${num(sm.errors)}</b><span>med fejl springes over</span></div>
          ${sm.unselected ? `<div class="is-warn"><b>${num(sm.unselected)}</b><span>fravalgt</span></div>` : ''}
        </div>
        ${res.rows.some((r) => r.similar) ? '<p class="small notice">Nogle kurser ligner kurser, du allerede har registreret (samme dag, skole og konsulent). De er fravalgt. Sæt flueben, hvis de alligevel skal med.</p>' : ''}
        <details class="howto imp-cols" ${sm.errors || Object.keys(mapping).length ? 'open' : ''}><summary>Hvilken kolonne er hvad? Ret her, hvis noget er koblet forkert</summary>
          <div class="imp-cols-grid">${Object.keys(FIELD_LABELS).map(colPick).join('')}</div></details>
        ${sm.warnings ? `<p class="small muted">${num(sm.warnings)} ${sm.warnings === 1 ? 'række' : 'rækker'} er udfyldt eller tilpasset automatisk. Se Bemærkning i tabellen.</p>` : ''}
        <div class="form-actions">
          <button type="button" class="btn btn-primary btn-lg" id="imp-go" ${sm.ready ? '' : 'disabled'}>Importér ${num(sm.ready)} ${sm.ready === 1 ? 'kursus' : 'kurser'}</button>
          <span class="muted small">${sm.errors ? 'Ret fejlene i filen og upload den igen, eller importér de gyldige rækker nu.' : ''}</span>
        </div>
      </section>
      <div class="table-wrap import-wrap card card-flush">
        <table class="table import-table">
          <thead><tr><th><span class="sr">Medtag</span></th>${res.rows.some((r) => r.sheet) ? '<th>Ark</th>' : ''}<th>Række</th><th>Bemærkning</th><th>Dato</th><th>Status</th><th>Titel/emne</th><th>Skole</th><th>Kommune</th><th class="num">Deltagere</th>
            <th>Varighed</th><th>Konsulent</th><th>Reseller</th><th>Betalt af</th></tr></thead>
          <tbody>${res.rows.map((r) => `
            <tr class="imp-${rowState(r)} ${r.selected ? '' : 'imp-off'}">
              <td>${r.errors.length || r.duplicate ? '' : `<input type="checkbox" data-rid="${esc(r.rid)}" ${r.selected ? 'checked' : ''} aria-label="Medtag række ${r.line}">`}</td>
              ${res.rows.some((x) => x.sheet) ? `<td>${esc(r.sheet)}</td>` : ''}
              <td class="num">${r.line}</td><td class="imp-note">${esc(note(r)) || '<span class="muted">OK</span>'}</td><td class="nowrap">${r.date ? fmtDate(r.date) : '–'}${timeSub(r)}</td>
              <td>${r.date ? statusPill(r) : ''}</td><td>${esc(r.title)}</td><td>${esc(r.school || '–')}</td><td>${esc(r.municipality || '–')}</td>
              <td class="num">${r.status === 'planned' && !r.participants ? '–' : num(r.participants)}</td><td class="nowrap">${r.duration === 'full' ? 'Hel dag' : r.duration === 'half' ? 'Halv dag' : '–'}</td>
              <td>${esc(r.consultant || '–')}</td><td>${esc(r.reseller || '–')}</td><td>${esc(r.paidBy || '–')}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
    $$('[data-rid]', box).forEach((cb) => {
      cb.onchange = () => { include = { ...include, [cb.dataset.rid]: cb.checked }; refresh(); };
    });
    box.querySelectorAll('.imp-cols select').forEach((sel) => {
      sel.onchange = async () => {
        mapping = { ...mapping, [sel.dataset.field]: sel.value };
        refresh();
      };
    });
    $('#imp-go').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        const done = await api.post('/api/import', body(true));
        state.options = await api.get('/api/options');
        toast(`${num(done.summary.imported || 0)} kurser importeret`);
        Object.assign(state.listFilters, { q: '', status: '', year: '', from: '', to: '' });
        go('activities');
      } catch (ex) { showErr(ex.message); e.currentTarget.disabled = false; }
    };
  }
}

// --- Calendar ------------------------------------------------------------------------------
async function renderCalendar(root) {
  const cal = await api.get('/api/calendar');
  const preview = Boolean(transport.isPreview);
  const feedUrl = preview ? '' : new URL(cal.feedPath, location.href).toString();
  const webcal = feedUrl.replace(/^https?:/, 'webcal:');
  root.innerHTML = `
    <div class="pagehead"><div><p class="eyebrow">Apple Kalender · iCal</p><h1>Kalender</h1>
      <p class="muted">${isAdmin() ? 'Kurser og aftaler fra din kalender samlet. Klik på en dag for at se den eller registrere et kursus.' : seesAll() ? 'Alle APL-kurser måned for måned.' : `${esc(state.me.reseller)}s APL-kurser måned for måned.`}</p></div></div>
    <section class="card month-card" id="month"></section>
    ${isAdmin() ? `
    <section class="card">
      <div class="card-head"><h2>Fra din kalender</h2><span class="muted small">Aftaler fra de seneste 4 måneder og de næste 2</span></div>
      ${preview ? '' : `
      <form id="cal-url-form" class="admin-add">
        <input id="cal-url" type="url" inputmode="url" placeholder="webcal://p…-caldav.icloud.com/published/…" value="${esc(cal.url)}" aria-label="Link til din kalender">
        <button class="btn" type="submit">Gem link</button>
        <button class="btn btn-primary" type="button" id="cal-fetch" ${cal.url ? '' : 'disabled'}>Hent aftaler</button>
      </form>
      <details class="howto"><summary>Sådan finder du linket i Apple Kalender</summary>
        <ol><li>Åbn Kalender på Mac, eller iCloud.com.</li>
        <li>Højreklik på din arbejdskalender, og vælg <b>Del kalender</b>.</li>
        <li>Slå <b>Offentlig kalender</b> til, og kopiér linket (det starter med webcal://).</li>
        <li>Sæt linket ind her, og tryk Gem link.</li></ol>
        <p class="muted small">Alle med linket kan se kalenderen, så del det ikke med andre.</p></details>`}
      <div class="cal-file">
        <label class="btn" for="cal-file-input">Upload .ics-fil</label>
        <input id="cal-file-input" type="file" accept=".ics,text/calendar" hidden>
        <span class="muted small">${preview ? 'I denne demo: eksportér din kalender som .ics-fil (Arkiv › Eksportér i Kalender på Mac), og upload den her.' : 'Alternativt: eksportér kalenderen som .ics-fil og upload den.'}</span>
      </div>
      <p class="form-error" id="cal-err" role="alert" hidden></p>
      <div id="cal-events"></div>
    </section>` : ''}
    <section class="card">
      <div class="card-head"><h2>Til din kalender</h2><span class="muted small">${seesAll() ? 'Alle registrerede aktiviteter' : `Kun ${esc(state.me.reseller)}s aktiviteter`}</span></div>
      ${preview ? `<p class="muted">I den fulde app får hver bruger et privat abonnementslink, som Apple Kalender, Outlook og Google holder opdateret automatisk. I denne demo kan du hente aktiviteterne som en .ics-fil og åbne den i Kalender.</p>`
      : `<p class="muted">Abonnér på dette private link i Apple Kalender (Arkiv › Nyt kalenderabonnement) eller på iPhone (Indstillinger › Kalender › Konti › Tilføj konto › Andet). Nye aktiviteter dukker selv op.</p>
      <div class="copyrow"><input id="feed-url" readonly value="${esc(webcal)}" aria-label="Abonnementslink"><button class="btn" type="button" id="feed-copy">Kopiér</button><a class="btn btn-primary" href="${esc(webcal)}">Åbn i Kalender</a></div>
      <p class="muted small">Linket giver adgang uden login. Hvis det er delt ved en fejl, så <button type="button" class="linkbtn" id="feed-reset">lav et nyt link</button>.</p>`}
      <button type="button" class="btn" id="ics-download">Download .ics-fil</button>
    </section>`;

  renderMonth();
  $('#ics-download').onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { const n = await transport.download('/api/calendar/download'); if (n) toast(`Hentet: ${n}`); } catch (ex) { toast(ex.message, 'err'); }
    e.currentTarget.disabled = false;
  };
  if (!preview) {
    $('#feed-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(webcal); toast('Link kopieret'); } catch { $('#feed-url').select(); }
    };
    $('#feed-reset').onclick = async () => { await api.post('/api/calendar/reset-feed', {}); toast('Nyt link lavet. Det gamle virker ikke længere.'); renderCalendar(root); };
  }
  if (!isAdmin()) return;

  const err = $('#cal-err');
  const showErr = (m) => { err.textContent = m; err.hidden = !m; };
  const load = async (fn) => {
    showErr('');
    $('#cal-events').innerHTML = '<div class="loading">Henter aftaler…</div>';
    try { state.calEvents = await fn(); renderEvents(); renderMonth(); } catch (ex) { $('#cal-events').innerHTML = ''; showErr(ex.message); }
  };
  if (!preview) {
    $('#cal-url-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api.put('/api/calendar', { url: $('#cal-url').value });
        toast(r.url ? 'Kalenderlink gemt' : 'Kalenderlink fjernet');
        $('#cal-fetch').disabled = !r.url;
        if (r.url) load(() => api.get('/api/calendar/events'));
      } catch (ex) { showErr(ex.message); }
    };
    $('#cal-fetch').onclick = () => load(() => api.get('/api/calendar/events'));
  }
  $('#cal-file-input').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    load(async () => api.post('/api/calendar/events', { ics: await file.text() }));
    e.target.value = '';
  };

  function renderEvents() {
    const box = $('#cal-events');
    const all = state.calEvents;
    if (!all) { box.innerHTML = ''; return; }
    const shown = state.calShowAll ? all : all.filter((ev) => ev.matched);
    const hidden = all.length - shown.length;
    box.innerHTML = `
      ${shown.length ? `<ul class="cal-list">${shown.map((ev) => `
        <li>
          <div class="latest-date">${fmtDate(ev.date, true)}${ev.start ? `<div class="muted small">${ev.start}</div>` : ''}</div>
          <div class="cal-body"><b>${esc(ev.title)}</b>
            <span class="muted">${esc(ev.location || '')}</span>
            <span class="muted small">${[ev.suggestion.school && `Skole: ${esc(ev.suggestion.school)}`, ev.hours != null && `${ev.hours.toLocaleString('da-DK')} timer`].filter(Boolean).join(' · ')}</span></div>
          <div class="cal-actions"><button type="button" class="btn btn-primary btn-sm" data-reg="${esc(ev.uid)}">Registrér</button>
            <button type="button" class="linkbtn" data-ign="${esc(ev.uid)}">Skjul</button></div>
        </li>`).join('')}</ul>` : `<p class="muted empty">Ingen nye APL-aftaler at registrere.</p>`}
      ${hidden || state.calShowAll ? `<button type="button" class="linkbtn" id="cal-toggle">${state.calShowAll ? 'Vis kun APL-aftaler' : `Vis alle aftaler (${hidden} mere)`}</button>` : ''}`;
    const byUid = (uid) => all.find((ev) => ev.uid === uid);
    $$('[data-reg]', box).forEach((b) => {
      b.onclick = () => {
        const ev = byUid(b.dataset.reg);
        go('register', { prefill: { ...ev.suggestion, uid: ev.uid, eventTitle: ev.title } });
      };
    });
    $$('[data-ign]', box).forEach((b) => {
      b.onclick = async () => {
        await api.post('/api/calendar/ignore', { uid: b.dataset.ign });
        state.calEvents = state.calEvents.filter((ev) => ev.uid !== b.dataset.ign);
        renderEvents();
        renderMonth();
      };
    });
    if ($('#cal-toggle')) $('#cal-toggle').onclick = () => { state.calShowAll = !state.calShowAll; renderEvents(); };
  }
  renderEvents();
  if (!preview && cal.url && !state.calEvents && !state.calAutoLoaded) {
    state.calAutoLoaded = true;
    load(() => api.get('/api/calendar/events'));
  }
}

// Month view: registered courses (held / planned) plus, for Kompas, calendar appointments not yet registered.
const MONTHS_DA = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const pad2 = (n) => String(n).padStart(2, '0');

async function renderMonth() {
  const box = $('#month');
  if (!box) return;
  const ym = state.calMonth || todayIso().slice(0, 7);
  state.calMonth = ym;
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const from = `${ym}-01`;
  const to = `${ym}-${pad2(days)}`;
  const shift = (d) => { const t = new Date(y, m - 1 + d, 1); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}`; };

  if (!box.dataset.ym || box.dataset.ym !== ym) box.innerHTML = '<div class="loading">Indlæser…</div>';
  const acts = await api.get(`/api/activities${qs({ from, to })}`);
  if (state.calMonth !== ym || !$('#month')) return; // the user moved on while loading
  box.dataset.ym = ym;
  const events = (state.calEvents || []).filter((ev) => ev.date >= from && ev.date <= to);

  // Several consultants on the same course and day show as one entry with a count.
  const byDay = {};
  for (const a of acts) {
    const list = (byDay[a.date] ||= { courses: [], events: [] }).courses;
    const k = `${a.title}|${a.school || ''}|${a.reseller}|${a.start_time || ''}`;
    const hit = list.find((g) => g.key === k);
    if (hit) hit.items.push(a); else list.push({ key: k, items: [a] });
  }
  for (const ev of events) (byDay[ev.date] ||= { courses: [], events: [] }).events.push(ev);

  const today = todayIso();
  const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday first
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="mday is-out" aria-hidden="true"></div>');
  for (let d = 1; d <= days; d++) {
    const iso = `${ym}-${pad2(d)}`;
    const day = byDay[iso] || { courses: [], events: [] };
    const count = day.courses.reduce((n, g) => n + g.items.length, 0);
    const label = [count && `${count} ${count === 1 ? 'kursus' : 'kurser'}`, day.events.length && `${day.events.length} ${day.events.length === 1 ? 'aftale' : 'aftaler'}`].filter(Boolean).join(', ');
    cells.push(`<button type="button" class="mday ${iso === today ? 'is-today' : ''} ${iso === state.calDay ? 'is-sel' : ''}" data-day="${iso}" aria-label="${d}. ${MONTHS_DA[m - 1]}${label ? `: ${label}` : ''}">
      <span class="mday-n">${d}</span>
      <span class="mday-items">${day.courses.map((g) => `<span class="mchip ${g.items.some((x) => x.pending) ? 'is-planned is-pending' : g.items[0].status === 'planned' ? 'is-planned' : 'is-held'}">${g.items.some((x) => x.reschedule) ? '★ ' : ''}${g.items[0].start_time ? `<time>${g.items[0].start_time}</time> ` : ''}${esc(g.items[0].title)}${g.items.length > 1 ? ` <b>×${g.items.length}</b>` : ''}</span>`).join('')}
        ${day.events.map((ev) => `<span class="mchip is-event">${ev.start ? `<time>${ev.start}</time> ` : ''}${esc(ev.title)}</span>`).join('')}</span>
      <span class="mday-dots">${count ? `<i class="${day.courses.some((g) => g.items.some((x) => x.status === 'planned')) ? 'is-planned' : 'is-held'}"></i>` : ''}${day.events.length ? '<i class="is-event"></i>' : ''}</span>
    </button>`);
  }

  const held = acts.filter((a) => a.status === 'held').length;
  box.innerHTML = `
    <div class="month-head">
      <button type="button" class="btn btn-sm" data-shift="-1" aria-label="Forrige måned">‹</button>
      <h2>${MONTHS_DA[m - 1][0].toUpperCase()}${MONTHS_DA[m - 1].slice(1)} ${y}</h2>
      <button type="button" class="btn btn-sm" data-shift="1" aria-label="Næste måned">›</button>
      ${ym !== today.slice(0, 7) ? '<button type="button" class="linkbtn" data-shift="0">I dag</button>' : ''}
      <span class="spacer"></span>
      <span class="muted small">${held} afholdt · ${acts.length - held} planlagt</span>
    </div>
    <div class="legend"><span><i class="sw sw-held"></i>Afholdt</span><span><i class="sw sw-planned"></i>Planlagt</span>
      <span><i class="sw sw-pending"></i>Foreløbig</span>
      ${isAdmin() ? `<span><i class="sw sw-event"></i>${state.calEvents ? 'Aftale i din kalender, ikke registreret' : 'Aftaler fra din kalender vises, når de er hentet nedenfor'}</span>` : ''}</div>
    <div class="mgrid" role="grid">${['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'].map((d) => `<div class="mdow">${d}</div>`).join('')}${cells.join('')}</div>
    <div id="mday-detail"></div>`;

  $$('[data-shift]', box).forEach((b) => {
    b.onclick = () => { state.calMonth = b.dataset.shift === '0' ? today.slice(0, 7) : shift(Number(b.dataset.shift)); state.calDay = null; renderMonth(); };
  });
  $$('[data-day]', box).forEach((b) => { b.onclick = () => { state.calDay = b.dataset.day; renderMonth(); }; });

  const sel = state.calDay && state.calDay.startsWith(ym) ? state.calDay : null;
  if (!sel) return;
  const day = byDay[sel] || { courses: [], events: [] };
  const items = day.courses.flatMap((g) => g.items).sort((x, y) => (x.start_time || '').localeCompare(y.start_time || ''));
  $('#mday-detail').innerHTML = `
    <div class="mday-detail">
      <div class="card-head"><h3>${fmtDate(sel)}</h3>
        ${isAdmin() ? '<button type="button" class="btn btn-primary btn-sm" id="mday-reg">Registrér kursus denne dag</button>' : ''}</div>
      ${items.length ? `<ul class="latest">${items.map((a) => `
        <li class="latest-item ${rowState(a)} ${isAdmin() ? 'clickable' : ''}" ${isAdmin() ? `data-open="${a.id}" role="button" tabindex="0"` : ''}>
          <div class="latest-body"><div class="latest-title">${star(a)}${esc(a.title)} ${statusPill(a)}</div>
          <div class="latest-meta">${timeText(a) ? `<span class="nowrap"><b>${timeText(a)}</b></span>` : ''}<span>${esc(a.school || '–')}</span><span>${esc(a.consultant || '')}</span><span>${participantsText(a)}</span><span class="tag">${esc(a.reseller)}</span></div></div>
        </li>`).join('')}</ul>` : '<p class="muted">Ingen registrerede kurser denne dag.</p>'}
      ${day.events.length ? `<p class="section-label mday-ev-label">Fra din kalender</p><ul class="cal-list">${day.events.map((ev) => `
        <li><div class="cal-body"><b>${ev.start ? `${ev.start}${ev.end ? `–${ev.end}` : ''} · ` : ''}${esc(ev.title)}</b><span class="muted">${esc(ev.location || '')}</span></div>
          <div class="cal-actions"><button type="button" class="btn btn-sm" data-reg-ev="${esc(ev.uid)}">Registrér</button></div></li>`).join('')}</ul>` : ''}
    </div>`;
  $$('[data-open]', box).forEach((li) => {
    const open = async () => go('register', { editing: await api.get(`/api/activities/${li.dataset.open}`) });
    li.onclick = open;
    li.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  $$('[data-reg-ev]', box).forEach((b) => {
    b.onclick = () => {
      const ev = state.calEvents.find((x) => x.uid === b.dataset.regEv);
      go('register', { prefill: { ...ev.suggestion, uid: ev.uid, eventTitle: ev.title } });
    };
  });
  if ($('#mday-reg')) $('#mday-reg').onclick = () => go('register', { prefill: { date: sel } });
}

// --- Administration ------------------------------------------------------------------------
const ADMIN_TABS = [
  ['consultants', 'Konsulenter'], ['schools', 'Skoler'], ['municipalities', 'Kommuner'],
  ['apl-types', 'APL-typer'], ['resellers', 'Resellere'], ['paid-by', 'Betalt af'], ['users', 'Brugere og adgang'],
];

async function renderAdmin(root) {
  const tab = state.adminTab;
  root.innerHTML = `
    <div class="pagehead"><div><p class="eyebrow">Kun for Kompas</p><h1>Administration</h1>
      <p class="muted">Valglister til registreringsformularen og filtrene, og hvem der har adgang.</p></div></div>
    <div class="tabs" role="tablist">${ADMIN_TABS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join('')}</div>
    <section class="card" id="admin-body"><div class="loading">Indlæser…</div></section>`;
  $$('[data-tab]').forEach((b) => { b.onclick = () => { state.adminTab = b.dataset.tab; renderAdmin(root); }; });
  const rows = await api.get(`/api/admin/${tab}`);
  const body = $('#admin-body');
  const o = state.options;
  const isUsers = tab === 'users';
  const isSchools = tab === 'schools';
  const label = ADMIN_TABS.find(([k]) => k === tab)[1];

  const editorFields = (r = {}) => {
    if (isUsers) {
      return `
        <input name="name" placeholder="Navn" value="${esc(r.name || '')}" aria-label="Navn" required>
        <input name="email" type="email" placeholder="E-mail" value="${esc(r.email || '')}" aria-label="E-mail" required>
        <select name="role" aria-label="Rolle"><option value="reseller" ${!r.role || r.role === 'reseller' ? 'selected' : ''}>Reseller-bruger</option><option value="viewer" ${r.role === 'viewer' ? 'selected' : ''}>Læseadgang til alle resellere (fx Apple)</option><option value="admin" ${r.role === 'admin' ? 'selected' : ''}>Kompas-administrator</option></select>
        <select name="reseller_id" aria-label="Reseller">${selectOptions(o.resellers, r.reseller_id, 'Vælg reseller…')}</select>`;
    }
    return `<input name="name" placeholder="Navn" value="${esc(r.name || '')}" aria-label="Navn" required>
      ${isSchools ? `<select name="municipality_id" aria-label="Kommune">${selectOptions(o.municipalities, r.municipality_id, 'Vælg kommune…')}</select>` : ''}
      ${tab === 'consultants' ? `<input name="initials" placeholder="Initialer, fx KB" value="${esc(r.initials || '')}" aria-label="Initialer" maxlength="6" class="input-short">` : ''}`;
  };
  const describe = (r) => {
    if (isUsers) return `<b>${esc(r.name)}</b><span class="muted">${esc(r.email)}</span><span class="tag ${r.role === 'admin' ? 'tag-admin' : ''}">${r.role === 'admin' ? 'Kompas-administrator' : r.role === 'viewer' ? 'Ser alle resellere · kun læse' : `Ser ${esc(r.reseller)}`}</span>${userState(r)}`;
    return `<b>${esc(r.name)}</b>${isSchools ? `<span class="muted">${esc(r.municipality || 'Ingen kommune')}</span>` : ''}${tab === 'consultants' && r.initials ? `<span class="muted">${esc(r.initials)}</span>` : ''}
      <span class="muted small">${r.used ? `${r.used} ${r.used === 1 ? 'aktivitet' : 'aktiviteter'}` : 'Ikke brugt'}</span>${tab === 'consultants' ? consultantState(r) : ''}`;
  };

  body.innerHTML = `
    <form class="admin-add" id="admin-add">${editorFields()}<button class="btn btn-primary" type="submit">Tilføj</button></form>
    <p class="form-error" id="admin-err" role="alert" hidden></p>
    ${isUsers ? '<p class="muted small">Reseller-brugere ser kun aktiviteter, hvor Reseller / partner er deres egen reseller. Brugere med læseadgang (fx Apple) ser alle resellere, men kan ikke ændre noget. Opret brugeren, og tryk Ny engangskode for at give vedkommende adgang.</p>' : ''}
    <ul class="admin-list">${rows.map((r) => `
      <li data-id="${r.id}">
        <div class="admin-row">${describe(r)}</div>
        <div class="admin-actions">
          ${isUsers && !transport.isPreview && r.role !== 'admin' ? '<button type="button" class="linkbtn" data-act="viewas">Se som</button>' : ''}
          ${isUsers && !transport.isPreview ? '<button type="button" class="linkbtn" data-act="pw">Ny engangskode</button>' : ''}
          ${tab === 'consultants' && !transport.isPreview ? '<button type="button" class="linkbtn" data-act="feed">Konsulentlink</button>' : ''}
          <button type="button" class="linkbtn" data-act="edit">Redigér</button>
          <button type="button" class="linkbtn danger" data-act="delete">Slet</button>
        </div>
      </li>`).join('')}</ul>
    <p class="muted small">${rows.length} i alt</p>`;

  const errEl = $('#admin-err');
  const fail = (ex) => { errEl.textContent = ex.message; errEl.hidden = false; };
  const toggleReseller = (form) => {
    const role = form.querySelector('[name=role]');
    const res = form.querySelector('[name=reseller_id]');
    if (role && res) { res.disabled = role.value !== 'reseller'; role.onchange = () => toggleReseller(form); }
  };
  const after = async () => {
    state.options = await api.get('/api/options');
    if (isUsers) state.demoUsers = await transport.auth.demoUsers().catch(() => state.demoUsers);
    if (isUsers) renderShell();
    renderAdmin($('#view'));
  };
  toggleReseller($('#admin-add'));
  $('#admin-add').onsubmit = async (e) => {
    e.preventDefault();
    try { await api.post(`/api/admin/${tab}`, Object.fromEntries(new FormData(e.target))); toast(`${label}: tilføjet`); await after(); } catch (ex) { fail(ex); }
  };
  $$('.admin-list li').forEach((li) => {
    const r = rows.find((x) => String(x.id) === li.dataset.id);
    const vaBtn = li.querySelector('[data-act=viewas]');
    if (vaBtn) vaBtn.onclick = () => viewAs(Number(li.dataset.id));
    const pwBtn = li.querySelector('[data-act=pw]');
    if (pwBtn) {
      pwBtn.onclick = async () => {
        try {
          const { password } = await transport.auth.resetPassword(r.id);
          li.insertAdjacentHTML('beforeend', `<div class="temp-pw">Engangskode til ${esc(r.email)}: <code>${esc(password)}</code>
            <button type="button" class="btn btn-sm" data-copy>Kopiér</button>
            <span class="muted small">Vises kun nu. Brugeren vælger sin egen adgangskode ved første login.</span></div>`);
          li.querySelector('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(password); toast('Kopieret'); } catch { /* select manually */ } };
          pwBtn.remove();
        } catch (ex) { fail(ex); }
      };
    }
    const feedBtn = li.querySelector('[data-act=feed]');
    if (feedBtn) {
      const showFeed = async (reset) => {
        try {
          const { feedPath, pagePath } = reset ? await api.post(`/api/admin/consultants/${r.id}/feed`, {}) : await api.get(`/api/admin/consultants/${r.id}/feed`);
          const page = new URL(pagePath, location.href).toString();
          const webcal = new URL(feedPath, location.href).toString().replace(/^https?:/, 'webcal:');
          li.querySelector('.temp-pw')?.remove();
          li.insertAdjacentHTML('beforeend', `<div class="temp-pw feed-box">
            <p class="small"><b>Konsulentside:</b> ${esc(r.name)}s afholdte og kommende kurser, antal sessioner og linket til Apples spørgeskema.</p>
            <div class="copyrow"><input readonly value="${esc(page)}" aria-label="Konsulentside til ${esc(r.name)}"><button type="button" class="btn btn-sm" data-copy="${esc(page)}">Kopiér</button><a class="btn btn-sm" href="${esc(page)}" target="_blank" rel="noopener">Åbn</a></div>
            <p class="small"><b>Kalender:</b> kurserne i Apple Kalender (Arkiv › Nyt kalenderabonnement) eller på iPhone (Indstillinger › Kalender › Konti › Tilføj konto › Andet). Linket findes også på konsulentsiden.</p>
            <div class="copyrow"><input readonly value="${esc(webcal)}" aria-label="Kalenderlink til ${esc(r.name)}"><button type="button" class="btn btn-sm" data-copy="${esc(webcal)}">Kopiér</button></div>
            <p class="muted small">Linkene virker uden login. Er de delt ved en fejl, så <button type="button" class="linkbtn" data-reset>lav nye links</button>.</p></div>`);
          const box = li.querySelector('.temp-pw');
          box.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link kopieret'); } catch { b.previousElementSibling.select(); } }; });
          box.querySelector('[data-reset]').onclick = async () => { await showFeed(true); toast('Nye links lavet. De gamle virker ikke længere.'); };
        } catch (ex) { fail(ex); }
      };
      feedBtn.onclick = () => showFeed(false);
    }
    li.querySelector('[data-act=edit]').onclick = () => {
      li.innerHTML = `<form class="admin-add admin-edit">${editorFields(r)}<button class="btn btn-primary btn-sm" type="submit">Gem</button><button class="btn btn-sm" type="button" data-cancel>Annullér</button></form>`;
      const f = li.querySelector('form');
      toggleReseller(f);
      f.querySelector('[data-cancel]').onclick = () => renderAdmin($('#view'));
      f.onsubmit = async (e) => {
        e.preventDefault();
        try { await api.put(`/api/admin/${tab}/${r.id}`, Object.fromEntries(new FormData(f))); toast('Gemt'); await after(); } catch (ex) { fail(ex); }
      };
      f.querySelector('input').focus();
    };
    li.querySelector('[data-act=delete]').onclick = (e) => {
      const actions = e.target.parentElement;
      actions.innerHTML = `<span class="small">Slet?</span><button type="button" class="btn btn-danger btn-sm" data-yes>Slet</button><button type="button" class="btn btn-sm" data-no>Annullér</button>`;
      actions.querySelector('[data-no]').onclick = () => renderAdmin($('#view'));
      actions.querySelector('[data-yes]').onclick = async () => {
        try { await api.del(`/api/admin/${tab}/${r.id}`); toast('Slettet'); await after(); } catch (ex) { await renderAdmin($('#view')); $('#admin-err').textContent = ex.message; $('#admin-err').hidden = false; }
      };
    };
  });
}

// --- Tilmelding --------------------------------------------------------------------------------
// Doodle for Foreløbig courses without a consultant: the consultants answer on their own page
// (Konsulentlink); here Kompas sees every answer and puts the chosen consultants on the course.
const ANSWER_MARK = { yes: ['✓', 'Kan'], maybe: ['?', 'Måske'] };

async function renderSignup(root) {
  const { consultants, courses } = await api.get('/api/signups');
  const munis = [...new Set(courses.map((c) => c.municipality).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'da'));
  if (state.signupMunicipality && !munis.includes(state.signupMunicipality)) state.signupMunicipality = '';
  const shown = courses.filter((c) => !state.signupMunicipality || c.municipality === state.signupMunicipality);
  const count = (c, k) => Object.values(c.answers).filter((a) => a === k).length;
  const silent = consultants.filter((p) => !courses.some((c) => c.answers[p.id]));
  root.innerHTML = `
    <div class="pagehead"><div><p class="eyebrow">Foreløbige kurser</p><h1>Tilmelding</h1>
      <p class="muted">Foreløbige kurser, der mangler konsulenter. Konsulenterne klikker Kan eller Måske på deres konsulentside, og du sætter dem på kurset her.
        Kun Kan og konsulenter, du har sat på, tæller med i tilmeldt. Kurset bliver her, indtil du har sat så mange på, som der skal bruges. Når et kursus har fået de konsulenter, der skal bruges, lukker det for tilmelding.
        Linket til konsulentsiden finder du under Administration › Konsulenter › Konsulentlink.</p></div></div>
    ${munis.length > 1 ? `<div class="filters filters-inline"><label class="field field-compact"><span>Kommune</span><select id="su-muni">
      <option value="">Alle kommuner</option>${munis.map((m) => `<option ${m === state.signupMunicipality ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label></div>` : ''}
    ${!shown.length ? `<section class="card"><p class="empty">Der er ingen foreløbige kurser, der mangler konsulenter, lige nu. Et kursus kommer med her, når det er markeret som Foreløbig og ikke har fået alle de konsulenter, der skal bruges.</p></section>` : `
    <section class="card card-flush"><div class="table-wrap signup-wrap"><table class="table signup-grid">
      <thead><tr><th>Kursus</th><th class="num">Skal bruges</th><th class="num">Tilmeldt</th>
        ${consultants.map((p) => `<th class="su-person" title="${esc(p.name)}">${esc(p.initials || p.name.split(' ')[0])}</th>`).join('')}<th></th></tr></thead>
      <tbody>${shown.map((c) => {
        return `<tr data-id="${c.id}">
        <td><span class="nowrap"><b>${fmtDate(c.date)}</b>${withTime(c)} · ${c.duration === 'full' ? 'Hel dag' : 'Halv dag'}</span>
          <div><b>${esc(c.title)}</b></div><div class="muted small">${esc(c.school || '–')}${c.municipality ? ` · ${esc(c.municipality)}` : ''} · ${esc(c.reseller)}</div>
          ${c.assigned.length ? `<div class="small su-on-list">Sat på: ${c.assigned.map((id) => esc(consultants.find((p) => p.id === id)?.name || '')).join(', ')}</div>` : ''}</td>
        <td class="num"><input class="input-num" type="number" min="1" max="50" value="${c.needed ?? ''}" data-needed aria-label="Konsulenter der skal bruges"></td>
        <td class="num"><b class="nowrap ${c.full ? 'su-enough' : ''}">${c.yes}${c.needed ? `/${c.needed}` : ''}</b>${c.full ? '<div class="small su-enough">Fuld · lukket</div>' : c.needed ? `<div class="muted small">mangler ${Math.max(c.needed - c.yes, 0)}</div>` : ''}${count(c, 'maybe') ? `<div class="muted small">+${count(c, 'maybe')} måske</div>` : ''}</td>
        ${consultants.map((p) => { const a = c.answers[p.id]; if (c.assigned.includes(p.id)) return `<td class="su-cell su-on" title="${esc(p.name)}: sat på kurset">På</td>`; return `<td class="su-cell ${a ? `su-${a}` : ''}" title="${esc(p.name)}: ${a ? ANSWER_MARK[a][1] : 'Har ikke meldt sig'}">${a ? `<button type="button" class="su-remove" data-remove="${p.id}" aria-label="Fjern ${esc(p.name)}s tilmelding">${ANSWER_MARK[a][0]}</button>` : '<span class="muted">–</span>'}</td>`; }).join('')}
        <td><button type="button" class="btn btn-sm" data-assign>Sæt på</button></td></tr>`;
      }).join('')}</tbody></table></div></section>`}
    <p class="muted small">På = sat på kurset · ✓ Kan · ? Måske · – kan ikke (har ikke meldt sig). Klik på et ✓ eller ? for at fjerne tilmeldingen.${silent.length ? ` Har ikke meldt sig på noget endnu: ${silent.map((p) => `${esc(p.name)}${p.has_link ? '' : ' (har ikke fået et konsulentlink)'}`).join(', ')}.` : ''}</p>`;

  $('#su-muni')?.addEventListener('change', (e) => { state.signupMunicipality = e.target.value; renderSignup(root); });
  $$('.signup-grid tbody tr').forEach((tr) => {
    const c = courses.find((x) => String(x.id) === tr.dataset.id);
    const needed = tr.querySelector('[data-needed]');
    needed.onchange = async () => {
      try { await api.put(`/api/signups/${c.id}/needed`, { needed: needed.value }); toast('Gemt'); await renderSignup(root); } catch (ex) { toast(ex.message, 'err'); }
    };
    // Consultants cannot withdraw a Kan themselves; Kompas removes it here.
    tr.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = async () => {
        const p = consultants.find((x) => String(x.id) === b.dataset.remove);
        if (!confirm(`Fjern ${p.name}s tilmelding (${ANSWER_MARK[c.answers[p.id]][1]}) til ${c.title}, ${c.school || ''} ${fmtDate(c.date)}?`)) return;
        try { await api.del(`/api/signups/${c.id}/consultants/${p.id}`); toast('Tilmelding fjernet'); await renderSignup(root); } catch (ex) { toast(ex.message, 'err'); }
      };
    });
    tr.querySelector('[data-assign]').onclick = () => {
      const next = tr.nextElementSibling;
      if (next?.classList.contains('su-assign')) { next.remove(); return; }
      // Those who said Kan come first and are ticked, up to the number needed.
      const order = { yes: 0, maybe: 1, undefined: 2 };
      const ranked = [...consultants].filter((p) => !c.assigned.includes(p.id)).sort((a, b) => order[c.answers[a.id]] - order[c.answers[b.id]]);
      const limit = c.needed ? c.needed - c.assigned.length : Infinity;
      let ticked = 0;
      tr.insertAdjacentHTML('afterend', `<tr class="su-assign"><td colspan="${consultants.length + 4}">
        <form class="su-assign-form"><p class="small"><b>Hvem skal tage kurset?</b> Hver konsulent får sit eget kursus, og kurserne forbliver Foreløbige, indtil du godkender dem.${c.assigned.length ? ` Allerede sat på: ${c.assigned.map((id) => esc(consultants.find((p) => p.id === id)?.name || '')).join(', ')}.` : ''}</p>
          <div class="su-choices">${ranked.map((p) => { const a = c.answers[p.id]; const on = a === 'yes' && ticked < limit; if (on) ticked += 1;
            return `<label class="check"><input type="checkbox" name="c" value="${p.id}" ${on ? 'checked' : ''}> ${esc(p.name)} <span class="muted small">${a ? ANSWER_MARK[a][1] : 'ikke meldt sig'}</span>${c.busy.includes(p.id) ? ' <span class="dbl small" title="Dobbeltbooking">⚠ har et andet kursus på det tidspunkt</span>' : ''}</label>`; }).join('')}</div>
          <div class="copyrow"><button class="btn btn-primary btn-sm" type="submit">Sæt på kurset</button><button class="btn btn-sm" type="button" data-cancel>Annullér</button></div>
        </form></td></tr>`);
      const row = tr.nextElementSibling;
      row.querySelector('[data-cancel]').onclick = () => row.remove();
      row.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const ids = [...e.target.querySelectorAll('input:checked')].map((i) => Number(i.value));
        try {
          const { assigned } = await api.post(`/api/signups/${c.id}/assign`, { consultant_ids: ids });
          toast(`${assigned} ${assigned === 1 ? 'konsulent' : 'konsulenter'} sat på kurset`);
          await renderSignup(root);
        } catch (ex) { toast(ex.message, 'err'); }
      };
    };
  });
}

// --- Beskeder ----------------------------------------------------------------------------------
// One-way notices to the consultants. They read them at the top of their consultant page.
const fmtStamp = (ts) => new Date(`${ts.replace(' ', 'T')}Z`).toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });

async function renderMessages(root) {
  const messages = await api.get('/api/messages');
  const consultants = state.options.consultants || [];
  root.innerHTML = `
    <div class="pagehead"><div><p class="eyebrow">Til konsulenterne</p><h1>Beskeder</h1>
      <p class="muted">Beskederne står øverst på konsulentsiden, nyeste først, og nye er markeret med Ny. Konsulenterne får ingen mail eller sms,
        så de ser beskeden, næste gang de åbner deres konsulentlink.</p></div></div>
    <section class="card"><form class="msg-form" id="msg-form">
      <div class="form-grid">
        <label class="field"><span>Til</span><select name="consultant_id">
          <option value="">Alle konsulenter</option>${consultants.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Overskrift</span><input name="title" required maxlength="200" placeholder="Fx Nyt materiale til Modul 2"></label>
        <label class="field field-wide"><span>Besked</span><textarea name="body" maxlength="5000" placeholder="Skriv beskeden her. Links bliver klikbare."></textarea></label>
      </div>
      <div class="copyrow"><button class="btn btn-primary" type="submit">Send besked</button></div>
    </form></section>
    <section class="card"><div class="card-head"><h2>Sendte beskeder</h2><span class="muted small">${messages.length ? 'Nyeste først' : ''}</span></div>
      ${!messages.length ? '<p class="empty">Du har ikke sendt nogen beskeder endnu.</p>' : `<ul class="msg-list">${messages.map((m) => `
        <li class="msg" data-id="${m.id}">
          <div class="msg-head"><h3>${esc(m.title)}</h3></div>
          <div class="muted small">${esc(fmtStamp(m.created_at))} · Til ${m.consultant_id ? esc(m.consultant) : 'alle konsulenter'}${m.author ? ` · Fra ${esc(m.author)}` : ''}</div>
          ${m.body ? `<p class="msg-body">${esc(m.body)}</p>` : ''}
          <div class="msg-actions"><span class="small" title="${esc(m.read.length ? `Læst af: ${m.read.join(', ')}` : 'Ingen har læst den endnu')}"><b>Læst af ${m.read.length} af ${m.read.length + m.unread.length}</b></span>
            ${m.unread.length && m.read.length ? `<span class="muted small">Mangler: ${m.unread.map(esc).join(', ')}</span>` : ''}
            <button type="button" class="linkbtn" data-delete>Slet</button></div>
        </li>`).join('')}</ul>`}
      <p class="muted small">Ved beskeder til alle tæller kun konsulenter, der har fået et konsulentlink.</p></section>`;

  $('#msg-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api.post('/api/messages', Object.fromEntries(new FormData(e.target)));
      toast('Beskeden er sendt');
      await renderMessages(root);
    } catch (ex) { toast(ex.message, 'err'); btn.disabled = false; }
  };
  $$('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Slet beskeden? Den forsvinder også fra konsulenternes side.')) return;
      try { await api.del(`/api/messages/${b.closest('[data-id]').dataset.id}`); toast('Slettet'); await renderMessages(root); } catch (ex) { toast(ex.message, 'err'); }
    };
  });
}

// --- Boot ----------------------------------------------------------------------------------
async function render() {
  renderShell();
  const root = $('#view');
  // Long tables get the full screen width.
  document.body.classList.toggle('is-wide', ['activities', 'import', 'signup'].includes(state.view));
  try {
    if (state.me.must_change_password) return renderChangePassword(root, { forced: true });
    if (state.view === 'password') return renderChangePassword(root, { forced: false });
    if (state.view === 'activities') await renderActivities(root);
    else if (state.view === 'register') renderRegister(root);
    else if (state.view === 'admin') await renderAdmin(root);
    else if (state.view === 'calendar') await renderCalendar(root);
    else if (state.view === 'signup') await renderSignup(root);
    else if (state.view === 'messages') await renderMessages(root);
    else if (state.view === 'import') renderImport(root);
    else await renderDashboard(root);
  } catch (ex) {
    if (ex.status === 401) { state.me = null; return boot(); }
    root.innerHTML = `<div class="card"><p class="form-error">${esc(ex.message)}</p></div>`;
  }
}

// "Se som": look at the system as a reseller or Apple sees it (read only), then go back.
async function viewAs(userId) {
  transport.viewAs = userId;
  try { await loadSession(); } catch (ex) { transport.viewAs = null; await loadSession(); toast(ex.message, 'err'); }
  state.listFilters.reseller = '';
  state.dashFilters.reseller = '';
  go(userId ? 'dashboard' : 'admin');
}

async function loadSession() {
  state.me = await api.get('/api/me');
  state.options = await api.get('/api/options');
  try {
    const cfg = await transport.auth.config();
    state.version = cfg.version || '';
    state.demoUsers = cfg.demo ? await transport.auth.demoUsers() : [];
  } catch { state.demoUsers = []; }
}

async function boot() {
  try {
    await loadSession();
  } catch {
    state.me = null;
    return renderLogin();
  }
  const v = location.hash.slice(1);
  go(VIEWS.includes(v) ? v : 'dashboard');
}

export { boot };
boot();
