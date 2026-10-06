// Konsulentoverblik on Overblik, and the Dobbeltbooking warning (a consultant on two courses the same day).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { todayIso } from '../core/api.js';

let server, base, kim, soren, opts;
const cookies = {};

before(async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || 'admin'] = r.headers.get('set-cookie').split(';')[0];
  }
  opts = await json('admin', '/api/options');
  kim = opts.consultants.find((c) => c.name === 'Kim Byrding');
  soren = opts.consultants.find((c) => c.name === 'Søren Rasmussen');
});
after(() => server.close());
const call = (who, path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const future = (days) => new Date(Date.parse(`${todayIso()}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const course = (extra) => ({ date: future(40), duration: 'half', apl_type_id: opts.aplTypes[0].id, title: 'Dobbelt test', participants: '',
  reseller_id: opts.resellers[0].id, consultant_id: kim.id, ...extra });

test('Konsulentoverblik counts held, planned and Foreløbig per consultant; Foreløbig never as held', async () => {
  const year = todayIso().slice(0, 4);
  const before = (await json('admin', `/api/dashboard?year=${year}`)).consultants.rows.find((r) => r.id === kim.id);
  // A Foreløbig course in the past stays out of Afholdt.
  const past = new Date(Date.parse(`${todayIso()}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
  await json('admin', '/api/activities', post(course({ date: past, participants: 5, pending: 1 })));
  await json('admin', '/api/activities', post(course({ date: future(10), duration: 'full' })));
  const d = await json('admin', `/api/dashboard?year=${year}`);
  const row = d.consultants.rows.find((r) => r.id === kim.id);
  assert.equal(row.held, before.held);
  assert.equal(row.pending, before.pending + 1);
  assert.equal(row.planned, before.planned + 1);
  assert.equal(d.consultants.rows.length, opts.consultants.length);
  // The numbers match the activity list.
  const list = await json('admin', `/api/activities?year=${year}&consultant=${kim.id}&status=held`);
  assert.equal(row.held, list.length);
  assert.equal(row.workshops, list.reduce((n, a) => n + (a.duration === 'full' ? 2 : 1), 0));
});

test('resellers and viewers never get the consultant overview or the double booking list', async () => {
  for (const who of ['Atea', 'Comm2IG']) {
    const d = await json(who, '/api/dashboard');
    assert.ok(!('consultants' in d) && !('doubleBookings' in d));
    assert.ok((await json(who, '/api/activities?year=')).every((a) => !('double_booked' in a)));
    assert.equal((await call(who, `/api/activities/same-day?date=${future(40)}&consultants=${kim.id}`)).status, 403);
  }
});

test('Dobbeltbooking is a warning: saving works, and the course is marked in lists and on Overblik', async () => {
  const date = future(55);
  const first = await json('admin', '/api/activities', post(course({ date })));
  assert.deepEqual(await json('admin', `/api/activities/same-day?date=${date}&consultants=${kim.id}&exclude=${first.id}`), []);
  const hits = await json('admin', `/api/activities/same-day?date=${date}&consultants=${kim.id},${soren.id}`);
  assert.deepEqual(hits.map((a) => a.id), [first.id]);
  const res = await call('admin', '/api/activities', post(course({ date, title: 'Andet kursus' })));
  assert.equal(res.status, 200);
  const second = await res.json();
  const rows = (await json('admin', `/api/activities?year=&consultant=${kim.id}`)).filter((a) => a.date === date);
  assert.deepEqual(rows.map((a) => a.double_booked), [1, 1]);
  // Another consultant the same day is not a double booking.
  const other = await json('admin', '/api/activities', post(course({ date, consultant_id: soren.id })));
  assert.equal((await json('admin', `/api/activities?year=&consultant=${soren.id}`)).find((a) => a.id === other.id).double_booked, 0);
  const group = (await json('admin', '/api/dashboard')).doubleBookings.find((g) => g.date === date);
  assert.equal(group.consultant, 'Kim Byrding');
  assert.deepEqual(group.courses.map((c) => c.id).sort(), [first.id, second.id].sort());
});

test('Tilmelding tells Kompas which consultants already have a course that day', async () => {
  const date = future(70);
  await json('admin', '/api/activities', post(course({ date })));
  const rows = [{ Dato: date, Varighed: 'Halv dag', 'Titel/emne': 'Åbent kursus', Skole: 'Borgerskolen', Kommune: 'Høje-Taastrup', Reseller: 'Atea', Status: 'Foreløbig' }];
  assert.equal((await json('admin', '/api/import', post({ rows, commit: true }))).summary.imported, 1);
  const c = (await json('admin', '/api/signups')).courses.find((x) => x.date === date);
  assert.deepEqual(c.busy, [kim.id]);
});
