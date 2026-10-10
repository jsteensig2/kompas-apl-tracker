// A consultant's own page: held and coming courses, Apple workshop count and the button that opens Apple's form filled in.
// Opened from the private link Kompas sends (/k/<token>); no login.

// Beskeder is paused (Jakob, 2026-10-06): the messages are kept, but not shown. Set to true to resume.
const SHOW_BESKEDER = false;
const LOGO_MARK = `<svg class="wordmark-mark" viewBox="0 0 660 660" aria-hidden="true">
  <polygon class="lm-2" points="336,0 429,323 336,323"/><polygon class="lm-3" points="1,323 326,231 326,323"/>
  <polygon class="lm-1" points="234,338 326,338 326,658"/><polygon class="lm-4" points="336,338 659,338 336,430"/></svg>`;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeText = (a) => (a.start_time ? (a.end_time ? `${a.start_time}–${a.end_time}` : `kl. ${a.start_time}`) : '');
const app = document.getElementById('app');
const PENDING = '<span class="pill pill-pending" title="Foreløbig: Datoen er aftalt, men kurset er endnu ikke endeligt godkendt af skolen eller kommunen">Foreløbig</span>';
const STAR = '<span class="star" title="Skal have ny dato. Står på den gamle dato, indtil en ny er fundet" aria-label="Skal have ny dato">★</span> ';
const rowClass = (a, planned) => (a.pending ? 'is-planned is-pending' : planned ? 'is-planned' : '');
const token = location.pathname.split('/').filter(Boolean)[1] || '';
const GOAL = 12; // workshops a year to keep the Apple Professional Learning Specialist status
let data;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
}

// Noter: a small speech bubble on each course; it opens the notes in a box. Empty bubble = no notes yet.
const NOTE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
const noteBtn = (a) => {
  const n = a.notes.length;
  const label = n ? `${n} ${n === 1 ? 'note' : 'noter'}` : 'Skriv en note';
  return ` <button type="button" class="note-btn ${n ? 'has-notes' : ''}" data-notes="${a.id}" title="${label}" aria-label="${label}">${NOTE_ICON}${n || ''}</button>`;
};

// Indberet hos Apple: one button per held course opens Apple's form with every known answer filled in.
// When the consultant comes back to this page, it asks whether the form was sent. A course marked as
// reported (by the consultant or Kompas) shows a green "Indberettet" that opens the details instead.
const appleBtn = (a) => (a.apple_reported_at
  ? `<button type="button" class="btn btn-sm nowrap apple-done" data-apple="${a.id}" title="Indberettet til Apple ${esc(fmtDate(a.apple_reported_at.slice(0, 10)))}">✓ Indberettet</button>`
  : a.appleForm ? `<a class="btn btn-sm btn-primary nowrap" href="${esc(a.appleForm)}" target="_blank" rel="noopener" data-apple-go="${a.id}">Indberet hos Apple</a>`
    : `<button type="button" class="btn btn-sm nowrap" data-apple="${a.id}">Indberet hos Apple</button>`);
let awaiting = null; // the course whose Apple form was just opened
// The tracker's hints point at Administration, which consultants don't have.
const OWN_HINTS = { 'E-mailadresse til specialist': 'Din egen e-mail', Postnummer: 'Skolens postnummer' };
const appleFields = (a) => `<div class="apple-pages">${[...new Set(a.apple.map(([p]) => p))].map((p) => `
  <div class="apple-page"><p class="eyebrow">${p}</p><dl>${a.apple.filter(([pg]) => pg === p).map(([, label, value, h]) => [label, value, OWN_HINTS[label] || h]).map(([label, value, hint]) => `
    <div class="apple-field"><dt>${esc(label)}</dt><dd>${value
      ? `<button type="button" class="apple-copy" data-copy="${esc(value)}" title="Kopiér">${esc(value)}</button>`
      : '<span class="apple-blank">Udfyld selv</span>'}${hint ? `<div class="muted small">${esc(hint)}</div>` : ''}</dd></div>`).join('')}
  </dl></div>`).join('')}</div>`;

