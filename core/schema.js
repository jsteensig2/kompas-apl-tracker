// Database schema (SQLite). Shared by the Node server and the browser preview.
// All choice lists are reference tables so Kompas can manage them without code changes.

export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS resellers (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS municipalities (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS schools (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL COLLATE NOCASE,
  municipality_id  INTEGER REFERENCES municipalities(id),
  UNIQUE (name, municipality_id)
);

CREATE TABLE IF NOT EXISTS consultants (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS apl_types (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS paid_by (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE
);

-- role: 'admin' (Kompas), 'viewer' (sees every reseller, changes nothing; e.g. Apple) or 'reseller'.
-- A reseller user must point at exactly one reseller.
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'reseller', 'viewer')),
  reseller_id  INTEGER REFERENCES resellers(id),
  CHECK ((role IN ('admin', 'viewer') AND reseller_id IS NULL) OR (role = 'reseller' AND reseller_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id               INTEGER PRIMARY KEY,
  date             TEXT NOT NULL,                      -- ISO yyyy-mm-dd
  duration         TEXT NOT NULL CHECK (duration IN ('half', 'full')),
  apl_type_id      INTEGER NOT NULL REFERENCES apl_types(id),
  title            TEXT NOT NULL,
  school_id        INTEGER REFERENCES schools(id),
  municipality_id  INTEGER REFERENCES municipalities(id),
  participants     INTEGER NOT NULL CHECK (participants >= 0),
  consultant_id    INTEGER REFERENCES consultants(id),
  reseller_id      INTEGER NOT NULL REFERENCES resellers(id),  -- decides who can see the activity
  paid_by_id       INTEGER REFERENCES paid_by(id),             -- separate from reseller on purpose
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activities_reseller_date ON activities (reseller_id, date);
`;

// Adds columns introduced after version 1 to an existing database.
export function migrate(db) {
  const cols = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols('users').includes('calendar_url')) db.exec('ALTER TABLE users ADD COLUMN calendar_url TEXT');
  if (!cols('users').includes('feed_token')) db.exec('ALTER TABLE users ADD COLUMN feed_token TEXT');
  if (!cols('users').includes('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!cols('users').includes('must_change_password')) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  if (!cols('activities').includes('calendar_uid')) db.exec('ALTER TABLE activities ADD COLUMN calendar_uid TEXT');
  if (!cols('consultants').includes('initials')) db.exec('ALTER TABLE consultants ADD COLUMN initials TEXT');
  if (!cols('activities').includes('apple_reported_at')) db.exec('ALTER TABLE activities ADD COLUMN apple_reported_at TEXT');
  if (!cols('consultants').includes('feed_token')) db.exec('ALTER TABLE consultants ADD COLUMN feed_token TEXT');
  // Kompas' own initials (Jakob, 2026-10-03); only filled in where none are set.
  for (const [initials, name] of [['KB', 'kim byrding'], ['TH', 'torben hollensen'], ['SR', 'søren rasmussen'],
    ['RT', 'rasmus toft'], ['JRS', 'jakob steensig'], ['JS', 'jacob schandor']]) {
    db.run(`UPDATE consultants SET initials = ? WHERE initials IS NULL AND lower(name) LIKE ?
              AND NOT EXISTS (SELECT 1 FROM consultants c2 WHERE upper(c2.initials) = ?)`, [initials, `${name}%`, initials]);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_ignored (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid     TEXT NOT NULL,
    PRIMARY KEY (user_id, uid)
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  once(db, 'apl-types-2026-10-04', () => resetAplTypes(db));
  allowViewerRole(db);
}

// Databases created before the 'viewer' role have the old CHECK on users; SQLite can only change
// that by rebuilding the table. Same columns and rows; foreign keys are paused during the swap.
function allowViewerRole(db) {
  const { sql } = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'");
  if (sql.includes("'viewer'")) return;
  const next = sql
    .replace("CHECK (role IN ('admin', 'reseller'))", "CHECK (role IN ('admin', 'reseller', 'viewer'))")
    .replace("CHECK ((role = 'admin' AND reseller_id IS NULL)", "CHECK ((role IN ('admin', 'viewer') AND reseller_id IS NULL)")
    .replace(/^CREATE TABLE (IF NOT EXISTS )?["`]?users["`]?/, 'CREATE TABLE users_new');
  if (!next.includes("'viewer'") || !next.startsWith('CREATE TABLE users_new')) throw new Error('Unexpected users table definition');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(next);
    db.exec('INSERT INTO users_new SELECT * FROM users');
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Runs a data change a single time; it is skipped until there is data to change.
function once(db, name, fn) {
  if (db.get('SELECT 1 AS x FROM app_migrations WHERE name = ?', [name])) return;
  if (fn() !== false) db.run('INSERT INTO app_migrations (name) VALUES (?)', [name]);
}

export const APL_TYPE_NAMES = ['Oplæg', 'Workshop Online', 'Workshop Fysisk', 'Sparring', 'Andet'];
const GREENLAND = ['avannaata', 'kujalleq', 'qeqertalik', 'qeqqata', 'sermersooq'];

// Jakob (2026-10-04): the APL types are replaced by a fixed list. Courses in Greenland become
// "Workshop Online", all others "Workshop Fysisk".
function resetAplTypes(db) {
  if (!db.get('SELECT COUNT(*) AS n FROM apl_types').n) return false; // not seeded yet
  const id = (name) => {
    const hit = db.get('SELECT id FROM apl_types WHERE lower(name) = lower(?)', [name]);
    return hit ? hit.id : Number(db.run('INSERT INTO apl_types (name) VALUES (?)', [name]).lastInsertRowid);
  };
  const ids = Object.fromEntries(APL_TYPE_NAMES.map((n) => [n, id(n)]));
  const like = GREENLAND.map(() => 'lower(x) LIKE ?').join(' OR ');
  const params = GREENLAND.map((g) => `%${g}%`);
  const greenland = `(${like.replaceAll('x', 'm.name')}) OR (${like.replaceAll('x', 's.name')})
    OR lower(p.name) LIKE '%kivitsisa%' OR lower(s.name) LIKE '%uddannelsesstyrelsen%'`;
  const glIds = db.all(`SELECT a.id FROM activities a LEFT JOIN municipalities m ON m.id = a.municipality_id
    LEFT JOIN schools s ON s.id = a.school_id LEFT JOIN paid_by p ON p.id = a.paid_by_id WHERE ${greenland}`, [...params, ...params]).map((r) => r.id);
  db.run('UPDATE activities SET apl_type_id = ?', [ids['Workshop Fysisk']]);
  for (const a of glIds) db.run('UPDATE activities SET apl_type_id = ? WHERE id = ?', [ids['Workshop Online'], a]);
  db.run(`DELETE FROM apl_types WHERE id NOT IN (${Object.values(ids).join(',')})`);
  return true;
}

