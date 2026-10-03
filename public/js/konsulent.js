// A consultant's own page: held and coming courses, Apple session count and help with Apple's survey.
// Opened from the private link Kompas sends (/k/<token>); no login.

const APPLE_SURVEY = 'https://essentials.applesurveys.com/jfe/form/SV_7UiJTisrllOFbsG';
const LOGO_MARK = `<svg class="wordmark-mark" viewBox="0 0 660 660" aria-hidden="true">
  <polygon class="lm-2" points="336,0 429,323 336,323"/><polygon class="lm-3" points="1,323 326,231 326,323"/>
  <polygon class="lm-1" points="234,338 326,338 326,658"/><polygon class="lm-4" points="336,338 659,338 336,430"/></svg>`;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dmy = (d) => d.split('-').reverse().join('/'); // Apple asks for dd/mm/åååå
const addDays = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
const app = document.getElementById('app');
const token = location.pathname.split('/').filter(Boolean)[1] || '';
let data;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

// Apple wants the report within 7 days of the session.
function appleState(a) {
  if (a.appleReportedAt) return { cls: 'pill-done', text: 'Indsendt til Apple' };
  const due = addDays(a.date, 7);
  return due < data.today ? { cls: 'pill-late', text: `Mangler · frist ${dmy(due)}` } : { cls: 'pill-planned', text: `Indsend senest ${dmy(due)}` };
}

function table(rows, planned) {
  if (!rows.length) return `<p class="empty">${planned ? 'Ingen planlagte kurser lige nu.' : 'Ingen afholdte kurser endnu.'}</p>`;
  const apple = (a) => `<button type="button" class="btn btn-sm" data-apple="${a.id}">Klar til Apple</button>
    <div class="small k-state"><span class="pill ${appleState(a).cls}">${esc(appleState(a).text)}</span></div>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Dato</th><th>Kursus</th><th>Skole</th><th>Varighed</th>${planned ? '' : '<th class="num">Deltagere</th><th class="num">Sessioner</th><th>Apple</th>'}</tr></thead>
    <tbody>${rows.map((a) => `<tr class="${planned ? 'is-planned' : ''}">
      <td class="nowrap">${esc(fmtDate(a.date))}</td>
      <td><b>${esc(a.title)}</b><div class="muted small">${esc(a.reseller)}</div></td>
      <td>${esc(a.school || '–')}${a.municipality ? `<div class="muted small">${esc(a.municipality)}</div>` : ''}</td>
      <td>${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</td>
      ${planned ? '' : `<td class="num">${a.participants}</td><td class="num">${a.sessions}</td><td class="nowrap">${apple(a)}</td>`}
    </tr>`).join('')}</tbody></table></div>
    <ul class="cards-list k-cards">${rows.map((a) => `
      <li class="card act-card ${planned ? 'is-planned' : ''}">
        <div class="act-top"><span class="act-date">${esc(fmtDate(a.date))}</span><span class="tag">${esc(a.reseller)}</span></div>
        <div class="act-title">${esc(a.title)}</div>
        <div class="muted">${esc(a.school || '–')}${a.municipality ? ` · ${esc(a.municipality)}` : ''}</div>
        <dl class="act-meta">
          <div><dt>Varighed</dt><dd>${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</dd></div>
          ${planned ? '' : `<div><dt>Sessioner</dt><dd>${a.sessions}</dd></div><div><dt>Deltagere</dt><dd>${a.participants}</dd></div>`}
        </dl>
        ${planned ? '' : `<div class="k-card-apple">${apple(a)}</div>`}
      </li>`).join('')}</ul>`;
}

// The survey's questions in its own order. Values we know are filled in; the rest is the consultant's choice.
function appleFields(a) {
  const several = /flere skoler/i.test(a.school);
  const online = /webinar|online|zoom|teams/i.test(`${a.title} ${a.apl_type}`);
  return [
    ['Side 1', null],
    ['Vælg dit område', 'EMEIA (Europa, Mellemøsten, Indien og Afrika)'],
    ['Navn på specialist (for- og efternavn)', data.name],
    ['E-mailadresse til specialist', '', 'Din egen e-mail'],
    ['Leveringsland', a.country],
    ['Side 2', null],
    ['Skolens navn', several ? '' : a.school, several ? 'Flere skoler: skriv kundens navn' : ''],
    ['System/distrikt/ministeriums navn', a.municipality ? (a.country === 'Danmark' ? `${a.municipality} Kommune` : a.municipality) : ''],
    ['Postnummer', '', 'Skolens postnummer'],
    ['Hvor mange individuelle uddannelsesinstitutioner deltog?', several ? '' : '1', several ? 'Antal skoler' : ''],
    ['Projekttype/niveau', '', 'Vælg fx Indskoling, Mellemtrin, Udskoling eller Alle skolealdre'],
    ['Implementeringsstadie', '', 'Introduktion, Integration eller Innovation'],
    ['Side 3', null],
    ['Var institutionen en Apple Distinguished School?', 'No', 'Vælg Yes, hvis skolen er ADS'],
    ['Brugte du ressourcer fra APLS Experiences Catalog?', '', 'Yes eller No'],
    ['Side 4', null],
    ['Hvad var varigheden af din session?', a.duration === 'full' ? 'Hel dag' : 'Halv dag (1-4 timer)'],
    ['Leveringstilstand', online ? 'Online' : 'Fysisk fremmøde', online ? '' : 'Vælg Online, hvis det var et webinar'],
    ['Startdato', dmy(a.date)],
    ['Slutdato', dmy(a.date)],
    ['Blev denne session afholdt …', '', 'Enkeltstående, del af en serie eller del af en længerevarende plan'],
    ['Hvem var sessionen tilpasset til?', 'Undervisere'],
    ['Antal deltagere', String(a.participants || '')],
  ];
}

function openApple(id) {
  const a = data.held.find((x) => x.id === id);
  if (!a) return;
  const fields = appleFields(a);
  const sheet = document.createElement('div');
  sheet.className = 'k-overlay';
  sheet.innerHTML = `<section class="k-sheet card" role="dialog" aria-modal="true" aria-labelledby="k-sheet-title">
    <div class="card-head"><div><p class="eyebrow">Klar til Apple</p><h2 id="k-sheet-title">${esc(a.title)}</h2>
      <p class="muted small">${esc(fmtDate(a.date))}${a.school ? ` · ${esc(a.school)}` : ''}</p></div>
      <button type="button" class="btn btn-sm" data-close aria-label="Luk">Luk</button></div>
    <p class="small">Åbn skemaet, vælg Dansk, og udfyld felterne i samme rækkefølge som her. Tryk på en værdi for at kopiere den.</p>
    <div class="copyrow"><a class="btn btn-primary" href="${APPLE_SURVEY}" target="_blank" rel="noopener">Åbn Apples skema</a></div>
    <dl class="k-fields">${fields.map(([label, value, hint]) => (value === null ? `<dt class="k-step">${esc(label)}</dt>` : `
      <div class="k-field"><dt>${esc(label)}</dt><dd>${value
        ? `<button type="button" class="k-copy" data-value="${esc(value)}">${esc(value)}<span class="k-copy-hint">Kopiér</span></button>`
        : '<span class="muted">Udfyld selv</span>'}${hint ? `<div class="muted small">${esc(hint)}</div>` : ''}</dd></div>`)).join('')}</dl>
    <label class="k-done"><input type="checkbox" ${a.appleReportedAt ? 'checked' : ''}> Jeg har sendt kurset til Apple</label>
  </section>`;
  document.body.append(sheet);
  document.body.classList.add('k-noscroll');
  const close = () => { sheet.remove(); document.body.classList.remove('k-noscroll'); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  sheet.onclick = (e) => { if (e.target === sheet) close(); };
  sheet.querySelector('[data-close]').onclick = close;
  sheet.querySelector('[data-close]').focus();
  sheet.querySelectorAll('.k-copy').forEach((b) => {
    b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.value); toast('Kopieret'); } catch { toast('Kunne ikke kopiere'); } };
  });
  sheet.querySelector('.k-done input').onchange = async (e) => {
    const reported = e.target.checked;
    try {
      const r = await fetch(`/k/${encodeURIComponent(token)}/apple`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, reported }) });
      if (!r.ok) throw new Error((await r.json()).error);
      a.appleReportedAt = reported ? new Date().toISOString() : null;
      toast(reported ? 'Markeret som sendt til Apple' : 'Markering fjernet');
      render();
    } catch (ex) { e.target.checked = !reported; toast(ex.message || 'Det lykkedes ikke'); }
  };
}

