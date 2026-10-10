// Business logic and access control for Kompas APL Tracker.
//
// Every request is handled here with an authenticated `user`. Reseller users are always
// restricted to activities where activities.reseller_id = user.reseller_id. The restriction
// is added to the SQL itself, so it applies to lists, single records, dashboard numbers,
// filter options and exports alike, whatever the client sends.
//
// The same module runs in the Node server (server/index.js) and in the browser preview.

import { parseIcs, suggestFromEvent } from './ical.js';
import { runImport, TEMPLATE_HEADERS, parseClock } from './import.js';

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
// A course awaiting final approval from the school or municipality ("Foreløbig") is never
// counted as held; it stays in the order book, marked as pending, until Kompas confirms it.
const withStatus = (row) => row && ({ ...row, pending: row.pending ? 1 : 0,
  status: row.date <= todayIso() && !row.pending ? 'held' : 'planned' });
// SQL counterparts of withStatus (the date is bound as a parameter).
const HELD_SQL = '(a.date <= ? AND a.pending = 0)';
const PLANNED_SQL = '(a.date > ? OR a.pending = 1)';

function requireAdmin(user) {
  if (!isAdmin(user)) throw new HttpError(403, 'Kun Kompas-administratorer kan gøre dette.');
}

const ACTIVITY_SELECT = `
  SELECT a.id, a.date, a.start_time, a.end_time, a.duration, a.title, a.participants, a.pending, a.reschedule, a.consultants_needed,
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

// Dobbeltbooking: two courses the same day clash, unless both have a start and an end time
// and the times do not overlap (09:00–12:00 and 12:30–15:00 is fine).
const timed = (x) => Boolean(x.start_time && x.end_time);
export const clash = (x, y) => !(timed(x) && timed(y)) || (x.start_time < y.end_time && y.start_time < x.end_time);
// "09:00–12:00", "kl. 09:00" or "".
export const timeText = (a) => (a.start_time ? (a.end_time ? `${a.start_time}–${a.end_time}` : `kl. ${a.start_time}`) : '');

const truthy = (v) => v === true || v === 1 || /^(1|true|on|ja|yes)$/i.test(String(v ?? '').trim());

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
  if (f.status === 'held') { where.push(HELD_SQL); params.push(todayIso()); }
  if (f.status === 'planned') { where.push(PLANNED_SQL); params.push(todayIso()); }
  if (f.status === 'pending') where.push('a.pending = 1');
  if (truthy(f.reschedule)) where.push('a.reschedule = 1'); // ★ Skal have ny dato
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
  ['Starttid', (a) => a.start_time || ''],
  ['Sluttid', (a) => a.end_time || ''],
  ['Status', (a) => (a.pending ? 'Foreløbig' : a.status === 'planned' ? 'Planlagt' : 'Afholdt')],
  ['Skal have ny dato', (a) => (a.reschedule ? 'Ja' : '')],
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

// APL Engagement Checkout (Apple's form for specialists), field by field in the form's own order
// (from Jakob's screenshots, 2026-10-03, and the six pages he saved, 2026-10-10). Each field is
// [page, label, value, hint, answer-mapping]; an empty value
// is something only the consultant knows, so it is left for them to fill in.
const GREENLAND = new Set(['avannaata', 'kujalleq', 'qeqertalik', 'qeqqata', 'sermersooq']);
const dmy = (d) => d.split('-').reverse().join('/'); // Apple asks for dd/mm/åååå
export function appleFields(a) {
  const several = /flere skoler/i.test(a.school || '');
  const online = /online|webinar|zoom|teams/i.test(`${a.apl_type} ${a.title}`);
  const greenland = GREENLAND.has(String(a.municipality || '').toLowerCase());
  const district = !a.municipality ? '' : greenland || /kommune/i.test(a.municipality) ? a.municipality : `${a.municipality} Kommune`;
  const partner = /atea/i.test(a.reseller || '') ? ['ATEA Denmark', '9'] : /comm2ig/i.test(a.reseller || '') ? ['Comm2IG', '10'] : null;
  const participants = a.participants ? String(a.participants) : '';
  // The fifth element says how the answer goes into Apple's form (Qualtrics question id, and the
  // sub-field or choice id), read from the form's pages that Jakob saved on 2026-10-10.
  return [
    ['Side 1', 'Vælg dit område', 'EMEIA (Europa, Mellemøsten, Indien og Afrika)', '', ['QID41', null, '8']],
    ['Side 2', 'Navn på specialist (for- og efternavn)', a.consultant || '', '', ['QID1']],
    ['Side 2', 'E-mailadresse til specialist', a.consultant_email || '', 'Skriv konsulentens e-mail under Administration › Konsulenter', ['QID2']],
    ['Side 2', 'Leveringsland', greenland ? 'Grønland' : 'Danmark', '', ['QID121', null, greenland ? '28' : '7']],
    ['Side 3', 'Skolens navn', several ? '' : a.school || '', several ? 'Flere skoler: skriv kundens navn' : '', ['QID99', '4']],
    ['Side 3', 'System/distrikt/ministeriums navn', district, '', ['QID99', '5']],
    ['Side 3', 'Postnummer', a.postal_code || '', 'Skriv skolens postnummer under Administration › Skoler', ['QID99', '6']],
    ['Side 3', 'Hvor mange individuelle uddannelsesinstitutioner deltog i sessionerne?', several ? '' : '1', several ? 'Antal skoler' : '', ['QID100']],
    ['Side 3', 'Projekttype/Niveau for deltagende uddannelsesinstitutioner', '', 'Fx Indskoling, Mellemtrin, Udskoling eller Alle skolealdre'],
    ['Side 3', 'Implementeringsstadie', '', 'Introduktion, Integration eller Innovation'],
    ['Side 3', 'Hvem var sessionen tilpasset til?', 'Undervisere', '', ['QID103', null, ['2']]],
    ['Side 3', 'Antal deltagere', participants, participants ? '' : 'Antal deltagere mangler i trackeren', ['QID104']],
    // Apple's choices are 1-5 dage and Virtuelt / På side (on site) / Hybrid; a course is one day.
    ['Side 4', 'Hvad var varigheden af din session?', '1 dag', 'Halv og hel dag er begge 1 dag. Vælg flere dage, hvis sessionen strakte sig over flere', ['QID141', null, '4']],
    ['Side 4', 'Leveringstilstand', online ? 'Virtuelt' : 'På side', 'Vælg Hybrid, hvis nogle deltog virtuelt', ['QID142', null, online ? '1' : '2']],
    ['Side 4', 'Startdato', dmy(a.date), '', ['QID87', '1']],
    ['Side 4', 'Slutdato', dmy(a.date), '', ['QID87', '2']],
    ['Side 4', 'Blev denne session afholdt …', '', 'Enkeltstående supportsession, del af en serie eller del af en længerevarende supportplan'],
    ['Side 4', 'Hvem arrangerede APL-sessionen med dig?', partner ? 'Apple Authorised Education Specialist (AAES)' : '', partner ? '' : 'Apple, AAES, uddannelsesinstitution eller andet', partner && ['QID108', null, '1']],
    ['Side 5', 'Vælg navnet (Channel Partner)', partner ? partner[0] : '', partner ? '' : 'Kun hvis en partner arrangerede sessionen', partner && ['QID137', null, partner[1]]],
    ['Side 6', 'Was this institution an Apple Distinguished School?', 'No', 'Vælg Yes, hvis skolen er en Apple Distinguished School', ['QID153', null, '2']],
    ['Side 6', 'Did you use any resource(s) from the APLS Experiences Catalog?', 'No', 'Vælg Yes, hvis du brugte materiale fra kataloget', ['QID156', null, '2']],
  ];
}

// Postal code for a school from OpenStreetMap (Nominatim), searched by name and municipality.
// Returns a four-digit Danish postal code or null. Nominatim allows one request a second.
export async function nominatimPostal(name, municipality, fetchFn = fetch) {
  const muni = !municipality ? '' : /kommune/i.test(municipality) ? municipality : `${municipality} Kommune`;
  const q = [name, muni, 'Danmark'].filter(Boolean).join(', ');
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', countrycodes: 'dk,gl', limit: '5' })}`;
  const r = await fetchFn(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'kompas-apl-tracker (https://kompas-apl-tracker.onrender.com)', 'accept-language': 'da' } });
  if (!r.ok) throw new Error(String(r.status));
  const hits = await r.json();
  const hit = hits.find((h) => h.category === 'amenity' || h.class === 'amenity') || hits[0];
  const code = String(hit?.address?.postcode || '').trim();
  return /^\d{4}$/.test(code) ? code : null;
}

