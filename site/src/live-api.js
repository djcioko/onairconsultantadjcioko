export class LiveError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

export function approvedEndpoint(url) {
  if (url !== 'wss://djcioko.ro') throw new LiveError('INVALID_SERVER');
  return url;
}

export class LiveApi {
  constructor({fetchImpl = (...args) => globalThis.fetch(...args), csrf = '', token = ''} = {}) {
    this.fetchImpl = fetchImpl;
    this.csrf = csrf;
    this.token = token;
  }
  async call(path, body, {keepalive = false, signal} = {}) {
    if (!path.startsWith('/api/')) throw new LiveError('INVALID_PATH');
    const headers = {Accept: 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.csrf) headers['X-DJCioko-CSRF'] = this.csrf;
    if (this.token) headers['X-Live-Token'] = this.token;
    let response;
    try {
      response = await this.fetchImpl(path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', keepalive,
        signal: signal ?? (keepalive ? undefined : AbortSignal.timeout(8000)),
      });
    } catch { throw new LiveError('NETWORK'); }
    let data;
    try { data = await response.json(); } catch { throw new LiveError('INVALID_RESPONSE', response.status); }
    if (!response.ok) throw new LiveError(data.error || 'UNAVAILABLE', response.status);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new LiveError('INVALID_RESPONSE');
    return data;
  }
}

export const friendlyError = error => ({
  FULL: 'Toate cele 20 de locuri sunt ocupate. Reîncearcă în câteva clipe.',
  OFFLINE: 'Emisia este oprită momentan.',
  LIVE_DISABLED: 'Studioul se pregătește. Revino puțin mai târziu.',
  RATE_LIMIT: 'Ai încercat prea repede. Așteaptă un minut.',
  REAUTH_REQUIRED: 'Confirmă parola pentru această acțiune.',
  PUBLISHER_ACTIVE: 'Un studio transmite deja. Oprește-l înainte de a porni aici.',
  NETWORK: 'Conexiunea a fost întreruptă. Reîncearcă.',
  NotAllowedError: 'Permite camera și microfonul din setările browserului, apoi reîncearcă.',
  NotFoundError: 'Nu am găsit o cameră și un microfon disponibile.',
}[error?.code || error?.name] || 'Acțiunea nu a reușit. Reîncearcă în câteva clipe.');
