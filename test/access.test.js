// Verifies reseller data separation and admin-only writes over real HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { createServer } from '../server/index.js';

let server, base;
const cookies = {};

before(async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  const users = await (await fetch(`${base}/auth/demo-users`)).json();
  for (const u of users) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || 'admin'] = r.headers.get('set-cookie').split(';')[0];
  }
});
after(() => server.close());

const call = (who, path, opts = {}) => fetch(base + path, {
  ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json', ...(opts.headers || {}) },
});
const json = async (who, path, opts) => (await call(who, path, opts)).json();

test('admin sees activities for all resellers', async () => {
  const rows = await json('admin', '/api/activities');
  assert.deepEqual([...new Set(rows.map((r) => r.reseller))].sort(), ['Atea', 'Comm2IG']);
});

test('each reseller only sees own activities, even when asking for another reseller', async () => {
  const opts = await json('admin', '/api/options');
  const comm2ig = opts.resellers.find((r) => r.name === 'Comm2IG').id;
  const atea = await json('Atea', `/api/activities?reseller=${comm2ig}`);
  assert.ok(atea.length > 0);
  assert.ok(atea.every((r) => r.reseller === 'Atea'));
  const c = await json('Comm2IG', '/api/activities');
  assert.ok(c.length > 0 && c.every((r) => r.reseller === 'Comm2IG'));
});

test('reseller cannot open another reseller\'s activity by id', async () => {
  const c = await json('Comm2IG', '/api/activities');
  const res = await call('Atea', `/api/activities/${c[0].id}`);
  assert.equal(res.status, 404);
});

test('dashboard numbers are scoped', async () => {
  const all = await json('admin', '/api/dashboard');
  const a = await json('Atea', '/api/dashboard');
  const c = await json('Comm2IG', '/api/dashboard');
  assert.equal(a.kpi.experiences + c.kpi.experiences, all.kpi.experiences);
  assert.ok(a.latest.every((r) => r.reseller === 'Atea'));
});

test('exports respect access (CSV and XLSX)', async () => {
  const csv = await (await call('Atea', '/api/activities/export?format=csv')).text();
  assert.ok(csv.includes('Atea') && !csv.includes('Comm2IG;'));
  const buf = await (await call('Comm2IG', '/api/activities/export?format=xlsx')).arrayBuffer();
  const rows = XLSX.utils.sheet_to_json(XLSX.read(buf).Sheets['APL-aktiviteter']);
  assert.ok(rows.length > 0 && rows.every((r) => r.Reseller === 'Comm2IG'));
});