// One link per course that opens Apple's form (in Danish) with every known answer already filled in,
// using Qualtrics' Q_PopulateResponse. The consultant checks it, adds the rest and submits it themselves.
const APPLE_FORM = 'https://essentials.applesurveys.com/jfe/form/SV_7UiJTisrllOFbsG';
export function appleFormLink(fields) {
  const answers = {};
  for (const [, , value, , q] of fields) {
    if (!value || !q) continue;
    const [qid, sub, choice] = q;
    if (sub) (answers[qid] ||= {})[sub] = value;
    else answers[qid] = choice || value;
  }
  return `${APPLE_FORM}?${new URLSearchParams({ Q_Language: 'DA', Q_PopulateResponse: JSON.stringify(answers) })}`;
}

// The specialist's personal link to Apple's Engagement Checkout fills in their name and e-mail
// (format from Jakob, 2026-10-10). Without an e-mail there is no personal link.
export function appleCheckoutLink(name, email) {
  if (!name || !email) return null;
  return `https://apple.co/apls-checkout?${new URLSearchParams({ specialist: name, apple_email: email })}`;
}

// Short column headings for the spreadsheet, in the same order as appleFields.
const APPLE_HEADINGS = ['Område', 'Navn på specialist', 'E-mail til specialist', 'Leveringsland', 'Skolens navn',
  'System/distrikt (kommune)', 'Postnummer', 'Antal institutioner', 'Projekttype/niveau', 'Implementeringsstadie',
  'Målgruppe', 'Antal deltagere', 'Varighed', 'Leveringstilstand', 'Startdato', 'Slutdato', 'Sessionskontekst',
  'Hvem arrangerede', 'Partner', 'Apple Distinguished School?', 'APLS Experiences Catalog?'];

