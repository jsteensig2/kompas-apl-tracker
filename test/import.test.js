// Bulk import and held/planned (order book) split.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { parseDate, parseDuration } from '../core/import.js';
import { todayIso } from '../core/api.js';

let server, base;
const cookies = {};
before(async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || 'admin'] = r.headers.get('set-cookie').split(';')[0];
  }
});
after(() => server.close());
const call = (who, path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const post = (who, path, body) => json(who, path, { method: 'POST', body: JSON.stringify(body) });

const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10).split('-').reverse().join('.');
const ROWS = [
  { Dato: '03.03.2025', Varighed: 'Halv dag', Type: 'Workshop Fysisk', 'Titel/emne': 'Jamf', Skole: 'Torstorp Skole', Kommune: 'Høje-Taastrup Kommune', Deltagere: 12, Konsulent: 'Kim Byrding', Reseller: 'Atea', 'Betalt af': 'Atea' },
  { Dato: future(30), Varighed: 'Hel dag', 'Titel/emne': 'ADS 2', Skole: 'Helt Ny Skole', Kommune: 'Aalborg', Deltagere: '', Konsulent: 'Ny Konsulent', Reseller: 'comm2ig', 'Betalt af': 'Apple' },
  { Dato: 45700, Varighed: 'half day', 'Titel/emne': 'AI', Skole: '', Kommune: '', Deltagere: 9, Konsulent: 'Kim Byrding', Reseller: 'Atea', 'Betalt af': '' },
  { Dato: '31.02.2026', 'Titel/emne': 'Mac – module 1', Reseller: 'Atea', Deltagere: 5 },
  { Dato: '04.03.2025', 'Titel/emne': 'Mac – module 1', Reseller: 'Ukendt Partner', Deltagere: 5 },
  { Dato: '05.03.2025', 'Titel/emne': 'Mac – module 1', Reseller: 'Atea A/S', Deltagere: '' },
  { Dato: '03.03.2025', Varighed: 'Halv dag', 'Titel/emne': 'Jamf', Skole: 'Torstorp Skole', Kommune: 'Høje-Taastrup', Deltagere: 12, Reseller: 'Atea', Konsulent: 'Kim Byrding' },
];

test('date and duration parsing', () => {
  assert.equal(parseDate('19.02.2026'), '2026-02-19');
  assert.equal(parseDate('2026-02-19'), '2026-02-19');
  assert.equal(parseDate('5/8/26'), '2026-08-05');
  assert.equal(parseDate(45707), '2025-02-19');
  assert.equal(parseDate('31.02.2026'), null);
  assert.equal(parseDuration('Hel dag'), 'full');
  assert.equal(parseDuration('Full day'), 'full');
  assert.equal(parseDuration(''), 'half');
  assert.equal(parseDate('19. feb 2026'), '2026-02-19');
  assert.equal(parseDate('3 marts 2025'), '2025-03-03');
  assert.equal(parseDate('19.02.2026 09:00'), '2026-02-19');
  assert.equal(parseDate('torsdag d. 19.02.2026'), '2026-02-19');
});

test('preview validates rows and splits held and planned', async () => {
  const res = await post('admin', '/api/import', { rows: ROWS });
  const [held, planned, serial, badDate, badReseller, noParticipants, dup] = res.rows;
  assert.equal(held.status, 'held');
  assert.equal(held.municipality, 'Høje-Taastrup');
  assert.equal(planned.status, 'planned');
  assert.equal(planned.reseller, 'Comm2IG');
  assert.ok(planned.warnings.some((w) => w.includes('Ny Konsulent')) && planned.warnings.some((w) => w.includes('Helt Ny Skole')));
  assert.equal(serial.date, '2025-02-12');
  assert.ok(badDate.errors.length);
  assert.ok(badReseller.errors.some((e) => e.includes('Ukendt Partner')));
  assert.equal(noParticipants.errors.length, 0);
  assert.equal(noParticipants.reseller, 'Atea');
  assert.equal(noParticipants.participants, 0);
  assert.ok(noParticipants.warnings.some((w) => w.includes('deltagere')));
  assert.equal(dup.duplicate, true);
  assert.deepEqual({ ready: res.summary.ready, held: res.summary.held, planned: res.summary.planned, errors: res.summary.errors, duplicates: res.summary.duplicates },
    { ready: 4, held: 3, planned: 1, errors: 2, duplicates: 1 });
});

