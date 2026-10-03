// In-browser stand-in for public/js/transport.js, used only by the clickable preview
// (scripts/build-preview.js). It runs the same core/api.js access rules against an
// in-memory SQLite database (sql.js), so the preview behaves like the real server.
import { SCHEMA, migrate } from '../core/schema.js';
import { seed } from '../core/seed.js';
import { createApi, HttpError } from '../core/api.js';

const KEY = 'apl.preview.db.v3';
const SQL = await window.initSqlJs();

function load() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return new SQL.Database(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)));
  } catch { /* start fresh */ }
  return null;
}
const raw = load() || new SQL.Database();
const db = {
  all(sql, params = []) {
    const st = raw.prepare(sql);
    st.bind(params);
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    st.free();
    return rows;
  },
  get(sql, params = []) { return db.all(sql, params)[0]; },
  run(sql, params = []) {
    raw.run(sql, params);
    return { changes: raw.getRowsModified(), lastInsertRowid: raw.exec('SELECT last_insert_rowid()')[0].values[0][0] };
  },
  exec: (sql) => raw.exec(sql),
};
db.exec(SCHEMA);
migrate(db);
if (db.get('SELECT COUNT(*) AS n FROM municipalities').n === 0) { seed(db); migrate(db); }

function persist() {
  try {
    const bytes = raw.export();
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    localStorage.setItem(KEY, btoa(s));
  } catch { /* storage unavailable: data lives until reload */ }
}

const api = createApi(db, { XLSX: window.XLSX });
let userId = null;
try { userId = Number(localStorage.getItem('apl.preview.user')) || null; } catch { /* none */ }
const currentUser = () => (userId ? db.get('SELECT id, name, email, role, reseller_id FROM users WHERE id = ?', [userId]) || null : null);

function call(method, path, body) {
  const url = new URL(path, 'https://preview.local');
  try {
    const result = api.handle({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, user: currentUser() });
    if (method !== 'GET') persist();
    return result;
  } catch (e) {
    const err = new Error(e instanceof HttpError ? e.message : 'Der opstod en fejl.');
    err.status = e.status || 500;
    if (!(e instanceof HttpError)) console.error(e);
    throw err;
  }
}

export const transport = {
  isPreview: true,
  async request(method, path, body) {
    return call(method, path, body).json;
  },
  async download(path) {
    const { filename, data } = call('GET', path).file;
    const downloads = await window.claude?.use?.('downloads');
    if (!downloads) throw new Error('Filer kan ikke gemmes i denne visning. Eksport virker normalt i den fulde app.');
    try {
      await downloads.save({ filename, data });
      return filename;
    } catch (e) {
      if (e?.code === 'declined') return null;
      throw new Error(e?.message || 'Filen kunne ikke gemmes.');
    }
  },
  auth: {
    config: async () => ({ demo: true, password: false }),
    demoUsers: async () => db.all(`SELECT u.id, u.name, u.email, u.role, r.name AS reseller FROM users u
                                   LEFT JOIN resellers r ON r.id = u.reseller_id ORDER BY u.role, u.name`),
    async login(id) {
      userId = Number(id);
      try { localStorage.setItem('apl.preview.user', String(userId)); } catch { /* ignore */ }
      return { ok: true };
    },
    async logout() {
      userId = null;
      try { localStorage.removeItem('apl.preview.user'); } catch { /* ignore */ }
      return { ok: true };
    },
  },
};
