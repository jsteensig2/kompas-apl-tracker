// A consultant's own page: held and coming courses, Apple session count and the Apple survey link.
// Opened from the private link Kompas sends (/k/<token>); no login.

const APPLE_SURVEY = 'https://essentials.applesurveys.com/jfe/form/SV_7UiJTisrllOFbsG';
const LOGO_MARK = `<svg class="wordmark-mark" viewBox="0 0 660 660" aria-hidden="true">
  <polygon class="lm-2" points="336,0 429,323 336,323"/><polygon class="lm-3" points="1,323 326,231 326,323"/>
  <polygon class="lm-1" points="234,338 326,338 326,658"/><polygon class="lm-4" points="336,338 659,338 336,430"/></svg>`;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const app = document.getElementById('app');
const PENDING = '<span class="pill pill-pending" title="Foreløbig: Datoen er aftalt, men kurset er endnu ikke endeligt godkendt af skolen eller kommunen">Foreløbig</span>';
const rowClass = (a, planned) => (a.pending ? 'is-planned is-pending' : planned ? 'is-planned' : '');
const token = location.pathname.split('/').filter(Boolean)[1] || '';
const GOAL = 12; // workshops a year to keep the Apple Professional Learning Specialist status
let data;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

function table(rows, planned) {
  if (!rows.length) return `<p class="empty">${planned ? 'Ingen planlagte kurser lige nu.' : 'Ingen afholdte kurser endnu.'}</p>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Dato</th><th>Kursus</th><th>Skole</th><th>Varighed</th>${planned ? '' : '<th class="num">Deltagere</th><th class="num">Workshops</th>'}</tr></thead>
    <tbody>${rows.map((a) => `<tr class="${rowClass(a, planned)}">
      <td class="nowrap">${esc(fmtDate(a.date))}</td>
      <td><b>${esc(a.title)}</b>${a.pending ? ` ${PENDING}` : ''}<div class="muted small">${esc(a.reseller)}</div></td>
      <td>${esc(a.school || '–')}${a.municipality ? `<div class="muted small">${esc(a.municipality)}</div>` : ''}</td>
      <td>${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</td>
      ${planned ? '' : `<td class="num">${a.participants}</td><td class="num">${a.sessions}</td>`}
    </tr>`).join('')}</tbody></table></div>
    <ul class="cards-list k-cards">${rows.map((a) => `
      <li class="card act-card ${rowClass(a, planned)}">
        <div class="act-top"><span class="act-date">${esc(fmtDate(a.date))}</span><span class="tag">${esc(a.reseller)}</span></div>
        <div class="act-title">${esc(a.title)}${a.pending ? ` ${PENDING}` : ''}</div>
        <div class="muted">${esc(a.school || '–')}${a.municipality ? ` · ${esc(a.municipality)}` : ''}</div>
        <dl class="act-meta">
          <div><dt>Varighed</dt><dd>${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</dd></div>
          ${planned ? '' : `<div><dt>Workshops</dt><dd>${a.sessions}</dd></div><div><dt>Deltagere</dt><dd>${a.participants}</dd></div>`}
        </dl>
      </li>`).join('')}</ul>`;
}

function render() {
  const year = data.today.slice(0, 4);
  const sessionsTotal = data.held.reduce((n, a) => n + a.sessions, 0);
  const thisYear = data.sessionsByYear[year] || 0; // a full day counts as two workshops
  const heldYear = data.held.filter((a) => a.date.startsWith(year));
  const nPending = data.planned.filter((a) => a.pending).length;
  // "15 halve dage + 1 hel dag" makes it clear why 16 courses are 17 workshops.
  const days = (rows) => {
    const full = rows.filter((a) => a.duration === 'full').length;
    const half = rows.length - full;
    return [half && `${half} ${half === 1 ? 'halv dag' : 'halve dage'}`, full && `${full} ${full === 1 ? 'hel dag' : 'hele dage'}`].filter(Boolean).join(' + ') || 'ingen endnu';
  };
  const years = Object.entries(data.sessionsByYear).sort(([a], [b]) => b.localeCompare(a));
  const webcal = new URL(data.feedPath, location.href).toString().replace(/^https?:/, 'webcal:');
  document.title = `Mine kurser · ${data.name}`;

  app.innerHTML = `
    <header class="topbar"><div class="topbar-inner">
      <span class="wordmark">${LOGO_MARK}<span class="wordmark-text"><span class="wordmark-kompas">KOMPAS</span> APL Tracker</span></span>
    </div></header>
    <main class="page">
      <div class="pagehead"><div><p class="eyebrow">Konsulent</p><h1>${esc(data.name)}</h1>
        <p class="muted">Dine afholdte og kommende kurser. Siden opdateres, når Kompas registrerer eller flytter et kursus.</p></div>
        <div class="pagehead-actions"><a class="btn" href="${esc(webcal)}">Abonnér i Kalender</a><a class="btn btn-primary" href="${APPLE_SURVEY}" target="_blank" rel="noopener">Registrér hos Apple</a></div></div>

      <div class="kpis">
        <div class="kpi"><div class="kpi-num">${data.planned.length}</div><div class="kpi-label">Kommende kurser</div>
          <div class="kpi-sub">${nPending ? `heraf ${nPending} foreløbige` : 'ingen foreløbige'}</div></div>
        <div class="kpi"><div class="kpi-num">${heldYear.length}</div><div class="kpi-label">Afholdte kurser i ${year}</div>
          <div class="kpi-sub">${days(heldYear)}</div></div>
        <div class="kpi"><div class="kpi-num">${thisYear}<span class="kpi-of"> / ${GOAL}</span></div><div class="kpi-label">Workshops i ${year}</div>
          <div class="kpi-sub">halv dag = 1 · hel dag = 2</div></div>
        <div class="kpi"><div class="kpi-num">${data.held.length}</div><div class="kpi-label">Afholdte kurser i alt</div>
          <div class="kpi-sub">= ${sessionsTotal} ${sessionsTotal === 1 ? 'workshop' : 'workshops'} i alt</div></div>
      </div>

      <section class="card apple-card">
        <div class="card-head"><h2>Registrering hos Apple</h2><span class="muted small">En heldag tæller som 2 workshops</span></div>
        <p>Husk at registrere alle dine afholdte workshops hos Apple, også når du har nået de ${GOAL}. Du skal afholde mindst ${GOAL} workshops om året for at bevare din status som Apple Professional Learning Specialist.${thisYear >= GOAL ? ` Du har afholdt ${thisYear} i ${year}.` : ` Du har afholdt ${thisYear} i ${year} og mangler ${GOAL - thisYear}.`}</p>
        <p>I forhold til opgørelsen tæller en normal workshop på 1-4 timer som én session, mens en heldagsworkshop tæller for to.</p>
        <p>Hvis du ikke kan finde dit personlige link til spørgeskemaet ”Engagement Checkout Survey”, kan du også benytte dette åbne link. Den eneste forskel er, at du her selv skal indtaste navn, land og e-mail.</p>
        <div class="copyrow"><a class="btn btn-primary" href="${APPLE_SURVEY}" target="_blank" rel="noopener">Åbn Engagement Checkout Survey</a><button type="button" class="btn" id="copy-survey">Kopiér link</button></div>
        ${years.length > 1 ? `<p class="muted small">Workshops pr. år: ${years.map(([y, n]) => `${y}: ${n}`).join(' · ')}</p>` : ''}
      </section>

      <section class="card card-flush"><div class="card-head card-head-pad"><h2>Kommende kurser</h2><span class="muted small">Nærmeste først${data.planned.some((a) => a.pending) ? ' · Foreløbig = endnu ikke endeligt godkendt af skolen eller kommunen' : ''}</span></div>${table(data.planned, true)}</section>
      <section class="card card-flush"><div class="card-head card-head-pad"><h2>Afholdte kurser</h2><span class="muted small">Nyeste først · heldag tæller som 2 workshops</span></div>${table(data.held, false)}</section>
    </main>`;

  document.getElementById('copy-survey').onclick = async () => {
    try { await navigator.clipboard.writeText(APPLE_SURVEY); toast('Link kopieret'); } catch { window.open(APPLE_SURVEY, '_blank', 'noopener'); }
  };
}

async function load() {
  try {
    const r = await fetch(`/k/${encodeURIComponent(token)}/data`, { cache: 'no-store' });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Siden kunne ikke hentes.');
  } catch (ex) {
    app.innerHTML = `<main class="page"><div class="card"><h1>Siden findes ikke</h1><p class="muted">${esc(ex.message)}</p></div></main>`;
    return;
  }
  render();
}

load();
