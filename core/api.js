// Business logic and access control for Kompas APL Tracker.
//
// Every request is handled here with an authenticated `user`. Reseller users are always
// restricted to activities where activities.reseller_id = user.reseller_id. The restriction
// is added to the SQL itself, so it applies to lists, single records, dashboard numbers,
// filter options and exports alike, whatever the client sends.
//
// The same module runs in the Node server (server/index.js) and in the browser preview.

import { parseIcs, suggestFromEvent } from './ical.js';
import { runImport, TEMPLATE_HEADERS } from './import.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isAdmin = (user) => user?.role === 'admin';
// Kompas admins and read-only viewers (Apple) see every reseller's courses.
const seesAll = (user) => user?.role === 'admin' || user?.role === 'viewer';

// Today's date in Denmark. Activities on or before this date are held ("Afholdt");
// later ones are planned and form the order book ("Ordrebog").
export function todayIso() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const withStatus = (row) => row && ({ ...row, status: row.date <= todayIso() ? 'held' : 'planned' });

function requireAdmin(user) {
  if (!isAdmin(user)) throw new HttpError(403, 'Kun Kompas-administratorer kan gøre dette.');
}

const ACTIVITY_SELECT = `
  SELECT a.id, a.date, a.duration, a.title, a.participants,
         a.apl_type_id, t.name AS apl_type,
         a.school_id, s.name AS school,
         a.municipality_id, m.name AS municipality,
         a.consultant_id, c.name AS consultant,
         a.reseller_id, r.name AS reseller,
         a.paid_by_id, p.name AS paid_by
  FROM activities a
  JOIN apl_types t ON t.id = a.apl_type_id
  JOIN resellers r ON r.id = a.reseller_id
  LEFT JOIN schools s ON s.id = a.school_id
  LEFT JOIN municipalities m ON m.id = a.municipality_id
  LEFT JOIN consultants c ON c.id = a.consultant_id
  LEFT JOIN paid_by p ON p.id = a.paid_by_id`;

const int = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// Builds the WHERE clause. The reseller scope comes first and cannot be overridden.
function buildWhere(user, f = {}) {
  const where = [];
  const params = [];
  if (seesAll(user)) {
    if (int(f.reseller)) { where.push('a.reseller_id = ?'); params.push(int(f.reseller)); }
  } else if (user?.role === 'reseller' && user.reseller_id) {
    where.push('a.reseller_id = ?');
    params.push(user.reseller_id);
  } else {
    throw new HttpError(403, 'Din bruger har ikke adgang til nogen aktiviteter.');
  }
  if (f.status === 'held') { where.push('a.date <= ?'); params.push(todayIso()); }
  if (f.status === 'planned') { where.push('a.date > ?'); params.push(todayIso()); }
  if (int(f.year)) { where.push("substr(a.date, 1, 4) = ?"); params.push(String(int(f.year))); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from || '')) { where.push('a.date >= ?'); params.push(f.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to || '')) { where.push('a.date <= ?'); params.push(f.to); }
  if (int(f.municipality)) { where.push('a.municipality_id = ?'); params.push(int(f.municipality)); }
  if (int(f.consultant)) { where.push('a.consultant_id = ?'); params.push(int(f.consultant)); }
  if (int(f.type)) { where.push('a.apl_type_id = ?'); params.push(int(f.type)); }
  const q = String(f.q || '').trim();
  if (q) {
    where.push(`(a.title LIKE ? OR s.name LIKE ? OR m.name LIKE ? OR c.name LIKE ? OR c.initials LIKE ? OR p.name LIKE ? OR r.name LIKE ? OR t.name LIKE ?)`);
    params.push(...Array(8).fill(`%${q}%`));
  }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
}

// Accepts iCloud/Outlook/Google iCal links (webcal:// or https://). Plain http and local
// addresses are refused so the server cannot be pointed at internal systems.
export function normalizeCalendarUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw.replace(/^webcals?:\/\//i, 'https://')); } catch { throw new HttpError(400, 'Linket ser ikke ud som en kalenderadresse.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || host === 'localhost' || /^(\d+\.){3}\d+$/.test(host) || host.includes(':') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new HttpError(400, 'Brug et offentligt kalenderlink, der starter med webcal:// eller https://.');
  }
  return url.toString();
}