test('resellers cannot create, edit or delete, or use administration', async () => {
  const any = (await json('Atea', '/api/activities'))[0];
  assert.equal((await call('Atea', '/api/activities', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await call('Atea', `/api/activities/${any.id}`, { method: 'PUT', body: '{}' })).status, 403);
  assert.equal((await call('Atea', `/api/activities/${any.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('Atea', '/api/admin/users')).status, 403);
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await fetch(`${base}/api/activities`)).status, 401);
});

test('admin can add a new reseller and user without code changes', async () => {
  const { id: rid } = await json('admin', '/api/admin/resellers', { method: 'POST', body: JSON.stringify({ name: 'NewPartner' }) });
  await json('admin', '/api/admin/users', { method: 'POST', body: JSON.stringify({ name: 'NP', email: 'np@example.com', role: 'reseller', reseller_id: rid }) });
  const opts = await json('admin', '/api/options');
  const created = await json('admin', '/api/activities', { method: 'POST', body: JSON.stringify({
    date: '2026-10-01', duration: 'full', apl_type_id: opts.aplTypes[0].id, title: 'Jamf', school_name: 'Ny Skole',
    municipality_id: opts.municipalities[0].id, participants: 12, consultant_id: opts.consultants[0].id,
    reseller_id: rid, paid_by_id: opts.paidBy[0].id }) });
  assert.equal(created.reseller, 'NewPartner');
  assert.equal(created.school, 'Ny Skole');
  const users = await (await fetch(`${base}/auth/demo-users`)).json();
  const np = users.find((u) => u.email === 'np@example.com');
  const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: np.id }) });
  cookies.np = r.headers.get('set-cookie').split(';')[0];
  const rows = await json('np', '/api/activities');
  assert.deepEqual(rows.map((x) => x.id), [created.id]);
});

test('admin can update and delete activities; validation errors are clear', async () => {
  const bad = await call('admin', '/api/activities', { method: 'POST', body: JSON.stringify({ date: '' }) });
  assert.equal(bad.status, 400);
  const row = (await json('admin', '/api/activities'))[0];
  const upd = await json('admin', `/api/activities/${row.id}`, { method: 'PUT', body: JSON.stringify({ ...row, participants: 99 }) });
  assert.equal(upd.participants, 99);
  assert.equal((await call('admin', `/api/activities/${row.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('admin', `/api/activities/${row.id}`)).status, 404);
});

test('reference values in use cannot be deleted', async () => {
  const types = await json('admin', '/api/admin/apl-types');
  assert.equal((await call('admin', `/api/admin/apl-types/${types[0].id}`, { method: 'DELETE' })).status, 409);
});

test('admins can change participants straight from the list; resellers cannot', async () => {
  const [a] = await json('admin', '/api/activities');
  const put = (who, body) => call(who, `/api/activities/${a.id}/participants`, { method: 'PUT', body: JSON.stringify(body) });
  assert.equal((await put('Atea', { participants: 7 })).status, 403);
  assert.equal((await put('admin', { participants: -1 })).status, 400);
  assert.equal((await put('admin', { participants: 'abc' })).status, 400);
  const saved = await (await put('admin', { participants: 17 })).json();
  assert.equal(saved.participants, 17);
  assert.equal((await json('admin', `/api/activities/${a.id}`)).participants, 17);
});

test('admins mark a course as awaiting approval; it is filtered, kept out of key figures and shown to resellers', async () => {
  const opts = await json('admin', '/api/options');
  const atea = opts.resellers.find((x) => x.name === 'Atea').id;
  const before = await json('admin', '/api/dashboard?year=');
  const a = await json('admin', '/api/activities', { method: 'POST', body: JSON.stringify({
    date: '2020-01-15', duration: 'half', apl_type_id: opts.aplTypes[0].id, title: 'Venter på kommunen',
    participants: '', consultant_id: opts.consultants[0].id, reseller_id: atea, pending: '1' }) });
  assert.equal(a.pending, 1);
  assert.equal(a.status, 'planned'); // never counted as held while it awaits approval
  const put = (who, pending) => call(who, `/api/activities/${a.id}/pending`, { method: 'PUT', body: JSON.stringify({ pending }) });
  assert.equal((await put('Atea', false)).status, 403);
  const d = await json('admin', '/api/dashboard?year=');
  assert.equal(d.kpi.experiences, before.kpi.experiences);
  assert.equal(d.orderbook.pending, before.orderbook.pending + 1);
  assert.deepEqual((await json('admin', '/api/activities?status=pending')).map((x) => x.id), [a.id]);
  assert.ok(!(await json('admin', '/api/activities?status=held')).some((x) => x.id === a.id));
  const seen = await json('Atea', '/api/activities?status=pending');
  assert.equal(seen[0]?.pending, 1); // resellers see it too, marked
  const off = await (await put('admin', false)).json();
  assert.equal(off.pending, 0);
  assert.equal(off.status, 'held');
  assert.equal((await json('admin', '/api/activities?status=pending')).length, 0);
  await put('admin', true);
  const { feedPath } = await json('Atea', '/api/calendar');
  const ics = (await (await fetch(base + feedPath)).text()).replace(/\r\n /g, '');
  assert.match(ics, /SUMMARY:\(Foreløbig\) .*Venter på kommunen/);
});

test('a read-only viewer (Apple) sees every reseller but cannot change anything', async () => {
  const created = await (await call('admin', '/api/admin/users', { method: 'POST', body: JSON.stringify({ name: 'Apple', email: 'apl@apple.example', role: 'viewer' }) })).json();
  assert.equal(created.role ?? 'viewer', 'viewer');
  const u = (await json('admin', '/api/admin/users')).find((x) => x.email === 'apl@apple.example');
  assert.equal(u.role, 'viewer');
  assert.equal(u.reseller_id, null);
  const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
  cookies.viewer = r.headers.get('set-cookie').split(';')[0];
  const all = await json('admin', '/api/activities');
  const seen = await json('viewer', '/api/activities');
  assert.equal(seen.length, all.length);
  assert.deepEqual([...new Set(seen.map((a) => a.reseller))].sort(), [...new Set(all.map((a) => a.reseller))].sort());
  assert.ok(seen.some((a) => a.reseller === 'Atea') && seen.some((a) => a.reseller === 'Comm2IG'));
  const opts = await json('viewer', '/api/options');
  assert.equal(opts.resellers.length, (await json('admin', '/api/options')).resellers.length);
  const atea = opts.resellers.find((x) => x.name === 'Atea').id;
  assert.ok((await json('viewer', `/api/activities?reseller=${atea}`)).every((a) => a.reseller === 'Atea'));
  assert.equal((await call('viewer', `/api/activities/${all[0].id}`, { method: 'PUT', body: '{}' })).status, 403);
  assert.equal((await call('viewer', `/api/activities/${all[0].id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('viewer', `/api/activities/${all[0].id}/participants`, { method: 'PUT', body: '{"participants":3}' })).status, 403);
  assert.equal((await call('viewer', `/api/activities/${all[0].id}/pending`, { method: 'PUT', body: '{"pending":true}' })).status, 403);
  assert.equal((await call('viewer', '/api/admin/users')).status, 403);
  assert.equal((await call('viewer', '/api/import', { method: 'POST', body: '{"rows":[]}' })).status, 403);
});

test('"Se som": an admin can read as a reseller, but cannot change anything in that mode', async () => {
  const users = await json('admin', '/api/admin/users');
  const atea = users.find((u) => u.reseller === 'Atea' && u.role === 'reseller');
  const as = (path, opts = {}) => call('admin', path, { ...opts, headers: { 'x-view-as': String(atea.id) } });
  const me = await (await as('/api/me')).json();
  assert.equal(me.role, 'reseller');
  assert.equal(me.reseller, 'Atea');
  assert.ok(me.viewed_by);
  const seen = await (await as('/api/activities')).json();
  assert.deepEqual(seen.map((a) => a.id), (await json('Atea', '/api/activities')).map((a) => a.id));
  assert.equal((await as(`/api/activities/${seen[0].id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await as('/api/admin/users')).status, 403); // reseller has no admin pages
  const admin = users.find((u) => u.role === 'admin');
  assert.equal((await call('admin', '/api/me', { headers: { 'x-view-as': String(admin.id) } })).status, 400);
  assert.equal((await call('Atea', '/api/me', { headers: { 'x-view-as': String(atea.id) } })).status, 403);
});
