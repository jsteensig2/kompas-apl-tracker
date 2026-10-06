// Optional start and end times (24-hour clock): form, lists, iCal, import/export and Dobbeltbooking.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { parseClock, parseClockRange } from '../core/import.js';
import { parseIcs, suggestFromEvent } from '../core/ical.js';
import { todayIso, clash } from '../core/api.js';

let server, base, kim, soren, opts;
const cookies = {};

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
});
after(() => server.close());
const call = (who, path, o = {}) => fetch(base + path, { ...o, headers: { cookie: cookies[who], 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const future = (days) => new Date(Date.parse(`${todayIso()}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const course = (extra) => ({ date: future(50), duration: 'half', apl_type_id: opts.aplTypes[0].id, title: 'Tid test', participants: '',
  reseller_id: opts.resellers[0].id, consultant_id: kim.id, ...extra });

test('clock parsing: 24-hour clock, Danish ways of writing it and Excel times', () => {
  assert.equal(parseClock('9'), '09:00');
  assert.equal(parseClock('9.30'), '09:30');
  assert.equal(parseClock('9,30'), '09:30');
  assert.equal(parseClock('kl. 13:15'), '13:15');
  assert.equal(parseClock('0830'), '08:30');
  assert.equal(parseClock('15:30:00'), '15:30');
  assert.equal(parseClock(0.375), '09:00');
  assert.equal(parseClock(45700.625), '15:00');
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('9:75'), null);
  assert.equal(parseClock('formiddag'), null);
  assert.deepEqual(parseClockRange('9-12'), { start: '09:00', end: '12:00' });
  assert.deepEqual(parseClockRange('09.00 – 15.30'), { start: '09:00', end: '15:30' });
  assert.deepEqual(parseClockRange('8:30'), { start: '08:30', end: null });
});

test('times are optional, stored as HH:MM and validated', async () => {
  const none = await json('admin', '/api/activities', post(course()));
  assert.equal(none.start_time, null);
  assert.equal(none.end_time, null);
  const timed = await json('admin', '/api/activities', post(course({ start_time: '9', end_time: '12.30' })));
  assert.equal(timed.start_time, '09:00');
  assert.equal(timed.end_time, '12:30');
  const startOnly = await json('admin', '/api/activities', post(course({ start_time: '08:15' })));
  assert.deepEqual([startOnly.start_time, startOnly.end_time], ['08:15', null]);
  for (const [extra, msg] of [[{ start_time: '25:00' }, '24-timers'], [{ end_time: '12:00' }, 'starttidspunkt'],
    [{ start_time: '12:00', end_time: '09:00' }, 'efter starttidspunktet']]) {
    const r = await call('admin', '/api/activities', post(course(extra)));
    assert.equal(r.status, 400);
    assert.ok((await r.json()).error.includes(msg));
  }
  // Editing keeps the time, or removes it when the fields are emptied.
  const edited = await json('admin', `/api/activities/${timed.id}`, { method: 'PUT', body: JSON.stringify(course({ start_time: '', end_time: '' })) });
  assert.equal(edited.start_time, null);
});

test('Dobbeltbooking: only when the times overlap, or when a time is missing', async () => {
  const date = future(60);
  const am = await json('admin', '/api/activities', post(course({ date, start_time: '08:00', end_time: '11:30' })));
  const pm = await json('admin', '/api/activities', post(course({ date, start_time: '12:00', end_time: '15:00' })));
  let rows = (await json('admin', `/api/activities?year=&consultant=${kim.id}`)).filter((a) => a.date === date);
  assert.deepEqual(rows.map((a) => a.double_booked), [0, 0]);
  assert.ok(!(await json('admin', '/api/dashboard')).doubleBookings.some((g) => g.date === date));
  // The form asks with its own times.
  const ask = (q) => json('admin', `/api/activities/same-day?date=${date}&consultants=${kim.id}${q}`);
  assert.deepEqual((await ask('&start=15:00&end=16:00')).map((a) => a.id), []);
  assert.deepEqual((await ask('&start=11:00&end=12:30')).map((a) => a.id).sort(), [am.id, pm.id].sort());
  assert.equal((await ask('')).length, 2); // no time in the form: warn about both
  assert.deepEqual((await ask('&start=13:00')).map((a) => a.id).sort(), [am.id, pm.id].sort()); // no end time: unknown length
  // A course without a time the same day clashes with both.
  const loose = await json('admin', '/api/activities', post(course({ date })));
  rows = (await json('admin', `/api/activities?year=&consultant=${kim.id}`)).filter((a) => a.date === date);
  assert.deepEqual(Object.fromEntries(rows.map((a) => [a.id, a.double_booked])), { [am.id]: 1, [pm.id]: 1, [loose.id]: 2 });
  const group = (await json('admin', '/api/dashboard')).doubleBookings.find((g) => g.date === date && g.consultant_id === kim.id);
  assert.equal(group.courses.length, 3);
  // Overlapping times.
  await json('admin', `/api/activities/${loose.id}`, { method: 'PUT', body: JSON.stringify(course({ date, start_time: '11:00', end_time: '13:00' })) });
  rows = (await json('admin', `/api/activities?year=&consultant=${kim.id}`)).filter((a) => a.date === date);
  assert.deepEqual(Object.fromEntries(rows.map((a) => [a.id, a.double_booked])), { [am.id]: 1, [pm.id]: 1, [loose.id]: 2 });
  assert.equal(clash({ start_time: '08:00', end_time: '12:00' }, { start_time: '12:00', end_time: '15:00' }), false);
});

test('iCal feed: courses with a time are timed events in Danish time, the rest stay all-day', async () => {
  const date = future(70);
  await json('admin', '/api/activities', post(course({ date, consultant_id: soren.id, title: 'Med tid', start_time: '09:00', end_time: '14:30' })));
  await json('admin', '/api/activities', post(course({ date, consultant_id: soren.id, title: 'Kun start', duration: 'full', start_time: '08:30' })));
  await json('admin', '/api/activities', post(course({ date, consultant_id: soren.id, title: 'Uden tid' })));
  const ics = await (await fetch(base + (await json('admin', '/api/calendar')).feedPath)).text();
  const d = date.replace(/-/g, '');
  assert.ok(ics.includes('BEGIN:VTIMEZONE') && ics.includes('TZID:Europe/Copenhagen'));
  const ev = (title) => ics.split('BEGIN:VEVENT').find((e) => e.includes(title)).replace(/\r\n /g, '');
  assert.ok(ev('Med tid').includes(`DTSTART;TZID=Europe/Copenhagen:${d}T090000`) && ev('Med tid').includes(`DTEND;TZID=Europe/Copenhagen:${d}T143000`));
  assert.ok(ev('Med tid').includes('Tid: 09:00–14:30') && ev('Med tid').includes('TRANSP:OPAQUE'));
  assert.ok(ev('Kun start').includes(`DTEND;TZID=Europe/Copenhagen:${d}T153000`)); // full day without an end: 7 hours
  assert.ok(ev('Uden tid').includes(`DTSTART;VALUE=DATE:${d}`) && ev('Uden tid').includes('TRANSP:TRANSPARENT'));
  // The consultant's own page has the times too.
  const { pagePath } = await json('admin', `/api/admin/consultants/${soren.id}/feed`);
  const page = await (await fetch(`${base}${pagePath}/data`)).json();
  assert.deepEqual(page.planned.filter((a) => a.date === date).map((a) => a.start_time), [null, '08:30', '09:00']);
});

test('iCal import suggests the appointment\'s times', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Workshop', 'DTSTART:20261110T080000Z', 'DTEND:20261110T110000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Heldag', 'DTSTART;VALUE=DATE:20261111', 'DTEND;VALUE=DATE:20261112', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Lokal', 'DTSTART;TZID=Europe/Copenhagen:20260615T130000', 'DTEND;TZID=Europe/Copenhagen:20260615T160000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const byUid = Object.fromEntries(parseIcs(ics).map((e) => [e.uid, suggestFromEvent(e, {})]));
  assert.deepEqual([byUid.a.start_time, byUid.a.end_time], ['09:00', '12:00']); // UTC to Danish winter time
  assert.deepEqual([byUid.b.start_time, byUid.b.end_time], ['', '']);
  assert.deepEqual([byUid.c.start_time, byUid.c.end_time], ['13:00', '16:00']);
});

test('import reads Starttid/Sluttid, a "Tid" range or a time in the date; export has both columns', async () => {
  const res = await json('admin', '/api/import', post({ rows: [
    { Dato: '10.11.2026', Starttid: '9', Sluttid: '12.30', 'Titel/emne': 'Imp A', Reseller: 'Atea', Konsulent: 'Kim Byrding' },
    { Dato: '12.11.2026 08:30', 'Titel/emne': 'Imp C', Reseller: 'Atea', Konsulent: 'Kim Byrding' },
    { Dato: 46336, Starttid: 0.5, Sluttid: 'snart', 'Titel/emne': 'Imp D', Reseller: 'Atea', Konsulent: 'Kim Byrding' },
    { Dato: '14.11.2026', 'Titel/emne': 'Imp E', Reseller: 'Atea', Konsulent: 'Kim Byrding' },
  ], commit: true }));
  const t = (r) => [r.start_time, r.end_time];
  assert.deepEqual(res.rows.map(t), [['09:00', '12:30'], ['08:30', null], ['12:00', null], [null, null]]);
  assert.ok(res.rows[2].warnings.some((w) => w.includes('Sluttid "snart"')));
  assert.equal(res.summary.imported, 4);
  // One "Tid" column with both times.
  const range = await json('admin', '/api/import', post({ rows: [
    { Dato: '11.11.2026', Tid: '9-15', 'Titel/emne': 'Imp B', Reseller: 'Atea', Konsulent: 'Kim Byrding' },
    { Dato: '12.11.2026', Tid: 'kl. 10', 'Titel/emne': 'Imp B', Reseller: 'Atea', Konsulent: 'Kim Byrding' },
  ] }));
  assert.deepEqual(range.rows.map(t), [['09:00', '15:00'], ['10:00', null]]);
  const saved = (await json('admin', '/api/activities?year=2026&q=Imp')).find((a) => a.title === 'Imp A');
  assert.deepEqual(t(saved), ['09:00', '12:30']);
  const csv = await (await call('admin', '/api/activities/export?format=csv&q=Imp%20A')).text();
  const [head, row] = csv.replace(/^﻿/, '').split('\r\n');
  assert.deepEqual(head.split(';').slice(0, 3), ['Dato', 'Starttid', 'Sluttid']);
  assert.deepEqual(row.split(';').slice(0, 3), ['2026-11-10', '09:00', '12:30']);
});