test('commit imports only valid rows; re-import finds duplicates', async () => {
  const before = (await json('admin', '/api/activities')).length;
  const res = await post('admin', '/api/import', { rows: ROWS, commit: true });
  assert.equal(res.summary.imported, 4);
  assert.equal((await json('admin', '/api/activities')).length, before + 4);
  const again = await post('admin', '/api/import', { rows: ROWS });
  assert.equal(again.summary.ready, 0);
  const c2 = await json('Comm2IG', '/api/activities?status=planned');
  assert.ok(c2.some((a) => a.school === 'Helt Ny Skole' && a.status === 'planned'));
  assert.ok(c2.every((a) => a.status === 'planned' && a.date > todayIso()));
});

test('dashboard key figures count held courses only; order book counts planned', async () => {
  const d = await json('admin', `/api/dashboard?year=${new Date().getFullYear()}`);
  const all = await json('admin', `/api/activities?year=${new Date().getFullYear()}`);
  assert.equal(d.kpi.experiences, all.filter((a) => a.status === 'held').length);
  const coming = await json('admin', '/api/activities?status=planned');
  assert.equal(d.orderbook.courses, coming.length); // all coming courses, also in later years
  assert.ok(d.upcoming.every((a) => a.status === 'planned'));
});

test('resellers cannot import', async () => {
  assert.equal((await call('Atea', '/api/import', { method: 'POST', body: JSON.stringify({ rows: ROWS, commit: true }) })).status, 403);
});

test('missing date column is reported', async () => {
  const res = await post('admin', '/api/import', { rows: [{ Foo: 1, Bar: 2, Baz: 3 }] });
  assert.deepEqual(res.missingColumns, ['date']);
});

test('messy sheet: title above headers, loose headers, blanks filled in, default reseller', async () => {
  const opts = await json('admin', '/api/options');
  const comm2ig = opts.resellers.find((r) => r.name === 'Comm2IG').id;
  const table = [
    ['Kurser efterår 2024', '', '', ''],
    ['', '', '', ''],
    ['Dato for kurset', 'Skole', 'Antal deltagere (ca.)', 'Kommune', 'Varighed'],
    ['12. sep 2024', 'Rødovre Skole', 'ca. 20', 'Atlantis', 'formiddag'],
    ['13.09.2024', '', '', '', ''],
    ['', '', '', '', ''],
    ['ikke en dato', 'X', '3', '', ''],
  ];
  const noDefault = await post('admin', '/api/import', { table });
  assert.deepEqual(noDefault.missingColumns, []);
  assert.ok(noDefault.rows[0].errors.some((e) => e.includes('reseller')));
  const res = await post('admin', '/api/import', { table, reseller: comm2ig });
  const [a, b, c] = res.rows;
  assert.equal(a.line, 4);
  assert.deepEqual(a.errors, []);
  assert.equal(a.date, '2024-09-12');
  assert.equal(a.participants, 20);
  assert.equal(a.duration, 'half');
  assert.equal(a.reseller, 'Comm2IG');
  assert.ok(a.warnings.some((w) => w.includes('Atlantis')));
  assert.ok(a.title);
  assert.deepEqual(b.errors, []);
  assert.equal(b.participants, 0);
  assert.equal(c.line, 7);
  assert.ok(c.errors.some((e) => e.includes('dato')));
  const done = await post('admin', '/api/import', { table, reseller: comm2ig, commit: true });
  assert.equal(done.summary.imported, 2);
  const atea = await json('Atea', '/api/activities');
  assert.ok(!atea.some((x) => x.school === 'Rødovre Skole'));
});