function bindCopy(root) {
  root.querySelectorAll('.apple-copy').forEach((b) => {
    b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Kopieret'); } catch { toast('Kunne ikke kopiere'); } };
  });
}

// The Apple dialog. `asked`: the consultant is back from Apple's form, so ask whether it was sent.
function openApple(id, { asked = false } = {}) {
  const a = data.held.find((x) => String(x.id) === String(id));
  const dlg = document.getElementById('apple-dialog');
  if (!a || !dlg) return;
  const save = async (reported) => {
    try {
      const r = await fetch(`/k/${encodeURIComponent(token)}/courses/${a.id}/apple`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reported }) });
      if (!r.ok) throw new Error();
      a.apple_reported_at = (await r.json()).apple_reported_at;
      toast(reported ? 'Markeret som indberettet' : 'Markering fjernet');
      dlg.close();
      render();
    } catch { toast('Kunne ikke gemme'); }
  };
  dlg.innerHTML = `<div class="card-head"><div><p class="eyebrow">Indberet hos Apple</p><h2>${esc(a.title)}</h2>
      <p class="muted small">${esc(fmtDate(a.date))}${a.school ? ` · ${esc(a.school)}` : ''}</p></div>
      <button type="button" class="btn btn-sm" data-close>Luk</button></div>
    ${asked ? `<p><b>Har du indsendt Apples skema for dette kursus?</b></p>
      <p class="copyrow"><button type="button" class="btn btn-primary" data-yes>Ja, markér som indberettet</button><button type="button" class="btn" data-close>Ikke endnu</button></p>`
    : a.apple_reported_at ? `<p class="apple-todo is-done"><b>✓ Indberettet ${esc(fmtDate(a.apple_reported_at.slice(0, 10)))}</b></p>
      <p class="copyrow">${a.appleForm ? `<a class="btn btn-sm" href="${esc(a.appleForm)}" target="_blank" rel="noopener">Åbn Apples skema igen</a>` : ''}<button type="button" class="btn btn-sm" data-undo>Fjern markeringen</button></p>`
    : `<p class="small">Apples skema åbner med det, trackeren ved. Gå siderne igennem, udfyld felterne markeret Udfyld selv, og indsend skemaet.</p>
      <p class="copyrow">${a.appleForm ? `<a class="btn btn-primary btn-sm" href="${esc(a.appleForm)}" target="_blank" rel="noopener" data-apple-go="${a.id}">Åbn Apples skema udfyldt</a>` : ''}<button type="button" class="btn btn-sm" data-yes>Markér som indberettet</button></p>`}
    <details class="howto"><summary>Vis svarene til skemaet</summary>
      <p class="small muted">Tryk på en værdi for at kopiere den, hvis et felt står tomt i Apples skema.</p>${appleFields(a)}</details>`;
  bindCopy(dlg);
  dlg.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => dlg.close(); });
  dlg.querySelector('[data-yes]')?.addEventListener('click', () => save(true));
  dlg.querySelector('[data-undo]')?.addEventListener('click', () => save(false));
  dlg.querySelector('[data-apple-go]')?.addEventListener('click', () => { awaiting = a.id; dlg.close(); });
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  if (!dlg.open) dlg.showModal();
}

// Back from Apple's form (another tab): ask once whether it was sent.
const askIfSent = () => {
  if (awaiting == null || document.visibilityState !== 'visible') return;
  const id = awaiting;
  awaiting = null;
  if (!data.held.find((x) => x.id === id)?.apple_reported_at) openApple(id, { asked: true });
};
document.addEventListener('visibilitychange', askIfSent);
window.addEventListener('focus', askIfSent);