function render() {
  const year = data.today.slice(0, 4);
  const sessionsTotal = data.held.reduce((n, a) => n + a.sessions, 0);
  const missing = data.held.filter((a) => !a.appleReportedAt).length;
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
        <div class="kpi"><div class="kpi-num">${data.planned.length}</div><div class="kpi-label">Planlagte kurser</div></div>
        <div class="kpi"><div class="kpi-num">${data.held.length}</div><div class="kpi-label">Afholdte kurser</div></div>
        <div class="kpi"><div class="kpi-num">${data.sessionsByYear[year] || 0}</div><div class="kpi-label">Sessioner i ${year}</div></div>
        <div class="kpi"><div class="kpi-num">${missing}</div><div class="kpi-label">Mangler at sende til Apple</div></div>
      </div>

      <section class="card apple-card">
        <div class="card-head"><h2>Registrering hos Apple</h2><span class="muted small">${sessionsTotal} sessioner i alt</span></div>
        <p>I forhold til opgørelsen tæller en normal workshop på 1-4 timer som én session, mens en heldagsworkshop tæller for to.</p>
        <p>Hvis du ikke kan finde dit personlige link til spørgeskemaet ”Engagement Checkout Survey”, kan du også benytte dette åbne link. Den eneste forskel er, at du her selv skal indtaste navn, land og e-mail.</p>
        <p>Tryk <b>Klar til Apple</b> ved et afholdt kursus for at få svarene til skemaet klar til at kopiere, og sæt flueben, når det er sendt.</p>
        <div class="copyrow"><a class="btn btn-primary" href="${APPLE_SURVEY}" target="_blank" rel="noopener">Åbn Engagement Checkout Survey</a><button type="button" class="btn" id="copy-survey">Kopiér link</button></div>
        ${years.length > 1 ? `<p class="muted small">Sessioner pr. år: ${years.map(([y, n]) => `${y}: ${n}`).join(' · ')}</p>` : ''}
      </section>

      <section class="card card-flush"><div class="card-head card-head-pad"><h2>Kommende kurser</h2><span class="muted small">Nærmeste først</span></div>${table(data.planned, true)}</section>
      <section class="card card-flush"><div class="card-head card-head-pad"><h2>Afholdte kurser</h2><span class="muted small">Nyeste først · heldag tæller som 2 sessioner</span></div>${table(data.held, false)}</section>
    </main>`;

  document.getElementById('copy-survey').onclick = async () => {
    try { await navigator.clipboard.writeText(APPLE_SURVEY); toast('Link kopieret'); } catch { window.open(APPLE_SURVEY, '_blank', 'noopener'); }
  };
  app.querySelectorAll('[data-apple]').forEach((b) => { b.onclick = () => openApple(Number(b.dataset.apple)); });
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
