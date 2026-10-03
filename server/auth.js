// Authentication.
//
// Real login: email + password (scrypt hashes), sessions in the database (httpOnly cookie).
// Kompas administrators create users and hand out a one-time password; the user must choose
// their own password at first login.
//
// Demo login (pick any user, switch user in the grey bar) is for testing only. It is on by
// default locally and OFF when NODE_ENV=production unless DEMO_LOGIN=on is set explicitly.
//
// The rest of the system only depends on `req.user` (id, role, reseller_id), so single sign-on
// (Microsoft Entra ID / Google) can be added here later without changing the access rules.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const COOKIE = 'apl_session';
const SESSION_DAYS = 30;
const demoEnabled = () => (process.env.NODE_ENV === 'production' ? process.env.DEMO_LOGIN === 'on' : process.env.DEMO_LOGIN !== 'off');

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Readable one-time password, e.g. "kmrp-7fhw-q2dx".
export function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  return Array.from(bytes, (b, i) => chars[b % chars.length] + ((i + 1) % 4 === 0 && i < 11 ? '-' : '')).join('');
}

function readCookie(req, name) {
  const match = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function authMiddleware(db) {
  return (req, _res, next) => {
    const token = readCookie(req, COOKIE);
    req.user = token
      ? db.get(`SELECT u.id, u.name, u.email, u.role, u.reseller_id, u.must_change_password FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token = ? AND s.created_at > datetime('now', ?)`, [token, `-${SESSION_DAYS} days`]) || null
      : null;
    next();
  };
}

function startSession(db, req, res, userId) {
  const token = randomBytes(32).toString('base64url');
  db.run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, userId]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
}

// Simple in-memory brake on password guessing: 8 failed attempts per email/IP per 15 minutes.
const failures = new Map();
function tooMany(key) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter((t) => now - t < 15 * 60e3);
  failures.set(key, list);
  return list.length >= 8;
}
const fail = (key) => failures.set(key, [...(failures.get(key) || []), Date.now()]);

// Creates (or gives a password to) the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD.
export function bootstrapAdmin(db) {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return;
  const user = db.get('SELECT id, password_hash FROM users WHERE email = ?', [email]);
  if (!user) {
    db.run(`INSERT INTO users (name, email, role, reseller_id, password_hash, must_change_password) VALUES (?, ?, 'admin', NULL, ?, 1)`,
      [process.env.ADMIN_NAME || 'Kompas Admin', email, hashPassword(password)]);
    console.log(`Created administrator ${email}`);
  } else if (!user.password_hash) {
    db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(password), user.id]);
  }
}

export function authRoutes(app, db) {
  // version: the deployed commit (Render sets RENDER_GIT_COMMIT), shown at the bottom of the app.
  app.get('/auth/config', (_req, res) => res.json({ demo: demoEnabled(), password: true, version: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) }));

  app.get('/auth/demo-users', (_req, res) => {
    if (!demoEnabled()) return res.status(404).json({ error: 'Demo-login er slået fra.' });
    res.json(db.all(`SELECT u.id, u.name, u.email, u.role, r.name AS reseller FROM users u
                     LEFT JOIN resellers r ON r.id = u.reseller_id ORDER BY u.role, u.name`));
  });

  app.post('/auth/demo-login', (req, res) => {
    if (!demoEnabled()) return res.status(404).json({ error: 'Demo-login er slået fra.' });
    const user = db.get('SELECT id FROM users WHERE id = ?', [Number(req.body?.userId)]);
    if (!user) return res.status(400).json({ error: 'Ukendt bruger.' });
    startSession(db, req, res, user.id);
    res.json({ ok: true });
  });

  app.post('/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    if (tooMany(key)) return res.status(429).json({ error: 'For mange forsøg. Vent 15 minutter, og prøv igen.' });
    const user = db.get('SELECT id, password_hash FROM users WHERE email = ?', [email]);
    if (!user || !verifyPassword(req.body?.password || '', user.password_hash)) {
      fail(key);
      return res.status(401).json({ error: 'Forkert e-mail eller adgangskode.' });
    }
    failures.delete(key);
    startSession(db, req, res, user.id);
    res.json({ ok: true });
  });

  app.post('/auth/change-password', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Log venligst ind.' });
    const { current = '', next = '' } = req.body || {};
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (row.password_hash && !req.user.must_change_password && !verifyPassword(current, row.password_hash)) {
      return res.status(400).json({ error: 'Den nuværende adgangskode er forkert.' });
    }
    if (String(next).length < 10) return res.status(400).json({ error: 'Den nye adgangskode skal være mindst 10 tegn.' });
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(next), req.user.id]);
    // Sign out everywhere else.
    db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [req.user.id, readCookie(req, COOKIE)]);
    res.json({ ok: true });
  });

  // Administrator gives a user a new one-time password (shown once).
  app.post('/api/admin/users/:id/password', (req, res) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Kun Kompas-administratorer kan gøre dette.' });
    const user = db.get('SELECT id FROM users WHERE id = ?', [Number(req.params.id)]);
    if (!user) return res.status(404).json({ error: 'Brugeren findes ikke.' });
    const password = tempPassword();
    db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(password), user.id]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    res.json({ password });
  });

  app.post('/auth/logout', (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) db.run('DELETE FROM sessions WHERE token = ?', [token]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
}