const TZID = 'Europe/Copenhagen';
const VTIMEZONE = ['BEGIN:VTIMEZONE', `TZID:${TZID}`,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE'];

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

  // Noter are for Kompas and the consultants only, so resellers and viewers never get the count.
  function withNoteCounts(user, rows) {
    if (!isAdmin(user) || !rows.length) return rows;
    const counts = new Map(db.all('SELECT activity_id, COUNT(*) AS n FROM course_notes GROUP BY activity_id').map((r) => [r.activity_id, r.n]));
    return rows.map((r) => ({ ...r, notes: counts.get(r.id) || 0 }));
  }

  // Dobbeltbooking: a consultant on more than one course the same day. Only Kompas is warned;
  // it never blocks saving, as two half days the same day can be fine.
  // Courses that share a consultant and a day with another course, and the ids of those they clash with.
  const SAME_DAY = `a.consultant_id IS NOT NULL AND EXISTS (SELECT 1 FROM activities b
      WHERE b.consultant_id = a.consultant_id AND b.date = a.date AND b.id <> a.id)`;
  function clashesOf(rows) {
    const byDay = new Map();
    for (const r of rows) byDay.set(`${r.consultant_id}|${r.date}`, [...(byDay.get(`${r.consultant_id}|${r.date}`) || []), r]);
    const out = new Map();
    for (const list of byDay.values()) {
      for (const r of list) {
        const others = list.filter((o) => o.id !== r.id && clash(r, o)).map((o) => o.id);
        if (others.length) out.set(r.id, others);
      }
    }
    return out;
  }

  function withDoubleBookings(user, rows) {
    if (!isAdmin(user) || !rows.length) return rows;
    const clashes = clashesOf(db.all(`SELECT a.id, a.consultant_id, a.date, a.start_time, a.end_time FROM activities a WHERE ${SAME_DAY}`));
    return rows.map((r) => ({ ...r, double_booked: clashes.get(r.id)?.length || 0 }));
  }

  // Other courses the given consultants already have on a date at a clashing time (for the warning in the form).
  function sameDayCourses(user, f) {
    requireAdmin(user);
    const date = String(f.date || '');
    const ids = String(f.consultants || '').split(',').map(int).filter(Boolean);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !ids.length) return [];
    const mine = { start_time: parseClock(f.start), end_time: parseClock(f.start) && parseClock(f.end) };
    return db.all(`${ACTIVITY_SELECT} WHERE a.date = ? AND a.consultant_id IN (${ids.map(() => '?').join(', ')}) AND a.id <> ?
        ORDER BY c.name, a.start_time, a.id`, [date, ...ids, int(f.exclude) || 0]).filter((r) => clash(mine, r)).map(withStatus);
  }

  // Upcoming days where a consultant has courses at clashing times, across all resellers.
  function upcomingDoubleBookings() {
    const all = db.all(`${ACTIVITY_SELECT} WHERE a.date >= ? AND ${SAME_DAY} ORDER BY a.date, c.name, a.start_time, a.id`, [todayIso()]);
    const clashes = clashesOf(all);
    const rows = all.filter((r) => clashes.has(r.id)).map(withStatus);
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.date}|${r.consultant_id}`;
      if (!groups.has(key)) groups.set(key, { date: r.date, consultant_id: r.consultant_id, consultant: r.consultant, courses: [] });
      groups.get(key).courses.push(r);
    }
    return [...groups.values()];
  }

  // Konsulentoverblik: held courses in the chosen year, and every coming course split into
  // Planlagt and Foreløbig, per consultant, so Kompas can see whether the work is shared fairly.
  function consultantLoad(from, and, params, ob, obAnd, today) {
    const held = new Map(db.all(`SELECT a.consultant_id AS id, COUNT(*) AS held,
        SUM(CASE a.duration WHEN 'full' THEN 2 ELSE 1 END) AS workshops ${from}${and} ${HELD_SQL} AND a.consultant_id IS NOT NULL
        GROUP BY a.consultant_id`, [...params, today]).map((r) => [r.id, r]));
    const coming = db.all(`SELECT a.consultant_id AS id, SUM(a.pending = 0) AS planned, SUM(a.pending) AS pending, MIN(a.date) AS next
        FROM activities a${ob.sql}${obAnd} ${PLANNED_SQL} GROUP BY a.consultant_id`, [...ob.params, today]);
    const byId = new Map(coming.filter((r) => r.id).map((r) => [r.id, r]));
    const unassigned = coming.find((r) => !r.id);
    const rows = db.all('SELECT id, name, initials FROM consultants ORDER BY name').map((c) => ({ ...c,
      held: held.get(c.id)?.held || 0, workshops: held.get(c.id)?.workshops || 0,
      planned: byId.get(c.id)?.planned || 0, pending: byId.get(c.id)?.pending || 0, next: byId.get(c.id)?.next || null }));
    return { rows, unassigned: unassigned ? (unassigned.planned || 0) + (unassigned.pending || 0) : 0 };
  }

  function listActivities(user, f) {
    const { sql, params } = buildWhere(user, f);
    const rows = withDoubleBookings(user, withNoteCounts(user, db.all(`${ACTIVITY_SELECT}${sql} ORDER BY a.date DESC, a.start_time DESC, a.id DESC`, params).map(withStatus)));
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
        COALESCE(SUM(a.duration = 'half'), 0) AS half_days, COALESCE(SUM(a.duration = 'full'), 0) AS full_days ${from}${and} ${HELD_SQL}`, [...params, today]);
    // Kommende kurser always covers every coming course, also those in a later year than the one chosen.
    const ob = buildWhere(user, { reseller: f.reseller });
    const obAnd = ob.sql ? ' AND' : ' WHERE';
    const orderbook = db.get(`SELECT COUNT(*) AS courses, COALESCE(SUM(a.participants), 0) AS participants,
        COALESCE(SUM(a.duration = 'half'), 0) AS half_days, COALESCE(SUM(a.duration = 'full'), 0) AS full_days,
        COALESCE(SUM(a.pending), 0) AS pending FROM activities a${ob.sql}${obAnd} ${PLANNED_SQL}`, [...ob.params, today]);
    const monthly = db.all(`SELECT substr(a.date, 1, 7) AS month, COUNT(*) AS activities,
        SUM(${HELD_SQL}) AS held, SUM(${PLANNED_SQL}) AS planned, SUM(a.pending) AS pending ${from} GROUP BY month ORDER BY month`, [today, today, ...params]);
    const latest = db.all(`${ACTIVITY_SELECT}${sql}${and} ${HELD_SQL} ORDER BY a.date DESC, a.start_time DESC, a.id DESC LIMIT 6`, [...params, today]).map(withStatus);
    const upcoming = db.all(`${ACTIVITY_SELECT}${ob.sql}${obAnd} ${PLANNED_SQL} ORDER BY a.date ASC, a.start_time ASC, a.id ASC LIMIT 6`, [...ob.params, today]).map(withStatus);
    const result = { kpi, orderbook, monthly, latest: withNoteCounts(user, latest), upcoming: withDoubleBookings(user, withNoteCounts(user, upcoming)) };
    if (isAdmin(user)) {
      result.consultants = consultantLoad(from, and, params, ob, obAnd, today);
      result.doubleBookings = upcomingDoubleBookings();
    }
    return result;
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
    if (participants === null && String(b.participants ?? '').trim() === '' && (b.date > todayIso() || truthy(b.pending))) participants = 0;
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
    // A Foreløbig course may be created without a consultant, so it opens for sign-up (Jakob, 2026-10-07).
    const consultant_id = ref('consultants', b.consultant_id, 'Konsulent', !truthy(b.pending));
    const paid_by_id = ref('paid_by', b.paid_by_id, 'Betalt af', false);
    let school_id = int(b.school_id);
    const schoolName = String(b.school_name || '').trim();
    if (school_id) {
      if (!db.get('SELECT id FROM schools WHERE id = ?', [school_id])) errors.push('Skolen findes ikke.');
    } else if (schoolName) {
      school_id = 'new';
    }
    // Optional times on a 24-hour clock; an end time needs a start time.
    const clock = (v, label) => {
      if (String(v ?? '').trim() === '') return null;
      const t = parseClock(String(v));
      if (!t) errors.push(`${label} skal skrives som tt:mm med 24-timers ur, fx 09:00 eller 15:30.`);
      return t;
    };
    const start_time = clock(b.start_time, 'Starttidspunktet');
    const end_time = clock(b.end_time, 'Sluttidspunktet');
    if (end_time && !start_time && String(b.start_time ?? '').trim() === '') errors.push('Skriv også et starttidspunkt, når der er et sluttidspunkt.');
    if (start_time && end_time && end_time <= start_time) errors.push('Sluttidspunktet skal være efter starttidspunktet.');
    const needed = neededInput(b.consultants_needed);
    if (needed === undefined) errors.push(NEEDED_ERROR);
    if (errors.length) throw new HttpError(400, errors.join(' '));
    if (school_id === 'new') {
      const existing = db.get('SELECT id FROM schools WHERE name = ? COLLATE NOCASE AND municipality_id IS ?', [schoolName, municipality_id]);
      school_id = existing ? existing.id
        : db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', [schoolName, municipality_id]).lastInsertRowid;
    }
    return { date: b.date, start_time, end_time, duration: b.duration, apl_type_id, title, school_id: school_id || null, municipality_id,
      participants, consultant_id, reseller_id, paid_by_id, pending: truthy(b.pending) ? 1 : 0,
      reschedule: truthy(b.reschedule) ? 1 : 0, needed };
  }

  // Consultants needed (Tilmelding): empty = not set, otherwise a whole number 1–50; undefined = invalid.
  const NEEDED_ERROR = 'Antal konsulenter skal være et helt tal fra 1 til 50.';
  function neededInput(v) {
    const raw = String(v ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 50 ? n : undefined;
  }

  const ACTIVITY_FIELDS = ['date', 'start_time', 'end_time', 'duration', 'apl_type_id', 'title', 'school_id', 'municipality_id',
    'participants', 'consultant_id', 'reseller_id', 'paid_by_id', 'pending', 'reschedule'];

  function createActivity(user, body) {
    requireAdmin(user);
    const a = activityInput(body);
    const { lastInsertRowid } = db.run(
      `INSERT INTO activities (${ACTIVITY_FIELDS.join(', ')}, created_by) VALUES (${ACTIVITY_FIELDS.map(() => '?').join(', ')}, ?)`,
      [...ACTIVITY_FIELDS.map((k) => a[k]), user.id]);
    const uid = String(body?.calendar_uid || '').slice(0, 300);
    if (uid) db.run('UPDATE activities SET calendar_uid = ? WHERE id = ?', [uid, lastInsertRowid]);
    if (a.pending && a.needed) db.run('UPDATE activities SET consultants_needed = ? WHERE id = ?', [a.needed, lastInsertRowid]);
    return getActivity(user, Number(lastInsertRowid));
  }

  function updateActivity(user, id, body) {
    requireAdmin(user);
    getActivity(user, id);
    const a = activityInput(body);
    db.run(`UPDATE activities SET ${ACTIVITY_FIELDS.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      [...ACTIVITY_FIELDS.map((k) => a[k]), id]);
    // The form only sends the number needed for Foreløbig courses; otherwise it is left as it was.
    if (body && 'consultants_needed' in body && a.pending) db.run('UPDATE activities SET consultants_needed = ? WHERE id = ?', [a.needed, id]);
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

  // Quick toggle from the lists: mark a course as awaiting approval, or as approved.
  function setPending(user, id, body) {
    requireAdmin(user);
    getActivity(user, id);
    db.run("UPDATE activities SET pending = ?, updated_at = datetime('now') WHERE id = ?", [truthy(body?.pending) ? 1 : 0, id]);
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
    ws['!cols'] = [12, 8, 8, 14, 22, 24, 18, 12, 10, 20, 12, 22].map((wch) => ({ wch }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: EXPORT_COLUMNS.length - 1 } }) };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'APL-aktiviteter');
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true });
    return { filename: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: new Uint8Array(data) };
  }

  // --- Til Apple ---------------------------------------------------------------------------
  // Held courses with the fields of Apple's APL Engagement Checkout, so consultants (or Kompas on their
  // behalf) can copy them from a spreadsheet or a printout. Foreløbig and coming courses are never included.
  function appleCourses(user, f) {
    requireAdmin(user);
    return appleRows(f);
  }

  function appleRows(f) {
    const rows = listActivities({ role: 'admin' }, { ...f, status: 'held' });
    const extra = new Map(db.all(`SELECT a.id, a.apple_reported_at, c.email AS consultant_email, s.postal_code
        FROM activities a LEFT JOIN consultants c ON c.id = a.consultant_id LEFT JOIN schools s ON s.id = a.school_id
        WHERE ${HELD_SQL}`, [todayIso()]).map((x) => [x.id, x]));
    return rows.map((a) => ({ ...a, ...extra.get(a.id) }))
      .filter((a) => (f.sent === 'no' ? !a.apple_reported_at : f.sent === 'yes' ? Boolean(a.apple_reported_at) : true))
      .sort((x, y) => (x.consultant || '').localeCompare(y.consultant || '', 'da') || x.date.localeCompare(y.date))
      .map((a) => {
        const fields = appleFields(a);
        return { id: a.id, date: a.date, title: a.title, school: a.school || '', consultant: a.consultant || '', reseller: a.reseller,
          apple_reported_at: a.apple_reported_at || null, fields: fields.map((x) => x.slice(0, 4)), formLink: appleFormLink(fields) };
      });
  }

  function exportApple(user, f) {
    const rows = appleCourses(user, f);
    const consultant = int(f.consultant) && db.get('SELECT name FROM consultants WHERE id = ?', [int(f.consultant)])?.name;
    return appleFile(rows, consultant || 'alle', f.format);
  }

  // The consultant's own held courses for Apple, newest first, from their private page.
  function consultantAppleExport(token, format) {
    const c = consultantByToken(token);
    const rows = appleRows({ consultant: c.id }).sort((x, y) => y.date.localeCompare(x.date));
    return appleFile(rows, c.name, format);
  }

  function appleFile(rows, who, format) {
    // File names must stay ASCII (HTTP header): Søren -> soeren.
    const slug = who.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const base = `apple-registrering-${slug || 'alle'}-${todayIso()}`;
    const headings = [...APPLE_HEADINGS, 'Kursus (titel)', 'Reseller', 'Sendt til Apple'];
    const line = (a) => [...a.fields.map(([, , v]) => v), a.title, a.reseller, a.apple_reported_at ? dmy(a.apple_reported_at.slice(0, 10)) : ''];
    if (format === 'csv') {
      const cell = (v) => { const t = String(v ?? ''); return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8',
        data: '﻿' + [headings, ...rows.map(line)].map((l) => l.map(cell).join(';')).join('\r\n') };
    }
    if (!XLSX) throw new HttpError(500, 'Excel-eksport er ikke tilgængelig.');
    // Dates stay text (dd/mm/åååå) so they paste into Apple's form exactly as it asks.
    const ws = XLSX.utils.aoa_to_sheet([headings, ...rows.map(line)]);
    ws['!cols'] = [12, 22, 26, 12, 24, 24, 10, 10, 18, 18, 12, 10, 8, 14, 11, 11, 18, 22, 14, 12, 12, 28, 12, 12].map((wch) => ({ wch }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length, 1), c: headings.length - 1 } }) };
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Til Apple');
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return { filename: `${base}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: new Uint8Array(data) };
  }

  // Kompas ticks a course off once it is registered with Apple, so it drops out of "Ikke sendt".
  function setAppleReported(user, id, body) {
    requireAdmin(user);
    getActivity(user, id);
    db.run('UPDATE activities SET apple_reported_at = ? WHERE id = ?', [truthy(body?.reported) ? new Date().toISOString() : null, id]);
    return { id, apple_reported_at: db.get('SELECT apple_reported_at FROM activities WHERE id = ?', [id]).apple_reported_at };
  }

  // --- Administration of reference data -------------------------------------------------

  function adminList(user, list) {
    requireAdmin(user);
    const def = LISTS[list];
    if (!def) throw new HttpError(404, 'Ukendt liste.');
    if (list === 'users') {
      // Activity: logins before tracking started are read from the sessions table.
      return db.all(`SELECT u.id, u.name, u.email, u.role, u.reseller_id, r.name AS reseller,
                       u.password_hash IS NOT NULL AS has_password, u.must_change_password,
                       COALESCE(u.last_login_at, (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id)) AS last_login_at,
                       COALESCE(u.last_seen_at, u.last_login_at, (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id)) AS last_seen_at
                     FROM users u LEFT JOIN resellers r ON r.id = u.reseller_id ORDER BY u.role, u.name`).map(({ ...x }) => ({ ...x, has_password: Boolean(x.has_password), must_change_password: Boolean(x.must_change_password) }));
    }
    if (list === 'schools') {
      return db.all(`SELECT s.id, s.name, s.municipality_id, m.name AS municipality, s.postal_code,
                       (SELECT COUNT(*) FROM activities a WHERE a.school_id = s.id) AS used
                     FROM schools s LEFT JOIN municipalities m ON m.id = s.municipality_id ORDER BY s.name`);
    }
    if (list === 'consultants') {
      return db.all(`SELECT x.id, x.name, x.initials, x.email, (SELECT COUNT(*) FROM activities a WHERE a.consultant_id = x.id) AS used,
                       x.feed_token IS NOT NULL AS has_link, x.page_seen_at, x.feed_seen_at
                     FROM consultants x ORDER BY x.name`).map((x) => ({ ...x, has_link: Boolean(x.has_link) }));
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
      const postal = String(body?.postal_code ?? '').trim() || null;
      if (postal && !/^\d{3,4}$/.test(postal)) throw new HttpError(400, 'Postnummeret skal være 3 eller 4 cifre.');
      if (id) db.run('UPDATE schools SET name = ?, municipality_id = ?, postal_code = ? WHERE id = ?', [name, municipality_id, postal, id]);
      else id = Number(db.run('INSERT INTO schools (name, municipality_id, postal_code) VALUES (?, ?, ?)', [name, municipality_id, postal]).lastInsertRowid);
      return { id };
    }
    if (nameExists(def.table, name, id || 0)) throw new HttpError(409, `${def.label} "${name}" findes allerede.`);
    if (list === 'consultants') {
      const initials = String(body?.initials || '').trim().toUpperCase() || null;
      if (initials && db.get('SELECT id FROM consultants WHERE upper(initials) = ? AND id <> ?', [initials, id || 0])) {
        throw new HttpError(409, `Initialerne ${initials} bruges allerede af en anden konsulent.`);
      }
      const email = String(body?.email ?? '').trim().toLowerCase() || null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Indtast en gyldig e-mailadresse.');
      if (id) db.run('UPDATE consultants SET name = ?, initials = ?, email = ? WHERE id = ?', [name, initials, email, id]);
      else id = Number(db.run('INSERT INTO consultants (name, initials, email) VALUES (?, ?, ?)', [name, initials, email]).lastInsertRowid);
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
    // Courses with a start time are timed events in Danish time; the others stay all-day events.
    // Without an end time a half day is shown as 3 hours and a full day as 7.
    if (rows.some((a) => a.start_time)) lines.push(...VTIMEZONE);
    const local = (d, t) => `${d.replace(/-/g, '')}T${t.replace(':', '')}00`;
    const plus = (t, hours) => {
      const m = Math.min(+t.slice(0, 2) * 60 + +t.slice(3, 5) + hours * 60, 23 * 60 + 59);
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    for (const a of rows) {
      const where = [a.school, a.municipality].filter(Boolean).join(', ');
      const when = a.start_time
        ? [`DTSTART;TZID=${TZID}:${local(a.date, a.start_time)}`, `DTEND;TZID=${TZID}:${local(a.date, a.end_time || plus(a.start_time, a.duration === 'full' ? 7 : 3))}`]
        : [`DTSTART;VALUE=DATE:${a.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${next(a.date)}`];
      lines.push('BEGIN:VEVENT', `UID:apl-${a.id}@kompas-apl-tracker`, `DTSTAMP:${stamp}`, ...when,
        `SUMMARY:${a.reschedule ? '★ ' : ''}${a.pending ? '(Foreløbig) ' : ''}${esc(filter.consultant ? `${a.title}${a.school ? ` · ${a.school}` : ''}` : `${a.apl_type} · ${a.title}${a.school ? ` · ${a.school}` : ''}`)}`,
        `LOCATION:${esc(where)}`,
        `DESCRIPTION:${esc([...(a.start_time ? [`Tid: ${timeText(a)}`] : []), `Varighed: ${a.duration === 'full' ? 'Hel dag' : 'Halv dag'}`, `Deltagere: ${a.participants}`,
          `Konsulent: ${a.consultant || '–'}`, `Reseller: ${a.reseller}`, `Betalt af: ${a.paid_by || '–'}`].join('\n'))}`,
        `TRANSP:${a.start_time ? 'OPAQUE' : 'TRANSPARENT'}`, 'END:VEVENT');
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
    const c = db.get('SELECT id, name, email, feed_token FROM consultants WHERE id = ?', [id]);
    if (!c) throw new HttpError(404, 'Konsulenten findes ikke.');
    if (reset || !c.feed_token) db.run('UPDATE consultants SET feed_token = ? WHERE id = ?', [newToken(), id]);
    const token = db.get('SELECT feed_token FROM consultants WHERE id = ?', [id]).feed_token;
    return { feedPath: `/calendar/feed/${token}.ics`, pagePath: `/k/${token}`, appleLink: appleCheckoutLink(c.name, c.email) };
  }

  // The consultant's own page (same secret link as their calendar): held and coming courses.
  // Apple counts a workshop of 1-4 hours as one session and a full day as two.
  const consultantByToken = (token) => {
    const c = /^[a-f0-9]{48}$/.test(String(token)) && db.get('SELECT id, name, email, feed_token FROM consultants WHERE feed_token = ?', [token]);
    if (!c) throw new HttpError(404, 'Siden findes ikke. Bed Kompas om et nyt link.');
    return c;
  };

  function consultantOverview(token) {
    const c = consultantByToken(token);
    db.run("UPDATE consultants SET page_seen_at = datetime('now') WHERE id = ?", [c.id]);
    const rows = listActivities({ role: 'admin' }, { consultant: c.id }).map((a) => ({
      id: a.id, date: a.date, start_time: a.start_time, end_time: a.end_time, duration: a.duration, title: a.title, school: a.school || '', municipality: a.municipality || '',
      apl_type: a.apl_type, participants: a.participants, reseller: a.reseller, status: a.status, pending: a.pending, reschedule: a.reschedule, sessions: a.duration === 'full' ? 2 : 1,
      country: GREENLAND.has(String(a.municipality || '').toLowerCase()) ? 'Grønland' : 'Danmark',
      notes: notesFor(a.id, { consultantId: c.id }),
    }));
    const apple = new Map(appleRows({ consultant: c.id }).map((a) => [a.id, a]));
    const held = rows.filter((a) => a.status === 'held').map((a) => ({ ...a, apple: apple.get(a.id)?.fields || [], appleForm: apple.get(a.id)?.formLink || null }))
      .sort((x, y) => y.date.localeCompare(x.date) || (y.start_time || '').localeCompare(x.start_time || ''));
    const planned = rows.filter((a) => a.status === 'planned')
      .sort((x, y) => x.date.localeCompare(y.date) || (x.start_time || '').localeCompare(y.start_time || ''));
    const byYear = {};
    for (const a of held) byYear[a.date.slice(0, 4)] = (byYear[a.date.slice(0, 4)] || 0) + a.sessions;
    return { name: c.name, email: c.email || '', appleLink: appleCheckoutLink(c.name, c.email), today: todayIso(), feedPath: `/calendar/feed/${c.feed_token}.ics`, held, planned, sessionsByYear: byYear, signup: signupList(c.id), messages: messagesFor(c.id) };
  }

  // --- Tilmelding ---------------------------------------------------------------------------
  // Works like a Doodle: Foreløbig courses from today on that have no consultant yet are open, and
  // every consultant clicks "Det kan jeg" on their own page (no answer means they cannot). Kompas sees all answers and
  // puts the chosen consultants on the course (one course per consultant, as everywhere else).
  // Consultants only say yes now (Jakob, 2026-10-06). Older Måske answers stay visible to Kompas.
  const ANSWERS = ['yes'];
  // "Sæt på" gives each consultant their own copy of the course (same date, title, school and reseller).
  // The first row of that group carries the sign-ups. The course stays open until as many consultants
  // as needed are on it (Jakob, 2026-10-06: putting one consultant on a course that needs three must
  // not close it). Without a number needed it closes once anyone is on it, as before.
  const SAME_COURSE = (x) => `${x}.pending = 1 AND ${x}.date = a.date AND ${x}.title = a.title AND ${x}.reseller_id = a.reseller_id AND ${x}.school_id IS a.school_id`;
  const ASSIGNED = `(SELECT COUNT(*) FROM activities g WHERE ${SAME_COURSE('g')} AND g.consultant_id IS NOT NULL)`;
  const OPEN_WHERE = `a.pending = 1 AND a.date >= ? AND NOT EXISTS (SELECT 1 FROM activities f WHERE ${SAME_COURSE('f')} AND f.id < a.id)
    AND (a.consultant_id IS NULL OR COALESCE(a.consultants_needed, 1) > ${ASSIGNED})`;
  const assignedTo = (c) => db.all(`SELECT g.consultant_id AS id FROM activities a JOIN activities g ON ${SAME_COURSE('g')}
    WHERE a.id = ? AND g.consultant_id IS NOT NULL ORDER BY g.id`, [c.id]).map((r) => r.id);
  const openCourses = () => db.all(`${ACTIVITY_SELECT} WHERE ${OPEN_WHERE} ORDER BY a.date, a.start_time, s.name, a.id`, [todayIso()])
    .map((a) => ({ id: a.id, date: a.date, start_time: a.start_time, end_time: a.end_time, duration: a.duration, title: a.title, school: a.school || '', municipality: a.municipality || '',
      reseller: a.reseller, needed: a.consultants_needed ?? null, lead_consultant: a.consultant_id }))
    .map((c) => ({ ...c, assigned: c.lead_consultant ? assignedTo(c) : [] }));
  const openAnswers = () => db.all(`SELECT cs.activity_id, cs.consultant_id, cs.answer FROM course_signups cs
    JOIN activities a ON a.id = cs.activity_id WHERE cs.answer IN ('yes', 'maybe') AND ${OPEN_WHERE}`, [todayIso()]);
  const openCourse = (id) => {
    const row = db.get(`SELECT a.id FROM activities a WHERE a.id = ? AND ${OPEN_WHERE}`, [id, todayIso()]);
    if (!row) throw new HttpError(404, 'Kurset er ikke længere åbent for tilmelding.');
    return row;
  };

  // Only Kan counts towards the number needed. A full course closes for sign-up: it disappears from
  // the pages of consultants who have not answered it, while those who have still see their answer.
  // Consultants already put on the course count as signed up too.
  const yesCount = (answers, c) => new Set([...answers.filter((x) => x.activity_id === c.id && x.answer === 'yes').map((x) => x.consultant_id), ...c.assigned]).size;
  const isFull = (c, yes) => Boolean(c.needed) && yes >= c.needed;

  function signupList(consultantId) {
    const answers = openAnswers();
    // A course the consultant is already on is under their coming courses, not here.
    return openCourses().filter((c) => !c.assigned.includes(consultantId)).map(({ assigned, lead_consultant, ...c }) => {
      const mine = answers.find((x) => x.activity_id === c.id && x.consultant_id === consultantId);
      const yes = yesCount(answers, { ...c, assigned });
      return { ...c, answer: mine?.answer || '', yes, full: isFull(c, yes) };
    }).filter((c) => !c.full || c.answer);
  }

  function signupOverview(user) {
    requireAdmin(user);
    const answers = openAnswers();
    const consultants = db.all('SELECT id, name, initials, feed_token IS NOT NULL AS has_link FROM consultants ORDER BY name')
      .map((c) => ({ ...c, has_link: Boolean(c.has_link) }));
    const courses = openCourses().map(({ lead_consultant, ...c }) => ({ ...c, yes: yesCount(answers, c), full: isFull(c, yesCount(answers, c)),
      answers: Object.fromEntries(answers.filter((x) => x.activity_id === c.id).map((x) => [x.consultant_id, x.answer])),
      // Consultants who already have a course that day (Dobbeltbooking warning when assigning).
      busy: [...new Set(db.all('SELECT consultant_id AS id, start_time, end_time FROM activities WHERE date = ? AND consultant_id IS NOT NULL', [c.date])
        .filter((r) => clash(c, r)).map((r) => r.id))] }));
    return { consultants, courses };
  }

  function setSignup(token, activityId, body) {
    const c = consultantByToken(token);
    openCourse(activityId);
    const answer = String(body?.answer || '');
    if (answer && !ANSWERS.includes(answer)) throw new HttpError(400, 'Ugyldigt svar.');
    const course = signupList(c.id).find((x) => x.id === activityId);
    // Kan is a commitment: only Kompas can take it back (Jakob, 2026-10-06). A full course takes no new Kan.
    if (course?.answer === 'yes' && answer !== 'yes') throw new HttpError(409, 'Du er tilmeldt kurset. Kontakt Kompas, hvis du skal melde fra.');
    if (!course || (answer === 'yes' && course.full && course.answer !== 'yes')) {
      throw new HttpError(409, 'Kurset har allerede fået de konsulenter, der skal bruges.');
    }
    if (answer) {
      db.run(`INSERT INTO course_signups (activity_id, consultant_id, answer) VALUES (?, ?, ?)
              ON CONFLICT (activity_id, consultant_id) DO UPDATE SET answer = excluded.answer, updated_at = datetime('now')`, [activityId, c.id, answer]);
    } else {
      db.run('DELETE FROM course_signups WHERE activity_id = ? AND consultant_id = ?', [activityId, c.id]);
    }
    return signupList(c.id);
  }

  // Kompas takes a consultant's answer back (consultants cannot withdraw a Kan themselves).
  function removeSignup(user, id, consultantId) {
    requireAdmin(user);
    openCourse(id);
    db.run('DELETE FROM course_signups WHERE activity_id = ? AND consultant_id = ?', [id, consultantId]);
    return { ok: true };
  }

  function setNeeded(user, id, body) {
    requireAdmin(user);
    openCourse(id);
    const n = neededInput(body?.needed);
    if (n === undefined) throw new HttpError(400, NEEDED_ERROR);
    db.run("UPDATE activities SET consultants_needed = ?, updated_at = datetime('now') WHERE id = ?", [n, id]);
    return { ok: true };
  }

  // If nobody is on the course yet, the first chosen consultant takes it; every other one gets a copy.
  // Consultants already on the course are skipped. The courses stay Foreløbig until Kompas confirms them.
  function assignConsultants(user, id, body) {
    requireAdmin(user);
    openCourse(id);
    const lead = db.get('SELECT consultant_id FROM activities WHERE id = ?', [id]);
    const already = lead.consultant_id ? assignedTo({ id }) : [];
    const ids = [...new Set((Array.isArray(body?.consultant_ids) ? body.consultant_ids : []).map(int).filter(Boolean))].filter((cid) => !already.includes(cid));
    if (!ids.length) throw new HttpError(400, 'Vælg mindst én konsulent, der ikke allerede er sat på.');
    for (const cid of ids) if (!db.get('SELECT id FROM consultants WHERE id = ?', [cid])) throw new HttpError(400, 'Konsulenten findes ikke.');
    db.exec('BEGIN');
    try {
      if (!lead.consultant_id) db.run("UPDATE activities SET consultant_id = ?, updated_at = datetime('now') WHERE id = ?", [ids[0], id]);
      for (const cid of lead.consultant_id ? ids : ids.slice(1)) {
        db.run(`INSERT INTO activities (date, start_time, end_time, duration, apl_type_id, title, school_id, municipality_id, participants, consultant_id,
                  reseller_id, paid_by_id, pending, reschedule, consultants_needed, created_by)
                SELECT date, start_time, end_time, duration, apl_type_id, title, school_id, municipality_id, participants, ?,
                  reseller_id, paid_by_id, pending, reschedule, consultants_needed, ? FROM activities WHERE id = ?`, [cid, user.id, id]);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { assigned: ids.length };
  }

  // --- Beskeder ------------------------------------------------------------------------------
  // One-way notices from Kompas to the consultants, shown at the top of each consultant's page.
  // A message goes to every consultant or to one; Kompas sees who has read it.
  const MESSAGES_FOR = '(m.consultant_id IS NULL OR m.consultant_id = ?)';

  function messagesFor(consultantId) {
    return db.all(`SELECT m.id, m.title, m.body, m.created_at, m.consultant_id IS NOT NULL AS personal,
        EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.consultant_id = ?) AS seen
      FROM messages m WHERE ${MESSAGES_FOR} ORDER BY m.created_at DESC, m.id DESC`, [consultantId, consultantId])
      .map((m) => ({ id: m.id, title: m.title, body: m.body, created_at: m.created_at, personal: Boolean(m.personal), unread: !m.seen }));
  }

  // Called by the consultant page after it has shown the messages, so they are marked "Ny" only once.
  // The consultant writes their own Apple e-mail on their page, which gives them their personal checkout link.
  function setConsultantAppleEmail(token, body) {
    const c = consultantByToken(token);
    const email = String(body?.email ?? '').trim().toLowerCase() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Skriv en gyldig e-mailadresse.');
    db.run('UPDATE consultants SET email = ? WHERE id = ?', [email, c.id]);
    return { email, appleLink: appleCheckoutLink(c.name, email) };
  }

  function markMessagesRead(token) {
    const c = consultantByToken(token);
    db.run(`INSERT OR IGNORE INTO message_reads (message_id, consultant_id) SELECT m.id, ? FROM messages m WHERE ${MESSAGES_FOR}`, [c.id, c.id]);
    return { ok: true };
  }

  function listMessages(user) {
    requireAdmin(user);
    const withLink = db.all('SELECT id, name FROM consultants WHERE feed_token IS NOT NULL ORDER BY name');
    return db.all(`SELECT m.id, m.title, m.body, m.created_at, m.consultant_id, c.name AS consultant, u.name AS author
        FROM messages m LEFT JOIN consultants c ON c.id = m.consultant_id LEFT JOIN users u ON u.id = m.created_by
        ORDER BY m.created_at DESC, m.id DESC`).map((m) => {
      const read = new Set(db.all('SELECT consultant_id FROM message_reads WHERE message_id = ?', [m.id]).map((r) => r.consultant_id));
      const audience = m.consultant_id ? [{ id: m.consultant_id, name: m.consultant }] : withLink;
      return { ...m, read: audience.filter((p) => read.has(p.id)).map((p) => p.name), unread: audience.filter((p) => !read.has(p.id)).map((p) => p.name) };
    });
  }

  function createMessage(user, body) {
    requireAdmin(user);
    const title = String(body?.title ?? '').trim();
    const text = String(body?.body ?? '').trim();
    const to = int(body?.consultant_id) || null;
    if (!title) throw new HttpError(400, 'Skriv en overskrift.');
    if (title.length > 200) throw new HttpError(400, 'Overskriften er for lang (højst 200 tegn).');
    if (text.length > 5000) throw new HttpError(400, 'Beskeden er for lang (højst 5000 tegn).');
    if (to && !db.get('SELECT id FROM consultants WHERE id = ?', [to])) throw new HttpError(400, 'Konsulenten findes ikke.');
    const id = Number(db.run('INSERT INTO messages (title, body, consultant_id, created_by) VALUES (?, ?, ?, ?)', [title, text, to, user.id]).lastInsertRowid);
    return { id };
  }

  function deleteMessage(user, id) {
    requireAdmin(user);
    if (!db.get('SELECT id FROM messages WHERE id = ?', [id])) throw new HttpError(404, 'Beskeden findes ikke.');
    db.run('DELETE FROM messages WHERE id = ?', [id]);
    return { ok: true };
  }

  // --- Noter -------------------------------------------------------------------------------
  // Short notes on a course ("husk projektor næste gang"). Kompas writes them in the app; the course's
  // own consultant writes them on their page. Resellers and viewers never see them.
  // Everyone may delete their own notes; Kompas may delete any note.
  function notesFor(activityId, { consultantId = null, userId = null, admin = false } = {}) {
    return db.all('SELECT id, body, author, user_id, consultant_id, created_at FROM course_notes WHERE activity_id = ? ORDER BY created_at, id', [activityId])
      .map((n) => ({ id: n.id, body: n.body, author: n.author, created_at: n.created_at,
        mine: admin || (consultantId != null && n.consultant_id === consultantId) || (userId != null && n.user_id === userId) }));
  }

  const noteText = (body) => {
    const text = String(body?.body ?? '').trim();
    if (!text) throw new HttpError(400, 'Skriv en note.');
    if (text.length > 1000) throw new HttpError(400, 'Noten er for lang (højst 1000 tegn).');
    return text;
  };

  function listNotes(user, id) {
    requireAdmin(user);
    getActivity(user, id);
    return notesFor(id, { userId: user.id, admin: true });
  }

  function addNote(user, id, body) {
    requireAdmin(user);
    getActivity(user, id);
    db.run('INSERT INTO course_notes (activity_id, body, user_id, author) VALUES (?, ?, ?, ?)', [id, noteText(body), user.id, user.name]);
    return notesFor(id, { userId: user.id, admin: true });
  }

  function deleteNote(user, id) {
    requireAdmin(user);
    const n = db.get('SELECT activity_id FROM course_notes WHERE id = ?', [id]);
    if (!n) throw new HttpError(404, 'Noten findes ikke.');
    db.run('DELETE FROM course_notes WHERE id = ?', [id]);
    return notesFor(n.activity_id, { userId: user.id, admin: true });
  }

  // From the consultant page: only on the consultant's own courses.
  function consultantNotes(token, activityId, body) {
    const c = consultantByToken(token);
    if (!db.get('SELECT id FROM activities WHERE id = ? AND consultant_id = ?', [activityId, c.id])) throw new HttpError(404, 'Kurset findes ikke på din side.');
    if (body !== undefined) db.run('INSERT INTO course_notes (activity_id, body, consultant_id, author) VALUES (?, ?, ?, ?)', [activityId, noteText(body), c.id, c.name]);
    return notesFor(activityId, { consultantId: c.id });
  }

  function deleteConsultantNote(token, noteId) {
    const c = consultantByToken(token);
    const n = db.get('SELECT activity_id FROM course_notes WHERE id = ? AND consultant_id = ?', [noteId, c.id]);
    if (!n) throw new HttpError(404, 'Noten findes ikke, eller den er skrevet af en anden.');
    db.run('DELETE FROM course_notes WHERE id = ?', [noteId]);
    return notesFor(n.activity_id, { consultantId: c.id });
  }

  /** Subscription feed: authenticated by the secret token in the link, not by a login. */
  function feed(token) {
    const valid = /^[a-f0-9]{48}$/.test(String(token));
    const consultant = valid && db.get('SELECT id, name FROM consultants WHERE feed_token = ?', [token]);
    if (consultant) {
      db.run("UPDATE consultants SET feed_seen_at = datetime('now') WHERE id = ?", [consultant.id]);
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
        return { json: { id: user.id, name: user.name, email: user.email, role: user.role, reseller_id: user.reseller_id, reseller, must_change_password: Boolean(user.must_change_password),
          viewed_by: user.viewed_by || null } };
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
      case 'GET /activities/same-day': return { json: sameDayCourses(user, query) };
      case 'GET /activities/:id': return { json: getActivity(user, id) };
      case 'POST /activities': return { json: createActivity(user, body) };
      case 'PUT /activities/:id': return { json: updateActivity(user, id, body) };
      case 'PUT /activities/:id/participants': return { json: setParticipants(user, int(parts[1]), body) };
      case 'PUT /activities/:id/pending': return { json: setPending(user, int(parts[1]), body) };
      case 'PUT /activities/:id/apple': return { json: setAppleReported(user, int(parts[1]), body) };
      case 'GET /apple': return { json: appleCourses(user, query) };
      case 'GET /apple/export': return { file: exportApple(user, query) };
      case 'DELETE /activities/:id': return { json: deleteActivity(user, id) };
      case 'GET /activities/:id/notes': return { json: listNotes(user, int(parts[1])) };
      case 'POST /activities/:id/notes': return { json: addNote(user, int(parts[1]), body) };
      case 'DELETE /notes/:id': return { json: deleteNote(user, id) };
      case 'GET /signups': return { json: signupOverview(user) };
      case 'PUT /signups/:id/needed': return { json: setNeeded(user, int(parts[1]), body) };
      case 'POST /signups/:id/assign': return { json: assignConsultants(user, int(parts[1]), body) };
      case 'DELETE /signups/:id/consultants/:id': return { json: removeSignup(user, int(parts[1]), int(parts[3])) };
      case 'GET /messages': return { json: listMessages(user) };
      case 'POST /messages': return { json: createMessage(user, body) };
      case 'DELETE /messages/:id': return { json: deleteMessage(user, id) };
      case 'GET /admin/consultants/:id/feed': return { json: consultantFeed(user, int(parts[2]), false) };
      case 'POST /admin/consultants/:id/feed': return { json: consultantFeed(user, int(parts[2]), true) };
      case `GET /admin/${parts[1]}`: return { json: adminList(user, parts[1]) };
      case `POST /admin/${parts[1]}`: return { json: adminSave(user, parts[1], null, body) };
      case `PUT /admin/${parts[1]}/:id`: return { json: adminSave(user, parts[1], id, body) };
      case `DELETE /admin/${parts[1]}/:id`: return { json: adminDelete(user, parts[1], id) };
      default: throw new HttpError(404, 'Ikke fundet.');
    }
  }

  // Administration › Skoler › Find postnumre: looks up schools without a postal code, a batch at a
  // time (Nominatim allows one request a second), and saves what it finds.
  // `after` continues from the last school of the previous batch, so schools not found are skipped.
  async function findPostalCodes(user, { after = 0, lookup = nominatimPostal, limit = 25, pause = 1100 } = {}) {
    requireAdmin(user);
    const todo = db.all(`SELECT s.id, s.name, m.name AS municipality FROM schools s LEFT JOIN municipalities m ON m.id = s.municipality_id
      WHERE COALESCE(s.postal_code, '') = '' AND s.name NOT LIKE '%flere skoler%' AND s.id > ? ORDER BY s.id`, [int(after) || 0]);
    const found = [];
    const missing = [];
    for (const [i, sch] of todo.slice(0, limit).entries()) {
      if (i && pause) await new Promise((r) => setTimeout(r, pause));
      let code = null;
      try { code = await lookup(sch.name, sch.municipality); } catch { /* counted as not found */ }
      if (code) {
        db.run('UPDATE schools SET postal_code = ? WHERE id = ?', [code, sch.id]);
        found.push({ name: sch.name, postal_code: code });
      } else missing.push(sch.name);
    }
    const done = todo.slice(0, limit);
    return { found, missing, remaining: Math.max(todo.length - limit, 0), next: done.at(-1)?.id || 0 };
  }

  return { handle, feed, findPostalCodes, consultantOverview, consultantAppleExport, setConsultantAppleEmail, setSignup, markMessagesRead, consultantNotes, deleteConsultantNote, calendarUrlFor: (user) => db.get('SELECT calendar_url FROM users WHERE id = ?', [user.id])?.calendar_url || '' };
}
