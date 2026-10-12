// Uniform course names (Jakob, 2026-10-12): "Modul N – Lærere" / "Modul N – Pædagoger".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA, migrate } from '../core/schema.js';
import { moduleCourse } from '../core/course-names.js';
import { createServer } from '../server/index.js';

test('module titles are read with the target group from the title, or in Høje-Taastrup from the time', () => {
  const t = (title, ctx) => moduleCourse(title, ctx)?.title ?? null;
  assert.equal(t('Modul 2 (lærere)'), 'Modul 2 – Lærere');
  assert.equal(t('Modul 1 – Pædagoger'), 'Modul 1 – Pædagoger');
  assert.equal(t('PÆDAGOGER modul1'), 'Modul 1 – Pædagoger');
  assert.equal(t('Mac – module 2 for teachers'), 'Modul 2 – Lærere');
  assert.equal(t('Modul 1'), null);
  assert.equal(t('Modul 1', { startTime: '09:00', municipality: 'Høje-Taastrup' }), 'Modul 1 – Pædagoger');
  assert.equal(t('Mac – module 1', { startTime: '14:00', municipality: 'Høje-Taastrup Kommune' }), 'Modul 1 – Lærere');
  assert.equal(t('Modul 1', { startTime: '09:00', municipality: 'Aarhus' }), null);
  assert.equal(t('Modul 1', { startTime: '10:00', municipality: 'Høje-Taastrup' }), null);
  assert.equal(t('Modul 1 for lærere og pædagoger'), null);
  assert.equal(t('Webinar: didaktik'), null);
});

