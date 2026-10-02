// Minimal iCalendar (.ics) reader for Apple Kalender / iCloud, Outlook and Google feeds.
// Returns single events with a local (Copenhagen) date. Repeating events are skipped:
// workshops are booked as individual events.

const TZ = 'Europe/Copenhagen';

function unfold(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
}

// Parses DTSTART/DTEND values. Returns { date: 'yyyy-mm-dd', minutes: minutes since epoch or null }.
function parseTime(params, value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h || /VALUE=DATE(?!-)/i.test(params)) return { date: `${y}-${mo}-${d}`, minutes: null, allDay: true };
  if (z) {
    const utc = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(utc);
    return { date: local, minutes: utc.getTime() / 60000 };
  }
  // Floating or TZID time: treat as local wall-clock time.
  return { date: `${y}-${mo}-${d}`, minutes: Date.UTC(+y, +mo - 1, +d, +h, +mi) / 60000 };
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.start && !cur.rrule && !/CANCELLED/i.test(cur.status || '')) {
        const hours = cur.end && cur.start.minutes != null && cur.end.minutes != null ? (cur.end.minutes - cur.start.minutes) / 60 : null;
        events.push({
          uid: cur.recurrenceId ? `${cur.uid}#${cur.recurrenceId}` : cur.uid,
          date: cur.start.date,
          title: cur.summary || '(uden titel)',
          location: cur.location || '',
          notes: cur.description || '',
          hours,
          allDay: Boolean(cur.start.allDay),
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [name, ...params] = line.slice(0, idx).split(';');
    const value = line.slice(idx + 1);
    const p = params.join(';');
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'DESCRIPTION': cur.description = unescapeText(value).slice(0, 500); break;
      case 'STATUS': cur.status = value; break;
      case 'RRULE': cur.rrule = value; break;
      case 'RECURRENCE-ID': cur.recurrenceId = value.trim(); break;
      case 'DTSTART': cur.start = parseTime(p, value); break;
      case 'DTEND': cur.end = parseTime(p, value); break;
      default:
    }
  }
  return events.sort((a, b) => b.date.localeCompare(a.date));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[–—-]/g, ' ').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Guesses form values from an event by looking for known schools, municipalities, topics
 * and consultants in its title, location and notes.
 */
export function suggestFromEvent(ev, { schools = [], municipalities = [], titles = [], consultants = [] }) {
  const hay = ` ${norm(`${ev.title} ${ev.location} ${ev.notes}`)} `;
  const has = (name) => name && hay.includes(` ${norm(name)} `);
  const longestFirst = (list, key = (x) => x.name) => [...list].sort((a, b) => key(b).length - key(a).length);

  const school = longestFirst(schools).find((s) => has(s.name)) || null;
  const municipality = school?.municipality_id
    ? municipalities.find((m) => m.id === school.municipality_id) || null
    : longestFirst(municipalities).find((m) => has(m.name)) || null;
  const title = longestFirst(titles, (t) => t).find((t) => has(t)) || null;
  const consultant = longestFirst(consultants).find((c) => has(c.name)) || null;
  return {
    date: ev.date,
    duration: ev.hours != null && ev.hours >= 5 ? 'full' : 'half',
    title: title || ev.title,
    school_id: school?.id || '',
    school: school?.name || '',
    municipality_id: municipality?.id || '',
    consultant_id: consultant?.id || '',
  };
}
