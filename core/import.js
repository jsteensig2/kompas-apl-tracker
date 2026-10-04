// Bulk import of courses from Excel or CSV.
//
// The browser reads the file (SheetJS) and sends the rows as plain JSON, keyed by the column
// headers in the file. This module maps the headers, validates every row against the reference
// lists and either returns a preview (commit = false) or inserts the valid rows (commit = true).
// The server always validates again on commit; the preview is only for the user.

// Municipalities in Greenland (or a school name such as "Flere skoler – Kujalleq").
const GL_HINT = /avannaata|kujalleq|qeqertalik|qeqqata|sermersooq|grønland|kalaallit/i;

const HEADERS = {
  date: ['dato', 'date', 'kursusdato', 'afholdt'],
  duration: ['varighed', 'duration', 'længde', 'halv hel dag'],
  type: ['type', 'apl type', 'type af apl aktivitet', 'type of apl experience', 'apl experience', 'aktivitetstype'],
  title: ['titel', 'emne', 'titel emne', 'title', 'topic', 'title topic', 'kursus', 'modul'],
  school: ['skole', 'school', 'institution'],
  municipality: ['kommune', 'municipality'],
  participants: ['deltagere', 'antal deltagere', 'participants', 'number of participants', 'antal'],
  consultant: ['konsulent', 'konsulenter', 'consultant', 'consultants', 'underviser', 'undervisere', 'instruktør'],
  reseller: ['reseller', 'partner', 'reseller partner', 'forhandler'],
  paidBy: ['betalt af', 'paid by', 'betaler', 'betaling'],
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export const FIELDS = Object.keys(HEADERS);
export const TEMPLATE_HEADERS = ['Dato', 'Varighed', 'Type', 'Titel/emne', 'Skole', 'Kommune', 'Deltagere', 'Konsulent', 'Reseller', 'Betalt af'];

// Names too vague to match inside a longer header ("Antal timer" is not participants).
const TOO_VAGUE = new Set(['antal', 'afholdt']);

function mapHeaders(sample) {
  const map = {};
  const keys = Object.keys(sample || {});
  const taken = new Set();
  // First exact names, then headers that contain a known name ("Dato for kursus", "Antal deltagere (ca.)").
  for (const loose of [false, true]) {
    for (const key of keys) {
      if (taken.has(key)) continue;
      const n = norm(key);
      if (!n) continue;
      for (const [field, names] of Object.entries(HEADERS)) {
        if (map[field]) continue;
        const hit = loose
          ? names.some((name) => name.length >= 4 && !TOO_VAGUE.has(name) && ` ${n} `.includes(` ${name} `))
          : names.includes(n);
        if (hit) { map[field] = key; taken.add(key); break; }
      }
    }
  }
  return map;
}

// A raw sheet (array of rows of cells) may have a title or blank lines above the headers.
// The header row is the first of the top 15 rows where at least two headers are recognised.
// A single-cell line above the headers ("LÆRERE") is kept as the table's heading.
export function tableToRows(table, { strict = false } = {}) {
  const lines = (Array.isArray(table) ? table : []).filter(Array.isArray);
  let headerAt = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const sample = Object.fromEntries(lines[i].map((c, j) => [String(c ?? '').trim() || `_${j}`, '']));
    if (Object.keys(mapHeaders(sample)).length >= 2) { headerAt = i; break; }
  }
  if (headerAt < 0) {
    if (strict) return { rows: [], heading: '' };
    headerAt = 0;
  }
  const heading = lines.slice(0, headerAt).map((l) => l.filter((c) => String(c ?? '').trim()))
    .filter((cells) => cells.length === 1).map((cells) => String(cells[0]).trim()).pop() || '';
  const headers = (lines[headerAt] || []).map((c, j) => String(c ?? '').trim() || `Kolonne ${j + 1}`);
  const rows = [];
  for (let i = headerAt + 1; i < lines.length; i++) {
    const cells = lines[i];
    if (!cells.some((v) => v !== '' && v != null)) continue;
    const row = { _line: i + 1 };
    headers.forEach((h, j) => { if (!(h in row)) row[h] = cells[j] ?? ''; });
    rows.push(row);
  }
  return strict ? { rows, heading } : rows;
}

