// Calendar in (iCal events as suggestions) and out (private subscription feed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { parseIcs } from '../core/ical.js';

let server, base;
const cookies = {};
const d = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:ev-1@icloud', `DTSTART:${d(-3)}T070000Z`, `DTEND:${d(-3)}T110000Z`,
  'SUMMARY:Mac – module 2 Sengeløse Skole', 'LOCATION:Sengeløse', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ev-2@icloud', `DTSTART;TZID=Europe/Copenhagen:${d(-2)}T083000`, `DTEND;TZID=Europe/Copenhagen:${d(-2)}T153000`,
  'SUMMARY:Workshop AI', 'LOCATION:Holte Skole\\, Rudersdal', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ev-3@icloud', `DTSTART;VALUE=DATE:${d(-1)}`, 'SUMMARY:Tandlæge', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:ev-old@icloud', 'DTSTART;VALUE=DATE:20200101', 'SUMMARY:Gammel', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

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

test('parses iCloud-style events', () => {
  const ev = parseIcs(ICS);
  assert.equal(ev.length, 4);
  const ai = ev.find((e) => e.uid === 'ev-2@icloud');
  assert.equal(ai.hours, 7);
  assert.equal(ai.location, 'Holte Skole, Rudersdal');
});

test('admin gets suggestions with school, municipality, topic and duration filled in', async () => {
  const events = await json('admin', '/api/calendar/events', { method: 'POST', body: JSON.stringify({ ics: ICS }) });
  assert.deepEqual(events.map((e) => e.uid).sort(), ['ev-1@icloud', 'ev-2@icloud', 'ev-3@icloud']);
  const mac = events.find((e) => e.uid === 'ev-1@icloud');
  assert.equal(mac.suggestion.title, 'Mac – module 2');
  assert.equal(mac.suggestion.school, 'Sengeløse Skole');
  assert.ok(mac.suggestion.municipality_id);
  assert.equal(mac.suggestion.duration, 'half');
  assert.equal(events.find((e) => e.uid === 'ev-2@icloud').suggestion.duration, 'full');
  assert.equal(events.find((e) => e.uid === 'ev-3@icloud').matched, false);
});

test('registered and hidden events disappear from suggestions', async () => {
  const opts = await json('admin', '/api/options');
  const [ev] = (await json('admin', '/api/calendar/events', { method: 'POST', body: JSON.stringify({ ics: ICS }) })).filter((e) => e.uid === 'ev-1@icloud');
  await json('admin', '/api/activities', { method: 'POST', body: JSON.stringify({ ...ev.suggestion, apl_type_id: opts.aplTypes[0].id,
    participants: 14, consultant_id: opts.consultants[0].id, reseller_id: opts.resellers[0].id, calendar_uid: ev.uid }) });
  await json('admin', '/api/calendar/ignore', { method: 'POST', body: JSON.stringify({ uid: 'ev-3@icloud' }) });
  const left = await json('admin', '/api/calendar/events', { method: 'POST', body: JSON.stringify({ ics: ICS }) });
  assert.deepEqual(left.map((e) => e.uid), ['ev-2@icloud']);
});

test('resellers cannot import calendar events', async () => {
  assert.equal((await call('Atea', '/api/calendar/events', { method: 'POST', body: JSON.stringify({ ics: ICS }) })).status, 403);
});

test('calendar link must be a public https/webcal address', async () => {
  for (const url of ['http://example.com/a.ics', 'https://localhost/a.ics', 'https://127.0.0.1/a.ics', 'file:///etc/passwd']) {
    assert.equal((await call('admin', '/api/calendar', { method: 'PUT', body: JSON.stringify({ url }) })).status, 400, url);
  }
  const ok = await json('admin', '/api/calendar', { method: 'PUT', body: JSON.stringify({ url: 'webcal://p01-caldav.icloud.com/published/2/abc' }) });
  assert.equal(ok.url, 'https://p01-caldav.icloud.com/published/2/abc');
});

test('subscription feed only contains the user\'s own activities', async () => {
  const { feedPath } = await json('Atea', '/api/calendar');
  const ics = await (await fetch(base + feedPath)).text();
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.ok(ics.includes('Reseller: Atea'));
  assert.ok(!ics.includes('Reseller: Comm2IG'));
  const adminFeed = await (await fetch(base + (await json('admin', '/api/calendar')).feedPath)).text();
  assert.ok(adminFeed.includes('Reseller: Comm2IG') && adminFeed.includes('Reseller: Atea'));
  assert.equal((await fetch(`${base}/calendar/feed/${'0'.repeat(48)}.ics`)).status, 404);
});

test('resetting the feed link disables the old one', async () => {
  const { feedPath } = await json('Comm2IG', '/api/calendar');
  const fresh = await json('Comm2IG', '/api/calendar/reset-feed', { method: 'POST', body: '{}' });
  assert.notEqual(fresh.feedPath, feedPath);
  assert.equal((await fetch(base + feedPath)).status, 404);
});

test('each consultant has a private feed with only their own courses; resellers cannot fetch it', async () => {
  const opts = await json('admin', '/api/options');
  const kim = opts.consultants.find((c) => c.name === 'Kim Byrding');
  assert.equal((await call('Atea', `/api/admin/consultants/${kim.id}/feed`)).status, 403);
  const { feedPath } = await json('admin', `/api/admin/consultants/${kim.id}/feed`);
  assert.equal((await json('admin', `/api/admin/consultants/${kim.id}/feed`)).feedPath, feedPath);
  const ics = await (await fetch(base + feedPath)).text();
  const mine = (await json('admin', `/api/activities?consultant=${kim.id}`)).length;
  assert.ok(mine > 0);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, mine);
  assert.ok(ics.includes('Kompas-kurser · Kim Byrding'));
  const fresh = await (await call('admin', `/api/admin/consultants/${kim.id}/feed`, { method: 'POST', body: '{}' })).json();
  assert.notEqual(fresh.feedPath, feedPath);
  assert.equal((await fetch(base + feedPath)).status, 404);
});
