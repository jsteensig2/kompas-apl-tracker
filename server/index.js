import express from 'express';
import XLSX from 'xlsx';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { authMiddleware, authRoutes, bootstrapAdmin } from './auth.js';
import { createApi, HttpError } from '../core/api.js';

export function createServer({ dbFile = process.env.DB_FILE || fileURLToPath(new URL('../data/kompas-apl.db', import.meta.url)) } = {}) {
  const db = openDatabase(dbFile);
  const api = createApi(db, { XLSX });
  bootstrapAdmin(db);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Render's HTTPS proxy
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
    // Changes must be sent as JSON; this blocks cross-site form posts (CSRF).
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Forespørgslen skal sendes som JSON.' });
    }
    next();
  });
  // Bibliotek: uploaded files come as base64 in JSON (up to 20 MB each); everything else stays small.
  app.use('/api/library/items', express.json({ limit: '30mb' }));
  app.use(express.json({ limit: '5mb' }));
  app.get('/healthz', (_req, res) => res.send('ok'));
  app.use(authMiddleware(db));
  // "Se som": an administrator can look at the system exactly as a reseller or viewer sees it.
  // The X-View-As header swaps the user for API reads only; every change is refused in that mode.
  app.use('/api', (req, res, next) => {
    const viewAs = Number(req.get('x-view-as'));
    if (!viewAs) return next();
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Kun Kompas-administratorer kan se systemet som en anden bruger.' });
    const target = db.get('SELECT id, name, email, role, reseller_id FROM users WHERE id = ?', [viewAs]);
    if (!target || target.role === 'admin') return res.status(400).json({ error: 'Brugeren kan ikke vises.' });
    if (req.method !== 'GET') return res.status(403).json({ error: `Du ser systemet som ${target.name}. Afslut visningen for at ændre noget.` });
    req.user = { ...target, must_change_password: 0, viewed_by: req.user.name };
    next();
  });
  authRoutes(app, db);

  // Private iCal subscription link for Apple Kalender, Outlook or Google (token in the URL).
  app.get('/calendar/feed/:token.ics', (req, res) => {
    try {
      const { contentType, data } = api.feed(req.params.token);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(data);
    } catch (err) {
      res.status(err.status || 500).send(err.message);
    }
  });

  // A consultant's own overview page, opened from the private link Kompas sends them (no login).
  app.get('/k/:token', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.sendFile(fileURLToPath(new URL('../public/konsulent.html', import.meta.url)));
  });
  app.get('/k/:token/data', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(api.consultantOverview(req.params.token));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Der opstod en fejl på serveren.' });
    }
  });

  // The consultant answers whether they can take a Foreløbig course (Tilmelding).
  app.put('/k/:token/signup/:id', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(api.setSignup(req.params.token, Number(req.params.id), req.body));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Der opstod en fejl på serveren.' });
    }
  });

  // The consultant page has shown the messages from Kompas (Beskeder).
  app.post('/k/:token/messages/read', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(api.markMessagesRead(req.params.token));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Der opstod en fejl på serveren.' });
    }
  });

  // Noter: the consultant writes or deletes a short note on one of their own courses.
  const kRoute = (fn) => (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(fn(req));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Der opstod en fejl på serveren.' });
    }
  };
  app.put('/k/:token/apple-email', kRoute((req) => api.setConsultantAppleEmail(req.params.token, req.body || {})));
  app.put('/k/:token/courses/:id/apple', kRoute((req) => api.setConsultantAppleReported(req.params.token, Number(req.params.id), req.body || {})));
  app.post('/k/:token/courses/:id/notes', kRoute((req) => api.consultantNotes(req.params.token, Number(req.params.id), req.body || {})));
  app.delete('/k/:token/notes/:id', kRoute((req) => api.deleteConsultantNote(req.params.token, Number(req.params.id))));

  // Bibliotek: the consultant opens a material from their page.
  app.get('/k/:token/library/:id/file', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      sendFile(res, api.consultantFile(req.params.token, Number(req.params.id)));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Der opstod en fejl på serveren.' });
    }
  });

  // Fetches the admin's own calendar (saved iCal link) and returns events to register.
  app.get('/api/calendar/events', async (req, res) => {
    try {
      if (!req.user) throw new HttpError(401, 'Log venligst ind.');
      if (req.user.role !== 'admin') throw new HttpError(403, 'Kun Kompas-administratorer kan gøre dette.');
      const url = api.calendarUrlFor(req.user);
      if (!url) throw new HttpError(400, 'Indsæt først linket til din kalender.');
      let ics;
      try {
        const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { accept: 'text/calendar' } });
        if (!r.ok) throw new Error(String(r.status));
        ics = await r.text();
      } catch {
        throw new HttpError(502, 'Kalenderen kunne ikke hentes. Tjek at linket er en offentlig iCal-kalender.');
      }
      res.json(api.handle({ method: 'POST', path: '/api/calendar/events', body: { ics }, user: req.user }).json);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Der opstod en fejl på serveren.' });
    }
  });

  // Administration › Skoler › Find postnumre (looks schools up on OpenStreetMap, one batch per call).
  app.post('/api/admin/schools/postal-lookup', async (req, res) => {
    try {
      if (!req.user) throw new HttpError(401, 'Log venligst ind.');
      res.json(await api.findPostalCodes(req.user, { after: req.body?.after }));
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Der opstod en fejl på serveren.' });
    }
  });

  app.all('/api/*', (req, res) => {
    try {
      const result = api.handle({ method: req.method, path: req.path, query: req.query, body: req.body, user: req.user });
      if (result.file) return sendFile(res, result.file);
      res.json(result.json);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(err);
      res.status(500).json({ error: 'Der opstod en fejl på serveren.' });
    }
  });

  // Browsers must check for a new version on every load, so updates show up without a hard refresh.
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  // SheetJS for reading Excel/CSV files in the browser (bulk import).
  app.get('/vendor/xlsx.full.min.js', (_req, res) => res.sendFile(fileURLToPath(new URL('../node_modules/xlsx/dist/xlsx.full.min.js', import.meta.url))));
  return { app, db };
}

// PDFs and photos open in the browser; anything else is downloaded, so an uploaded web page never runs on this site.
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function sendFile(res, { filename, contentType, data }) {
  const inline = INLINE.has(contentType);
  res.setHeader('Content-Type', inline || /^(text\/(csv|calendar)|application\/(vnd|zip|octet-stream))/.test(contentType) ? contentType : 'application/octet-stream');
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(typeof data === 'string' ? data : Buffer.from(data));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createServer().app.listen(port, () => console.log(`Kompas APL Tracker running on http://localhost:${port}`));
}