function table(rows, planned) {
  if (!rows.length) return `<p class="empty">${planned ? 'Ingen planlagte kurser lige nu.' : 'Ingen afholdte kurser endnu.'}</p>`;
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>Dato</th><th>Kursus</th><th>Skole</th><th>Varighed</th>${planned ? '' : '<th class="num">Deltagere</th><th class="num">Apple-workshops</th><th><span class="sr">Til Apple</span></th>'}</tr></thead>
    <tbody>${rows.map((a) => `<tr class="${rowClass(a, planned)}">
      <td class="nowrap">${esc(fmtDate(a.date))}${timeText(a) ? `<div class="muted small">${timeText(a)}</div>` : ''}</td>
      <td>${a.reschedule ? STAR : ''}<b>${esc(a.title)}</b>${a.pending ? ` ${PENDING}` : ''}${noteBtn(a)}<div class="muted small">${esc(a.reseller)}</div></td>
      <td>${esc(a.school || '–')}${a.municipality ? `<div class="muted small">${esc(a.municipality)}</div>` : ''}</td>
      <td>${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</td>
      ${planned ? '' : `<td class="num">${a.participants}</td><td class="num">${a.sessions}</td><td>${appleBtn(a)}</td>`}
    </tr>`).join('')}</tbody></table></div>
    <ul class="cards-list k-cards">${rows.map((a) => `
      <li class="card act-card ${rowClass(a, planned)}">
        <div class="act-top"><span class="act-date">${esc(fmtDate(a.date))}${timeText(a) ? ` · <span class="nowrap">${timeText(a)}</span>` : ''}</span><span class="tag">${esc(a.reseller)}</span></div>
        <div class="act-title">${a.reschedule ? STAR : ''}${esc(a.title)}${a.pending ? ` ${PENDING}` : ''}${noteBtn(a)}</div>
        <div class="muted">${esc(a.school || '–')}${a.municipality ? ` · ${esc(a.municipality)}` : ''}</div>
        <dl class="act-meta">
          <div><dt>Varighed</dt><dd>${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}</dd></div>
          ${planned ? '' : `<div><dt>Apple-workshops</dt><dd>${a.sessions}</dd></div><div><dt>Deltagere</dt><dd>${a.participants}</dd></div>`}
        </dl>${planned ? '' : `<div class="k-card-apple">${appleBtn(a)}</div>`}
      </li>`).join('')}</ul>`;
}

// Beskeder: notices from Kompas, newest first. New ones are marked "Ny" on this visit only.
const SHOW_MESSAGES = 3;
const fmtStamp = (ts) => new Date(`${ts.replace(' ', 'T')}Z`).toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' });
// Plain text with line breaks; web addresses become links.
const richText = (t) => esc(t).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

function messageItem(m) {
  return `<li class="msg ${m.unread ? 'is-new' : ''}">
    <div class="msg-head"><h3>${esc(m.title)}</h3>${m.unread ? '<span class="pill pill-new">Ny</span>' : ''}</div>
    <div class="muted small">${esc(fmtStamp(m.created_at))}${m.personal ? ' · Kun til dig' : ''}</div>
    ${m.body ? `<p class="msg-body">${richText(m.body)}</p>` : ''}
  </li>`;
}

function messagesSection() {
  if (!SHOW_BESKEDER || !data.messages?.length) return '';
  const fresh = data.messages.filter((m) => m.unread).length;
  const first = data.messages.slice(0, Math.max(SHOW_MESSAGES, fresh));
  const older = data.messages.slice(first.length);
  return `<section class="card" id="messages"><div class="card-head"><h2>Beskeder fra Kompas</h2>
      <span class="muted small">${fresh ? `${fresh} ${fresh === 1 ? 'ny besked' : 'nye beskeder'}` : 'Ingen nye beskeder'}</span></div>
    <ul class="msg-list">${first.map(messageItem).join('')}</ul>
    ${older.length ? `<details class="howto msg-older"><summary>Vis ${older.length} ældre ${older.length === 1 ? 'besked' : 'beskeder'}</summary>
      <ul class="msg-list">${older.map(messageItem).join('')}</ul></details>` : ''}</section>`;
}

// Tilmelding: Foreløbig courses without a consultant yet. Like a Doodle, the consultant answers
// "Det kan jeg" (no answer means they cannot; Måske was dropped, Jakob 2026-10-06). Kompas sees the
// answers and puts consultants on the courses.
const ANSWERS = [['yes', 'Det kan jeg']];
const people = (n) => `${n} ${n === 1 ? 'konsulent' : 'konsulenter'}`;
const needText = (c) => (c.needed
  ? `Tilmeldt ${c.yes}/${c.needed}${c.full ? ' · fuldt, lukket for tilmelding' : ` · mangler ${people(c.needed - c.yes)}`}`
  : (c.yes ? `${people(c.yes)} har meldt sig` : 'Ingen har meldt sig endnu'));

const signedText = () => { const n = data.signup.filter((c) => c.answer === 'yes').length; return `Du har meldt dig på ${n} af ${data.signup.length}`; };

function signupSection() {
  if (!data.signup.length) return '';
  return `<section class="card card-flush" id="signup"><div class="card-head card-head-pad"><h2>Kan du tage disse kurser?</h2>
      <span class="muted small" id="signup-count">${signedText()}</span></div>
    <p class="card-pad muted">Kurserne er foreløbige og har endnu ingen konsulent. Tryk Det kan jeg ved de kurser, du kan tage. Kurser, du ikke trykker på, regner Kompas med, at du ikke kan. Har du trykket Det kan jeg, er du tilmeldt, og skal du melde fra, så kontakt Kompas.</p>
    <ul class="signup-list">${data.signup.map((c) => `
      <li class="signup-row" data-id="${c.id}">
        <div class="signup-info">
          <div class="act-date">${esc(fmtDate(c.date))}${timeText(c) ? ` · ${timeText(c)}` : ''} · ${c.duration === 'full' ? 'Hel dag' : 'Halv dag'}</div>
          <div class="act-title">${esc(c.title)}</div>
          <div class="muted small">${esc(c.school || '–')}${c.municipality ? ` · ${esc(c.municipality)}` : ''} · ${esc(c.reseller)}</div>
          <div class="muted small" data-need>${needText(c)}</div>
          <div class="small su-locked" data-locked>${lockedText(c)}</div>
        </div>
        <div class="seg signup-seg" role="group" aria-label="Kan du tage kurset?">${ANSWERS.map(([k, l]) => `
          <button type="button" data-answer="${k}" class="ans-${k} ${c.answer === k ? 'on' : ''}" aria-pressed="${c.answer === k}"${locked(c, k) ? ' disabled' : ''}>${l}</button>`).join('')}</div>
      </li>`).join('')}</ul></section>`;
}

// A full course takes no new sign-ups.
const lockedText = (c) => (c.answer === 'yes' ? 'Du er tilmeldt. Kontakt Kompas, hvis du skal melde fra.' : '');
// After Det kan jeg only Kompas can take the sign-up back, so the button locks.
const locked = (c, k) => c.answer === 'yes' || (k === 'yes' && c.full);

function bindSignup() {
  document.querySelectorAll('.signup-row').forEach((li) => {
    li.querySelectorAll('[data-answer]').forEach((b) => {
      b.onclick = async () => {
        const c = data.signup.find((x) => String(x.id) === li.dataset.id);
        const answer = c.answer === b.dataset.answer ? '' : b.dataset.answer;
        li.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try {
          const r = await fetch(`/k/${encodeURIComponent(token)}/signup/${c.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }) });
          const res = await r.json();
          if (r.status === 409) { li.remove(); toast(res.error); return; }
          if (!r.ok) throw new Error(res.error || 'Svaret kunne ikke gemmes.');
          data.signup = res;
          const next = data.signup.find((x) => x.id === c.id);
          if (!next) { li.remove(); toast('Kurset er ikke længere åbent'); return; }
          li.querySelectorAll('[data-answer]').forEach((x) => { const on = x.dataset.answer === next.answer; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
          li.querySelector('[data-need]').textContent = needText(next);
          li.querySelector('[data-locked]').textContent = lockedText(next);
          document.getElementById('signup-count').textContent = signedText();
          toast(answer ? 'Svar gemt' : 'Svar fjernet');
        } catch (ex) {
          toast(ex.message);
        } finally {
          const now = data.signup.find((x) => x.id === c.id);
          li.querySelectorAll('[data-answer]').forEach((x) => { x.disabled = Boolean(now && locked(now, x.dataset.answer)); });
        }
      };
    });
  });
}

