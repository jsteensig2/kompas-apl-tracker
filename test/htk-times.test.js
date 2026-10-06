// One-time data change (Jakob, 2026-10-06): coming Høje-Taastrup courses without a time get
// 14:00–16:30 for teachers and 09:00–11:30 for pedagogues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA, migrate } from '../core/schema.js';
import { todayIso } from '../core/api.js';

test('Høje-Taastrup teacher and pedagogue courses get their usual times once', () => {
  const raw = new DatabaseSync(':memory:');
  const db = {
    exec: (sql) => raw.exec(sql),
    all: (sql, p = []) => raw.prepare(sql).all(...p),
    get: (sql, p = []) => raw.prepare(sql).get(...p),
    run: (sql, p = []) => raw.prepare(sql).run(...p),
  };
  db.exec(SCHEMA);
  migrate(db);
  db.run("DELETE FROM app_migrations WHERE name = 'htk-times-2026-10-06'");
  const htk = Number(db.run("INSERT INTO municipalities (name) VALUES ('Høje-Taastrup')").lastInsertRowid);
  const other = Number(db.run("INSERT INTO municipalities (name) VALUES ('Aarhus')").lastInsertRowid);
  const school = Number(db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', ['Torstorp Skole', htk]).lastInsertRowid);
  db.run("INSERT INTO apl_types (name) VALUES ('Workshop Fysisk')");
  db.run("INSERT INTO resellers (name) VALUES ('Atea')");
  const next = new Date(Date.parse(`${todayIso()}T12:00:00Z`) + 30 * 864e5).toISOString().slice(0, 10);
  const add = (title, { date = next, muni = htk, schoolId = null, start = null } = {}) => Number(db.run(`INSERT INTO activities
      (date, duration, apl_type_id, title, school_id, municipality_id, participants, reseller_id, pending, start_time)
      VALUES (?, 'half', 1, ?, ?, ?, 0, 1, 1, ?)`, [date, title, schoolId, muni, start]).lastInsertRowid);
  const ids = {
    teachers: add('Modul 2 (lærere)'),
    pedagogues: add('Modul 1 – Pædagoger'),
    viaSchool: add('Modul 3 (lærere)', { muni: null, schoolId: school }),
    hasTime: add('Modul 2 (lærere)', { start: '08:30' }),
    past: add('Modul 1 – Lærere', { date: '2025-01-10' }),
    otherTown: add('Modul 2 (lærere)', { muni: other }),
    noGroup: add('Jamf'),
  };
  migrate(db);
  const t = (id) => { const r = db.get('SELECT start_time, end_time FROM activities WHERE id = ?', [id]); return [r.start_time, r.end_time]; };
  assert.deepEqual(t(ids.teachers), ['14:00', '16:30']);
  assert.deepEqual(t(ids.pedagogues), ['09:00', '11:30']);
  assert.deepEqual(t(ids.viaSchool), ['14:00', '16:30']);
  assert.deepEqual(t(ids.hasTime), ['08:30', null]);
  assert.deepEqual(t(ids.past), [null, null]);
  assert.deepEqual(t(ids.otherTown), [null, null]);
  assert.deepEqual(t(ids.noGroup), [null, null]);
  // Runs only once: a course added later keeps having no time.
  const later = add('Modul 4 (lærere)');
  migrate(db);
  assert.deepEqual(t(later), [null, null]);
});
