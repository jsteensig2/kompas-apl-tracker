// One-time data changes in core/schema.js run against an existing (old) database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { adapt } from '../server/db.js';
import { SCHEMA, migrate } from '../core/schema.js';

test('APL types are replaced; Greenland courses become Workshop Online, the rest Workshop Fysisk', () => {
  const db = adapt(new DatabaseSync(':memory:'));
  db.exec(SCHEMA);
  for (const t of ['Workshop', 'tirsdag', 'onsdag']) db.run('INSERT INTO apl_types (name) VALUES (?)', [t]);
  for (const m of ['Høje-Taastrup', 'Kujalleq']) db.run('INSERT INTO municipalities (name) VALUES (?)', [m]);
  db.run("INSERT INTO resellers (name) VALUES ('Comm2IG')");
  db.run("INSERT INTO paid_by (name) VALUES ('Kivitsisa')");
  db.run("INSERT INTO schools (name) VALUES ('Flere skoler – Sermersooq')");
  const add = (type, muni, school, paid) => db.run(`INSERT INTO activities (date, duration, apl_type_id, title, municipality_id, school_id, participants, reseller_id, paid_by_id)
    VALUES ('2026-09-01', 'half', ?, 'x', ?, ?, 0, 1, ?)`, [type, muni, school, paid]);
  add(1, 1, null, null); // Denmark
  add(2, 2, null, null); // Kujalleq
  add(3, null, 1, null); // school in Sermersooq, no municipality
  add(1, null, null, 1); // paid by Kivitsisa
  add(2, null, null, null); // nothing known: Denmark
  migrate(db);
  assert.deepEqual(db.all('SELECT name FROM apl_types ORDER BY id').map((r) => r.name),
    ['Oplæg', 'Workshop Online', 'Workshop Fysisk', 'Sparring', 'Andet']);
  const types = db.all('SELECT t.name FROM activities a JOIN apl_types t ON t.id = a.apl_type_id ORDER BY a.id').map((r) => r.name);
  assert.deepEqual(types, ['Workshop Fysisk', 'Workshop Online', 'Workshop Online', 'Workshop Online', 'Workshop Fysisk']);
  // Runs once: later changes in Administration are kept.
  db.run("INSERT INTO apl_types (name) VALUES ('Ny type')");
  db.run("UPDATE activities SET apl_type_id = (SELECT id FROM apl_types WHERE name = 'Sparring') WHERE id = 1");
  migrate(db);
  assert.ok(db.get("SELECT 1 AS x FROM apl_types WHERE name = 'Ny type'"));
  assert.equal(db.get('SELECT t.name FROM activities a JOIN apl_types t ON t.id = a.apl_type_id WHERE a.id = 1').name, 'Sparring');
});

test('an old users table is rebuilt to allow the viewer role, keeping users and sessions', () => {
  const db = adapt(new DatabaseSync(':memory:'));
  const oldSchema = SCHEMA.replace("CHECK (role IN ('admin', 'reseller', 'viewer'))", "CHECK (role IN ('admin', 'reseller'))")
    .replace("CHECK ((role IN ('admin', 'viewer') AND reseller_id IS NULL)", "CHECK ((role = 'admin' AND reseller_id IS NULL)");
  assert.ok(!oldSchema.includes("'reseller', 'viewer'"));
  db.exec(oldSchema);
  db.run("INSERT INTO users (name, email, role) VALUES ('Jakob', 'j@k.dk', 'admin')");
  db.run("INSERT INTO sessions (token, user_id) VALUES ('t', 1)");
  assert.throws(() => db.run("INSERT INTO users (name, email, role) VALUES ('A', 'a@a.dk', 'viewer')"));
  migrate(db); // as on the live server: adds later columns, then rebuilds users
  db.run("UPDATE users SET password_hash = 'h' WHERE id = 1");
  db.run("INSERT INTO users (name, email, role) VALUES ('Apple', 'a@a.dk', 'viewer')");
  assert.equal(db.get("SELECT name FROM users WHERE email = 'j@k.dk'").name, 'Jakob');
  assert.equal(db.get("SELECT user_id FROM sessions WHERE token = 't'").user_id, 1);
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.throws(() => db.run("INSERT INTO users (name, email, role) VALUES ('B', 'b@b.dk', 'nobody')"));
  assert.throws(() => db.run("INSERT INTO users (name, email, role, reseller_id) VALUES ('C', 'c@c.dk', 'viewer', 1)"));
  migrate(db); // running again changes nothing
  assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 2);
});
