// Til Apple: held courses with the fields of Apple's APL Engagement Checkout, in the form's order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { createServer } from '../server/index.js';
import { appleFields } from '../core/api.js';

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

test('fields follow the form and fill in what the tracker knows', () => {
  const f = appleFields({ date: '2026-03-11', duration: 'full', apl_type: 'Workshop Fysisk', title: 'AI', school: 'Holte Skole', municipality: 'Rudersdal',
    consultant: 'Kim Byrding', consultant_email: 'kb@kompas.dk', postal_code: '2840', participants: 18 });
  const v = Object.fromEntries(f.map(([, l, val]) => [l, val]));
  assert.equal(f[0][1], 'Vælg dit område');
  assert.equal(f.at(-1)[1], 'Antal deltagere');
  assert.equal(v['Navn på specialist (for- og efternavn)'], 'Kim Byrding');
  assert.equal(v['E-mailadresse til specialist'], 'kb@kompas.dk');
  assert.equal(v['System/distrikt/ministeriums navn'], 'Rudersdal Kommune');
  assert.equal(v.Postnummer, '2840');
  assert.equal(v.Startdato, '11/03/2026');
  assert.equal(v['Hvad var varigheden af din session?'], 'Hel dag');
  assert.equal(v.Leveringstilstand, 'Fysisk fremmøde');
  assert.equal(v['Projekttype/Niveau for deltagende uddannelsesinstitutioner'], '');
  const gl = Object.fromEntries(appleFields({ date: '2026-01-05', duration: 'half', apl_type: 'Workshop Online', title: 'Webinar', school: 'X', municipality: 'Sermersooq', participants: 0 })
    .map(([, l, val]) => [l, val]));
  assert.equal(gl.Leveringsland, 'Grønland');
  assert.equal(gl['System/distrikt/ministeriums navn'], 'Sermersooq');
  assert.equal(gl.Leveringstilstand, 'Online');
  assert.equal(gl['Antal deltagere'], '');
});

test('only held courses, admin only, with e-mail and postal code from Administration', async () => {
  const rows = await json('admin', '/api/apple');
  const held = (await json('admin', '/api/activities?status=held'));
  assert.equal(rows.length, held.length);
  assert.ok(rows.every((r) => r.fields.length === 19));
  assert.equal((await call('Atea', '/api/apple')).status, 403);
  assert.equal((await call('Atea', '/api/apple/export')).status, 403);

  const course = held.find((a) => a.consultant_id && a.school_id);
  const c = (await json('admin', '/api/admin/consultants')).find((x) => x.id === course.consultant_id);
  assert.equal((await call('admin', `/api/admin/consultants/${c.id}`, { method: 'PUT', body: JSON.stringify({ name: c.name, initials: c.initials, email: 'nope' }) })).status, 400);
  assert.equal((await call('admin', `/api/admin/consultants/${c.id}`, { method: 'PUT', body: JSON.stringify({ name: c.name, initials: c.initials, email: 'Kon@Kompas.dk' }) })).status, 200);
  const s = (await json('admin', '/api/admin/schools')).find((x) => x.id === course.school_id);
  assert.equal((await call('admin', `/api/admin/schools/${s.id}`, { method: 'PUT', body: JSON.stringify({ name: s.name, municipality_id: s.municipality_id, postal_code: '2840' }) })).status, 200);
  const row = (await json('admin', '/api/apple')).find((r) => r.id === course.id);
  const v = Object.fromEntries(row.fields.map(([, l, val]) => [l, val]));
  assert.equal(v['E-mailadresse til specialist'], 'kon@kompas.dk');
  assert.equal(v.Postnummer, '2840');
});

test('ticking a course as sent moves it out of "Ikke sendt"', async () => {
  const [first] = await json('admin', '/api/apple?sent=no');
  await call('admin', `/api/activities/${first.id}/apple`, { method: 'PUT', body: JSON.stringify({ reported: true }) });
  assert.ok(!(await json('admin', '/api/apple?sent=no')).some((r) => r.id === first.id));
  assert.ok((await json('admin', '/api/apple?sent=yes')).some((r) => r.id === first.id));
  await call('admin', `/api/activities/${first.id}/apple`, { method: 'PUT', body: JSON.stringify({ reported: false }) });
  assert.ok((await json('admin', '/api/apple?sent=no')).some((r) => r.id === first.id));
});

test('Excel export has one row per course with the columns in the form order', async () => {
  const rows = await json('admin', '/api/apple');
  const r = await call('admin', '/api/apple/export?format=xlsx');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /apple-registrering-alle-.*\.xlsx/);
  const wb = XLSX.read(new Uint8Array(await r.arrayBuffer()));
  const table = XLSX.utils.sheet_to_json(wb.Sheets['Til Apple'], { header: 1, defval: '' });
  assert.deepEqual(table[0].slice(0, 4), ['Område', 'Navn på specialist', 'E-mail til specialist', 'Leveringsland']);
  assert.equal(table.length - 1, rows.length);
  assert.match(String(table[1][14]), /^\d{2}\/\d{2}\/\d{4}$/);
  const csv = await (await call('admin', '/api/apple/export?format=csv')).text();
  assert.ok(csv.replace(/^﻿/, '').startsWith('Område;Navn på specialist'));
});
