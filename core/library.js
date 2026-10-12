// Bibliotek: course descriptions and the materials that belong to them (files, links and guides).
// A course description is an attached document (PDF, Word, ...) with a few facts for finding it.
//
// A course in the registration points at its course description (activities.course_description_id)
// and so gets every material of that description. A single course can also have materials of its own
// (library_items.activity_id), e.g. a participant list. Only Kompas changes the library; consultants
// see the materials marked "Konsulenter" on their own page. Resellers and viewers do not see it yet.

import { AUDIENCES, audienceIn, moduleCourse, moduleIn } from './course-names.js';

export const KINDS = ['file', 'link', 'guide'];
export const VISIBILITY = ['consultants', 'kompas'];
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ITEM_COLS = 'i.id, i.name, i.kind, i.url, i.body, i.filename, i.content_type, i.size, i.visibility, i.activity_id, i.updated_at';
// The attached document, as { filename, content_type, size } or null.
const DOC_COLS = 'd.doc_filename, d.doc_content_type, d.doc_size';
const docOut = ({ doc_filename, doc_content_type, doc_size, ...d }) =>
  ({ ...d, document: doc_filename ? { filename: doc_filename, content_type: doc_content_type || '', size: doc_size || 0 } : null });
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
// The other titles a description is known by, one per line.
const aliases = (d) => String(d.match_titles || '').split('\n').map((t) => t.trim()).filter(Boolean);

// The active course description whose title (or one of its other titles) is exactly this course title.
export function descriptionForTitle(db, title) {
  const t = norm(title);
  if (!t) return null;
  const all = db.all('SELECT id, title, match_titles FROM course_descriptions WHERE active = 1 ORDER BY id');
  return all.find((d) => norm(d.title) === t)?.id ?? all.find((d) => aliases(d).some((a) => norm(a) === t))?.id ?? null;
}

// The uniform name of a course and its description: "Modul 2 (lærere)" becomes "Modul 2 – Lærere",
// and a title that is one of a description's other titles becomes the description's own title.
// ctx: { startTime, municipality }, used for Høje-Taastrup titles without the target group.
export function uniformTitle(db, title, ctx = {}) {
  const t = String(title ?? '').trim();
  const standard = moduleCourse(t, ctx)?.title || t;
  const id = descriptionForTitle(db, standard) ?? (standard !== t ? descriptionForTitle(db, t) : null);
  const own = id ? db.get('SELECT title FROM course_descriptions WHERE id = ?', [id]).title : null;
  return { title: own || standard, course_description_id: id };
}

