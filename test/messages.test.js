// Beskeder: Kompas sends notices to all consultants or one; they read them on their own page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

let server, base, kim, soren;
const cookies = {};

before(async () => {
  const { app } = createServer({ dbFile: ':memory:', messages: true });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || 'admin'] = r.headers.get('set-cookie').split(';')[0];
  }
  const opts = await json('admin', '/api/options');
  kim = opts.consultants.find((c) => c.name === 'Kim Byrding');
  soren = opts.consultants.find((c) => c.name === 'Søren Rasmussen');
});
after(() => server.close());
const call = (who, path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const page = async (c) => (await json('admin', `/api/admin/consultants/${c.id}/feed`)).pagePath;
const pageData = async (c) => (await fetch(`${base}${await page(c)}/data`)).json();
const send = (body) => call('admin', '/api/messages', { method: 'POST', body: JSON.stringify(body) });

test('a message to everyone and a personal one show on the right consultant pages', async () => {
  assert.equal((await send({ title: 'Nyt materiale', body: 'Se https://kompas.dk' })).status, 200);
  assert.equal((await send({ title: 'Kun til Kim', body: '', consultant_id: kim.id })).status, 200);
  const k = await pageData(kim);
  assert.deepEqual(k.messages.map((m) => [m.title, m.unread, m.personal]), [['Kun til Kim', true, true], ['Nyt materiale', true, false]]);
  const s = await pageData(soren);
  assert.deepEqual(s.messages.map((m) => m.title), ['Nyt materiale']);
});

test('a message is marked read once the consultant has seen it, and Kompas sees who read it', async () => {
  const kp = await page(kim);
  await page(soren); // Søren has a link but has not opened the page
  const r = await fetch(`${base}${kp}/messages/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  assert.ok((await pageData(kim)).messages.every((m) => !m.unread));
  assert.ok((await pageData(soren)).messages.every((m) => m.unread));
  const list = await json('admin', '/api/messages');
  const all = list.find((m) => m.title === 'Nyt materiale');
  assert.ok(all.read.includes('Kim Byrding'));
  assert.ok(all.unread.includes('Søren Rasmussen'));
  assert.deepEqual(list.find((m) => m.title === 'Kun til Kim').read, ['Kim Byrding']);
  assert.equal((await fetch(`${base}/k/${'0'.repeat(48)}/messages/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
});

test('only Kompas administrators can send, list and delete messages', async () => {
  assert.equal((await send({ title: '' })).status, 400);
  assert.equal((await send({ title: 'x', consultant_id: 999999 })).status, 400);
  assert.equal((await call('Atea', '/api/messages')).status, 403);
  assert.equal((await call('Atea', '/api/messages', { method: 'POST', body: JSON.stringify({ title: 'Hej' }) })).status, 403);
  const id = (await json('admin', '/api/messages'))[0].id;
  assert.equal((await call('Atea', `/api/messages/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('admin', `/api/messages/${id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await pageData(kim)).messages.some((m) => m.id === id));
  assert.equal((await call('admin', `/api/messages/${id}`, { method: 'DELETE' })).status, 404);
});

test('Beskeder is paused by default: no tab, no messages on the consultant page, the API is closed', async () => {
  const off = createServer({ dbFile: ':memory:' }).app.listen(0);
  const url = `http://localhost:${off.address().port}`;
  try {
    const admin = (await (await fetch(`${url}/auth/demo-users`)).json()).find((u) => u.role === 'admin');
    const r = await fetch(`${url}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: admin.id }) });
    const h = { cookie: r.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };
    assert.equal((await (await fetch(`${url}/api/me`, { headers: h })).json()).features.messages, false);
    assert.equal((await fetch(`${url}/api/messages`, { headers: h })).status, 404);
    assert.equal((await fetch(`${url}/api/messages`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'Hej' }) })).status, 404);
    const c = (await (await fetch(`${url}/api/options`, { headers: h })).json()).consultants[0];
    const path = (await (await fetch(`${url}/api/admin/consultants/${c.id}/feed`, { headers: h })).json()).pagePath;
    assert.deepEqual((await (await fetch(`${url}${path}/data`)).json()).messages, []);
  } finally { off.close(); }
});