// "LÆRERE" -> "Lærere"
const tidyHeading = (h) => (h === h.toUpperCase() ? h[0] + h.slice(1).toLowerCase() : h);

// Several sheets (or several tables exported from Numbers): sheets without recognisable headers
// are skipped. When the tables have different headings, the heading is added to each title
// ("Modul 1 – Lærere") so lærere and pædagoger on the same day stay separate courses.
export function sheetsToRows(sheets) {
  const parts = sheets.map((sh, k) => ({ ...tableToRows(sh?.table, { strict: true }), k }))
    .filter((p) => p.rows.length);
  const headings = new Set(parts.map((p) => p.heading).filter(Boolean));
  const useHeading = parts.length > 1 && headings.size > 1;
  return parts.flatMap((p) => p.rows.map((r) => ({
    ...r, _sheet: p.k, _group: useHeading && p.heading ? tidyHeading(p.heading) : '',
  })));
}

// Accepts 2026-02-19, 19.02.2026, 19-02-26, 19/2/2026, Excel serial numbers and ISO timestamps.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj|may', 'jun', 'jul', 'aug', 'sep', 'okt|oct', 'nov', 'dec'];
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
  }
  const s = String(v).trim().toLowerCase().replace(/^(man|tirs|ons|tors|fre|lør|søn)dag\s*(d\.|den)?\s*/, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  // 19.02.2026, 19-02-26, 19/2/2026, also with a time after it ("19.02.2026 09:00").
  m = /^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?!\d)/.exec(s);
  if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  // 19. feb 2026, 19 februar 2026, 19-feb-26
  m = /^(\d{1,2})\.?[\s-]*([a-zæøå]{3,})\.?[\s-]*(\d{4}|\d{2})(?!\d)/.exec(s);
  if (m) {
    const mo = MONTHS.findIndex((names) => names.split('|').some((n) => m[2].startsWith(n)));
    if (mo >= 0) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], mo + 1, +m[1]);
  }
  return null;
}
// Numbers and US Excel sometimes write 11/26/26 (month first). Only used when day-first is impossible.
export function parseUsDate(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/.exec(String(v ?? '').trim());
  return m ? valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]) : null;
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
 * @param body { table?: any[][], rows?: object[], reseller?: number, commit: boolean }
 *   table: the raw sheet (the header row is found automatically); rows: already keyed by header.
 *   reseller: used for rows that have no reseller of their own.
 */
