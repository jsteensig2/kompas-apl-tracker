// Production login: demo off, email + password, one-time passwords, CSRF guard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

let server, base;
const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = (r) => r.headers.get('set-cookie')?.split(';')[0];

before(() => {
  Object.assign(process.env, { NODE_ENV: 'production', SEED_EXAMPLES: 'false', ADMIN_EMAIL: 'jakob@kompas.dk', ADMIN_PASSWORD: 'first-secret-1' });
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('demo login is off in production', async () => {
  assert.equal((await (await fetch(`${base}/auth/config`)).json()).demo, false);
  assert.equal((await fetch(`${base}/auth/demo-users`)).status, 404);
  assert.equal((await post('/auth/demo-login', { userId: 1 })).status, 404);
});

test('clean install has choice lists but no example activities', async () => {
  const r = await post('/auth/login', { email: 'jakob@kompas.dk', password: 'first-secret-1' });
  const c = cookieOf(r);
  const opts = await (await fetch(`${base}/api/options`, { headers: { cookie: c } })).json();
  assert.equal(opts.municipalities.length, 98);
  assert.deepEqual(await (await fetch(`${base}/api/activities`, { headers: { cookie: c } })).json(), []);
});

test('first login requires a new password; wrong passwords are rejected and braked', async () => {
  assert.equal((await post('/auth/login', { email: 'jakob@kompas.dk', password: 'nope' })).status, 401);
  const r = await post('/auth/login', { email: 'JAKOB@kompas.dk', password: 'first-secret-1' });
  assert.equal(r.status, 200);
  const c = cookieOf(r);
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: c } })).json();
  assert.equal(me.must_change_password, true);
  assert.equal((await post('/auth/change-password', { next: 'short' }, c)).status, 400);
  assert.equal((await post('/auth/change-password', { next: 'a-much-better-password' }, c)).status, 200);
  assert.equal((await post('/auth/login', { email: 'jakob@kompas.dk', password: 'a-much-better-password' })).status, 200);
  for (let i = 0; i < 8; i++) await post('/auth/login', { email: 'x@y.dk', password: 'bad' });
  assert.equal((await post('/auth/login', { email: 'x@y.dk', password: 'bad' })).status, 429);
});

test('admin creates a reseller user and hands out a one-time password', async () => {
  const c = cookieOf(await post('/auth/login', { email: 'jakob@kompas.dk', password: 'a-much-better-password' }));
  const reseller = (await (await fetch(`${base}/api/options`, { headers: { cookie: c } })).json()).resellers.find((r) => r.name === 'Atea');
  const { id } = await (await post('/api/admin/users', { name: 'Atea APL', email: 'apl@atea.dk', role: 'reseller', reseller_id: reseller.id }, c)).json();
  const { password } = await (await post(`/api/admin/users/${id}/password`, {}, c)).json();
  const r = await post('/auth/login', { email: 'apl@atea.dk', password });
  assert.equal(r.status, 200);
  const atea = cookieOf(r);
  assert.equal((await post(`/api/admin/users/${id}/password`, {}, atea)).status, 403);
});

test('cross-site form posts are refused', async () => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(r.status, 415);
});
