// Bibliotek: course descriptions, materials, linking courses, and what consultants may open.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

let server, base, kim, soren;
const cookies = {};

before(async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || u.role] = r.headers.get('set-cookie').split(';')[0];
  }
  const opts = await json('admin', '/api/options');
  kim = opts.consultants.find((c) => c.name === 'Kim Byrding');
  soren = opts.consultants.find((c) => c.name === 'Søren Rasmussen');
});
after(() => server.close());
const call = (who, path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const send = (method, body) => ({ method, body: JSON.stringify(body) });
const page = async (c) => (await json('admin', `/api/admin/consultants/${c.id}/feed`)).pagePath;
const b64 = (s) => Buffer.from(s).toString('base64');
const options = () => json('admin', '/api/options');
const course = async (title, consultant, extra = {}) => {
  const o = await options();
  return json('admin', '/api/activities', send('POST', { date: '2030-03-04', duration: 'half', apl_type_id: o.aplTypes[0].id, title,
    participants: '', consultant_id: consultant.id, reseller_id: o.resellers[0].id, ...extra }));
};

test('only Kompas can use the library', async () => {
  assert.equal((await call('Atea', '/api/library')).status, 403);
  assert.equal((await call('Atea', '/api/library/descriptions', send('POST', { title: 'X' }))).status, 403);
  assert.equal((await call('admin', '/api/library/descriptions', send('POST', { title: ' ' }))).status, 400);
});

test('a description links courses by title, and remembers titles linked by hand', async () => {
  const d = await json('admin', '/api/library/descriptions', send('POST', { title: 'Modul 7 (pædagoger)', summary: 'Kom i gang', match_titles: 'M7 pæd' }));
  assert.equal(d.title, 'Modul 7 (pædagoger)');
  assert.equal((await call('admin', '/api/library/descriptions', send('POST', { title: 'modul 7 (Pædagoger)' }))).status, 400);

  // New courses get the description from their title, also through another title.
  assert.equal((await course('Modul 7 (pædagoger)', kim)).course_description_id, d.id);
  assert.equal((await course('m7 PÆD', kim)).course_description_id, d.id);
  // A course where the form says "none" stays without.
  assert.equal((await course('Modul 7 (pædagoger)', kim, { course_description_id: '' })).course_description_id, null);

  // Courses already registered under another title are linked from Bibliotek.
  const old = await course('Pæd modul 7 HTK', soren, { course_description_id: '' });
  const lib = await json('admin', '/api/library');
  const row = lib.unlinked.find((u) => u.title === 'Pæd modul 7 HTK');
  assert.deepEqual([row.n, row.suggestion], [1, null]);
  assert.deepEqual(await json('admin', '/api/library/link-title', send('POST', { title: 'Pæd modul 7 HTK', course_description_id: d.id })), { linked: 1 });
  assert.equal((await json('admin', `/api/activities/${old.id}`)).course_description, 'Modul 7 (pædagoger)');
  assert.equal((await course('Pæd modul 7 HTK', soren)).course_description_id, d.id);

  const full = await json('admin', `/api/library/descriptions/${d.id}`);
  assert.equal(full.courses.length, 4);
  assert.deepEqual(full.counts, { held: 0, planned: 4, pending: 0 });
  assert.equal((await json('admin', '/api/library')).descriptions.find((x) => x.id === d.id).counts.planned, 4);
});

test('materials: files, links and guides; files are downloaded again as they were sent', async () => {
  const d = await json('admin', '/api/library/descriptions', send('POST', { title: 'Modul 8 (lærere)' }));
  const file = await json('admin', '/api/library/items', send('POST', { kind: 'file', visibility: 'consultants', course_description_ids: [d.id],
    file: { name: 'Drejebog æøå.pdf', type: 'application/pdf', data: b64('%PDF-1.4 drejebog') } }));
  assert.deepEqual([file.name, file.size, file.kind], ['Drejebog æøå.pdf', 17, 'file']);
  const res = await call('admin', `/api/library/items/${file.id}/file`);
  assert.equal(await res.text(), '%PDF-1.4 drejebog');
  assert.match(res.headers.get('content-disposition'), /^inline; .*filename\*=UTF-8''Drejebog%20%C3%A6%C3%B8%C3%A5\.pdf/);

  assert.equal((await call('admin', '/api/library/items', send('POST', { kind: 'link', name: 'Apple', url: 'javascript:alert(1)' }))).status, 400);
  assert.equal((await call('admin', '/api/library/items', send('POST', { kind: 'guide', name: 'Tom' }))).status, 400);
  const link = await json('admin', '/api/library/items', send('POST', { kind: 'link', name: 'Everyone Can Create', url: 'https://education.apple.com' }));
  const guide = await json('admin', '/api/library/items', send('POST', { kind: 'guide', name: 'Tjekliste', body: 'Tag Apple TV med', visibility: 'kompas' }));

  // Add an existing material to the description, take it off again.
  let items = (await json('admin', `/api/library/descriptions/${d.id}/items/${link.id}`, { method: 'PUT' })).items;
  assert.deepEqual(items.map((i) => i.name), ['Drejebog æøå.pdf', 'Everyone Can Create']);
  items = (await json('admin', `/api/library/descriptions/${d.id}/items/${link.id}`, { method: 'DELETE' })).items;
  assert.deepEqual(items.map((i) => i.name), ['Drejebog æøå.pdf']);

  const updated = await json('admin', `/api/library/items/${guide.id}`, send('PUT', { name: 'Tjekliste før kurset', body: 'Tag Apple TV og adapter med', course_description_ids: [d.id] }));
  assert.deepEqual([updated.name, updated.kind, updated.visibility], ['Tjekliste før kurset', 'guide', 'kompas']);
  const lib = await json('admin', '/api/library');
  assert.deepEqual(lib.items.find((i) => i.id === guide.id).descriptions.map((x) => x.title), ['Modul 8 (lærere)']);

  assert.equal((await call('admin', '/api/library/items', send('POST', { kind: 'file', file: { name: 'stor.key', data: 'A'.repeat(28 * 1024 * 1024) } }))).status, 413);
  assert.deepEqual(await json('admin', `/api/library/items/${link.id}`, { method: 'DELETE' }), { ok: true });
  assert.equal((await call('admin', `/api/library/items/${link.id}/file`)).status, 404);
});

test('a consultant sees the materials of their own courses, never Kun Kompas or other consultants\' course files', async () => {
  const d = await json('admin', '/api/library/descriptions', send('POST', { title: 'Modul 9 (lærere)', program: '09:00 Velkomst' }));
  const add = (body) => json('admin', '/api/library/items', send('POST', body));
  const slides = await add({ kind: 'file', name: 'Slides', course_description_ids: [d.id], file: { name: 'slides.pdf', type: 'application/pdf', data: b64('slides') } });
  const secret = await add({ kind: 'file', name: 'Drejebog', visibility: 'kompas', course_description_ids: [d.id], file: { name: 'drejebog.pdf', type: 'application/pdf', data: b64('hemmelig') } });
  const guide = await add({ kind: 'guide', name: 'Indberet hos Apple', body: 'Trin 1' });
  const kimCourse = await course('Modul 9 (lærere)', kim);
  const sorenCourse = await course('Modul 9 (lærere)', soren);
  const list = await add({ kind: 'file', activity_id: kimCourse.id, file: { name: 'deltagere.pdf', type: 'application/pdf', data: b64('deltagere') } });
  const sorenList = await add({ kind: 'file', activity_id: sorenCourse.id, file: { name: 'deltagere-s.pdf', type: 'application/pdf', data: b64('s') } });

  // Course materials (Kompas) show the description's and the course's own.
  const m = await json('admin', `/api/activities/${kimCourse.id}/materials`);
  assert.deepEqual([m.description.title, m.inherited.map((i) => i.name), m.own.map((i) => i.name)], ['Modul 9 (lærere)', ['Drejebog', 'Slides'], ['deltagere.pdf']]);
  // Course-only files are not in the library list.
  assert.ok(!(await json('admin', '/api/library')).items.some((i) => i.id === list.id));

  const kp = await page(kim);
  const data = await (await fetch(`${base}${kp}/data`)).json();
  const mine = data.planned.find((a) => a.id === kimCourse.id);
  assert.deepEqual(mine.materials.map((i) => i.name), ['Slides', 'deltagere.pdf']);
  const desc = data.library.descriptions.find((x) => x.id === d.id);
  assert.deepEqual([desc.program, desc.items.map((i) => i.name)], ['09:00 Velkomst', ['Slides']]);
  assert.ok(data.library.general.some((i) => i.id === guide.id && i.body === 'Trin 1'));
  assert.ok(!JSON.stringify(data).includes('hemmelig'));

  const open = (id) => fetch(`${base}${kp}/library/${id}/file`);
  assert.equal(await (await open(slides.id)).text(), 'slides');
  assert.equal(await (await open(list.id)).text(), 'deltagere');
  assert.equal((await open(secret.id)).status, 404);
  assert.equal((await open(sorenList.id)).status, 404);
  assert.equal((await fetch(`${base}/k/${'0'.repeat(48)}/library/${slides.id}/file`)).status, 404);

  // Deleting the course removes its own files; deleting the description unlinks its courses.
  await call('admin', `/api/activities/${kimCourse.id}`, { method: 'DELETE' });
  assert.equal((await call('admin', `/api/library/items/${list.id}/file`)).status, 404);
  await call('admin', `/api/library/descriptions/${d.id}`, { method: 'DELETE' });
  assert.equal((await json('admin', `/api/activities/${sorenCourse.id}`)).course_description_id, null);
  assert.ok((await json('admin', '/api/library')).items.some((i) => i.id === slides.id));
});

test('import and Sæt på give courses their description', async () => {
  const d = await json('admin', '/api/library/descriptions', send('POST', { title: 'Webinar: Didaktik' }));
  const o = await options();
  const r = await json('admin', '/api/import', send('POST', { commit: true, defaults: {}, rows: [{ Dato: '05.05.2031', Varighed: 'Halv dag', 'Titel/emne': 'webinar: didaktik',
    Skole: 'Ny skole', Kommune: o.municipalities[0].name, Deltagere: '', Konsulent: 'Kim Byrding', Reseller: o.resellers[0].name }] }));
  assert.equal(r.summary.imported, 1);
  const imported = (await json('admin', '/api/activities?year=2031')).find((a) => a.title === 'webinar: didaktik');
  assert.equal(imported.course_description_id, d.id);
});
