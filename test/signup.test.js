// Tilmelding: consultants click "Det kan jeg" on Foreløbig courses without a consultant (Måske was dropped).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';

let server, base, opts, kim, soren, course;
const cookies = {};
const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10).split('-').reverse().join('.');

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
  const rows = [
    { Dato: future(40), Varighed: 'Halv dag', 'Titel/emne': 'Modul 2 (lærere)', Skole: 'Mølleholmskolen', Kommune: 'Høje-Taastrup', Reseller: 'Atea', Status: 'Foreløbig' },
    { Dato: future(41), Varighed: 'Halv dag', 'Titel/emne': 'Modul 1 (pædagoger)', Skole: 'Borgerskolen', Kommune: 'Høje-Taastrup', Reseller: 'Atea', Status: 'Foreløbig' },
  ];
  const res = await json('admin', '/api/import', { method: 'POST', body: JSON.stringify({ rows, commit: true }) });
  assert.equal(res.summary.imported, 2);
});
after(() => server.close());
const call = (who, path, opts = {}) => fetch(base + path, { ...opts, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const page = async (c) => (await json('admin', `/api/admin/consultants/${c.id}/feed`)).pagePath;
const answer = (path, id, a) => fetch(`${base}${path}/signup/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: a }) });

test('Foreløbig courses without a consultant are open on every consultant page', async () => {
  const data = await (await fetch(`${base}${await page(kim)}/data`)).json();
  const titles = data.signup.map((c) => `${c.title} · ${c.school}`);
  assert.ok(titles.includes('Modul 2 (lærere) · Mølleholmskolen'));
  assert.ok(titles.includes('Modul 1 (pædagoger) · Borgerskolen'));
  assert.ok(data.signup.every((c) => c.answer === ''));
  course = data.signup.find((c) => c.school === 'Mølleholmskolen');
});

test('consultants can only say "Det kan jeg"; Kompas sees all answers', async () => {
  const kp = await page(kim);
  const sp = await page(soren);
  assert.equal((await answer(kp, course.id, 'maybe')).status, 400);
  let list = await (await answer(kp, course.id, 'yes')).json();
  assert.equal(list.find((c) => c.id === course.id).answer, 'yes');
  assert.equal((await answer(sp, course.id, 'no')).status, 400);
  assert.equal((await answer(sp, course.id, 'maybe')).status, 400);
  list = await (await answer(sp, course.id, '')).json();
  assert.equal(list.find((c) => c.id === course.id).yes, 1);
  assert.equal((await answer(sp, course.id, 'perhaps')).status, 400);
  assert.equal((await answer(`/k/${'0'.repeat(48)}`, course.id, 'yes')).status, 404);

  const overview = await json('admin', '/api/signups');
  const row = overview.courses.find((c) => c.id === course.id);
  assert.deepEqual(row.answers, { [kim.id]: 'yes' });
  assert.equal(list.find((c) => c.id === course.id).answer, '');
});

test('only Kompas administrators see the overview and can assign', async () => {
  assert.equal((await call('Atea', '/api/signups')).status, 403);
  assert.equal((await call('Atea', `/api/signups/${course.id}/assign`, { method: 'POST', body: JSON.stringify({ consultant_ids: [kim.id] }) })).status, 403);
  assert.equal((await call('admin', `/api/signups/${course.id}/needed`, { method: 'PUT', body: JSON.stringify({ needed: 0 }) })).status, 400);
  assert.equal((await call('admin', `/api/signups/${course.id}/needed`, { method: 'PUT', body: JSON.stringify({ needed: 2 }) })).status, 200);
  assert.equal((await json('admin', '/api/signups')).courses.find((c) => c.id === course.id).needed, 2);
});

test('assigning gives each chosen consultant their own Foreløbig course and closes sign-up', async () => {
  const res = await json('admin', `/api/signups/${course.id}/assign`, { method: 'POST', body: JSON.stringify({ consultant_ids: [kim.id, soren.id] }) });
  assert.equal(res.assigned, 2);
  const acts = (await json('admin', '/api/activities?status=pending')).filter((a) => a.school === 'Mølleholmskolen');
  assert.deepEqual(acts.map((a) => a.consultant).sort(), ['Kim Byrding', 'Søren Rasmussen']);
  assert.ok(acts.every((a) => a.pending === 1 && a.title === 'Modul 2 (lærere)'));
  assert.ok(!(await json('admin', '/api/signups')).courses.some((c) => c.id === course.id));
  const data = await (await fetch(`${base}${await page(kim)}/data`)).json();
  assert.ok(data.planned.some((a) => a.school === 'Mølleholmskolen' && a.pending));
  assert.ok(!data.signup.some((c) => c.id === course.id));
  assert.equal((await answer(await page(kim), course.id, 'yes')).status, 404);
  assert.equal((await call('admin', `/api/signups/${course.id}/assign`, { method: 'POST', body: JSON.stringify({ consultant_ids: [kim.id] }) })).status, 404);
});

test('a course closes for sign-up when enough consultants have said Kan', async () => {
  const third = opts.consultants.find((c) => ![kim.id, soren.id].includes(c.id));
  const [kp, sp, tp] = [await page(kim), await page(soren), await page(third)];
  const borger = (await (await fetch(`${base}${kp}/data`)).json()).signup.find((c) => c.school === 'Borgerskolen');
  await call('admin', `/api/signups/${borger.id}/needed`, { method: 'PUT', body: JSON.stringify({ needed: 2 }) });
  let list = await (await answer(kp, borger.id, 'yes')).json();
  let mine = list.find((c) => c.id === borger.id);
  assert.deepEqual([mine.yes, mine.needed, mine.full], [1, 2, false]);
  list = await (await answer(sp, borger.id, 'yes')).json();
  assert.equal(list.find((c) => c.id === borger.id).full, true);

  // A full course takes no new sign-ups.
  assert.equal((await answer(tp, borger.id, 'yes')).status, 409);
  const fourth = opts.consultants.find((c) => ![kim.id, soren.id, third.id].includes(c.id));
  const fp = await page(fourth);
  assert.ok(!(await (await fetch(`${base}${fp}/data`)).json()).signup.some((c) => c.id === borger.id), 'hidden for those who have not answered');
  assert.equal((await answer(fp, borger.id, 'yes')).status, 409);
  const row = (await json('admin', '/api/signups')).courses.find((c) => c.id === borger.id);
  assert.deepEqual([row.yes, row.full], [2, true]);

  // When Kompas removes a sign-up the course opens again.
  await call('admin', `/api/signups/${borger.id}/consultants/${soren.id}`, { method: 'DELETE' });
  const again = (await (await fetch(`${base}${fp}/data`)).json()).signup.find((c) => c.id === borger.id);
  assert.deepEqual([again.yes, again.full], [1, false]);
});

test('a consultant cannot withdraw a Kan; only Kompas can remove it', async () => {
  const kp = await page(kim);
  const open = (await (await fetch(`${base}${kp}/data`)).json()).signup.find((c) => c.school === 'Borgerskolen');
  assert.equal(open.answer, 'yes');
  assert.equal((await answer(kp, open.id, '')).status, 409);
  assert.equal((await answer(kp, open.id, 'maybe')).status, 400);
  assert.equal((await call('Atea', `/api/signups/${open.id}/consultants/${kim.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await call('admin', `/api/signups/${open.id}/consultants/${kim.id}`, { method: 'DELETE' })).status, 200);
  const after = (await (await fetch(`${base}${kp}/data`)).json()).signup.find((c) => c.id === open.id);
  assert.equal(after.answer, '');
});

