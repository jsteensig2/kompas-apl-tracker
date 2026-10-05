// Noter: short notes on a course from Kompas and from the course's own consultant.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

let server, base, kim, soren, course;
const cookies = {};

before(async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || 'admin'] = r.headers.get('set-cookie').split(';')[0];
  }
  const opts = await json('admin', '/api/options');
  kim = opts.consultants.find((c) => c.name === 'Kim Byrding');
  soren = opts.consultants.find((c) => c.name === 'Søren Rasmussen');
  course = (await json('admin', `/api/activities?year=&consultant=${kim.id}`))[0];
});
after(() => server.close());
const call = (who, path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const page = async (c) => (await json('admin', `/api/admin/consultants/${c.id}/feed`)).pagePath;
const k = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'content-type': 'application/json' } });
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });

test('Kompas writes a note; it shows as a count in the list and on the consultant page', async () => {
  assert.equal((await call('admin', `/api/activities/${course.id}/notes`, post({ body: '  ' }))).status, 400);
  const notes = await json('admin', `/api/activities/${course.id}/notes`, post({ body: 'Husk projektor' }));
  assert.deepEqual(notes.map((n) => [n.body, n.mine]), [['Husk projektor', true]]);
  const row = (await json('admin', `/api/activities?year=&consultant=${kim.id}`)).find((a) => a.id === course.id);
  assert.equal(row.notes, 1);
  const mine = await (await k(`${await page(kim)}/data`)).json();
  const a = [...mine.planned, ...mine.held].find((x) => x.id === course.id);
  assert.deepEqual(a.notes.map((n) => [n.body, n.mine]), [['Husk projektor', false]]);
});

test('a consultant writes and deletes notes on their own courses only', async () => {
  const kp = await page(kim);
  const res = await k(`${kp}/courses/${course.id}/notes`, post({ body: 'God klasse, vil gerne igen' }));
  assert.equal(res.status, 200);
  const notes = await res.json();
  const own = notes.find((n) => n.author === 'Kim Byrding');
  assert.ok(own.mine);
  // Not someone else's course, and not someone else's note.
  assert.equal((await k(`${await page(soren)}/courses/${course.id}/notes`, post({ body: 'x' }))).status, 404);
  assert.equal((await k(`${await page(soren)}/notes/${own.id}`, { method: 'DELETE' })).status, 404);
  const kompasNote = notes.find((n) => n.author !== 'Kim Byrding');
  assert.equal((await k(`${kp}/notes/${kompasNote.id}`, { method: 'DELETE' })).status, 404);
  const after = await (await k(`${kp}/notes/${own.id}`, { method: 'DELETE' })).json();
  assert.deepEqual(after.map((n) => n.body), ['Husk projektor']);
});

test('resellers neither see nor write notes (viewers are refused by the same admin check)', async () => {
  for (const who of ['Atea', 'Comm2IG']) {
    const rows = await json(who, '/api/activities?year=');
    assert.ok(rows.every((a) => !('notes' in a)));
    assert.equal((await call(who, `/api/activities/${course.id}/notes`)).status, 403);
  }
  assert.equal((await call('Atea', `/api/activities/${course.id}/notes`, post({ body: 'x' }))).status, 403);
  const id = (await json('admin', `/api/activities/${course.id}/notes`))[0].id;
  assert.equal((await call('Atea', `/api/notes/${id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('admin', `/api/notes/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('admin', `/api/notes/${id}`, { method: 'DELETE' })).status, 404);
});
