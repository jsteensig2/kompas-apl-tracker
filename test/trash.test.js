// Slettede kurser: a deleted course can be genaktiveret with its notes and materials, or deleted for good.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

let server, base, kim;
const cookies = {};

before(async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || 'admin'] = r.headers.get('set-cookie').split(';')[0];
  }
  kim = (await json('admin', '/api/options')).consultants.find((c) => c.name === 'Kim Byrding');
});
after(() => server.close());
const call = (who, path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const send = (method, body) => ({ method, body: JSON.stringify(body ?? {}) });
const b64 = (s) => Buffer.from(s).toString('base64');

test('a deleted course shows under Slettede kurser and comes back with notes and materials', async () => {
  const course = (await json('admin', `/api/activities?year=&consultant=${kim.id}`))[0];
  await json('admin', `/api/activities/${course.id}/notes`, send('POST', { body: 'Husk projektor' }));
  const item = await json('admin', '/api/library/items', send('POST', { kind: 'file', visibility: 'consultants', activity_id: course.id,
    file: { name: 'Deltagerliste.pdf', type: 'application/pdf', data: b64('%PDF-1.4 deltagere') } }));

  assert.equal((await call('Atea', `/api/activities/${course.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('admin', `/api/activities/${course.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call('admin', `/api/activities/${course.id}`)).status, 404);

  assert.equal((await call('Atea', '/api/deleted-activities')).status, 403);
  const trash = await json('admin', '/api/deleted-activities');
  assert.equal(trash.length, 1);
  assert.equal(trash[0].title, course.title);
  assert.equal(trash[0].consultant, 'Kim Byrding');

  assert.equal((await call('Atea', `/api/deleted-activities/${trash[0].id}/restore`, send('POST'))).status, 403);
  const back = await json('admin', `/api/deleted-activities/${trash[0].id}/restore`, send('POST'));
  assert.equal(back.id, course.id);
  const again = await json('admin', `/api/activities/${course.id}`);
  assert.equal(again.title, course.title);
  assert.equal(again.consultant_id, kim.id);
  assert.deepEqual((await json('admin', `/api/activities/${course.id}/notes`)).map((n) => n.body), ['Husk projektor']);
  const file = await call('admin', `/api/library/items/${item.id}/file`);
  assert.equal(await file.text(), '%PDF-1.4 deltagere');
  assert.deepEqual(await json('admin', '/api/deleted-activities'), []);
});

test('Slet endeligt removes a deleted course from the list', async () => {
  const course = (await json('admin', `/api/activities?year=&consultant=${kim.id}`))[0];
  await call('admin', `/api/activities/${course.id}`, { method: 'DELETE' });
  const [row] = await json('admin', '/api/deleted-activities');
  assert.equal((await call('admin', `/api/deleted-activities/${row.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await json('admin', '/api/deleted-activities'), []);
  assert.equal((await call('admin', `/api/deleted-activities/${row.id}/restore`, send('POST'))).status, 404);
});