// Reference lists Kompas can manage in Administration.
const LISTS = {
  consultants: { table: 'consultants', label: 'Konsulent', usedBy: 'consultant_id' },
  schools: { table: 'schools', label: 'Skole', usedBy: 'school_id' },
  municipalities: { table: 'municipalities', label: 'Kommune', usedBy: 'municipality_id' },
  'apl-types': { table: 'apl_types', label: 'APL-type', usedBy: 'apl_type_id' },
  resellers: { table: 'resellers', label: 'Reseller', usedBy: 'reseller_id' },
  'paid-by': { table: 'paid_by', label: 'Betalt af-værdi', usedBy: 'paid_by_id' },
  users: { table: 'users', label: 'Bruger' },
};

export const EXPORT_COLUMNS = [
  ['Dato', (a) => a.date],
  ['Status', (a) => (a.status === 'planned' ? 'Planlagt' : 'Afholdt')],
  ['APL-type', (a) => a.apl_type],
  ['Titel/emne', (a) => a.title],
  ['Skole', (a) => a.school || ''],
  ['Kommune', (a) => a.municipality || ''],
  ['Deltagere', (a) => a.participants],
  ['Varighed', (a) => (a.duration === 'full' ? 'Hel dag' : 'Halv dag')],
  ['Konsulent', (a) => a.consultant || ''],
  ['Reseller', (a) => a.reseller],
  ['Betalt af', (a) => a.paid_by || ''],
];

function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Semicolon separator and BOM so Danish Excel opens the file with correct columns and letters.
  const lines = [EXPORT_COLUMNS.map(([h]) => h), ...rows.map((a) => EXPORT_COLUMNS.map(([, get]) => get(a)))];
  return '﻿' + lines.map((l) => l.map(cell).join(';')).join('\r\n');
}

/**
 * @param db   adapter with all(sql, params), get(sql, params), run(sql, params) -> { lastInsertRowid, changes }
 * @param deps { XLSX } – SheetJS, used to write .xlsx exports
 */
