// Jakob (2026-10-27): a course counts as held ("Afholdt") only once its end time has passed (Danish time).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { todayIso, nowStamp, isHeld } from '../core/api.js';

let server, base, opts;
const cookies = {};

before(async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
    const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
    cookies[u.reseller || 'admin'] = r.headers.get('set-cookie').split(';')[0];
  }
  opts = await json('/api/options');
});
after(() => server.close());
const call = (path, o = {}) => fetch(base + path, { ...o, headers: { cookie: cookies.admin, 'content-type': 'application/json' } });
const json = async (...a) => (await call(...a)).json();
const day = (days) => new Date(Date.parse(`${todayIso()}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const create = async (extra) => {
  const r = await call('/api/activities', { method: 'POST', body: JSON.stringify({ duration: 'half', apl_type_id: opts.aplTypes[0].id,
    title: 'Sluttid test', participants: '12', reseller_id: opts.resellers[0].id, consultant_id: opts.consultants[0].id, ...extra }) });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
};
const statusOf = async (id) => (await json(`/api/activities/${id}`)).status;

test('nowStamp is Danish time as "YYYY-MM-DD HH:MM"', () => {
  assert.equal(nowStamp(new Date('2026-10-27T13:05:00Z')), '2026-10-27 14:05'); // winter time, UTC+1
  assert.equal(nowStamp(new Date('2026-07-01T22:30:00Z')), '2026-07-02 00:30'); // summer time, UTC+2
});

test('isHeld: held only after the end time, or after the day without an end time; Foreløbig never', () => {
  const now = '2026-10-27 14:05';
  assert.equal(isHeld({ date: '2026-10-27', start_time: '09:00', end_time: '12:00' }, now), true);
  assert.equal(isHeld({ date: '2026-10-27', start_time: '13:00', end_time: '14:05' }, now), true);
  assert.equal(isHeld({ date: '2026-10-27', start_time: '13:00', end_time: '16:30' }, now), false);
  assert.equal(isHeld({ date: '2026-10-27', start_time: '09:00' }, now), false);
  assert.equal(isHeld({ date: '2026-10-27' }, now), false);
  assert.equal(isHeld({ date: '2026-10-26' }, now), true);
  assert.equal(isHeld({ date: '2026-10-26', end_time: '12:00', pending: 1 }, now), false);
});

test('a course today is planned until it has ended, in the list, filters and key figures', async () => {
  const later = await create({ date: day(0), start_time: '00:00', end_time: '23:59' });
  const noEnd = await create({ date: day(0) });
  const yesterday = await create({ date: day(-1), start_time: '22:00', end_time: '23:59' });
  assert.equal(await statusOf(later.id), 'planned');
  assert.equal(await statusOf(noEnd.id), 'planned');
  assert.equal(await statusOf(yesterday.id), 'held');

  const ids = (rows) => new Set(rows.map((r) => r.id));
  const held = ids(await json('/api/activities?status=held'));
  const planned = ids(await json('/api/activities?status=planned'));
  const approved = ids(await json('/api/activities?status=approved'));
  assert.ok(!held.has(later.id) && !held.has(noEnd.id) && held.has(yesterday.id));
  assert.ok(planned.has(later.id) && planned.has(noEnd.id) && !planned.has(yesterday.id));
  assert.ok(approved.has(later.id) && approved.has(noEnd.id));

  const dash = await json(`/api/dashboard?year=${todayIso().slice(0, 4)}`);
  assert.ok(dash.upcoming.some((a) => a.id === later.id) || dash.orderbook.courses >= 2);
  assert.ok(!dash.latest.some((a) => a.id === later.id || a.id === noEnd.id));
});