function decodeBase64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function createLibrary(db, { HttpError, requireAdmin, todayIso }) {
  const int = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  const text = (v, max = 20000) => String(v ?? '').trim().slice(0, max);

  // --- Course descriptions ------------------------------------------------------------------

  function descriptionInput(b = {}, id = 0) {
    const title = text(b.title, 200);
    if (!title) throw new HttpError(400, 'Kurset skal have et navn.');
    if (db.get('SELECT id FROM course_descriptions WHERE title = ? COLLATE NOCASE AND id <> ?', [title, id])) {
      throw new HttpError(400, `Der findes allerede et kursus, der hedder ${title}.`);
    }
    let apl_type_id = int(b.apl_type_id);
    if (apl_type_id && !db.get('SELECT id FROM apl_types WHERE id = ?', [apl_type_id])) throw new HttpError(400, 'APL-typen findes ikke.');
    if (!apl_type_id) apl_type_id = null;
    const match_titles = [...new Set(String(b.match_titles ?? '').split('\n').map((t) => t.trim()).filter((t) => t && norm(t) !== norm(title)))].join('\n');
    const active = b.active === undefined ? 1 : (b.active === true || b.active === 1 || /^(1|true|on)$/i.test(String(b.active)) ? 1 : 0);
    // Målgruppe and modul: what the form says, otherwise what the title says ("Modul 1 – Lærere").
    let audience = text(b.audience, 200) || audienceIn(title);
    audience = AUDIENCES.find((x) => x.toLowerCase() === audience.toLowerCase()) || audience;
    const module = text(b.module, 20).replace(/^modul(e)?\s*/i, '') || moduleIn(title);
    return { title, audience, module, apl_type_id, length_text: text(b.length_text, 200), match_titles, active };
  }
  // Summary, goals and program are no longer edited (the document holds them); they keep what earlier versions saved.
  const DESC_FIELDS = ['title', 'audience', 'module', 'apl_type_id', 'length_text', 'match_titles', 'active'];

  // body.document: { name, type, data } replaces the document; body.remove_document takes it off.
  function saveDocument(id, b) {
    if (b.document) {
      const f = fileInput(b.document);
      db.run('UPDATE course_descriptions SET doc_filename = ?, doc_content_type = ?, doc_size = ? WHERE id = ?', [f.filename, f.content_type, f.size, id]);
      db.run('DELETE FROM course_description_files WHERE description_id = ?', [id]);
      db.run('INSERT INTO course_description_files (description_id, data) VALUES (?, ?)', [id, f.data]);
    } else if (b.remove_document) {
      db.run('UPDATE course_descriptions SET doc_filename = NULL, doc_content_type = NULL, doc_size = NULL WHERE id = ?', [id]);
      db.run('DELETE FROM course_description_files WHERE description_id = ?', [id]);
    }
  }

  function inTransaction(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function createDescription(user, body) {
    requireAdmin(user);
    const d = descriptionInput(body);
    const id = inTransaction(() => {
      const { lastInsertRowid } = db.run(`INSERT INTO course_descriptions (${DESC_FIELDS.join(', ')}) VALUES (${DESC_FIELDS.map(() => '?').join(', ')})`,
        DESC_FIELDS.map((k) => d[k]));
      saveDocument(Number(lastInsertRowid), body);
      return Number(lastInsertRowid);
    });
    return getDescription(user, id);
  }

  function updateDescription(user, id, body) {
    requireAdmin(user);
    const before = descriptionRow(id);
    const d = descriptionInput(body, id);
    inTransaction(() => {
      db.run(`UPDATE course_descriptions SET ${DESC_FIELDS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        [...DESC_FIELDS.map((k) => d[k]), id]);
      // The courses are named after their description, so a new title renames them too.
      if (d.title !== before.title) db.run(`UPDATE activities SET title = ?, updated_at = datetime('now') WHERE course_description_id = ?`, [d.title, id]);
      saveDocument(id, body);
    });
    return getDescription(user, id);
  }

  // The courses keep their data; they are only no longer linked. Materials only this description had
  // stay in the library as general materials.
  function deleteDescription(user, id) {
    requireAdmin(user);
    descriptionRow(id);
    db.run('UPDATE activities SET course_description_id = NULL WHERE course_description_id = ?', [id]);
    db.run('DELETE FROM library_links WHERE course_description_id = ?', [id]);
    db.run('DELETE FROM course_description_files WHERE description_id = ?', [id]);
    db.run('DELETE FROM course_descriptions WHERE id = ?', [id]);
    return { ok: true };
  }

  function descriptionRow(id) {
    const d = db.get(`SELECT d.id, d.title, d.audience, d.module, d.apl_type_id, d.length_text, d.match_titles, d.active, d.created_at, d.updated_at,
        ${DOC_COLS}, t.name AS apl_type FROM course_descriptions d LEFT JOIN apl_types t ON t.id = d.apl_type_id WHERE d.id = ?`, [id]);
    if (!d) throw new HttpError(404, 'Kurset findes ikke.');
    return d;
  }

  // Afholdt / Planlagt / Foreløbig per description, counted the same way as everywhere else.
  function courseCounts() {
    const today = todayIso();
    return new Map(db.all(`SELECT course_description_id AS id,
        SUM(date <= ? AND pending = 0) AS held, SUM(date > ? AND pending = 0) AS planned, SUM(pending) AS pending
      FROM activities WHERE course_description_id IS NOT NULL GROUP BY course_description_id`, [today, today]).map((r) => [r.id, r]));
  }

  const itemOut = (r) => ({ id: r.id, name: r.name, kind: r.kind, url: r.url || '', body: r.body || '', filename: r.filename || '',
    content_type: r.content_type || '', size: r.size || 0, visibility: r.visibility, activity_id: r.activity_id || null, updated_at: r.updated_at });

  function itemsOf(descriptionId) {
    return db.all(`SELECT ${ITEM_COLS} FROM library_items i JOIN library_links l ON l.item_id = i.id
      WHERE l.course_description_id = ? ORDER BY i.name COLLATE NOCASE`, [descriptionId]).map(itemOut);
  }

  function getDescription(user, id) {
    requireAdmin(user);
    const d = descriptionRow(id);
    const c = courseCounts().get(id) || {};
    const courses = db.all(`SELECT a.id, a.date, a.start_time, a.end_time, a.title, a.pending, s.name AS school, m.name AS municipality,
        c.initials AS consultant_initials, c.name AS consultant, r.name AS reseller
      FROM activities a JOIN resellers r ON r.id = a.reseller_id LEFT JOIN schools s ON s.id = a.school_id
      LEFT JOIN municipalities m ON m.id = a.municipality_id LEFT JOIN consultants c ON c.id = a.consultant_id
      WHERE a.course_description_id = ? ORDER BY a.date DESC, a.start_time DESC, a.id DESC`, [id])
      .map((a) => ({ ...a, status: a.pending ? 'pending' : a.date <= todayIso() ? 'held' : 'planned' }));
    return { ...docOut(d), counts: { held: c.held || 0, planned: c.planned || 0, pending: c.pending || 0 }, items: itemsOf(id), courses };
  }

  // --- Overview -------------------------------------------------------------------------------

  // Titles of courses that are not linked yet, with the description they would get (if any).
  function unlinked() {
    return db.all(`SELECT title, COUNT(*) AS n FROM activities WHERE course_description_id IS NULL
        GROUP BY lower(trim(title)) ORDER BY n DESC, title`)
      .map((r) => ({ title: r.title, n: r.n, suggestion: descriptionForTitle(db, r.title) }));
  }

  function overview(user) {
    requireAdmin(user);
    const counts = courseCounts();
    const itemCounts = new Map(db.all('SELECT course_description_id AS id, COUNT(*) AS n FROM library_links GROUP BY course_description_id').map((r) => [r.id, r.n]));
    const descriptions = db.all(`SELECT d.id, d.title, d.audience, d.module, d.length_text, d.active, ${DOC_COLS}, t.name AS apl_type
        FROM course_descriptions d LEFT JOIN apl_types t ON t.id = d.apl_type_id ORDER BY d.active DESC, d.title COLLATE NOCASE`)
      .map((d) => {
        const c = counts.get(d.id) || {};
        return { ...docOut(d), counts: { held: c.held || 0, planned: c.planned || 0, pending: c.pending || 0 }, items: itemCounts.get(d.id) || 0 };
      });
    const linkNames = new Map();
    for (const r of db.all(`SELECT l.item_id, d.id, d.title FROM library_links l JOIN course_descriptions d ON d.id = l.course_description_id ORDER BY d.title COLLATE NOCASE`)) {
      linkNames.set(r.item_id, [...(linkNames.get(r.item_id) || []), { id: r.id, title: r.title }]);
    }
    const sent = new Map(db.all('SELECT item_id, COUNT(*) AS n FROM library_course_links GROUP BY item_id').map((r) => [r.item_id, r.n]));
    const items = db.all(`SELECT ${ITEM_COLS} FROM library_items i WHERE i.activity_id IS NULL ORDER BY i.name COLLATE NOCASE`)
      .map((r) => ({ ...itemOut(r), descriptions: linkNames.get(r.id) || [], courses: sent.get(r.id) || 0 }));
    return { descriptions, items, unlinked: unlinked() };
  }

  // Kobl eksisterende: every course with this title gets the description and its name. A title that differs
  // from the description's own is remembered, so later courses with that title are linked (and renamed) by themselves.
  function linkTitle(user, body = {}) {
    requireAdmin(user);
    const title = text(body.title, 300);
    const id = int(body.course_description_id);
    if (!title) throw new HttpError(400, 'Titlen mangler.');
    const d = descriptionRow(id);
    const { changes } = db.run(`UPDATE activities SET course_description_id = ?, title = ?, updated_at = datetime('now')
      WHERE course_description_id IS NULL AND lower(trim(title)) = lower(trim(?))`, [id, d.title, title]);
    if (norm(title) !== norm(d.title) && !aliases(d).some((a) => norm(a) === norm(title))) {
      db.run('UPDATE course_descriptions SET match_titles = ? WHERE id = ?', [[...aliases(d), title].join('\n'), id]);
    }
    return { linked: Number(changes) };
  }

  // --- Materials ------------------------------------------------------------------------------

  function itemRow(id) {
    const r = db.get(`SELECT ${ITEM_COLS} FROM library_items i WHERE i.id = ?`, [id]);
    if (!r) throw new HttpError(404, 'Materialet findes ikke.');
    return r;
  }

  // file: { name, type, data } with data as base64.
  function fileInput(file) {
    const name = text(file?.name, 200).replace(/[\\/]/g, '_');
    if (!name || typeof file?.data !== 'string' || !file.data) throw new HttpError(400, 'Vælg en fil.');
    if (file.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) throw new HttpError(413, 'Filen er for stor. Den må højst fylde 20 MB. Læg større filer som et link.');
    const data = decodeBase64(file.data);
    if (!data.length) throw new HttpError(400, 'Filen er tom.');
    if (data.length > MAX_FILE_BYTES) throw new HttpError(413, 'Filen er for stor. Den må højst fylde 20 MB. Læg større filer som et link.');
    return { filename: name, content_type: text(file.type, 200) || 'application/octet-stream', size: data.length, data };
  }

  function itemInput(b, existing = null) {
    const kind = existing?.kind || b.kind;
    if (!KINDS.includes(kind)) throw new HttpError(400, 'Vælg fil, link eller guide.');
    const visibility = VISIBILITY.includes(b.visibility) ? b.visibility : existing?.visibility || 'consultants';
    const out = { kind, visibility, url: null, body: '', file: null };
    if (kind === 'link') {
      out.url = text(b.url, 2000);
      if (!/^https?:\/\/\S+$/i.test(out.url)) throw new HttpError(400, 'Linket skal begynde med https:// eller http://.');
    } else if (kind === 'guide') {
      out.body = text(b.body, 50000);
      if (!out.body) throw new HttpError(400, 'Skriv guidens tekst.');
    } else if (b.file || !existing) {
      out.file = fileInput(b.file);
    }
    out.name = text(b.name, 200) || out.file?.filename || existing?.name || '';
    if (!out.name) throw new HttpError(400, 'Giv materialet et navn.');
    return out;
  }

  function linkDescriptions(itemId, ids) {
    db.run('DELETE FROM library_links WHERE item_id = ?', [itemId]);
    for (const did of [...new Set(ids.map(int).filter(Boolean))]) {
      descriptionRow(did);
      db.run('INSERT INTO library_links (item_id, course_description_id) VALUES (?, ?)', [itemId, did]);
    }
  }

  // body: name, kind, visibility, url | body | file, and either course_description_ids (library
  // material) or activity_id (material for that one course only).
  function createItem(user, b = {}) {
    requireAdmin(user);
    const activityId = int(b.activity_id);
    if (activityId && !db.get('SELECT id FROM activities WHERE id = ?', [activityId])) throw new HttpError(404, 'Aktiviteten findes ikke.');
    const it = itemInput(b);
    db.exec('BEGIN');
    try {
      const { lastInsertRowid } = db.run(`INSERT INTO library_items (name, kind, url, body, filename, content_type, size, visibility, activity_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [it.name, it.kind, it.url, it.body, it.file?.filename ?? null, it.file?.content_type ?? null,
        it.file?.size ?? null, it.visibility, activityId || null, user.id]);
      const id = Number(lastInsertRowid);
      if (it.file) db.run('INSERT INTO library_files (item_id, data) VALUES (?, ?)', [id, it.file.data]);
      if (!activityId) linkDescriptions(id, Array.isArray(b.course_description_ids) ? b.course_description_ids : []);
      db.exec('COMMIT');
      return itemOut(itemRow(id));
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function updateItem(user, id, b = {}) {
    requireAdmin(user);
    const old = itemRow(id);
    const it = itemInput(b, old);
    db.exec('BEGIN');
    try {
      db.run(`UPDATE library_items SET name = ?, url = ?, body = ?, visibility = ?, updated_at = datetime('now') WHERE id = ?`,
        [it.name, it.url, it.body, it.visibility, id]);
      if (it.file) {
        db.run('UPDATE library_items SET filename = ?, content_type = ?, size = ? WHERE id = ?', [it.file.filename, it.file.content_type, it.file.size, id]);
        db.run('DELETE FROM library_files WHERE item_id = ?', [id]);
        db.run('INSERT INTO library_files (item_id, data) VALUES (?, ?)', [id, it.file.data]);
      }
      if (!old.activity_id && Array.isArray(b.course_description_ids)) linkDescriptions(id, b.course_description_ids);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return itemOut(itemRow(id));
  }

  function deleteItem(user, id) {
    requireAdmin(user);
    itemRow(id);
    db.run('DELETE FROM library_files WHERE item_id = ?', [id]);
    db.run('DELETE FROM library_links WHERE item_id = ?', [id]);
    db.run('DELETE FROM library_course_links WHERE item_id = ?', [id]);
    db.run('DELETE FROM library_items WHERE id = ?', [id]);
    return { ok: true };
  }

  // Adds an existing library material to a description, or takes it off again.
  function setItemLink(user, descriptionId, itemId, on) {
    requireAdmin(user);
    descriptionRow(descriptionId);
    const it = itemRow(itemId);
    if (it.activity_id) throw new HttpError(400, 'Materialet hører til ét bestemt kursus.');
    if (on) db.run('INSERT OR IGNORE INTO library_links (item_id, course_description_id) VALUES (?, ?)', [itemId, descriptionId]);
    else db.run('DELETE FROM library_links WHERE item_id = ? AND course_description_id = ?', [itemId, descriptionId]);
    return { items: itemsOf(descriptionId) };
  }

  // --- Send til kurser -------------------------------------------------------------------------
  // A library material can go to every course of some course descriptions (library_links) and to
  // courses picked one by one (library_course_links). Both are set here in one go.

  function libraryItem(id) {
    const it = itemRow(id);
    if (it.activity_id) throw new HttpError(400, 'Materialet hører til ét bestemt kursus.');
    return it;
  }

  // The material's descriptions and chosen courses, and every course to choose from (newest first).
  function itemCourses(user, id) {
    requireAdmin(user);
    const it = libraryItem(id);
    const today = todayIso();
    const courses = db.all(`SELECT a.id, a.date, a.start_time, a.title, a.pending, a.course_description_id, s.name AS school,
        m.name AS municipality, c.name AS consultant, r.name AS reseller
      FROM activities a JOIN resellers r ON r.id = a.reseller_id LEFT JOIN schools s ON s.id = a.school_id
      LEFT JOIN municipalities m ON m.id = a.municipality_id LEFT JOIN consultants c ON c.id = a.consultant_id
      ORDER BY a.date DESC, a.start_time DESC, a.id DESC`)
      .map((a) => ({ ...a, status: a.pending ? 'pending' : a.date <= today ? 'held' : 'planned' }));
    return {
      item: itemOut(it),
      course_description_ids: db.all('SELECT course_description_id AS id FROM library_links WHERE item_id = ?', [id]).map((r) => r.id),
      activity_ids: db.all('SELECT activity_id AS id FROM library_course_links WHERE item_id = ?', [id]).map((r) => r.id),
      courses,
    };
  }

  // body: { activity_ids, course_description_ids? }. Replaces the chosen courses (and descriptions, when given).
  function sendToCourses(user, id, b = {}) {
    requireAdmin(user);
    libraryItem(id);
    const ids = [...new Set((Array.isArray(b.activity_ids) ? b.activity_ids : []).map(int).filter(Boolean))];
    inTransaction(() => {
      db.run('DELETE FROM library_course_links WHERE item_id = ?', [id]);
      for (const aid of ids) {
        if (!db.get('SELECT id FROM activities WHERE id = ?', [aid])) throw new HttpError(404, 'Et af kurserne findes ikke.');
        db.run('INSERT INTO library_course_links (item_id, activity_id) VALUES (?, ?)', [id, aid]);
      }
      if (Array.isArray(b.course_description_ids)) linkDescriptions(id, b.course_description_ids);
    });
    return itemCourses(user, id);
  }

  // Sends a material to one more course (Tilføj fra biblioteket under the course), or takes it off again.
  function sendToCourse(user, id, activityId, on) {
    requireAdmin(user);
    libraryItem(id);
    if (!db.get('SELECT id FROM activities WHERE id = ?', [activityId])) throw new HttpError(404, 'Aktiviteten findes ikke.');
    if (on) db.run('INSERT OR IGNORE INTO library_course_links (item_id, activity_id) VALUES (?, ?)', [id, activityId]);
    else db.run('DELETE FROM library_course_links WHERE item_id = ? AND activity_id = ?', [id, activityId]);
    return materialsFor(activityId);
  }

  function fileOf(it) {
    if (it.kind !== 'file') throw new HttpError(400, 'Materialet er ikke en fil.');
    const f = db.get('SELECT data FROM library_files WHERE item_id = ?', [it.id]);
    if (!f) throw new HttpError(404, 'Filen findes ikke.');
    return { filename: it.filename || it.name, contentType: it.content_type || 'application/octet-stream', data: f.data };
  }

  function documentOf(d) {
    const f = d?.doc_filename && db.get('SELECT data FROM course_description_files WHERE description_id = ?', [d.id]);
    if (!f) throw new HttpError(404, 'Kursusbeskrivelsen har ikke noget dokument.');
    return { filename: d.doc_filename, contentType: d.doc_content_type || 'application/octet-stream', data: f.data };
  }

  function downloadDocument(user, id) {
    requireAdmin(user);
    return documentOf(descriptionRow(id));
  }

  function downloadItem(user, id) {
    requireAdmin(user);
    return fileOf(itemRow(id));
  }

  // The materials of one course: those of its description and those sent to it (inherited, with
  // sent: true on the latter), then its own.
  function materialsFor(activityId, { consultantsOnly = false } = {}) {
    const a = db.get('SELECT id, course_description_id FROM activities WHERE id = ?', [activityId]);
    if (!a) return { description: null, inherited: [], own: [] };
    const vis = (rows) => (consultantsOnly ? rows.filter((r) => r.visibility === 'consultants') : rows);
    const d = a.course_description_id ? db.get(`SELECT d.id, d.title, ${DOC_COLS} FROM course_descriptions d WHERE d.id = ?`, [a.course_description_id]) : null;
    const description = d ? docOut(d) : null;
    return {
      description,
      inherited: vis(dedupe([...(description ? itemsOf(description.id) : []),
        ...db.all(`SELECT ${ITEM_COLS} FROM library_items i JOIN library_course_links k ON k.item_id = i.id WHERE k.activity_id = ?
          ORDER BY i.name COLLATE NOCASE`, [activityId]).map((r) => ({ ...itemOut(r), sent: true }))])),
      own: vis(db.all(`SELECT ${ITEM_COLS} FROM library_items i WHERE i.activity_id = ? ORDER BY i.name COLLATE NOCASE`, [activityId]).map(itemOut)),
    };
  }

  // A material both in the description and sent to the course shows once, as the description's.
  const dedupe = (rows) => rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);

  // How many materials each course has (its description's, those sent to it, and its own), for the lists.
  function materialCounts() {
    return new Map(db.all(`SELECT activity_id, COUNT(DISTINCT item_id) AS n FROM (
        SELECT activity_id, id AS item_id FROM library_items WHERE activity_id IS NOT NULL
        UNION SELECT a.id, l.item_id FROM activities a JOIN library_links l ON l.course_description_id = a.course_description_id
        UNION SELECT activity_id, item_id FROM library_course_links
      ) GROUP BY activity_id`).map((r) => [r.activity_id, r.n]));
  }

  function activityMaterials(user, activityId) {
    requireAdmin(user);
    if (!db.get('SELECT id FROM activities WHERE id = ?', [activityId])) throw new HttpError(404, 'Aktiviteten findes ikke.');
    return materialsFor(activityId);
  }

  // --- Konsulentside --------------------------------------------------------------------------

  // What a consultant may see: active descriptions, and library materials marked Konsulenter.
  function consultantLibrary() {
    const descriptions = db.all(`SELECT d.id, d.title, d.audience, d.module, d.length_text, ${DOC_COLS}, t.name AS apl_type
        FROM course_descriptions d LEFT JOIN apl_types t ON t.id = d.apl_type_id WHERE d.active = 1 ORDER BY d.title COLLATE NOCASE`).map(docOut);
    // Every library material marked Konsulenter, with the descriptions it belongs to.
    const names = new Map();
    for (const r of db.all(`SELECT l.item_id, d.title FROM library_links l JOIN course_descriptions d ON d.id = l.course_description_id
        WHERE d.active = 1 ORDER BY d.title COLLATE NOCASE`)) names.set(r.item_id, [...(names.get(r.item_id) || []), r.title]);
    const materials = db.all(`SELECT ${ITEM_COLS} FROM library_items i WHERE i.activity_id IS NULL AND i.visibility = 'consultants'
        ORDER BY i.name COLLATE NOCASE`).map((r) => ({ ...itemOut(r), descriptions: names.get(r.id) || [] }));
    return { descriptions, materials };
  }

  // A consultant may open a material marked Konsulenter that is in the library, or that belongs to one of their own courses.
  function consultantFile(consultantId, itemId) {
    const it = db.get(`SELECT ${ITEM_COLS}, a.consultant_id FROM library_items i LEFT JOIN activities a ON a.id = i.activity_id WHERE i.id = ?`, [itemId]);
    if (!it || it.visibility !== 'consultants' || (it.activity_id && it.consultant_id !== consultantId)) throw new HttpError(404, 'Materialet findes ikke.');
    return fileOf(it);
  }

  // Consultants may open the document of every active course description, and of the descriptions of their own courses.
  function consultantDocument(consultantId, id) {
    const d = db.get(`SELECT id, doc_filename, doc_content_type FROM course_descriptions d WHERE id = ?
      AND (active = 1 OR EXISTS (SELECT 1 FROM activities a WHERE a.course_description_id = d.id AND a.consultant_id = ?))`, [id, consultantId]);
    if (!d) throw new HttpError(404, 'Kurset findes ikke.');
    return documentOf(d);
  }

  return { downloadDocument, consultantDocument, overview, createDescription, updateDescription, deleteDescription, getDescription, linkTitle,
    createItem, updateItem, deleteItem, setItemLink, itemCourses, sendToCourses, sendToCourse, materialCounts, downloadItem, activityMaterials, materialsFor, consultantLibrary, consultantFile };
}
