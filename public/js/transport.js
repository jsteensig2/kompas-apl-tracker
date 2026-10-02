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

export const transport = {
  request(method, path, body) {
    const write = method !== 'GET';
    return fetch(path, {
      method,
      headers: write ? { 'content-type': 'application/json' } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
      credentials: 'same-origin',
    }).then(parse);
  },

  async download(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
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