test('columns can be re-mapped by hand; unknown reseller falls back to the chosen one', async () => {
  const opts = await json('admin', '/api/options');
  const atea = opts.resellers.find((r) => r.name === 'Atea').id;
  const table = [
    ['Dato', 'Kursus', 'Emne', 'Skole', 'Forhandler'],
    ['05.08.2026', '08:30 - 11:30', 'Jamf grundkursus', 'Læringshuset', '05-08-2026'],
  ];
  const auto = await post('admin', '/api/import', { table });
  assert.ok(auto.headers.includes('Emne'));
  assert.ok(auto.rows[0].errors.some((e) => e.includes('05-08-2026')));
  const fixed = await post('admin', '/api/import', { table, reseller: atea, mapping: { title: 'Emne', reseller: '' } });
  assert.deepEqual(fixed.rows[0].errors, []);
  assert.equal(fixed.rows[0].title, 'Jamf grundkursus');
  assert.equal(fixed.rows[0].reseller, 'Atea');
  const fallback = await post('admin', '/api/import', { table, reseller: atea });
  assert.deepEqual(fallback.rows[0].errors, []);
  assert.ok(fallback.rows[0].warnings.some((w) => w.includes('Atea brugt')));
});

test('several consultants by initials become one course each; unknown initials are left out', async () => {
  const table = [
    ['Dato', 'Titel', 'Reseller', 'Konsulent', 'Deltagere'],
    ['01.09.2025', 'Initialer-test', 'Atea', 'SR,KB,RT, JS', 4],
    ['02.09.2025', 'Initialer-test 2', 'Atea', 'kb og XY', 5],
  ];
  const res = await post('admin', '/api/import', { table, commit: true });
  assert.deepEqual(res.rows.map((r) => r.consultant), ['Søren Rasmussen', 'Kim Byrding', 'Rasmus Toft', 'Jacob Schandorf', 'Kim Byrding']);
  assert.equal(res.summary.imported, 5);
  assert.ok(res.rows[4].warnings.some((w) => w.includes('XY')));
  const list = await json('admin', '/api/activities?q=Initialer-test');
  assert.equal(list.filter((x) => x.title === 'Initialer-test').length, 4);
  const opts = await json('admin', '/api/options');
  assert.equal(opts.consultants.find((c) => c.name === 'Rasmus Toft').initials, 'RT');
  const again = await post('admin', '/api/import', { table });
  assert.equal(again.summary.duplicates, 5);
});