// The notes box for one course. Notes from Kompas and from the consultant; they can delete their own.
const course = (id) => [...data.planned, ...data.held].find((a) => String(a.id) === String(id));

function openNotes(id) {
  const a = course(id);
  const dlg = document.getElementById('notes-dialog');
  const draw = () => {
    dlg.innerHTML = `<form method="dialog" class="notes-dlg">
      <div class="card-head"><div><h2>Noter</h2><div class="muted small">${esc(fmtDate(a.date))} · ${esc(a.title)}${a.school ? ` · ${esc(a.school)}` : ''}</div></div>
        <button class="linkbtn" value="close" aria-label="Luk">Luk</button></div>
      ${a.notes.length ? `<ul class="note-list">${a.notes.map((n) => `<li class="note">
          <p class="note-body">${esc(n.body)}</p>
          <div class="note-meta muted small"><span>${esc(n.author)} · ${esc(fmtStamp(n.created_at))}</span>
            ${n.mine ? `<button type="button" class="linkbtn danger" data-del="${n.id}">Slet</button>` : ''}</div></li>`).join('')}</ul>`
        : '<p class="muted small">Ingen noter endnu. Skriv fx noget, man skal huske til næste gang, eller en idé. Noten ses kun af dig og Kompas.</p>'}
      <textarea name="body" rows="3" maxlength="1000" placeholder="Skriv en kort note…" aria-label="Ny note"></textarea>
      <div class="msg-actions"><button type="button" class="btn btn-primary" data-add>Gem note</button></div>
    </form>`;
    const save = async (url, opts) => {
      try {
        const r = await fetch(url, opts);
        const res = await r.json();
        if (!r.ok) throw new Error(res.error || 'Noten kunne ikke gemmes.');
        a.notes = res;
        document.querySelectorAll(`[data-notes="${a.id}"]`).forEach((b) => { b.outerHTML = noteBtn(a).trim(); });
        bindNotes();
        draw();
        return true;
      } catch (ex) { toast(ex.message); return false; }
    };
    dlg.querySelector('[data-add]').onclick = async () => {
      const body = dlg.querySelector('textarea').value.trim();
      if (!body) { dlg.querySelector('textarea').focus(); return; }
      if (await save(`/k/${encodeURIComponent(token)}/courses/${a.id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) })) toast('Note gemt');
    };
    dlg.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => { if (await save(`/k/${encodeURIComponent(token)}/notes/${b.dataset.del}`, { method: 'DELETE' })) toast('Note slettet'); };
    });
  };
  draw();
  dlg.showModal();
}

function bindNotes() {
  document.querySelectorAll('[data-notes]').forEach((b) => { b.onclick = () => openNotes(b.dataset.notes); });
}

function render() {
  const year = data.today.slice(0, 4);
  const thisYear = data.sessionsByYear[year] || 0; // a full day counts as two workshops
  const heldYear = data.held.filter((a) => a.date.startsWith(year));
  const notReported = data.held.filter((a) => !a.apple_reported_at).length;
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
        <div class="pagehead-actions"><a class="btn" href="${esc(webcal)}">Abonnér i Kalender</a></div></div>

      <div class="kpis kpis-3">
        <div class="kpi"><div class="kpi-num">${data.planned.length}</div><div class="kpi-label">Kommende kurser</div></div>
        <div class="kpi"><div class="kpi-num">${heldYear.length}</div><div class="kpi-label">Afholdte kurser i ${year}</div>
          <div class="kpi-sub">${days(heldYear)}</div></div>
        <div class="kpi"><div class="kpi-num">${data.held.length}</div><div class="kpi-label">Afholdte kurser i alt</div></div>
      </div>

      ${messagesSection()}

      ${signupSection()}

      <section class="card apple-card">
        <div class="card-head"><h2>Registrering hos Apple</h2></div>
        <div class="apple-count">
          <div class="kpi-num">${thisYear}<span class="kpi-of"> / ${GOAL}</span></div>
          <div><div class="kpi-label">Apple-workshops i ${year}</div>
            <div class="kpi-sub">Kun til Apple-registreringen tæller en halv dag som 1 workshop og en hel dag som 2.${heldYear.length && heldYear.length !== thisYear ? ` Dine ${heldYear.length} kurser i ${year} svarer derfor til ${thisYear} Apple-workshops.` : ''}</div></div>
        </div>
        ${notReported ? `<p class="apple-todo"><b>${notReported} ${notReported === 1 ? 'afholdt kursus mangler' : 'afholdte kurser mangler'}</b> at blive markeret som indberettet til Apple.</p>` : data.held.length ? '<p class="apple-todo is-done"><b>✓ Alle dine afholdte kurser er indberettet til Apple.</b></p>' : ''}
        <p>Husk at registrere alle dine afholdte workshops hos Apple, også når du har nået de ${GOAL}. Du skal afholde mindst ${GOAL} workshops om året for at bevare din status som Apple Professional Learning Specialist.${thisYear >= GOAL ? '' : ` Du mangler ${GOAL - thisYear} i ${year}.`}</p>
        <p class="small">Tryk <b>Indberet hos Apple</b> ved et afholdt kursus nedenfor. Apples skema åbner med det, trackeren ved, og du udfylder resten. Når du kommer tilbage hertil, spørger siden, om du har indsendt det.</p>
        <form class="k-apple-email" id="apple-email-form">
          <label class="field"><span>Din Apple-e-mail <small class="muted">· bliver skrevet ind i Apples skema</small></span><input type="email" name="email" value="${esc(data.email)}" placeholder="navn@eksempel.dk" autocomplete="email"></label>
          <button type="submit" class="btn">${data.email ? 'Gem ændring' : 'Gem'}</button>
        </form>
        ${years.length > 1 ? `<p class="muted small">Apple-workshops pr. år: ${years.map(([y, n]) => `${y}: ${n}`).join(' · ')}</p>` : ''}
      </section>

      <section class="card card-flush"><div class="card-head card-head-pad"><h2>Kommende kurser</h2><span class="muted small">Nærmeste først</span></div>
        <dl class="guide-list k-guide">
          <div><dt><span class="pill pill-planned">Planlagt</span></dt><dd>Kurset er godkendt. Du skal afholde det på datoen.</dd></div>
          <div><dt><span class="note-btn">${NOTE_ICON}</span></dt><dd>Noter. Tryk for at læse eller skrive en kort note på kurset, fx noget man skal huske til næste gang. Kun du og Kompas kan se noterne.</dd></div>
          <div><dt><span class="star">★</span></dt><dd>Kurset skal have en ny dato. Det står på den gamle dato, indtil en ny er fundet.</dd></div>
          <div><dt>${PENDING}</dt><dd>Datoen er aftalt, men skolen eller kommunen har endnu ikke godkendt kurset endeligt. Hold datoen fri, men regn ikke med kurset, før det skifter til Planlagt. I din kalender står der "(Foreløbig)" foran titlen.</dd></div>
        </dl>${table(data.planned, true)}</section>
      <section class="card card-flush"><div class="card-head card-head-pad"><h2>Afholdte kurser</h2><span class="muted small">Nyeste først</span></div>${table(data.held, false)}</section>
    </main>
    <dialog id="notes-dialog" class="dialog"></dialog>
    <dialog id="apple-dialog" class="dialog dialog-wide"></dialog>`;

  bindSignup();
  bindNotes();
  document.querySelectorAll('[data-apple]').forEach((b) => { b.onclick = () => openApple(b.dataset.apple); });
  document.querySelectorAll('[data-apple-go]').forEach((b) => { b.addEventListener('click', () => { awaiting = Number(b.dataset.appleGo); }); });
  document.getElementById('apple-email-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = e.target.email.value;
    try {
      const r = await fetch(`/k/${encodeURIComponent(token)}/apple-email`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error || 'Det lykkedes ikke');
      data.email = out.email || '';
      await load();
      toast(data.email ? 'Gemt' : 'E-mail fjernet');
    } catch (ex) { toast(ex.message); }
  };
  if (SHOW_BESKEDER && data.messages?.some((m) => m.unread)) {
    fetch(`/k/${encodeURIComponent(token)}/messages/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  }
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