export function runImport({ db, today, user }, body) {
  const input = (Array.isArray(body?.sheets) ? sheetsToRows(body.sheets)
    : Array.isArray(body?.table) ? tableToRows(body.table) : Array.isArray(body?.rows) ? body.rows : []).slice(0, 2000);
  if (!input.length) return { columns: {}, headers: [], rows: [], summary: { total: 0 }, missingColumns: [] };
  const isMeta = (h) => h === '_line' || h === '_sheet' || h === '_group';
  const headers = [...new Set(input.flatMap((r) => Object.keys(r).filter((h) => !isMeta(h))))];
  // Each sheet gets its own column match; the user can correct it: { field: header } or { field: '' } to ignore.
  const colsBySheet = new Map();
  const colsFor = (raw) => {
    const k = raw?._sheet ?? 0;
    if (!colsBySheet.has(k)) {
      const cols = mapHeaders(Object.fromEntries(Object.keys(raw || {}).filter((h) => !isMeta(h)).map((h) => [h, ''])));
      for (const [field, header] of Object.entries(body.mapping || {})) {
        if (!(field in HEADERS)) continue;
        if (header && header in raw) cols[field] = header;
        else if (header === '') delete cols[field];
      }
      colsBySheet.set(k, cols);
    }
    return colsBySheet.get(k);
  };
  const cols = colsFor(input[0]);
  const missingColumns = ['date'].filter((f) => !cols[f]);
  const defaults = body.defaults || {};
  const pickDefault = (table, id) => (id ? db.get(`SELECT id, name FROM ${table} WHERE id = ?`, [Number(id)]) : null);
  const defaultPaidBy = pickDefault('paid_by', defaults.paidBy);
  const defaultMunicipality = pickDefault('municipalities', defaults.municipality);
  const include = body.include || {};

  const consultantInitials = new Map(db.all('SELECT id, name, initials FROM consultants WHERE initials IS NOT NULL')
    .map((c) => [String(c.initials).toUpperCase(), c]));
  const lookup = (table) => new Map(db.all(`SELECT id, name FROM ${table}`).map((r) => [norm(r.name), r]));
  const lists = {
    apl_types: lookup('apl_types'), consultants: lookup('consultants'), resellers: lookup('resellers'),
    paid_by: lookup('paid_by'), municipalities: lookup('municipalities'),
  };
  // Municipalities are often written "Høje-Taastrup Kommune".
  const findMunicipality = (name) => lists.municipalities.get(norm(name)) || lists.municipalities.get(norm(name).replace(/ kommune$/, ''));
  const schools = db.all('SELECT id, name, municipality_id FROM schools');
  // "Fløng" finds "Fløng Skole"; "Borgerskolen" stays itself.
  const schoolKey = (name) => norm(name).replace(/ (skole|skolen)$/, '');
  const findSchool = (name, municipalityId) => {
    let hits = schools.filter((s) => norm(s.name) === norm(name));
    if (!hits.length) hits = schools.filter((s) => schoolKey(s.name) === schoolKey(name));
    return hits.find((s) => s.municipality_id === municipalityId) || (municipalityId ? null : hits[0]) || null;
  };
  // Same date, title, reseller, school and consultant = the same course.
  const registered = db.all(`SELECT a.date, a.title, a.reseller_id, a.school_id, a.consultant_id FROM activities a`);
  const existing = new Set(registered.map((r) => `${r.date}|${norm(r.title)}|${r.reseller_id}|${r.school_id ?? ''}|${r.consultant_id ?? ''}`));
  // Same day, school and consultant under another title: probably registered by hand already.
  const similar = new Map(registered.filter((r) => r.school_id && r.consultant_id)
    .map((r) => [`${r.date}|${r.school_id}|${r.consultant_id}`, r.title]));
  const seen = new Set();
  // Without a type in the file: Greenland courses are online, the rest are on site (Jakob, 2026-10-04).
  const typeNamed = (name) => db.get('SELECT id, name FROM apl_types WHERE lower(name) = lower(?)', [name]);
  const firstType = db.get('SELECT id, name FROM apl_types ORDER BY id LIMIT 1');
  const defaultTypeFor = (greenland) => typeNamed(greenland ? 'Workshop Online' : 'Workshop Fysisk') || firstType;
  const defaultReseller = pickDefault('resellers', defaults.reseller ?? body.reseller);
  // "Atea A/S" or "ATEA Danmark" should find Atea.
  const findReseller = (name) => {
    const n = norm(name);
    return lists.resellers.get(n) || [...lists.resellers.values()].find((r) => ` ${n} `.includes(` ${norm(r.name)} `)) || null;
  };

  const rows = input.flatMap((raw, i) => {
    const rowCols = colsFor(raw);
    const get = (f) => (rowCols[f] ? raw?.[rowCols[f]] : undefined);
    const text = (f) => String(get(f) ?? '').trim();
    const errors = [];
    const warnings = [];
    const create = {};

    let date = parseDate(get('date'));
    if (!date && parseUsDate(get('date'))) {
      date = parseUsDate(get('date'));
      warnings.push(`Datoen "${text('date')}" er skrevet med måned først og læst som ${date.split('-').reverse().join('.')}`);
    }
    if (!date) errors.push(text('date') ? `Ukendt dato "${text('date')}"` : 'Mangler dato');
    let duration = parseDuration(get('duration'));
    if (!duration) { warnings.push(`Varighed "${text('duration')}" ikke genkendt, sat til halv dag`); duration = 'half'; }

    const pick = (field, list, label) => {
      const name = text(field);
      if (!name) return null;
      const hit = list.get(norm(name));
      if (hit) return { id: hit.id, name: hit.name };
      warnings.push(`Ny ${label}: ${name}`);
      create[field] = name;
      return { id: null, name };
    };

    // The reseller decides who can see the course, so it is never guessed or created.
    const resellerName = text('reseller');
    let reseller = resellerName ? findReseller(resellerName) : defaultReseller;
    if (resellerName && !reseller && defaultReseller) {
      reseller = defaultReseller;
      warnings.push(`Reselleren "${resellerName}" findes ikke, ${defaultReseller.name} brugt`);
    } else if (resellerName && !reseller) errors.push(`Reselleren "${resellerName}" findes ikke`);
    else if (!reseller) errors.push('Mangler reseller (vælg en reseller til rækker uden reseller)');
    reseller = reseller && { id: reseller.id, name: reseller.name };

    // The type list is fixed in Administration, so an unknown type in the file is not created.
    const typeName = text('type');
    const knownType = typeName ? lists.apl_types.get(norm(typeName)) : null;
    const greenland = GL_HINT.test(`${text('municipality')} ${text('school')}`) || GL_HINT.test(defaultMunicipality?.name || '');
    const type = knownType ? { id: knownType.id, name: knownType.name } : defaultTypeFor(greenland);
    if (typeName && !knownType) warnings.push(`APL-typen "${typeName}" findes ikke, ${type?.name} brugt`);
    // "SR, KB/RT og JS": several consultants, by name or by initials.
    const consultants = [];
    for (const part of text('consultant').split(/\s*(?:[,;/&+\n]|\bog\b|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean)) {
      const hit = lists.consultants.get(norm(part)) || consultantInitials.get(part.toUpperCase().replace(/[^\p{L}]/gu, ''));
      if (hit) { if (!consultants.some((c) => c.id === hit.id)) consultants.push({ id: hit.id, name: hit.name }); continue; }
      if (/^\p{L}{1,4}\.?$/u.test(part)) { warnings.push(`Ukendte initialer "${part}" udeladt (tilføj dem under Administration › Konsulenter)`); continue; }
      warnings.push(`Ny konsulent: ${part}`);
      consultants.push({ id: null, name: part });
    }
    if (!consultants.length) warnings.push('Ingen konsulent angivet');
    const paidBy = pick('paidBy', lists.paid_by, 'betaler') || (defaultPaidBy && { id: defaultPaidBy.id, name: defaultPaidBy.name });

    const muniName = text('municipality');
    const municipality = muniName ? findMunicipality(muniName) : null;
    if (muniName && !municipality) warnings.push(`Kommunen "${muniName}" blev ikke fundet og er udeladt`);
    const schoolName = text('school');
    let school = null;
    if (schoolName) {
      school = findSchool(schoolName, municipality?.id ?? null);
      if (!school) { warnings.push(`Ny skole: ${schoolName}`); create.school = schoolName; }
    }
    const municipalityId = municipality?.id ?? school?.municipality_id ?? defaultMunicipality?.id ?? null;

    let title = text('title');
    if (!title) {
      title = type?.name || schoolName || 'APL-aktivitet';
      warnings.push(`Ingen titel, sat til "${title}"`);
    }
    if (raw?._group) title = `${title} – ${raw._group}`;

    const status = date && date > today ? 'planned' : 'held';
    const rawP = text('participants');
    let participants = 0;
    if (rawP) {
      const n = /\d+/.exec(rawP.replace(/\s/g, ''));
      if (n) {
        participants = Number(n[0]);
        if (n[0] !== rawP.replace(/\s/g, '')) warnings.push(`Deltagere "${rawP}" læst som ${participants}`);
      } else warnings.push(`Deltagere "${rawP}" ikke genkendt, sat til 0`);
    } else if (status === 'held') warnings.push('Ingen deltagere angivet, sat til 0');

    // Each consultant counts as one course, so "SR, KB" on one line becomes two courses.
    if (consultants.length > 1) warnings.push(`Delt i ${consultants.length} kurser, ét pr. konsulent`);
    return (consultants.length ? consultants : [null]).map((consultant, ci) => {
      const key = `${date}|${norm(title)}|${reseller?.id}|${school?.id ?? ''}|${consultant ? consultant.id ?? `n:${norm(consultant.name)}` : ''}`;
      const duplicate = !errors.length && Boolean(reseller?.id) && (existing.has(key) || seen.has(key));
      seen.add(key);
      const looksLike = !duplicate && school?.id && consultant?.id ? similar.get(`${date}|${school.id}|${consultant.id}`) : undefined;
      const rid = `${raw?._sheet ?? 0}:${raw?._line ?? i}:${ci}`;
      const rowWarnings = looksLike ? [`Ligner "${looksLike}", som allerede er registreret samme dag`, ...warnings] : warnings;
      return {
        rid,
        selected: include[rid] ?? !looksLike,
        similar: Boolean(looksLike),
        sheet: raw?._group || '',
        line: raw?._line ?? i + 2, // row number in the spreadsheet
        date, duration, title, status, participants,
        type: type?.name || '', consultant: consultant?.name || '', reseller: reseller?.name || '', paidBy: paidBy?.name || '',
        school: school?.name || schoolName, municipality: municipality?.name || (municipalityId ? db.get('SELECT name FROM municipalities WHERE id = ?', [municipalityId])?.name : ''),
        errors, warnings: rowWarnings, duplicate,
        _consultant: consultant,
        _ids: { type: type?.id, reseller: reseller?.id, paidBy: paidBy?.id, school: school?.id, municipality: municipalityId },
        _create: create,
      };
    });
  });

  const ok = rows.filter((r) => !r.errors.length && !r.duplicate && r.selected);
  const summary = {
    total: rows.length,
    ready: ok.length,
    held: ok.filter((r) => r.status === 'held').length,
    planned: ok.filter((r) => r.status === 'planned').length,
    errors: rows.filter((r) => r.errors.length).length,
    duplicates: rows.filter((r) => r.duplicate).length,
    warnings: ok.filter((r) => r.warnings.length).length,
    unselected: rows.filter((r) => !r.errors.length && !r.duplicate && !r.selected).length,
  };

  if (body.commit && ok.length && !missingColumns.length) {
    const created = { apl_types: {}, consultants: {}, paid_by: {}, schools: {} };
    // "Fløng" and "Fløng Skole" in the same file become one new school, under the longer name.
    const schoolNames = {};
    for (const r of ok) {
      const k = r._create.school && schoolKey(r._create.school);
      if (k && (!schoolNames[k] || r._create.school.length > schoolNames[k].length)) schoolNames[k] = r._create.school;
    }
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
        const consultantId = r._consultant ? r._consultant.id ?? ensure('consultants', r._consultant.name) : null;
        if (r._create.paidBy) ids.paidBy = ensure('paid_by', r._create.paidBy);
        if (r._create.school) {
          const sk = schoolKey(r._create.school);
          const k = `${sk}|${ids.municipality ?? ''}`;
          ids.school = created.schools[k] ||= Number(db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', [schoolNames[sk], ids.municipality]).lastInsertRowid);
        }
        db.run(`INSERT INTO activities (date, duration, apl_type_id, title, school_id, municipality_id, participants,
                  consultant_id, reseller_id, paid_by_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.date, r.duration, ids.type, r.title, ids.school ?? null, ids.municipality, r.participants,
            consultantId, ids.reseller, ids.paidBy ?? null, user.id]);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    summary.imported = ok.length;
  }

  const columns = Object.fromEntries(Object.entries(cols));
  return { columns, headers, missingColumns, summary, rows: rows.map(({ _ids, _create, _consultant, ...r }) => r) };
}
