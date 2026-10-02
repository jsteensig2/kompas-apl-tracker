// Example data so the system can be tested immediately.
// Everything here is ordinary reference data that Kompas can edit or delete in Administration.

export const MUNICIPALITIES = [
  'Albertslund', 'Allerød', 'Assens', 'Ballerup', 'Billund', 'Bornholm', 'Brøndby', 'Brønderslev',
  'Dragør', 'Egedal', 'Esbjerg', 'Fanø', 'Favrskov', 'Faxe', 'Fredensborg', 'Fredericia',
  'Frederiksberg', 'Frederikshavn', 'Frederikssund', 'Furesø', 'Faaborg-Midtfyn', 'Gentofte',
  'Gladsaxe', 'Glostrup', 'Greve', 'Gribskov', 'Guldborgsund', 'Haderslev', 'Halsnæs', 'Hedensted',
  'Helsingør', 'Herlev', 'Herning', 'Hillerød', 'Hjørring', 'Holbæk', 'Holstebro', 'Horsens',
  'Hvidovre', 'Høje-Taastrup', 'Hørsholm', 'Ikast-Brande', 'Ishøj', 'Jammerbugt', 'Kalundborg',
  'Kerteminde', 'Kolding', 'København', 'Køge', 'Langeland', 'Lejre', 'Lemvig', 'Lolland',
  'Lyngby-Taarbæk', 'Læsø', 'Mariagerfjord', 'Middelfart', 'Morsø', 'Norddjurs', 'Nordfyn', 'Nyborg',
  'Næstved', 'Odder', 'Odense', 'Odsherred', 'Randers', 'Rebild', 'Ringkøbing-Skjern', 'Ringsted',
  'Roskilde', 'Rudersdal', 'Rødovre', 'Samsø', 'Silkeborg', 'Skanderborg', 'Skive', 'Slagelse',
  'Solrød', 'Sorø', 'Stevns', 'Struer', 'Svendborg', 'Syddjurs', 'Sønderborg', 'Thisted', 'Tønder',
  'Tårnby', 'Vallensbæk', 'Varde', 'Vejen', 'Vejle', 'Vesthimmerland', 'Viborg', 'Vordingborg',
  'Ærø', 'Aabenraa', 'Aalborg', 'Aarhus',
];

export const RESELLERS = ['Atea', 'Comm2IG'];
export const APL_TYPES = ['Workshop'];
export const PAID_BY = ['Apple', 'Atea', 'Comm2IG', 'Høje-Taastrup Kommune', 'Skole', 'Kommune', 'Anden kunde'];
export const CONSULTANTS = [
  'Jakob Steensig', 'Kim Byrding', 'Søren Rasmussen', 'Rasmus Toft',
  'Jacob Schandorf', 'Christian Møller', 'Torben Hollensen',
];

// [school, municipality]
export const SCHOOLS = [
  ['Gåsetårnskolen', 'Vordingborg'],
  ['Kulsbjerg Skole', 'Vordingborg'],
  ['Ollerup Friskole', 'Svendborg'],
  ['Rantzausminde Skole', 'Svendborg'],
  ['Læringshuset', 'Høje-Taastrup'],
  ['Torstorp Skole', 'Høje-Taastrup'],
  ['Sengeløse Skole', 'Høje-Taastrup'],
  ['Mølleholmskolen', 'Høje-Taastrup'],
  ['Hedehusene Skole', 'Høje-Taastrup'],
  ['Holte Skole', 'Rudersdal'],
  ['Skovlyskolen', 'Rudersdal'],
  ['Ny Holte Skole', 'Rudersdal'],
  ['Tingløkkeskolen', 'Odense'],
  ['Katrinebjergskolen', 'Aarhus'],
  ['Skåde Skole', 'Aarhus'],
  ['Himmelev Skole', 'Roskilde'],
];

export const USERS = [
  { name: 'Kompas Admin', email: 'admin@kompas.dk', role: 'admin', reseller: null },
  { name: 'Atea', email: 'apl@atea.dk', role: 'reseller', reseller: 'Atea' },
  { name: 'Comm2IG', email: 'apl@comm2ig.dk', role: 'reseller', reseller: 'Comm2IG' },
];