test('a course that needs several consultants stays open after "Sæt på" until enough are on it', async () => {
  const rows = [{ Dato: future(50), Varighed: 'Halv dag', 'Titel/emne': 'Modul 3 (lærere)', Skole: 'Torstorp Skole', Kommune: 'Høje-Taastrup', Reseller: 'Atea', Status: 'Foreløbig' }];
  await json('admin', '/api/import', { method: 'POST', body: JSON.stringify({ rows, commit: true }) });
  const open = async () => (await json('admin', '/api/signups')).courses.find((c) => c.title === 'Modul 3 (lærere)');
  const lead = await open();
  await call('admin', `/api/signups/${lead.id}/needed`, { method: 'PUT', body: JSON.stringify({ needed: 3 }) });
  const rasmus = opts.consultants.find((c) => c.name === 'Rasmus Toft');
  const rp = await page(rasmus);
  await answer(rp, lead.id, 'yes');
  // Kompas puts only Rasmus on it: the course stays open, 1/3, with Rasmus marked as on it.
  await json('admin', `/api/signups/${lead.id}/assign`, { method: 'POST', body: JSON.stringify({ consultant_ids: [rasmus.id] }) });
  let c = await open();
  assert.equal(c.id, lead.id);
  assert.deepEqual(c.assigned, [rasmus.id]);
  assert.deepEqual([c.yes, c.full], [1, false]);
  // Rasmus sees it under his coming courses, the others can still sign up.
  const rd = await (await fetch(`${base}${rp}/data`)).json();
  assert.ok(!rd.signup.some((x) => x.id === lead.id) && rd.planned.some((x) => x.id === lead.id));
  const kp = await page(kim);
  assert.equal((await answer(kp, lead.id, 'yes')).status, 200);
  // Putting Rasmus on again does not make a second course for him.
  assert.equal((await call('admin', `/api/signups/${lead.id}/assign`, { method: 'POST', body: JSON.stringify({ consultant_ids: [rasmus.id] }) })).status, 400);
  await json('admin', `/api/signups/${lead.id}/assign`, { method: 'POST', body: JSON.stringify({ consultant_ids: [kim.id, rasmus.id] }) });
  c = await open();
  assert.deepEqual(c.assigned, [rasmus.id, kim.id]);
  await json('admin', `/api/signups/${lead.id}/assign`, { method: 'POST', body: JSON.stringify({ consultant_ids: [soren.id] }) });
  assert.equal(await open(), undefined); // 3 of 3: closed
  const acts = (await json('admin', '/api/activities?status=pending')).filter((a) => a.title === 'Modul 3 (lærere)');
  assert.deepEqual(acts.map((a) => a.consultant).sort(), ['Kim Byrding', 'Rasmus Toft', 'Søren Rasmussen']);
});