test('several sheets with headings, defaults for empty fields, similar courses unticked', async () => {
  const opts = await json('admin', '/api/options');
  const id = (list, name) => opts[list].find((x) => x.name === name).id;
  const sheets = [
    { name: 'Resume', table: [['Eksporteret fra Numbers'], ['Navn på ark']] },
    { name: 'Lærere', table: [['LÆRERE', ''], ['Dato', 'Dag', 'Skole', 'Modul', 'Konsulenter'], ['10-09-2025', 'onsdag', 'Fløng', 'Modul 1', 'KB, RT']] },
    { name: 'Pædagoger', table: [['PÆDAGOGER', ''], ['Dato', 'Dag', 'Skole', 'Modul', 'Konsulenter'], ['10-09-2025', 'onsdag', 'Fløng Skole', 'Modul 1', 'KB'], ['11/26/26', 'torsdag', 'Fløng Skole', 'Modul 1', 'SR']] },
  ];
  const defaults = { reseller: id('resellers', 'Atea'), paidBy: id('paidBy', 'Høje-Taastrup Kommune'), municipality: id('municipalities', 'Høje-Taastrup') };
  const res = await post('admin', '/api/import', { sheets, defaults });
  assert.equal(res.rows.length, 4);
  assert.deepEqual(res.rows.map((r) => r.title), ['Modul 1 – Lærere', 'Modul 1 – Lærere', 'Modul 1 – Pædagoger', 'Modul 1 – Pædagoger']);
  assert.ok(res.rows.every((r) => r.paidBy === 'Høje-Taastrup Kommune' && r.municipality === 'Høje-Taastrup' && r.reseller === 'Atea'));
  assert.equal(res.rows[3].date, '2026-11-26');
  assert.ok(res.rows[3].warnings.some((w) => w.includes('måned først')));
  const done = await post('admin', '/api/import', { sheets, defaults, commit: true });
  assert.equal(done.summary.imported, 4);
  const schools = (await json('admin', '/api/options')).schools.filter((s) => s.name.startsWith('Fløng'));
  assert.deepEqual(schools.map((s) => s.name), ['Fløng Skole']);

  // The same course registered by hand under another title is flagged and left out by default.
  const again = [{ name: 'X', table: [['Dato', 'Skole', 'Titel', 'Konsulent', 'Reseller'], ['10-09-2025', 'Fløng Skole', 'Kompetenceforløb', 'KB', 'Atea']] }];
  const prev = await post('admin', '/api/import', { sheets: again });
  assert.equal(prev.rows[0].similar, true);
  assert.equal(prev.rows[0].selected, false);
  assert.equal(prev.summary.ready, 0);
  const forced = await post('admin', '/api/import', { sheets: again, include: { [prev.rows[0].rid]: true } });
  assert.equal(forced.summary.ready, 1);
});

test('unknown APL types are not created; Greenland defaults to Workshop Online', async () => {
  const rows = [
    { Dato: '01.09.2026', Type: 'tirsdag', 'Titel/emne': 'A', Skole: 'Torstorp Skole', Reseller: 'Atea' },
    { Dato: '02.09.2026', 'Titel/emne': 'B', Skole: 'Flere skoler – Kujalleq', Reseller: 'Comm2IG' },
    { Dato: '03.09.2026', Type: 'Sparring', 'Titel/emne': 'C', Skole: 'Torstorp Skole', Reseller: 'Atea' },
  ];
  const r = await post('admin', '/api/import', { rows, commit: false });
  assert.deepEqual(r.rows.map((x) => x.type), ['Workshop Fysisk', 'Workshop Online', 'Sparring']);
  assert.ok(r.rows[0].warnings.some((w) => w.includes('"tirsdag" findes ikke')));
  const opts = await json('admin', '/api/options');
  assert.deepEqual(opts.aplTypes.map((t) => t.name), ['Oplæg', 'Workshop Online', 'Workshop Fysisk', 'Sparring', 'Andet']);
});

test('a Status column saying "afventer" imports the course as pending (Foreløbig)', async () => {
  const rows = [
    { Dato: future(40), 'Titel/emne': 'Pending import', Skole: 'Torstorp Skole', Reseller: 'Atea', Konsulent: 'Kim Byrding', Status: 'Afventer godkendelse' },
    { Dato: future(41), 'Titel/emne': 'Confirmed import', Skole: 'Torstorp Skole', Reseller: 'Atea', Konsulent: 'Kim Byrding', Status: 'Godkendt' },
  ];
  const r = await post('admin', '/api/import', { rows, commit: true });
  assert.deepEqual(r.rows.map((x) => x.pending), [true, false]);
  assert.equal(r.summary.pending, 1);
  const pending = await json('admin', '/api/activities?status=pending');
  assert.deepEqual(pending.map((a) => a.title), ['Pending import']);
});

test('the same course at several new schools on one day is not taken for a duplicate', async () => {
  const rows = ['Linje 10', 'Ungdomsskolen', 'Helt Ny Reerslev'].map((Skole) => ({ Dato: future(60), 'Titel/emne': 'Modul 2', Skole, Reseller: 'Atea' }));
  const r = await post('admin', '/api/import', { rows, commit: false });
  assert.equal(r.summary.duplicates, 0);
  assert.equal(r.summary.ready, 3);
});