// [date, duration, type, title, school, municipality, participants, consultant, reseller, paid by]
export const ACTIVITIES = [
  // Examples given by Kompas
  ['2026-02-19', 'half', 'Workshop', 'ADS 1', 'Gåsetårnskolen', 'Vordingborg', 16, 'Kim Byrding', 'Comm2IG', 'Comm2IG'],
  ['2026-05-06', 'half', 'Workshop', 'Jamf', 'Ollerup Friskole', 'Svendborg', 11, 'Jakob Steensig', 'Atea', 'Atea'],
  ['2026-08-05', 'half', 'Workshop', 'Mac – module 1', 'Læringshuset', 'Høje-Taastrup', 20, 'Kim Byrding', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-08-05', 'half', 'Workshop', 'AI', 'Holte Skole', 'Rudersdal', 16, 'Torben Hollensen', 'Comm2IG', 'Apple'],
  ['2026-09-01', 'half', 'Workshop', 'Mac – module 1', 'Torstorp Skole', 'Høje-Taastrup', 17, 'Kim Byrding', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-09-02', 'half', 'Workshop', 'Mac – module 1', 'Sengeløse Skole', 'Høje-Taastrup', 11, 'Jakob Steensig', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-10-02', 'half', 'Workshop', 'Mac – module 2', 'Sengeløse Skole', 'Høje-Taastrup', 18, 'Jakob Steensig', 'Atea', 'Høje-Taastrup Kommune'],
  // Additional realistic examples, spread over 2025 and 2026
  ['2025-09-10', 'full', 'Workshop', 'ADS 1', 'Katrinebjergskolen', 'Aarhus', 22, 'Søren Rasmussen', 'Comm2IG', 'Kommune'],
  ['2025-09-24', 'half', 'Workshop', 'Mac – module 1', 'Mølleholmskolen', 'Høje-Taastrup', 14, 'Jakob Steensig', 'Atea', 'Høje-Taastrup Kommune'],
  ['2025-10-08', 'half', 'Workshop', 'Jamf', 'Tingløkkeskolen', 'Odense', 9, 'Rasmus Toft', 'Atea', 'Atea'],
  ['2025-10-29', 'half', 'Workshop', 'AI', 'Skovlyskolen', 'Rudersdal', 19, 'Torben Hollensen', 'Comm2IG', 'Apple'],
  ['2025-11-12', 'full', 'Workshop', 'ADS 2', 'Katrinebjergskolen', 'Aarhus', 21, 'Søren Rasmussen', 'Comm2IG', 'Kommune'],
  ['2025-11-19', 'half', 'Workshop', 'Mac – module 2', 'Mølleholmskolen', 'Høje-Taastrup', 13, 'Jakob Steensig', 'Atea', 'Høje-Taastrup Kommune'],
  ['2025-12-03', 'half', 'Workshop', 'AI', 'Himmelev Skole', 'Roskilde', 24, 'Christian Møller', 'Atea', 'Skole'],
  ['2026-01-14', 'half', 'Workshop', 'Mac – module 1', 'Hedehusene Skole', 'Høje-Taastrup', 15, 'Kim Byrding', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-01-21', 'half', 'Workshop', 'Jamf', 'Kulsbjerg Skole', 'Vordingborg', 8, 'Jacob Schandorf', 'Comm2IG', 'Comm2IG'],
  ['2026-02-04', 'full', 'Workshop', 'ADS 3', 'Katrinebjergskolen', 'Aarhus', 20, 'Søren Rasmussen', 'Comm2IG', 'Kommune'],
  ['2026-02-25', 'half', 'Workshop', 'Mac – module 2', 'Hedehusene Skole', 'Høje-Taastrup', 14, 'Kim Byrding', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-03-04', 'half', 'Workshop', 'ADS 2', 'Gåsetårnskolen', 'Vordingborg', 15, 'Kim Byrding', 'Comm2IG', 'Comm2IG'],
  ['2026-03-11', 'half', 'Workshop', 'AI', 'Rantzausminde Skole', 'Svendborg', 23, 'Rasmus Toft', 'Atea', 'Apple'],
  ['2026-03-18', 'full', 'Workshop', 'Mac – module 1', 'Skåde Skole', 'Aarhus', 18, 'Christian Møller', 'Comm2IG', 'Skole'],
  ['2026-04-08', 'half', 'Workshop', 'ADS 3', 'Gåsetårnskolen', 'Vordingborg', 14, 'Kim Byrding', 'Comm2IG', 'Comm2IG'],
  ['2026-04-15', 'half', 'Workshop', 'Jamf', 'Mølleholmskolen', 'Høje-Taastrup', 7, 'Jacob Schandorf', 'Atea', 'Atea'],
  ['2026-04-22', 'half', 'Workshop', 'AI', 'Ny Holte Skole', 'Rudersdal', 21, 'Torben Hollensen', 'Comm2IG', 'Apple'],
  ['2026-05-20', 'half', 'Workshop', 'Mac – module 1', 'Tingløkkeskolen', 'Odense', 16, 'Rasmus Toft', 'Atea', 'Anden kunde'],
  ['2026-06-03', 'full', 'Workshop', 'AI', 'Himmelev Skole', 'Roskilde', 26, 'Christian Møller', 'Atea', 'Skole'],
  ['2026-06-10', 'half', 'Workshop', 'Mac – module 2', 'Skåde Skole', 'Aarhus', 17, 'Christian Møller', 'Comm2IG', 'Skole'],
  ['2026-06-17', 'half', 'Workshop', 'Mac – module 2', 'Tingløkkeskolen', 'Odense', 15, 'Rasmus Toft', 'Atea', 'Anden kunde'],
  ['2026-08-12', 'half', 'Workshop', 'Mac – module 1', 'Mølleholmskolen', 'Høje-Taastrup', 19, 'Jakob Steensig', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-08-19', 'half', 'Workshop', 'AI', 'Kulsbjerg Skole', 'Vordingborg', 12, 'Jacob Schandorf', 'Comm2IG', 'Comm2IG'],
  ['2026-08-26', 'full', 'Workshop', 'ADS 1', 'Skovlyskolen', 'Rudersdal', 20, 'Søren Rasmussen', 'Comm2IG', 'Kommune'],
  ['2026-09-09', 'half', 'Workshop', 'Mac – module 2', 'Torstorp Skole', 'Høje-Taastrup', 16, 'Kim Byrding', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-09-16', 'half', 'Workshop', 'Jamf', 'Rantzausminde Skole', 'Svendborg', 10, 'Jakob Steensig', 'Atea', 'Atea'],
  ['2026-09-23', 'half', 'Workshop', 'ADS 1', 'Holte Skole', 'Rudersdal', 18, 'Torben Hollensen', 'Comm2IG', 'Apple'],
  ['2026-09-30', 'half', 'Workshop', 'AI', 'Hedehusene Skole', 'Høje-Taastrup', 22, 'Christian Møller', 'Atea', 'Høje-Taastrup Kommune'],
  // Planned courses (order book). Participants are filled in once the course has been held.
  ['2026-10-14', 'half', 'Workshop', 'Mac – module 2', 'Mølleholmskolen', 'Høje-Taastrup', 0, 'Jakob Steensig', 'Atea', 'Høje-Taastrup Kommune'],
  ['2026-10-28', 'full', 'Workshop', 'ADS 2', 'Skovlyskolen', 'Rudersdal', 0, 'Søren Rasmussen', 'Comm2IG', 'Kommune'],
  ['2026-11-04', 'half', 'Workshop', 'Jamf', 'Tingløkkeskolen', 'Odense', 0, 'Rasmus Toft', 'Atea', 'Atea'],
  ['2026-11-11', 'half', 'Workshop', 'AI', 'Gåsetårnskolen', 'Vordingborg', 0, 'Kim Byrding', 'Comm2IG', 'Apple'],
  ['2026-11-25', 'half', 'Workshop', 'Mac – module 1', 'Himmelev Skole', 'Roskilde', 0, 'Christian Møller', 'Atea', 'Skole'],
  ['2026-12-02', 'full', 'Workshop', 'ADS 3', 'Katrinebjergskolen', 'Aarhus', 0, 'Søren Rasmussen', 'Comm2IG', 'Kommune'],
];

// examples = false seeds only the choice lists (for a real installation without demo data).
export function seed(db, { examples = true } = {}) {
  const ids = (table) => Object.fromEntries(db.all(`SELECT id, name FROM ${table}`).map((r) => [r.name, r.id]));
  const insertNames = (table, names) => names.forEach((n) => db.run(`INSERT INTO ${table} (name) VALUES (?)`, [n]));

  insertNames('municipalities', MUNICIPALITIES);
  insertNames('resellers', RESELLERS);
  insertNames('apl_types', APL_TYPES);
  insertNames('paid_by', PAID_BY);
  insertNames('consultants', CONSULTANTS);

  const muni = ids('municipalities');
  const resellers = ids('resellers');
  SCHOOLS.forEach(([name, m]) => db.run('INSERT INTO schools (name, municipality_id) VALUES (?, ?)', [name, muni[m]]));
  if (!examples) return;
  USERS.forEach((u) => db.run('INSERT INTO users (name, email, role, reseller_id) VALUES (?, ?, ?, ?)',
    [u.name, u.email, u.role, u.reseller ? resellers[u.reseller] : null]));

  const schools = ids('schools');
  const types = ids('apl_types');
  const consultants = ids('consultants');
  const paid = ids('paid_by');
  for (const [date, duration, type, title, school, m, n, consultant, reseller, paidBy] of ACTIVITIES) {
    db.run(`INSERT INTO activities (date, duration, apl_type_id, title, school_id, municipality_id, participants,
              consultant_id, reseller_id, paid_by_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [date, duration, types[type], title, schools[school], muni[m], n, consultants[consultant], resellers[reseller], paid[paidBy]]);
  }
}