test('Høje-Taastrup courses are renamed once and linked to a description per module and target group', () => {
  const raw = new DatabaseSync(':memory:');
  const db = { exec: (s) => raw.exec(s), all: (s, p = []) => raw.prepare(s).all(...p), get: (s, p = []) => raw.prepare(s).get(...p), run: (s, p = []) => raw.prepare(s).run(...p) };
  db.exec(SCHEMA);
  migrate(db);
  const htk = Number(db.run("INSERT INTO municipalities (name) VALUES ('Høje-Taastrup')").lastInsertRowid);
  const other = Number(db.run("INSERT INTO municipalities (name) VALUES ('Aarhus')").lastInsertRowid);
  const school = Number(db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', ['Fløng Skole', htk]).lastInsertRowid);
  db.run("INSERT INTO apl_types (name) VALUES ('Workshop Fysisk')");
  db.run("INSERT INTO resellers (name) VALUES ('Atea')");
  // A description Kompas already made for Modul 1 – Lærere is used, not made again.
  const own = Number(db.run("INSERT INTO course_descriptions (title, match_titles) VALUES ('Modul 1 – Lærere', 'Lærer M1')").lastInsertRowid);
  // One made under an old spelling is renamed, with its courses.
  const oldSpelling = Number(db.run("INSERT INTO course_descriptions (title) VALUES ('Modul 2 (lærere)')").lastInsertRowid);
  const add = (title, { muni = htk, schoolId = null, start = null } = {}) => Number(db.run(`INSERT INTO activities
      (date, duration, apl_type_id, title, school_id, municipality_id, participants, reseller_id, start_time)
      VALUES ('2026-11-01', 'half', 1, ?, ?, ?, 0, 1, ?)`, [title, schoolId, muni, start]).lastInsertRowid);
  const ids = {
    a: add('Modul 2 (lærere)'),
    b: add('Modul 2 – Lærere', { start: '14:00' }),
    c: add('Modul 1 (pædagoger)', { muni: null, schoolId: school }),
    d: add('Modul 1', { start: '09:00' }),
    e: add('Mac – module 1', { start: '14:00' }),
    f: add('Modul 1'),
    g: add('Modul 2 (lærere)', { muni: other }),
    h: add('LÆRERE Modul 1'),
    i: add('Lærer modul 2 HTK', { muni: other }),
  };
  db.run('UPDATE activities SET course_description_id = ? WHERE id = ?', [oldSpelling, ids.i]);
  migrate(db);
  const row = (id) => ({ ...db.get('SELECT a.title, d.title AS description FROM activities a LEFT JOIN course_descriptions d ON d.id = a.course_description_id WHERE a.id = ?', [id]) });
  assert.deepEqual(row(ids.a), { title: 'Modul 2 – Lærere', description: 'Modul 2 – Lærere' });
  assert.deepEqual(row(ids.b), { title: 'Modul 2 – Lærere', description: 'Modul 2 – Lærere' });
  assert.deepEqual(row(ids.c), { title: 'Modul 1 – Pædagoger', description: 'Modul 1 – Pædagoger' });
  assert.deepEqual(row(ids.d), { title: 'Modul 1 – Pædagoger', description: 'Modul 1 – Pædagoger' });
  assert.deepEqual(row(ids.e), { title: 'Modul 1 – Lærere', description: 'Modul 1 – Lærere' });
  assert.deepEqual(row(ids.f), { title: 'Modul 1', description: null }); // cannot be placed
  assert.deepEqual(row(ids.g), { title: 'Modul 2 (lærere)', description: null }); // not Høje-Taastrup
  assert.deepEqual(row(ids.h), { title: 'Modul 1 – Lærere', description: 'Modul 1 – Lærere' });
  assert.deepEqual(row(ids.i), { title: 'Modul 2 – Lærere', description: 'Modul 2 – Lærere' });

  const descs = db.all('SELECT id, title, audience, module, match_titles FROM course_descriptions ORDER BY title');
  assert.deepEqual(descs.map((d) => [d.title, d.audience, d.module]),
    [['Modul 1 – Lærere', 'Lærere', '1'], ['Modul 1 – Pædagoger', 'Pædagoger', '1'], ['Modul 2 – Lærere', 'Lærere', '2']]);
  assert.equal(descs[0].id, own);
  // Old titles that named the target group are remembered; "Mac – module 1" (placed by time) is not.
  assert.deepEqual(descs[0].match_titles.split('\n'), ['Lærer M1', 'LÆRERE Modul 1']);
  assert.equal(descs[1].match_titles, 'Modul 1 (pædagoger)');
  assert.equal(descs[2].id, oldSpelling);
  assert.equal(descs[2].match_titles, 'Modul 2 (lærere)');

  // Runs only once.
  const later = add('Modul 3 (lærere)');
  migrate(db);
  assert.equal(row(later).title, 'Modul 3 (lærere)');
});

describeServer();

function describeServer() {
  let server, base, opts;
  const cookies = {};
  before(async () => {
    const { app } = createServer({ dbFile: ':memory:' });
    server = app.listen(0);
    base = `http://localhost:${server.address().port}`;
    for (const u of await (await fetch(`${base}/auth/demo-users`)).json()) {
      const r = await fetch(`${base}/auth/demo-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
      cookies[u.reseller || u.role] = r.headers.get('set-cookie').split(';')[0];
    }
    opts = await json('/api/options');
  });
  after(() => server.close());
  const json = async (path, method = 'GET', body) => (await fetch(base + path, { method, headers: { cookie: cookies.admin, 'content-type': 'application/json' },
    body: body && JSON.stringify(body) })).json();

  test('import, the form and Kobl give courses the uniform name; the list filters on Kursus', async () => {
    const desc = await json('/api/library/descriptions', 'POST', { title: 'Modul 4 – Pædagoger' });
    assert.deepEqual([desc.audience, desc.module], ['Pædagoger', '4']);
    const kim = opts.consultants.find((c) => c.name === 'Kim Byrding');

    const r = await json('/api/import', 'POST', { commit: true, defaults: {}, rows: [
      { Dato: '05.05.2031', Starttid: '09:00', 'Titel/emne': 'Modul 4', Skole: 'Fløng Skole', Kommune: 'Høje-Taastrup', Konsulent: 'Kim Byrding', Reseller: 'Atea' },
      { Dato: '06.05.2031', 'Titel/emne': 'Modul 4 (pædagoger)', Skole: 'Fløng Skole', Kommune: 'Høje-Taastrup', Konsulent: 'Kim Byrding', Reseller: 'Atea' },
      { Dato: '07.05.2031', 'Titel/emne': 'Modul 5 (lærere)', Skole: 'Fløng Skole', Kommune: 'Høje-Taastrup', Konsulent: 'Kim Byrding', Reseller: 'Atea' },
    ] });
    assert.equal(r.summary.imported, 3);
    const acts = (await json('/api/activities?year=2031')).sort((x, y) => x.date.localeCompare(y.date));
    assert.deepEqual(acts.map((a) => [a.title, a.course_description_id]),
      [['Modul 4 – Pædagoger', desc.id], ['Modul 4 – Pædagoger', desc.id], ['Modul 5 – Lærere', null]]);

    // The form: a chosen description gives the title; without one the title is made uniform.
    const base = { date: '2031-06-01', duration: 'half', apl_type_id: opts.aplTypes[0].id, participants: '', consultant_id: kim.id, reseller_id: opts.resellers[0].id };
    assert.equal((await json('/api/activities', 'POST', { ...base, title: '', course_description_id: desc.id })).title, 'Modul 4 – Pædagoger');
    const typed = await json('/api/activities', 'POST', { ...base, title: 'modul 4 (Pædagoger)' });
    assert.deepEqual([typed.title, typed.course_description_id], ['Modul 4 – Pædagoger', desc.id]);

    // Kobl: the courses get the description's name, and so do later ones with that title.
    const odd = await json('/api/activities', 'POST', { ...base, title: 'Pæd. M4 Fløng' });
    await json('/api/library/link-title', 'POST', { title: 'Pæd. M4 Fløng', course_description_id: desc.id });
    assert.equal((await json(`/api/activities/${odd.id}`)).title, 'Modul 4 – Pædagoger');
    assert.equal((await json('/api/activities', 'POST', { ...base, title: 'Pæd. M4 Fløng' })).title, 'Modul 4 – Pædagoger');

    // Renaming the description renames its courses.
    await json(`/api/library/descriptions/${desc.id}`, 'PUT', { title: 'Modul 4 – Pædagoger (ny)', audience: 'Pædagoger', module: '4' });
    assert.ok((await json('/api/activities?year=2031')).filter((a) => a.course_description_id === desc.id).every((a) => a.title === 'Modul 4 – Pædagoger (ny)'));

    const o = await json('/api/options');
    assert.ok(o.courses.some((c) => c.id === desc.id && c.name === 'Modul 4 – Pædagoger (ny)'));
    const filtered = await json(`/api/activities?year=2031&course=${desc.id}`);
    assert.equal(filtered.length, 6);
    assert.ok(filtered.every((a) => a.course_description_id === desc.id));
  });
}
