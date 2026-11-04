// Slettede kurser (Jakob, 2026-11-04): deleting a course moves it to a trash list instead of losing it.
// The course row and everything that hangs on it (tilmeldinger, noter, the course's own materials and
// materials sent to it) are saved as one JSON snapshot in deleted_activities, and then removed as before.
// So nothing else in the app has to know about deleted courses. Kompas can see the list under
// Administration › Slettede kurser, genaktivere a course (the rows are put back) or delete it for good.

export const TRASH_SCHEMA = `CREATE TABLE IF NOT EXISTS deleted_activities (
  id           INTEGER PRIMARY KEY,
  activity_id  INTEGER NOT NULL,
  date         TEXT NOT NULL,
  title        TEXT NOT NULL,
  school       TEXT,
  municipality TEXT,
  consultant   TEXT,
  reseller     TEXT,
  deleted_by   TEXT NOT NULL DEFAULT '',
  deleted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  data         TEXT NOT NULL
)`;

// BLOBs (uploaded files) survive the JSON round trip as base64.
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const pack = (row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { $b64: toB64(v) } : v]));
const unpack = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) =>
  [k, v && typeof v === 'object' && '$b64' in v ? Uint8Array.from(atob(v.$b64), (c) => c.charCodeAt(0)) : v]));

export function createTrash(db, { HttpError, requireAdmin }) {
  const cols = new Map();
  const columnsOf = (table) => {
    if (!cols.has(table)) cols.set(table, db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
    return cols.get(table);
  };
  const exists = (table, id) => id != null && Boolean(db.get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, [id]));
  // Inserts a saved row; keeps its old id when that is still free, so links and calendar entries match.
  const insert = (table, row) => {
    const r = { ...row };
    if ('id' in r && exists(table, r.id)) delete r.id;
    const keys = Object.keys(r).filter((k) => columnsOf(table).includes(k));
    const res = db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => r[k]));
    return 'id' in r ? r.id : Number(res.lastInsertRowid);
  };

  // Called inside deleteActivity, before the row is removed.
  function save(user, id) {
    const activity = db.get('SELECT * FROM activities WHERE id = ?', [id]);
    const own = db.all('SELECT * FROM library_items WHERE activity_id = ?', [id]);
    const data = {
      activity,
      signups: db.all('SELECT * FROM course_signups WHERE activity_id = ?', [id]),
      notes: db.all('SELECT * FROM course_notes WHERE activity_id = ?', [id]),
      items: own.map((item) => ({
        item,
        file: pack(db.get('SELECT data FROM library_files WHERE item_id = ?', [item.id]))?.data ?? null,
        links: db.all('SELECT course_description_id FROM library_links WHERE item_id = ?', [item.id]).map((l) => l.course_description_id),
        courses: db.all('SELECT activity_id FROM library_course_links WHERE item_id = ? AND activity_id <> ?', [item.id, id]).map((l) => l.activity_id),
      })),
      sent: db.all(`SELECT item_id FROM library_course_links WHERE activity_id = ?
        AND item_id NOT IN (SELECT id FROM library_items WHERE activity_id = ?)`, [id, id]).map((l) => l.item_id),
    };
    const name = (table, rid) => (rid == null ? null : db.get(`SELECT name FROM ${table} WHERE id = ?`, [rid])?.name ?? null);
    db.run(`INSERT INTO deleted_activities (activity_id, date, title, school, municipality, consultant, reseller, deleted_by, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, activity.date, activity.title, name('schools', activity.school_id),
      name('municipalities', activity.municipality_id), name('consultants', activity.consultant_id), name('resellers', activity.reseller_id),
      user?.name || '', JSON.stringify(data)]);
  }

  function list(user) {
    requireAdmin(user);
    return db.all(`SELECT id, activity_id, date, title, school, municipality, consultant, reseller, deleted_by, deleted_at
      FROM deleted_activities ORDER BY deleted_at DESC, id DESC`);
  }

  function entry(id) {
    const row = db.get('SELECT * FROM deleted_activities WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Det slettede kursus findes ikke længere.');
    return row;
  }

  function restore(user, id) {
    requireAdmin(user);
    const { data } = entry(id);
    const d = JSON.parse(data);
    const a = { ...d.activity };
    if (!exists('apl_types', a.apl_type_id)) throw new HttpError(409, 'Kurset kan ikke genaktiveres, fordi dets APL-type er slettet. Opret APL-typen igen først.');
    if (!exists('resellers', a.reseller_id)) throw new HttpError(409, 'Kurset kan ikke genaktiveres, fordi dets reseller er slettet. Opret reselleren igen først.');
    // Choices deleted since are left empty rather than blocking the restore.
    for (const [col, table] of [['school_id', 'schools'], ['municipality_id', 'municipalities'], ['consultant_id', 'consultants'],
      ['paid_by_id', 'paid_by'], ['created_by', 'users'], ['course_description_id', 'course_descriptions']]) {
      if (a[col] != null && !exists(table, a[col])) a[col] = null;
    }
    db.exec('BEGIN');
    try {
      const aid = insert('activities', a);
      for (const s of d.signups) {
        if (exists('consultants', s.consultant_id)) insert('course_signups', { ...s, activity_id: aid });
      }
      for (const n of d.notes) {
        insert('course_notes', { ...n, activity_id: aid,
          user_id: exists('users', n.user_id) ? n.user_id : null, consultant_id: exists('consultants', n.consultant_id) ? n.consultant_id : null });
      }
      for (const { item, file, links, courses } of d.items) {
        const iid = insert('library_items', { ...item, activity_id: aid, created_by: exists('users', item.created_by) ? item.created_by : null });
        if (file) db.run('INSERT INTO library_files (item_id, data) VALUES (?, ?)', [iid, unpack({ file }).file]);
        for (const cd of links) if (exists('course_descriptions', cd)) db.run('INSERT OR IGNORE INTO library_links (item_id, course_description_id) VALUES (?, ?)', [iid, cd]);
        for (const c of courses) if (exists('activities', c)) db.run('INSERT OR IGNORE INTO library_course_links (item_id, activity_id) VALUES (?, ?)', [iid, c]);
      }
      for (const iid of d.sent) if (exists('library_items', iid)) db.run('INSERT OR IGNORE INTO library_course_links (item_id, activity_id) VALUES (?, ?)', [iid, aid]);
      db.run('DELETE FROM deleted_activities WHERE id = ?', [id]);
      db.exec('COMMIT');
      return { id: aid };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function purge(user, id) {
    requireAdmin(user);
    entry(id);
    db.run('DELETE FROM deleted_activities WHERE id = ?', [id]);
    return { ok: true };
  }

  return { save, list, restore, purge };
}
