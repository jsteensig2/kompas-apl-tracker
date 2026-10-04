// Talks to the Node server over HTTP. The browser preview swaps this file for an
// in-browser version with the same functions (see scripts/build-preview.js).

async function parse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Forespørgslen mislykkedes (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// "Se som": the administrator's chosen user, kept for this browser tab only.
const viewAsHeader = () => {
  const id = transport.viewAs;
  return id ? { 'x-view-as': String(id) } : {};
};

export const transport = {
  get viewAs() { try { return Number(sessionStorage.getItem('apl.viewAs')) || null; } catch { return null; } },
  set viewAs(id) { try { if (id) sessionStorage.setItem('apl.viewAs', String(id)); else sessionStorage.removeItem('apl.viewAs'); } catch { /* storage unavailable */ } },

  request(method, path, body) {
    const write = method !== 'GET';
    const auth = path.startsWith('/auth/');
    return fetch(path, {
      method,
      headers: { ...(write ? { 'content-type': 'application/json' } : {}), ...(auth ? {} : viewAsHeader()) },
      body: write ? JSON.stringify(body ?? {}) : undefined,
      credentials: 'same-origin',
    }).then(parse);
  },

  async download(path) {
    const res = await fetch(path, { credentials: 'same-origin', headers: viewAsHeader() });
    if (!res.ok) await parse(res);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'export';
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return name;
  },

  auth: {
    config: () => fetch('/auth/config').then(parse),
    demoUsers: () => fetch('/auth/demo-users').then(parse),
    login: (userId) => transport.request('POST', '/auth/demo-login', { userId }),
    logout: () => transport.request('POST', '/auth/logout', {}),
    passwordLogin: (email, password) => transport.request('POST', '/auth/login', { email, password }),
    changePassword: (current, next) => transport.request('POST', '/auth/change-password', { current, next }),
    resetPassword: (userId) => transport.request('POST', `/api/admin/users/${userId}/password`, {}),
  },
};
