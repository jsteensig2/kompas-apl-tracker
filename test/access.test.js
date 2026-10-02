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
