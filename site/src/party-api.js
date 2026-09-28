export class PartyApiError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'PartyApiError';
    this.code = code;
    this.status = status;
  }

  toJSON() { return {code: this.code, status: this.status}; }
}


const FRIENDLY_ERRORS = Object.freeze({
  PARTY_DISABLED: 'Camera de invitați nu este disponibilă momentan.',
  PARTY_CLOSED: 'Gazda a închis camera de invitați.',
  INVALID_NAME: 'Alege un nume între 1 și 32 de caractere.',
  AUTH_REQUIRED: 'Autentificarea gazdei a expirat.',
  REQUEST_BINDING: 'Cererea nu mai aparține acestui browser.',
  FORBIDDEN: 'Nu ai permisiunea pentru această acțiune.',
  CSRF: 'Sesiunea de administrare trebuie reîmprospătată.',
  ORIGIN: 'Cererea a fost blocată pentru siguranță.',
  REQUEST_DECLINED: 'Gazda a refuzat cererea.',
  ROOM_FULL: 'Camera este plină: maximum 9 persoane cu tot cu gazdă.',
  JOIN_ALREADY_EXCHANGED: 'Invitația a fost deja folosită. Reconectează-te dacă ai ieșit din rețea.',
  REVISION_CONFLICT: 'Lista s-a schimbat. A fost reîmprospătată.',
  IDEMPOTENCY_CONFLICT: 'Aceeași acțiune a fost trimisă cu alte date.',
  REQUEST_EXPIRED: 'Cererea a expirat. Ridică mâna din nou.',
  JOIN_EXPIRED: 'Timpul pentru intrare a expirat. Ridică mâna din nou.',
  RECONNECT_EXPIRED: 'Fereastra de reconectare a expirat.',
  REMOVED: 'Gazda te-a scos din cameră.',
  RATE_LIMIT: 'Ai încercat prea repede. Așteaptă puțin.',
  LIVE_UNAVAILABLE: 'Serviciul video nu răspunde momentan.',
  NETWORK: 'Conexiunea a fost întreruptă. Reîncearcă.',
  INVALID_RESPONSE: 'Serverul a trimis un răspuns neașteptat.',
});


export function partyFriendlyError(error) {
  return FRIENDLY_ERRORS[error?.code]
    || 'Acțiunea nu a reușit. Reîncearcă în câteva clipe.';
}


function objectResponse(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


function requireIdempotency(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new PartyApiError('IDEMPOTENCY_REQUIRED');
  }
  return value;
}


export function createPartyApi({
  fetchImpl = (...args) => globalThis.fetch(...args),
  csrf = '',
  browserKey = '',
  requestToken = '',
} = {}) {
  let credential = requestToken;

  async function call(path, {
    body,
    admin = false,
    publicRequest = false,
    protectedRequest = false,
    idempotencyKey,
    keepalive = false,
    timeoutMs = 8000,
  } = {}) {
    if (!path.startsWith('/api/')) throw new PartyApiError('INVALID_PATH');
    if (publicRequest && (typeof browserKey !== 'string' || browserKey.length < 8)) {
      throw new PartyApiError('REQUEST_BINDING', 403);
    }
    if (protectedRequest && (typeof credential !== 'string' || credential.length < 1)) {
      throw new PartyApiError('REQUEST_BINDING', 403);
    }
    const headers = {Accept: 'application/json'};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (publicRequest) headers['X-Party-Browser'] = browserKey;
    if (protectedRequest) headers['X-Party-Token'] = credential;
    if (idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = requireIdempotency(idempotencyKey);
    }
    if (admin && csrf) headers['X-DJCioko-CSRF'] = csrf;
    const options = {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive,
      signal: keepalive ? undefined : AbortSignal.timeout(timeoutMs),
    };
    let response;
    try {
      response = await fetchImpl(path, options);
    } catch {
      throw new PartyApiError('NETWORK');
    }
    let value;
    try { value = await response.json(); } catch {
      throw new PartyApiError('INVALID_RESPONSE', response.status);
    }
    if (!objectResponse(value)) {
      throw new PartyApiError('INVALID_RESPONSE', response.status);
    }
    if (!response.ok) {
      throw new PartyApiError(
        typeof value.error === 'string' ? value.error : 'LIVE_UNAVAILABLE',
        response.status,
      );
    }
    return value;
  }

  const api = {
    getStatus: () => call('/api/live/party/status', {publicRequest: true}),

    async createRequest({name, idempotencyKey}) {
      const result = await call('/api/live/party/request', {
        body: {name}, publicRequest: true, idempotencyKey,
      });
      if (typeof result.credential === 'string' && result.credential) {
        credential = result.credential;
      }
      return result;
    },

    getRequest: () => call('/api/live/party/request', {
      publicRequest: true, protectedRequest: true,
    }),

    cancel: ({idempotencyKey}) => call('/api/live/party/cancel', {
      body: {}, publicRequest: true, protectedRequest: true,
      idempotencyKey, keepalive: true,
    }),

    join: ({idempotencyKey}) => call('/api/live/party/join', {
      body: {}, publicRequest: true, protectedRequest: true, idempotencyKey,
    }),

    reconnect: ({idempotencyKey}) => call('/api/live/party/reconnect', {
      body: {}, publicRequest: true, protectedRequest: true, idempotencyKey,
    }),

    leave: ({idempotencyKey, keepalive = false}) => call('/api/live/party/leave', {
      body: {}, publicRequest: true, protectedRequest: true,
      idempotencyKey, keepalive,
    }),

    adminOpen: ({idempotencyKey}) => call('/api/admin/live/party/open', {
      body: {}, admin: true, idempotencyKey,
    }),

    adminRejoin: ({sessionId, idempotencyKey}) => call(
      '/api/admin/live/party/host-rejoin',
      {body: {sessionId}, admin: true, idempotencyKey},
    ),

    async adminStatus({sessionId, sinceRevision = -1, waitMs = 0}) {
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) {
        throw new PartyApiError('INVALID_WAIT');
      }
      if (!Number.isInteger(sinceRevision)) throw new PartyApiError('INVALID_WAIT');
      const query = new URLSearchParams({
        sessionId: String(sessionId),
        sinceRevision: String(sinceRevision),
        waitMs: String(waitMs),
      });
      return await call(`/api/admin/live/party/status?${query}`, {
        admin: true, timeoutMs: Math.max(8000, waitMs + 1000),
      });
    },

    adminAccept: ({sessionId, requestId, revision, idempotencyKey}) => call(
      '/api/admin/live/party/requests/accept', {
        body: {sessionId, requestId, expectedRevision: revision},
        admin: true, idempotencyKey,
      },
    ),

    adminDecline: ({sessionId, requestId, revision, idempotencyKey}) => call(
      '/api/admin/live/party/requests/decline', {
        body: {sessionId, requestId, expectedRevision: revision},
        admin: true, idempotencyKey,
      },
    ),

    adminRemove: ({sessionId, memberId, revision, idempotencyKey}) => call(
      '/api/admin/live/party/participants/remove', {
        body: {sessionId, memberId, expectedRevision: revision},
        admin: true, idempotencyKey,
      },
    ),

    adminClose: ({sessionId, revision, idempotencyKey}) => call(
      '/api/admin/live/party/close', {
        body: {sessionId, expectedRevision: revision},
        admin: true, idempotencyKey,
      },
    ),
  };
  return Object.freeze(api);
}
