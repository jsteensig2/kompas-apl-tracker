// Bibliotek: course descriptions and the materials that belong to them (files, links and guides).
//
// A course in the registration points at its course description (activities.course_description_id)
// and so gets every material of that description. A single course can also have materials of its own
// (library_items.activity_id), e.g. a participant list. Only Kompas changes the library; consultants
// see the materials marked "Konsulenter" on their own page. Resellers and viewers do not see it yet.

export const KINDS = ['file', 'link', 'guide'];
export const VISIBILITY = ['consultants', 'kompas'];
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ITEM_COLS = 'i.id, i.name, i.kind, i.url, i.body, i.filename, i.content_type, i.size, i.visibility, i.activity_id, i.updated_at';
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
    if (!title) throw new HttpError(400, 'Kursusbeskrivelsen skal have en titel.');
    if (db.get('SELECT id FROM course_descriptions WHERE title = ? COLLATE NOCASE AND id <> ?', [title, id])) {
      throw new HttpError(400, `Der findes allerede en kursusbeskrivelse, der hedder ${title}.`);
    }
    let apl_type_id = int(b.apl_type_id);
    if (apl_type_id && !db.get('SELECT id FROM apl_types WHERE id = ?', [apl_type_id])) throw new HttpError(400, 'APL-typen findes ikke.');
    if (!apl_type_id) apl_type_id = null;
    const match_titles = [...new Set(String(b.match_titles ?? '').split('\n').map((t) => t.trim()).filter((t) => t && norm(t) !== norm(title)))].join('\n');
    const active = b.active === undefined ? 1 : (b.active === true || b.active === 1 || /^(1|true|on)$/i.test(String(b.active)) ? 1 : 0);
    return { title, summary: text(b.summary, 4000), audience: text(b.audience, 200), apl_type_id, length_text: text(b.length_text, 200),
      goals: text(b.goals, 8000), program: text(b.program, 8000), match_titles, active };
  }
  const DESC_FIELDS = ['title', 'summary', 'audience', 'apl_type_id', 'length_text', 'goals', 'program', 'match_titles', 'active'];

  function createDescription(user, body) {
    requireAdmin(user);
    const d = descriptionInput(body);
    const { lastInsertRowid } = db.run(`INSERT INTO course_descriptions (${DESC_FIELDS.join(', ')}) VALUES (${DESC_FIELDS.map(() => '?').join(', ')})`,
      DESC_FIELDS.map((k) => d[k]));
    return getDescription(user, Number(lastInsertRowid));
  }

  function updateDescription(user, id, body) {
    requireAdmin(user);
    descriptionRow(id);
    const d = descriptionInput(body, id);
    db.run(`UPDATE course_descriptions SET ${DESC_FIELDS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      [...DESC_FIELDS.map((k) => d[k]), id]);
    return getDescription(user, id);
  }

  // The courses keep their data; they are only no longer linked. Materials only this description had
  // stay in the library as general materials.
  function deleteDescription(user, id) {
    requireAdmin(user);
    descriptionRow(id);
    db.run('UPDATE activities SET course_description_id = NULL WHERE course_description_id = ?', [id]);
    db.run('DELETE FROM library_links WHERE course_description_id = ?', [id]);
    db.run('DELETE FROM course_descriptions WHERE id = ?', [id]);
    return { ok: true };
  }

  function descriptionRow(id) {
    const d = db.get(`SELECT d.*, t.name AS apl_type FROM course_descriptions d LEFT JOIN apl_types t ON t.id = d.apl_type_id WHERE d.id = ?`, [id]);
    if (!d) throw new HttpError(404, 'Kursusbeskrivelsen findes ikke.');
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
    return { ...d, counts: { held: c.held || 0, planned: c.planned || 0, pending: c.pending || 0 }, items: itemsOf(id), courses };
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
    const descriptions = db.all(`SELECT d.id, d.title, d.summary, d.audience, d.length_text, d.active, t.name AS apl_type
        FROM course_descriptions d LEFT JOIN apl_types t ON t.id = d.apl_type_id ORDER BY d.active DESC, d.title COLLATE NOCASE`)
      .map((d) => {
        const c = counts.get(d.id) || {};
        return { ...d, counts: { held: c.held || 0, planned: c.planned || 0, pending: c.pending || 0 }, items: itemCounts.get(d.id) || 0 };
      });
    const linkNames = new Map();
    for (const r of db.all(`SELECT l.item_id, d.id, d.title FROM library_links l JOIN course_descriptions d ON d.id = l.course_description_id ORDER BY d.title COLLATE NOCASE`)) {
      linkNames.set(r.item_id, [...(linkNames.get(r.item_id) || []), { id: r.id, title: r.title }]);
    }
    const items = db.all(`SELECT ${ITEM_COLS} FROM library_items i WHERE i.activity_id IS NULL ORDER BY i.name COLLATE NOCASE`)
      .map((r) => ({ ...itemOut(r), descriptions: linkNames.get(r.id) || [] }));
    return { descriptions, items, unlinked: unlinked() };
  }

  // Kobl eksisterende: every course with this title gets the description. A title that differs from
  // the description's own is remembered, so later courses with that title are linked by themselves.
  function linkTitle(user, body = {}) {
    requireAdmin(user);
    const title = text(body.title, 300);
    const id = int(body.course_description_id);
    if (!title) throw new HttpError(400, 'Titlen mangler.');
    const d = descriptionRow(id);
    const { changes } = db.run(`UPDATE activities SET course_description_id = ?, updated_at = datetime('now')
      WHERE course_description_id IS NULL AND lower(trim(title)) = lower(trim(?))`, [id, title]);
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

  function fileOf(it) {
    if (it.kind !== 'file') throw new HttpError(400, 'Materialet er ikke en fil.');
    const f = db.get('SELECT data FROM library_files WHERE item_id = ?', [it.id]);
    if (!f) throw new HttpError(404, 'Filen findes ikke.');
    return { filename: it.filename || it.name, contentType: it.content_type || 'application/octet-stream', data: f.data };
  }

  function downloadItem(user, id) {
    requireAdmin(user);
    return fileOf(itemRow(id));
  }

  // The materials of one course: those of its description, then its own.
  function materialsFor(activityId, { consultantsOnly = false } = {}) {
    const a = db.get('SELECT id, course_description_id FROM activities WHERE id = ?', [activityId]);
    if (!a) return { description: null, inherited: [], own: [] };
    const vis = (rows) => (consultantsOnly ? rows.filter((r) => r.visibility === 'consultants') : rows);
    const description = a.course_description_id ? db.get('SELECT id, title FROM course_descriptions WHERE id = ?', [a.course_description_id]) : null;
    return {
      description: description || null,
      inherited: description ? vis(itemsOf(description.id)) : [],
      own: vis(db.all(`SELECT ${ITEM_COLS} FROM library_items i WHERE i.activity_id = ? ORDER BY i.name COLLATE NOCASE`, [activityId]).map(itemOut)),
    };
  }

  function activityMaterials(user, activityId) {
    requireAdmin(user);
    if (!db.get('SELECT id FROM activities WHERE id = ?', [activityId])) throw new HttpError(404, 'Aktiviteten findes ikke.');
    return materialsFor(activityId);
  }

  // --- Konsulentside --------------------------------------------------------------------------

  // What a consultant may see: active descriptions, and library materials marked Konsulenter.
  function consultantLibrary() {
    const descriptions = db.all(`SELECT d.id, d.title, d.summary, d.audience, d.length_text, d.goals, d.program, t.name AS apl_type
        FROM course_descriptions d LEFT JOIN apl_types t ON t.id = d.apl_type_id WHERE d.active = 1 ORDER BY d.title COLLATE NOCASE`)
      .map((d) => ({ ...d, items: itemsOf(d.id).filter((i) => i.visibility === 'consultants') }));
    const general = db.all(`SELECT ${ITEM_COLS} FROM library_items i WHERE i.activity_id IS NULL AND i.visibility = 'consultants'
        AND NOT EXISTS (SELECT 1 FROM library_links l WHERE l.item_id = i.id) ORDER BY i.name COLLATE NOCASE`).map(itemOut);
    return { descriptions, general };
  }

  // A consultant may open a material marked Konsulenter that is in the library, or that belongs to one of their own courses.
  function consultantFile(consultantId, itemId) {
    const it = db.get(`SELECT ${ITEM_COLS}, a.consultant_id FROM library_items i LEFT JOIN activities a ON a.id = i.activity_id WHERE i.id = ?`, [itemId]);
    if (!it || it.visibility !== 'consultants' || (it.activity_id && it.consultant_id !== consultantId)) throw new HttpError(404, 'Materialet findes ikke.');
    return fileOf(it);
  }

  return { overview, createDescription, updateDescription, deleteDescription, getDescription, linkTitle,
    createItem, updateItem, deleteItem, setItemLink, downloadItem, activityMaterials, materialsFor, consultantLibrary, consultantFile };
}