export function createApi(db, { XLSX } = {}) {
  const nameExists = (table, name, exceptId = 0) =>
    db.get(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE AND id <> ?`, [name, exceptId]);

  function listActivities(user, f) {
    const { sql, params } = buildWhere(user, f);
    const rows = db.all(`${ACTIVITY_SELECT}${sql} ORDER BY a.date DESC, a.id DESC`, params).map(withStatus);
    // Order book first (soonest at the top), then held courses newest first.
    return [...rows.filter((r) => r.status === 'planned').reverse(), ...rows.filter((r) => r.status === 'held')];
  }

  function getActivity(user, id) {
    const { sql, params } = buildWhere(user, {});
    const row = db.get(`${ACTIVITY_SELECT}${sql ? `${sql} AND` : ' WHERE'} a.id = ?`, [...params, id]);
    if (!row) throw new HttpError(404, 'Aktiviteten findes ikke.');
    return withStatus(row);
  }

  function dashboard(user, f) {
    const filters = { year: f.year, reseller: f.reseller };
    const { sql, params } = buildWhere(user, filters);
    const from = `FROM activities a JOIN apl_types t ON t.id = a.apl_type_id JOIN resellers r ON r.id = a.reseller_id
      LEFT JOIN schools s ON s.id = a.school_id LEFT JOIN municipalities m ON m.id = a.municipality_id
      LEFT JOIN consultants c ON c.id = a.consultant_id LEFT JOIN paid_by p ON p.id = a.paid_by_id${sql}`;
    const today = todayIso();
    const and = sql ? ' AND' : ' WHERE';
    // Key figures count held courses only; planned courses are reported as the order book.
    const kpi = db.get(`SELECT COUNT(*) AS experiences, COALESCE(SUM(a.participants), 0) AS participants,
        COALESCE(SUM(a.duration = 'half'), 0) AS half_days, COALESCE(SUM(a.duration = 'full'), 0) AS full_days ${from}${and} a.date <= ?`, [...params, today]);
    const orderbook = db.get(`SELECT COUNT(*) AS courses, COALESCE(SUM(a.participants), 0) AS participants,
        COALESCE(SUM(a.duration = 'half'), 0) AS half_days, COALESCE(SUM(a.duration = 'full'), 0) AS full_days ${from}${and} a.date > ?`, [...params, today]);
    const monthly = db.all(`SELECT substr(a.date, 1, 7) AS month, COUNT(*) AS activities,
        SUM(a.date <= ?) AS held, SUM(a.date > ?) AS planned ${from} GROUP BY month ORDER BY month`, [today, today, ...params]);
    const latest = db.all(`${ACTIVITY_SELECT}${sql}${and} a.date <= ? ORDER BY a.date DESC, a.id DESC LIMIT 6`, [...params, today]).map(withStatus);
    const upcoming = db.all(`${ACTIVITY_SELECT}${sql}${and} a.date > ? ORDER BY a.date ASC, a.id ASC LIMIT 6`, [...params, today]).map(withStatus);
    return { kpi, orderbook, monthly, latest, upcoming };
  }

  // Filter and form options. Resellers only get values that occur in their own activities.
  function options(user) {
    const scope = buildWhere(user, {});
    const years = db.all(`SELECT DISTINCT substr(a.date, 1, 4) AS year FROM activities a${scope.sql} ORDER BY year DESC`, scope.params)
      .map((r) => Number(r.year));
    if (isAdmin(user)) {
      return {
        years,
        resellers: db.all('SELECT id, name FROM resellers ORDER BY name'),
        municipalities: db.all('SELECT id, name FROM municipalities ORDER BY name'),
        consultants: db.all('SELECT id, name, initials FROM consultants ORDER BY name'),
        aplTypes: db.all('SELECT id, name FROM apl_types ORDER BY id'),
        paidBy: db.all('SELECT id, name FROM paid_by ORDER BY id'),
        schools: db.all(`SELECT s.id, s.name, s.municipality_id, m.name AS municipality
                         FROM schools s LEFT JOIN municipalities m ON m.id = s.municipality_id ORDER BY s.name`),
        titles: db.all(`SELECT title AS name, COUNT(*) AS n FROM activities GROUP BY title ORDER BY n DESC, title`).map((r) => r.name),
      };
    }
    const distinct = (idCol, table) => db.all(
      `SELECT DISTINCT x.id, x.name FROM activities a JOIN ${table} x ON x.id = a.${idCol}${scope.sql} ORDER BY x.name`, scope.params);
    return {
      years,
      resellers: seesAll(user) ? db.all('SELECT id, name FROM resellers ORDER BY name') : db.all('SELECT id, name FROM resellers WHERE id = ?', [user.reseller_id]),
      municipalities: distinct('municipality_id', 'municipalities'),
      consultants: distinct('consultant_id', 'consultants'),
      aplTypes: distinct('apl_type_id', 'apl_types'),
    };
  }

  // Validates and normalises an activity form. Creates a new school on the fly when the
  // consultant types a school name that does not exist yet.
  function activityInput(body) {
    const b = body || {};
    const errors = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) errors.push('Dato skal udfyldes.');
    if (!['half', 'full'].includes(b.duration)) errors.push('Vælg halv dag eller hel dag.');
    const title = String(b.title || '').trim();
    if (!title) errors.push('Titel / emne skal udfyldes.');
    // Participants may be left empty for planned courses (order book); stored as 0 until known.
    let participants = int(b.participants);
    if (participants === null && String(b.participants ?? '').trim() === '' && b.date > todayIso()) participants = 0;
    if (participants === null || participants < 0) errors.push('Antal deltagere skal være 0 eller mere.');
    const ref = (table, id, label, required) => {
      const v = int(id);
      if (!v) { if (required) errors.push(`${label} skal udfyldes.`); return null; }
      if (!db.get(`SELECT id FROM ${table} WHERE id = ?`, [v])) errors.push(`${label} findes ikke.`);
      return v;
    };
    const apl_type_id = ref('apl_types', b.apl_type_id, 'Type af APL-aktivitet', true);
    const reseller_id = ref('resellers', b.reseller_id, 'Reseller / partner', true);
    const municipality_id = ref('municipalities', b.municipality_id, 'Kommune', false);
    const consultant_id = ref('consultants', b.consultant_id, 'Konsulent', true);
    const paid_by_id = ref('paid_by', b.paid_by_id, 'Betalt af', false);
    let school_id = int(b.school_id);
    const schoolName = String(b.school_name || '').trim();
    if (school_id) {
      if (!db.get('SELECT id FROM schools WHERE id = ?', [school_id])) errors.push('Skolen findes ikke.');
    } else if (schoolName) {
      school_id = 'new';
    }
    if (errors.length) throw new HttpError(400, errors.join(' '));
    if (school_id === 'new') {
      const existing = db.get('SELECT id FROM schools WHERE name = ? COLLATE NOCASE AND municipality_id IS ?', [schoolName, municipality_id]);
      school_id = existing ? existing.id
        : db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', [schoolName, municipality_id]).lastInsertRowid;
    }
    return { date: b.date, duration: b.duration, apl_type_id, title, school_id: school_id || null, municipality_id,
      participants, consultant_id, reseller_id, paid_by_id };
  }

  const ACTIVITY_FIELDS = ['date', 'duration', 'apl_type_id', 'title', 'school_id', 'municipality_id',
    'participants', 'consultant_id', 'reseller_id', 'paid_by_id'];

  function createActivity(user, body) {
    requireAdmin(user);
    const a = activityInput(body);
    const { lastInsertRowid } = db.run(
      `INSERT INTO activities (${ACTIVITY_FIELDS.join(', ')}, created_by) VALUES (${ACTIVITY_FIELDS.map(() => '?').join(', ')}, ?)`,
      [...ACTIVITY_FIELDS.map((k) => a[k]), user.id]);
    const uid = String(body?.calendar_uid || '').slice(0, 300);
    if (uid) db.run('UPDATE activities SET calendar_uid = ? WHERE id = ?', [uid, lastInsertRowid]);
    return getActivity(user, Number(lastInsertRowid));
  }

  function updateActivity(user, id, body) {
    requireAdmin(user);
    getActivity(user, id);
    const a = activityInput(body);
    db.run(`UPDATE activities SET ${ACTIVITY_FIELDS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      [...ACTIVITY_FIELDS.map((k) => a[k]), id]);
    return getActivity(user, id);
  }

  // Quick edit from the lists: only the number of participants changes.
  function setParticipants(user, id, body) {
    requireAdmin(user);
    getActivity(user, id);
    const n = Number(body?.participants);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new HttpError(400, 'Deltagere skal være et helt tal, 0 eller derover.');
    db.run("UPDATE activities SET participants = ?, updated_at = datetime('now') WHERE id = ?", [n, id]);
    return getActivity(user, id);
  }

  function deleteActivity(user, id) {
    requireAdmin(user);
    getActivity(user, id);
    db.run('DELETE FROM activities WHERE id = ?', [id]);
    return { ok: true };
  }

  function exportActivities(user, f) {
    const rows = listActivities(user, f);
    const stamp = new Date().toISOString().slice(0, 10);
    const scopeName = seesAll(user) ? 'kompas' : db.get('SELECT name FROM resellers WHERE id = ?', [user.reseller_id]).name;
    const base = `apl-aktiviteter-${scopeName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}`;
    if (f.format === 'csv') {
      return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', data: toCsv(rows) };
    }
    if (!XLSX) throw new HttpError(500, 'Excel-eksport er ikke tilgængelig.');
    const aoa = [EXPORT_COLUMNS.map(([h]) => h), ...rows.map((a) => EXPORT_COLUMNS.map(([, get]) => get(a)))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Real dates in Excel
    rows.forEach((a, i) => { ws[XLSX.utils.encode_cell({ r: i + 1, c: 0 })] = { t: 'd', v: new Date(`${a.date}T00:00:00Z`), z: 'dd.mm.yyyy' }; });
    ws['!cols'] = [12, 14, 22, 24, 18, 12, 10, 20, 12, 22].map((wch) => ({ wch }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: EXPORT_COLUMNS.length - 1 } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'APL-aktiviteter');
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true });
    return { filename: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: new Uint8Array(data) };
  }

  // --- Administration of reference data -------------------------------------------------

  function adminList(user, list) {
    requireAdmin(user);
    const def = LISTS[list];
    if (!def) throw new HttpError(404, 'Ukendt liste.');
    if (list === 'users') {
      return db.all(`SELECT u.id, u.name, u.email, u.role, u.reseller_id, r.name AS reseller
                     FROM users u LEFT JOIN resellers r ON r.id = u.reseller_id ORDER BY u.role, u.name`);
    }
    if (list === 'schools') {
      return db.all(`SELECT s.id, s.name, s.municipality_id, m.name AS municipality,
                       (SELECT COUNT(*) FROM activities a WHERE a.school_id = s.id) AS used
                     FROM schools s LEFT JOIN municipalities m ON m.id = s.municipality_id ORDER BY s.name`);
    }
    if (list === 'consultants') {
      return db.all(`SELECT x.id, x.name, x.initials, (SELECT COUNT(*) FROM activities a WHERE a.consultant_id = x.id) AS used
                     FROM consultants x ORDER BY x.name`);
    }
    const order = def.table === 'apl_types' || def.table === 'paid_by' ? 'x.id' : 'x.name';
    return db.all(`SELECT x.id, x.name, (SELECT COUNT(*) FROM activities a WHERE a.${def.usedBy} = x.id) AS used
                   FROM ${def.table} x ORDER BY ${order}`);
  }

  function userInput(body, exceptId = 0) {
    const name = String(body?.name || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const role = ['admin', 'viewer'].includes(body?.role) ? body.role : 'reseller';
    const reseller_id = role === 'reseller' ? int(body?.reseller_id) : null;
    if (!name) throw new HttpError(400, 'Navn skal udfyldes.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Indtast en gyldig e-mailadresse.');
    if (role === 'reseller' && !db.get('SELECT id FROM resellers WHERE id = ?', [reseller_id])) {
      throw new HttpError(400, 'Vælg hvilken reseller brugeren hører til.');
    }
    if (db.get('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?', [email, exceptId])) {
      throw new HttpError(409, 'Der findes allerede en bruger med denne e-mail.');
    }
    return { name, email, role, reseller_id };
  }

  function adminSave(user, list, id, body) {
    requireAdmin(user);
    const def = LISTS[list];
    if (!def) throw new HttpError(404, 'Ukendt liste.');
    if (id && !db.get(`SELECT id FROM ${def.table} WHERE id = ?`, [id])) throw new HttpError(404, `${def.label} findes ikke.`);

    if (list === 'users') {
      const u = userInput(body, id || 0);
      if (id === user.id && u.role !== 'admin') throw new HttpError(400, 'Du kan ikke fjerne din egen administratoradgang.');
      if (id) db.run('UPDATE users SET name = ?, email = ?, role = ?, reseller_id = ? WHERE id = ?', [u.name, u.email, u.role, u.reseller_id, id]);
      else id = Number(db.run('INSERT INTO users (name, email, role, reseller_id) VALUES (?, ?, ?, ?)', [u.name, u.email, u.role, u.reseller_id]).lastInsertRowid);
      return { id };
    }

    const name = String(body?.name || '').trim();
    if (!name) throw new HttpError(400, 'Navn skal udfyldes.');
    if (list === 'schools') {
      const municipality_id = int(body?.municipality_id);
      if (municipality_id && !db.get('SELECT id FROM municipalities WHERE id = ?', [municipality_id])) throw new HttpError(400, 'Kommunen findes ikke.');
      if (db.get('SELECT id FROM schools WHERE name = ? COLLATE NOCASE AND municipality_id IS ? AND id <> ?', [name, municipality_id, id || 0])) {
        throw new HttpError(409, 'Skolen findes allerede i den kommune.');
      }
      if (id) db.run('UPDATE schools SET name = ?, municipality_id = ? WHERE id = ?', [name, municipality_id, id]);
      else id = Number(db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', [name, municipality_id]).lastInsertRowid);
      return { id };
    }
    if (nameExists(def.table, name, id || 0)) throw new HttpError(409, `${def.label} "${name}" findes allerede.`);
    if (list === 'consultants') {
      const initials = String(body?.initials || '').trim().toUpperCase() || null;
      if (initials && db.get('SELECT id FROM consultants WHERE upper(initials) = ? AND id <> ?', [initials, id || 0])) {
        throw new HttpError(409, `Initialerne ${initials} bruges allerede af en anden konsulent.`);
      }
      if (id) db.run('UPDATE consultants SET name = ?, initials = ? WHERE id = ?', [name, initials, id]);
      else id = Number(db.run('INSERT INTO consultants (name, initials) VALUES (?, ?)', [name, initials]).lastInsertRowid);
      return { id };
    }
    if (id) db.run(`UPDATE ${def.table} SET name = ? WHERE id = ?`, [name, id]);
    else id = Number(db.run(`INSERT INTO ${def.table} (name) VALUES (?)`, [name]).lastInsertRowid);
    return { id };
  }

  function adminDelete(user, list, id) {
    requireAdmin(user);
    const def = LISTS[list];
    if (!def) throw new HttpError(404, 'Ukendt liste.');
    if (!db.get(`SELECT id FROM ${def.table} WHERE id = ?`, [id])) throw new HttpError(404, `${def.label} findes ikke.`);
    if (list === 'users') {
      if (id === user.id) throw new HttpError(400, 'Du kan ikke slette din egen bruger.');
      db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      db.run('DELETE FROM users WHERE id = ?', [id]);
      return { ok: true };
    }
    const used = db.get(`SELECT COUNT(*) AS n FROM activities WHERE ${def.usedBy} = ?`, [id]).n;
    if (used) throw new HttpError(409, `${def.label} bruges af ${used} ${used === 1 ? 'aktivitet' : 'aktiviteter'} og kan ikke slettes. Du kan omdøbe den i stedet.`);
    if (list === 'resellers' && db.get('SELECT id FROM users WHERE reseller_id = ?', [id])) {
      throw new HttpError(409, 'Denne reseller har stadig brugere. Slet eller flyt dem først.');
    }
    if (list === 'municipalities' && db.get('SELECT id FROM schools WHERE municipality_id = ?', [id])) {
      throw new HttpError(409, 'Der er skoler knyttet til kommunen. Flyt eller slet dem først.');
    }
    db.run(`DELETE FROM ${def.table} WHERE id = ?`, [id]);
    return { ok: true };
  }

  // --- Calendar ------------------------------------------------------------------------------
  // In:  Kompas pastes the iCal link of their calendar; events become suggestions to register.
  // Out: every user gets a private subscription link (iCal feed) with the activities they may see.

  const newToken = () => {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  function calendarSettings(user) {
    let row = db.get('SELECT calendar_url, feed_token FROM users WHERE id = ?', [user.id]);
    if (!row.feed_token) {
      db.run('UPDATE users SET feed_token = ? WHERE id = ?', [newToken(), user.id]);
      row = db.get('SELECT calendar_url, feed_token FROM users WHERE id = ?', [user.id]);
    }
    return { url: isAdmin(user) ? row.calendar_url || '' : '', feedPath: `/calendar/feed/${row.feed_token}.ics` };
  }

  function saveCalendarUrl(user, body) {
    requireAdmin(user);
    const url = normalizeCalendarUrl(body?.url);
    db.run('UPDATE users SET calendar_url = ? WHERE id = ?', [url, user.id]);
    return calendarSettings(user);
  }

  function resetFeed(user) {
    db.run('UPDATE users SET feed_token = ? WHERE id = ?', [newToken(), user.id]);
    return calendarSettings(user);
  }

  function calendarEvents(user, body) {
    requireAdmin(user);
    let events;
    try { events = parseIcs(body?.ics); } catch { throw new HttpError(400, 'Kalenderfilen kunne ikke læses.'); }
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const from = iso(new Date(today.getTime() - 120 * 864e5));
    const to = iso(new Date(today.getTime() + 60 * 864e5));
    const registered = new Set(db.all('SELECT calendar_uid FROM activities WHERE calendar_uid IS NOT NULL').map((r) => r.calendar_uid));
    const ignored = new Set(db.all('SELECT uid FROM calendar_ignored WHERE user_id = ?', [user.id]).map((r) => r.uid));
    const o = options(user);
    const lists = { schools: o.schools, municipalities: o.municipalities, titles: o.titles, consultants: o.consultants };
    return events
      .filter((e) => e.date >= from && e.date <= to && !registered.has(e.uid) && !ignored.has(e.uid))
      .map((e) => {
        const s = suggestFromEvent(e, lists);
        const matched = Boolean(s.school_id || s.municipality_id || s.title !== e.title || /workshop|apl|kursus|apple/i.test(e.title));
        return { ...e, matched, suggestion: s };
      });
  }

  function ignoreEvent(user, body) {
    requireAdmin(user);
    const uid = String(body?.uid || '').slice(0, 300);
    if (!uid) throw new HttpError(400, 'Mangler kalenderaftale.');
    db.run('INSERT OR IGNORE INTO calendar_ignored (user_id, uid) VALUES (?, ?)', [user.id, uid]);
    return { ok: true };
  }

  function buildIcs(user, name, filter = {}) {
    const rows = listActivities(user, filter);
    const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
    const fold = (line) => line.match(/.{1,60}/gu)?.join('\r\n ') ?? line;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const next = (d) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kompas ApS//APL Tracker//DA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${esc(name)}`, 'X-WR-TIMEZONE:Europe/Copenhagen'];
    for (const a of rows) {
      const where = [a.school, a.municipality].filter(Boolean).join(', ');
      lines.push('BEGIN:VEVENT', `UID:apl-${a.id}@kompas-apl-tracker`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${a.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${next(a.date)}`,
        `SUMMARY:${esc(filter.consultant ? `${a.title}${a.school ? ` · ${a.school}` : ''}` : `${a.apl_type} · ${a.title}${a.school ? ` · ${a.school}` : ''}`)}`,
        `LOCATION:${esc(where)}`,
        `DESCRIPTION:${esc([`Varighed: ${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}`, `Deltagere: ${a.participants}`,
          `Konsulent: ${a.consultant || '–'}`, `Reseller: ${a.reseller}`, `Betalt af: ${a.paid_by || '–'}`].join('\n'))}`,
        'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function calendarName(user) {
    return seesAll(user) ? 'Kompas APL-aktiviteter'
      : `APL-aktiviteter · ${db.get('SELECT name FROM resellers WHERE id = ?', [user.reseller_id])?.name || ''}`;
  }

  // Each consultant has a subscription link with only their own courses (Kompas hands it out).
  function consultantFeed(user, id, reset) {
    requireAdmin(user);
    const c = db.get('SELECT id, feed_token FROM consultants WHERE id = ?', [id]);
    if (!c) throw new HttpError(404, 'Konsulenten findes ikke.');
    if (reset || !c.feed_token) db.run('UPDATE consultants SET feed_token = ? WHERE id = ?', [newToken(), id]);
    const token = db.get('SELECT feed_token FROM consultants WHERE id = ?', [id]).feed_token;
    return { feedPath: `/calendar/feed/${token}.ics`, pagePath: `/k/${token}` };
  }

  // The consultant's own page (same secret link as their calendar): held and coming courses.
  // Apple counts a workshop of 1-4 hours as one session and a full day as two.
  const GREENLAND = new Set(['avannaata', 'kujalleq', 'qeqertalik', 'qeqqata', 'sermersooq']);
  const consultantByToken = (token) => {
    const c = /^[a-f0-9]{48}$/.test(String(token)) && db.get('SELECT id, name, feed_token FROM consultants WHERE feed_token = ?', [token]);
    if (!c) throw new HttpError(404, 'Siden findes ikke. Bed Kompas om et nyt link.');
    return c;
  };

  function consultantOverview(token) {
    const c = consultantByToken(token);
    const rows = listActivities({ role: 'admin' }, { consultant: c.id }).map((a) => ({
      id: a.id, date: a.date, duration: a.duration, title: a.title, school: a.school || '', municipality: a.municipality || '',
      apl_type: a.apl_type, participants: a.participants, reseller: a.reseller, status: a.status, sessions: a.duration === 'full' ? 2 : 1,
      country: GREENLAND.has(String(a.municipality || '').toLowerCase()) ? 'Grønland' : 'Danmark',
    }));
    const held = rows.filter((a) => a.status === 'held').sort((x, y) => y.date.localeCompare(x.date));
    const planned = rows.filter((a) => a.status === 'planned').sort((x, y) => x.date.localeCompare(y.date));
    const byYear = {};
    for (const a of held) byYear[a.date.slice(0, 4)] = (byYear[a.date.slice(0, 4)] || 0) + a.sessions;
    return { name: c.name, today: todayIso(), feedPath: `/calendar/feed/${c.feed_token}.ics`, held, planned, sessionsByYear: byYear };
  }

  /** Subscription feed: authenticated by the secret token in the link, not by a login. */
  function feed(token) {
    const valid = /^[a-f0-9]{48}$/.test(String(token));
    const consultant = valid && db.get('SELECT id, name FROM consultants WHERE feed_token = ?', [token]);
    if (consultant) {
      return { filename: 'mine-kurser.ics', contentType: 'text/calendar; charset=utf-8',
        data: buildIcs({ role: 'admin' }, `Kompas-kurser · ${consultant.name}`, { consultant: consultant.id }) };
    }
    const user = valid &&
      db.get('SELECT id, name, email, role, reseller_id FROM users WHERE feed_token = ?', [token]);
    if (!user) throw new HttpError(404, 'Kalenderen findes ikke.');
    return { filename: 'apl-aktiviteter.ics', contentType: 'text/calendar; charset=utf-8', data: buildIcs(user, calendarName(user)) };
  }

  // --- Bulk import --------------------------------------------------------------------------
  function importActivities(user, body) {
    requireAdmin(user);
    return runImport({ db, today: todayIso(), user }, body);
  }

  function importTemplate() {
    if (!XLSX) throw new HttpError(500, 'Excel er ikke tilgængelig.');
    const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS,
      ['19.02.2026', 'Halv dag', 'Workshop Fysisk', 'ADS 1', 'Gåsetårnskolen', 'Vordingborg', 16, 'Kim Byrding', 'Comm2IG', 'Comm2IG'],
      ['12.11.2026', 'Hel dag', 'Workshop Fysisk', 'Mac – module 1', 'Torstorp Skole', 'Høje-Taastrup', '', 'Jakob Steensig', 'Atea', 'Høje-Taastrup Kommune']]);
    ws['!cols'] = [12, 10, 12, 18, 22, 16, 10, 18, 12, 22].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Kurser');
    return { filename: 'apl-import-skabelon.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })) };
  }

  // --- Router ------------------------------------------------------------------------------

  /** Returns { json } or { file: { filename, contentType, data } }. Throws HttpError. */
  function handle({ method, path, query = {}, body, user }) {
    if (!user) throw new HttpError(401, 'Log venligst ind.');
    const parts = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const id = int(parts[parts.length - 1]);
    const route = `${method} /${parts.map((p) => (int(p) ? ':id' : p)).join('/')}`;

    switch (route) {
      case 'GET /me': {
        const reseller = user.reseller_id ? db.get('SELECT name FROM resellers WHERE id = ?', [user.reseller_id])?.name : null;
        return { json: { id: user.id, name: user.name, email: user.email, role: user.role, reseller_id: user.reseller_id, reseller, must_change_password: Boolean(user.must_change_password) } };
      }
      case 'GET /options': return { json: options(user) };
      case 'POST /import': return { json: importActivities(user, body) };
      case 'GET /import/template': requireAdmin(user); return { file: importTemplate() };
      case 'GET /calendar': return { json: calendarSettings(user) };
      case 'PUT /calendar': return { json: saveCalendarUrl(user, body) };
      case 'POST /calendar/reset-feed': return { json: resetFeed(user) };
      case 'POST /calendar/events': return { json: calendarEvents(user, body) };
      case 'POST /calendar/ignore': return { json: ignoreEvent(user, body) };
      case 'GET /calendar/download': return { file: { filename: 'apl-aktiviteter.ics', contentType: 'text/calendar; charset=utf-8', data: buildIcs(user, calendarName(user)) } };
      case 'GET /dashboard': return { json: dashboard(user, query) };
      case 'GET /activities': return { json: listActivities(user, query) };
      case 'GET /activities/export': return { file: exportActivities(user, query) };
      case 'GET /activities/:id': return { json: getActivity(user, id) };
      case 'POST /activities': return { json: createActivity(user, body) };
      case 'PUT /activities/:id': return { json: updateActivity(user, id, body) };
      case 'PUT /activities/:id/participants': return { json: setParticipants(user, int(parts[1]), body) };
      case 'DELETE /activities/:id': return { json: deleteActivity(user, id) };
      case 'GET /admin/consultants/:id/feed': return { json: consultantFeed(user, int(parts[2]), false) };
      case 'POST /admin/consultants/:id/feed': return { json: consultantFeed(user, int(parts[2]), true) };
      case `GET /admin/${parts[1]}`: return { json: adminList(user, parts[1]) };
      case `POST /admin/${parts[1]}`: return { json: adminSave(user, parts[1], null, body) };
      case `PUT /admin/${parts[1]}/:id`: return { json: adminSave(user, parts[1], id, body) };
      case `DELETE /admin/${parts[1]}/:id`: return { json: adminDelete(user, parts[1], id) };
      default: throw new HttpError(404, 'Ikke fundet.');
    }
  }

  return { handle, feed, consultantOverview, calendarUrlFor: (user) => db.get('SELECT calendar_url FROM users WHERE id = ?', [user.id])?.calendar_url || '' };
}
