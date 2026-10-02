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
  { Dato: '03.03.2025', Varighed: 'Halv dag', Type: 'Workshop', 'Titel/emne': 'Jamf', Skole: 'Torstorp Skole', Kommune: 'Høje-Taastrup Kommune', Deltagere: 12, Konsulent: 'Kim Byrding', Reseller: 'Atea', 'Betalt af': 'Atea' },
  { Dato: future(30), Varighed: 'Hel dag', 'Titel/emne': 'ADS 2', Skole: 'Helt Ny Skole', Kommune: 'Aalborg', Deltagere: '', Konsulent: 'Ny Konsulent', Reseller: 'comm2ig', 'Betalt af': 'Apple' },
  { Dato: 45700, Varighed: 'half day', 'Titel/emne': 'AI', Skole: '', Kommune: '', Deltagere: 9, Konsulent: 'Kim Byrding', Reseller: 'Atea', 'Betalt af': '' },
  { Dato: '31.02.2026', 'Titel/emne': 'Mac – module 1', Reseller: 'Atea', Deltagere: 5 },
  { Dato: '04.03.2025', 'Titel/emne': 'Mac – module 1', Reseller: 'Ukendt Partner', Deltagere: 5 },
  { Dato: '05.03.2025', 'Titel/emne': 'Mac – module 1', Reseller: 'Atea', Deltagere: '' },
  { Dato: '03.03.2025', Varighed: 'Halv dag', 'Titel/emne': 'Jamf', Skole: 'Torstorp Skole', Kommune: 'Høje-Taastrup', Deltagere: 12, Reseller: 'Atea' },
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
  assert.ok(noParticipants.errors.some((e) => e.includes('deltagere')));
  assert.equal(dup.duplicate, true);
  assert.deepEqual({ ready: res.summary.ready, held: res.summary.held, planned: res.summary.planned, errors: res.summary.errors, duplicates: res.summary.duplicates },
    { ready: 3, held: 2, planned: 1, errors: 3, duplicates: 1 });
});

test('commit imports only valid rows; re-import finds duplicates', async () => {
  const before = (await json('admin', '/api/activities')).length;
  const res = await post('admin', '/api/import', { rows: ROWS, commit: true });
  assert.equal(res.summary.imported, 3);
  assert.equal((await json('admin', '/api/activities')).length, before + 3);
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
  assert.equal(d.orderbook.courses, all.filter((a) => a.status === 'planned').length);
  assert.ok(d.upcoming.every((a) => a.status === 'planned'));
});

test('resellers cannot import', async () => {
  assert.equal((await call('Atea', '/api/import', { method: 'POST', body: JSON.stringify({ rows: ROWS, commit: true }) })).status, 403);
});

test('missing required columns are reported', async () => {
  const res = await post('admin', '/api/import', { rows: [{ Foo: 1, Bar: 2, Baz: 3 }] });
  assert.deepEqual(res.missingColumns, ['date', 'title', 'reseller']);
});
