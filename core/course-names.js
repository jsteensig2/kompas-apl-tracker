// Uniform course names (Jakob, 2026-10-12): a module course is called "Modul N – Lærere" or
// "Modul N – Pædagoger", so courses for teachers and pedagogues and the modules can be told apart.
// Old spellings ("Modul 2 (lærere)", "LÆRERE Modul 2", "Mac – module 2" at 14:00) are read here.

export const AUDIENCES = ['Lærere', 'Pædagoger'];

export function standardTitle(module, audience) {
  return `Modul ${module} – ${audience}`;
}

// The target group named in a text, or '' when none (or both) are named.
export function audienceIn(text) {
  const s = String(text ?? '').toLowerCase();
  const teachers = /lærer|teacher/.test(s);
  const pedagogues = /pædagog|paedagog/.test(s);
  return teachers === pedagogues ? '' : teachers ? 'Lærere' : 'Pædagoger';
}

// "Modul 2", "module 2", "Modul2" -> "2"; '' when the text names no module.
export function moduleIn(text) {
  return /\bmodule?\s*(\d{1,2})\b/i.exec(String(text ?? ''))?.[1].replace(/^0+(?=\d)/, '') || '';
}

// In Høje-Taastrup the pedagogues have their courses at 09:00 and the teachers at 14:00 (Jakob, 2026-10-06).
export function htkAudienceAt(startTime) {
  return startTime === '09:00' ? 'Pædagoger' : startTime === '14:00' ? 'Lærere' : '';
}

export const isHtk = (municipality) => /^høje.?taastrup/i.test(String(municipality ?? '').trim());

// { module, audience, title, byTime } when the title is a module course whose target group is known
// (from the title itself, or in Høje-Taastrup from the time); null otherwise.
export function moduleCourse(title, { startTime = null, municipality = '' } = {}) {
  const module = moduleIn(title);
  if (!module) return null;
  let audience = audienceIn(title);
  const byTime = !audience;
  if (!audience && isHtk(municipality)) audience = htkAudienceAt(startTime);
  if (!audience) return null;
  return { module, audience, title: standardTitle(module, audience), byTime };
}
