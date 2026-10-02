// Bulk import of courses from Excel or CSV.
//
// The browser reads the file (SheetJS) and sends the rows as plain JSON, keyed by the column
// headers in the file. This module maps the headers, validates every row against the reference
// lists and either returns a preview (commit = false) or inserts the valid rows (commit = true).
// The server always validates again on commit; the preview is only for the user.

const HEADERS = {
  date: ['dato', 'date', 'kursusdato', 'afholdt', 'dag'],
  duration: ['varighed', 'duration', 'længde', 'halv hel dag'],
  type: ['type', 'apl type', 'type af apl aktivitet', 'type of apl experience', 'apl experience', 'aktivitetstype'],
  title: ['titel', 'emne', 'titel emne', 'title', 'topic', 'title topic', 'kursus', 'modul'],
  school: ['skole', 'school', 'institution'],
  municipality: ['kommune', 'municipality'],
  participants: ['deltagere', 'antal deltagere', 'participants', 'number of participants', 'antal'],
  consultant: ['konsulent', 'consultant', 'underviser', 'instruktør'],
  reseller: ['reseller', 'partner', 'reseller partner', 'forhandler'],
  paidBy: ['betalt af', 'paid by', 'betaler', 'betaling'],
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export const TEMPLATE_HEADERS = ['Dato', 'Varighed', 'Type', 'Titel/emne', 'Skole', 'Kommune', 'Deltagere', 'Konsulent', 'Reseller', 'Betalt af'];

function mapHeaders(sample) {
  const map = {};
  for (const key of Object.keys(sample || {})) {
    const n = norm(key).replace(/^kommune$/, 'kommune');
    for (const [field, names] of Object.entries(HEADERS)) {
      if (!map[field] && names.includes(n)) map[field] = key;
    }
  }
  return map;
}

// Accepts 2026-02-19, 19.02.2026, 19-02-26, 19/2/2026, Excel serial numbers and ISO timestamps.
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s);
  if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  return null;
}
function valid(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

export function parseDuration(v) {
  const n = norm(v);
  if (!n) return 'half';
  if (/^(half|halv|½|0 5|4)|half day|halv dag/.test(n)) return 'half';
  if (/^(full|hel|1|8)|full day|hel dag|heldag/.test(n)) return 'full';
  return null;
}

/**
 * @param ctx { db, today, user }
 * @param body { rows: object[], commit: boolean }
 */
export function runImport({ db, today, user }, body) {
  const input = Array.isArray(body?.rows) ? body.rows.slice(0, 2000) : [];
  if (!input.length) return { columns: {}, rows: [], summary: { total: 0 }, missingColumns: [] };
  const cols = mapHeaders(input.find((r) => r && Object.keys(r).length > 2) || input[0]);
  const missingColumns = ['date', 'title', 'reseller'].filter((f) => !cols[f]);

  const lookup = (table) => new Map(db.all(`SELECT id, name FROM ${table}`).map((r) => [norm(r.name), r]));
  const lists = {
    apl_types: lookup('apl_types'), consultants: lookup('consultants'), resellers: lookup('resellers'),
    paid_by: lookup('paid_by'), municipalities: lookup('municipalities'),
  };
  // Municipalities are often written "Høje-Taastrup Kommune".
  const findMunicipality = (name) => lists.municipalities.get(norm(name)) || lists.municipalities.get(norm(name).replace(/ kommune$/, ''));
  const schools = db.all('SELECT id, name, municipality_id FROM schools');
  const findSchool = (name, municipalityId) => {
    const hits = schools.filter((s) => norm(s.name) === norm(name));
    return hits.find((s) => s.municipality_id === municipalityId) || (municipalityId ? null : hits[0]) || null;
  };
  const existing = new Set(db.all(`SELECT a.date, a.title, a.reseller_id, a.school_id FROM activities a`)
    .map((r) => `${r.date}|${norm(r.title)}|${r.reseller_id}|${r.school_id ?? ''}`));
  const seen = new Set();
  const defaultType = db.get('SELECT id, name FROM apl_types ORDER BY id LIMIT 1');

  const rows = input.map((raw, i) => {
    const get = (f) => (cols[f] ? raw?.[cols[f]] : undefined);
    const text = (f) => String(get(f) ?? '').trim();
    const errors = [];
    const warnings = [];
    const create = {};

    const date = parseDate(get('date'));
    if (!date) errors.push(get('date') ? `Ukendt dato "${text('date')}"` : 'Mangler dato');
    const duration = parseDuration(get('duration'));
    if (!duration) errors.push(`Ukendt varighed "${text('duration')}"`);
    const title = text('title');
    if (!title) errors.push('Mangler titel/emne');

    const pick = (field, list, label, { required = false, creatable = true } = {}) => {
      const name = text(field);
      if (!name) { if (required) errors.push(`Mangler ${label}`); return null; }
      const hit = list.get(norm(name));
      if (hit) return { id: hit.id, name: hit.name };
      if (!creatable) { errors.push(`${label[0].toUpperCase()}${label.slice(1)} "${name}" findes ikke`); return null; }
      warnings.push(`Ny ${label}: ${name}`);
      create[field] = name;
      return { id: null, name };
    };
    const reseller = pick('reseller', lists.resellers, 'reseller', { required: true, creatable: false });
    const typeName = text('type');
    const type = typeName ? pick('type', lists.apl_types, 'APL-type') : defaultType;
    const consultant = pick('consultant', lists.consultants, 'konsulent');
    const paidBy = pick('paidBy', lists.paid_by, 'betaler');

    const muniName = text('municipality');
    const municipality = muniName ? findMunicipality(muniName) : null;
    if (muniName && !municipality) errors.push(`Kommunen "${muniName}" findes ikke`);
    const schoolName = text('school');
    let school = null;
    if (schoolName) {
      school = findSchool(schoolName, municipality?.id ?? null);
      if (!school) { warnings.push(`Ny skole: ${schoolName}`); create.school = schoolName; }
    }
    const municipalityId = municipality?.id ?? school?.municipality_id ?? null;

    const status = date && date > today ? 'planned' : 'held';
    const rawP = get('participants');
    let participants = rawP === '' || rawP == null ? null : Number(String(rawP).replace(/\s/g, '').replace(',', '.'));
    if (participants !== null && (!Number.isInteger(participants) || participants < 0)) {
      errors.push(`Ugyldigt antal deltagere "${text('participants')}"`);
      participants = null;
    }
    if (participants === null && status === 'held' && !errors.length) errors.push('Mangler antal deltagere');

    const key = `${date}|${norm(title)}|${reseller?.id}|${school?.id ?? ''}`;
    let duplicate = false;
    if (!errors.length && reseller?.id && (existing.has(key) || seen.has(key))) duplicate = true;
    seen.add(key);

    return {
      line: i + 2, // row number in the spreadsheet (header is row 1)
      date, duration, title, status, participants: participants ?? 0,
      type: type?.name || '', consultant: consultant?.name || '', reseller: reseller?.name || '', paidBy: paidBy?.name || '',
      school: school?.name || schoolName, municipality: municipality?.name || (municipalityId ? db.get('SELECT name FROM municipalities WHERE id = ?', [municipalityId])?.name : ''),
      errors, warnings, duplicate,
      _ids: { type: type?.id, consultant: consultant?.id, reseller: reseller?.id, paidBy: paidBy?.id, school: school?.id, municipality: municipalityId },
      _create: create,
    };
  });

  const ok = rows.filter((r) => !r.errors.length && !r.duplicate);
  const summary = {
    total: rows.length,
    ready: ok.length,
    held: ok.filter((r) => r.status === 'held').length,
    planned: ok.filter((r) => r.status === 'planned').length,
    errors: rows.filter((r) => r.errors.length).length,
    duplicates: rows.filter((r) => r.duplicate).length,
    warnings: ok.filter((r) => r.warnings.length).length,
  };

  if (body.commit && ok.length && !missingColumns.length) {
    const created = { apl_types: {}, consultants: {}, paid_by: {}, schools: {} };
    const ensure = (table, name) => {
      const k = norm(name);
      if (created[table][k]) return created[table][k];
      const id = Number(db.run(`INSERT INTO ${table} (name) VALUES (?)`, [name]).lastInsertRowid);
      created[table][k] = id;
      return id;
    };
    db.exec('BEGIN');
    try {
      for (const r of ok) {
        const ids = { ...r._ids };
        if (r._create.type) ids.type = ensure('apl_types', r._create.type);
        if (r._create.consultant) ids.consultant = ensure('consultants', r._create.consultant);
        if (r._create.paidBy) ids.paidBy = ensure('paid_by', r._create.paidBy);
        if (r._create.school) {
          const k = `${norm(r._create.school)}|${ids.municipality ?? ''}`;
          ids.school = created.schools[k] ||= Number(db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', [r._create.school, ids.municipality]).lastInsertRowid);
        }
        db.run(`INSERT INTO activities (date, duration, apl_type_id, title, school_id, municipality_id, participants,
                  consultant_id, reseller_id, paid_by_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.date, r.duration, ids.type, r.title, ids.school ?? null, ids.municipality, r.participants,
            ids.consultant ?? null, ids.reseller, ids.paidBy ?? null, user.id]);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    summary.imported = ok.length;
  }

  const columns = Object.fromEntries(Object.entries(cols));
  return { columns, missingColumns, summary, rows: rows.map(({ _ids, _create, ...r }) => r) };
}
