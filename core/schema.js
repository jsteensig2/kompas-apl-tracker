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
  if (!cols('users').includes('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  if (!cols('users').includes('last_seen_at')) db.exec('ALTER TABLE users ADD COLUMN last_seen_at TEXT');
  if (!cols('consultants').includes('page_seen_at')) db.exec('ALTER TABLE consultants ADD COLUMN page_seen_at TEXT');
  if (!cols('consultants').includes('feed_seen_at')) db.exec('ALTER TABLE consultants ADD COLUMN feed_seen_at TEXT');
  if (!cols('activities').includes('reschedule')) db.exec('ALTER TABLE activities ADD COLUMN reschedule INTEGER NOT NULL DEFAULT 0');
  if (!cols('activities').includes('pending')) db.exec('ALTER TABLE activities ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
  if (!cols('activities').includes('apple_reported_at')) db.exec('ALTER TABLE activities ADD COLUMN apple_reported_at TEXT');
  if (!cols('consultants').includes('feed_token')) db.exec('ALTER TABLE consultants ADD COLUMN feed_token TEXT');
  // Optional start and end time, "HH:MM" on a 24-hour clock (Jakob, 2026-10-06).
  if (!cols('activities').includes('start_time')) db.exec('ALTER TABLE activities ADD COLUMN start_time TEXT');
  if (!cols('activities').includes('end_time')) db.exec('ALTER TABLE activities ADD COLUMN end_time TEXT');
  // Apple's registration form asks for the specialist's e-mail and the school's postal code (Jakob, 2026-10-10).
  if (!cols('consultants').includes('email')) db.exec('ALTER TABLE consultants ADD COLUMN email TEXT');
  if (!cols('schools').includes('postal_code')) db.exec('ALTER TABLE schools ADD COLUMN postal_code TEXT');
  if (!cols('activities').includes('consultants_needed')) db.exec('ALTER TABLE activities ADD COLUMN consultants_needed INTEGER');
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
  // Tilmelding: each consultant answers whether they can take a Foreløbig course that has no consultant yet.
  db.exec(`CREATE TABLE IF NOT EXISTS course_signups (
    activity_id    INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    consultant_id  INTEGER NOT NULL REFERENCES consultants(id) ON DELETE CASCADE,
    answer         TEXT NOT NULL CHECK (answer IN ('yes', 'maybe', 'no')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (activity_id, consultant_id)
  )`);
  // Beskeder: Kompas writes to all consultants (consultant_id NULL) or to one; they read it on their page.
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    consultant_id  INTEGER REFERENCES consultants(id) ON DELETE CASCADE,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS message_reads (
    message_id     INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    consultant_id  INTEGER NOT NULL REFERENCES consultants(id) ON DELETE CASCADE,
    read_at        TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, consultant_id)
  )`);
  // Noter: short notes on a course, written by Kompas (user_id) or by the course's consultant (consultant_id).
  db.exec(`CREATE TABLE IF NOT EXISTS course_notes (
    id             INTEGER PRIMARY KEY,
    activity_id    INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    body           TEXT NOT NULL,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    consultant_id  INTEGER REFERENCES consultants(id) ON DELETE SET NULL,
    author         TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_course_notes_activity ON course_notes (activity_id)');
  // Bibliotek (Jakob, 2026-10-12): course descriptions, and materials (files, links, guides) that belong
  // to descriptions, to the whole library, or to one single course (activity_id).
  db.exec(`CREATE TABLE IF NOT EXISTS course_descriptions (
    id            INTEGER PRIMARY KEY,
    title         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    summary       TEXT NOT NULL DEFAULT '',
    audience      TEXT NOT NULL DEFAULT '',
    apl_type_id   INTEGER REFERENCES apl_types(id) ON DELETE SET NULL,
    length_text   TEXT NOT NULL DEFAULT '',
    goals         TEXT NOT NULL DEFAULT '',
    program       TEXT NOT NULL DEFAULT '',
    match_titles  TEXT NOT NULL DEFAULT '',          -- other course titles that mean this course, one per line
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // kind: 'file' | 'link' | 'guide'; visibility: 'consultants' | 'kompas' (checked in code, so more levels can come).
  db.exec(`CREATE TABLE IF NOT EXISTS library_items (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL,
    url           TEXT,
    body          TEXT NOT NULL DEFAULT '',
    filename      TEXT,
    content_type  TEXT,
    size          INTEGER,
    visibility    TEXT NOT NULL DEFAULT 'consultants',
    activity_id   INTEGER REFERENCES activities(id) ON DELETE CASCADE,
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Uploaded files live in the database itself, so they are part of every database backup.
  db.exec(`CREATE TABLE IF NOT EXISTS library_files (
    item_id  INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
    data     BLOB NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS library_links (
    item_id                INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
    course_description_id  INTEGER NOT NULL REFERENCES course_descriptions(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, course_description_id)
  )`);
  // The course description itself is an attached document (Jakob, 2026-10-12): PDF, Word or the like.
  if (!cols('course_descriptions').includes('doc_filename')) {
    db.exec('ALTER TABLE course_descriptions ADD COLUMN doc_filename TEXT');
    db.exec('ALTER TABLE course_descriptions ADD COLUMN doc_content_type TEXT');
    db.exec('ALTER TABLE course_descriptions ADD COLUMN doc_size INTEGER');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS course_description_files (
    description_id  INTEGER PRIMARY KEY REFERENCES course_descriptions(id) ON DELETE CASCADE,
    data            BLOB NOT NULL
  )`);
  if (!cols('activities').includes('course_description_id')) {
    db.exec('ALTER TABLE activities ADD COLUMN course_description_id INTEGER REFERENCES course_descriptions(id) ON DELETE SET NULL');
  }
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  once(db, 'apl-types-2026-10-04', () => resetAplTypes(db));
  once(db, 'htk-times-2026-10-06', () => setHtkTimes(db));
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

// Jakob (2026-10-06): coming Høje-Taastrup courses without a time get the usual times,
// teachers ("lærere") 14:00–16:30 and pedagogues ("pædagoger") 09:00–11:30. Other courses are left alone.
function setHtkTimes(db) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen' }).format(new Date());
  const htk = `start_time IS NULL AND date >= ? AND id IN (SELECT a2.id FROM activities a2
    LEFT JOIN schools s ON s.id = a2.school_id
    JOIN municipalities m ON m.id = COALESCE(a2.municipality_id, s.municipality_id)
    WHERE lower(m.name) LIKE 'høje%taastrup%')`;
  const set = (pattern, start, end) => db.run(`UPDATE activities SET start_time = ?, end_time = ?, updated_at = datetime('now')
    WHERE ${htk} AND lower(title) LIKE ?`, [start, end, today, pattern]).changes;
  const teachers = set('%lærer%', '14:00', '16:30');
  const pedagogues = set('%pædagog%', '09:00', '11:30');
  if (teachers || pedagogues) console.log(`Tidspunkter sat på Høje-Taastrup-kurser: ${teachers} for lærere, ${pedagogues} for pædagoger.`);
  return true;
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

