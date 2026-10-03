// SQLite database for the Node server, using Node's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA, migrate } from '../core/schema.js';
import { seed } from '../core/seed.js';

// Small adapter so core/api.js does not depend on a specific SQLite driver.
export function adapt(raw) {
  return {
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    run: (sql, params = []) => raw.prepare(sql).run(...params),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
  };
}

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = adapt(new DatabaseSync(file));
  db.exec(SCHEMA);
  migrate(db);
  if (db.get('SELECT COUNT(*) AS n FROM municipalities').n === 0) {
    // SEED_EXAMPLES=false gives a clean installation: choice lists only, no demo users or activities.
    seed(db, { examples: process.env.SEED_EXAMPLES !== 'false' });
    migrate(db); // fills in data that depends on the seeded rows
  }
  return db;
}
