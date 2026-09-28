import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  PartyApiError,
  createPartyApi,
  partyFriendlyError,
} from '../site/src/party-api.js';


const ok = (value = {ok: true}, status = 200) => ({
  ok: true,
  status,
  async json() { return value; },
});


function fixture(responses = []) {
  const calls = [];
  const fetchImpl = vi.fn(async (path, options) => {
    calls.push({path, options});
    return responses.length ? responses.shift() : ok();
  });
  const api = createPartyApi({
    fetchImpl, csrf: 'csrf-value', browserKey: 'browser-key-value',
    requestToken: 'request-token-value',
  });
  return {api, calls, fetchImpl};
}


afterEach(() => vi.restoreAllMocks());


describe('party API request contract', () => {
  it('maps every public and admin method to the exact path and JSON body', async () => {
    const value = fixture();
    await value.api.getStatus();
    await value.api.createRequest({name: 'Ana', idempotencyKey: 'idem-request'});
    await value.api.getRequest();
    await value.api.cancel({idempotencyKey: 'idem-cancel'});
    await value.api.join({idempotencyKey: 'idem-join'});
    await value.api.reconnect({idempotencyKey: 'idem-reconnect'});
    await value.api.leave({idempotencyKey: 'idem-leave', keepalive: true});
    await value.api.adminOpen({idempotencyKey: 'idem-open'});
    await value.api.adminRejoin({sessionId: 'session-1', idempotencyKey: 'idem-rejoin'});
    await value.api.adminStatus({sessionId: 'session-1', sinceRevision: 7, waitMs: 7000});
    await value.api.adminAccept({
      sessionId: 'session-1', requestId: 'request-1', revision: 8,
      idempotencyKey: 'idem-accept',
    });
    await value.api.adminDecline({
      sessionId: 'session-1', requestId: 'request-2', revision: 9,
      idempotencyKey: 'idem-decline',
    });
    await value.api.adminRemove({
      sessionId: 'session-1', memberId: 'member-1', revision: 10,
      idempotencyKey: 'idem-remove',
    });
    await value.api.adminClose({
      sessionId: 'session-1', revision: 11, idempotencyKey: 'idem-close',
    });

    expect(value.calls.map(call => call.path)).toEqual([
      '/api/live/party/status',
      '/api/live/party/request',
      '/api/live/party/request',
      '/api/live/party/cancel',
      '/api/live/party/join',
      '/api/live/party/reconnect',
      '/api/live/party/leave',
      '/api/admin/live/party/open',
      '/api/admin/live/party/host-rejoin',
      '/api/admin/live/party/status?sessionId=session-1&sinceRevision=7&waitMs=7000',
      '/api/admin/live/party/requests/accept',
      '/api/admin/live/party/requests/decline',
      '/api/admin/live/party/participants/remove',
      '/api/admin/live/party/close',
    ]);
    expect(value.calls.map(call => call.options.method)).toEqual([
      'GET', 'POST', 'GET', 'POST', 'POST', 'POST', 'POST',
      'POST', 'POST', 'GET', 'POST', 'POST', 'POST', 'POST',
    ]);
    expect(value.calls.map(call => call.options.body && JSON.parse(call.options.body))).toEqual([
      undefined, {name: 'Ana'}, undefined, {}, {}, {}, {}, {},
      {sessionId: 'session-1'}, undefined,
      {sessionId: 'session-1', requestId: 'request-1', expectedRevision: 8},
      {sessionId: 'session-1', requestId: 'request-2', expectedRevision: 9},
      {sessionId: 'session-1', memberId: 'member-1', expectedRevision: 10},
      {sessionId: 'session-1', expectedRevision: 11},
    ]);
  });

  it('keeps browser/token/idempotency/CSRF bindings in headers only', async () => {
    const value = fixture();
    await value.api.join({idempotencyKey: 'join-key'});
    await value.api.adminAccept({
      sessionId: 'session', requestId: 'request', revision: 3,
      idempotencyKey: 'accept-key',
    });
    const [guest, admin] = value.calls;
    expect(guest.options.headers).toMatchObject({
      'X-Party-Browser': 'browser-key-value',
      'X-Party-Token': 'request-token-value',
      'Idempotency-Key': 'join-key',
    });
    expect(guest.options.headers).not.toHaveProperty('X-DJCioko-CSRF');
    expect(admin.options.headers).toMatchObject({
      'X-DJCioko-CSRF': 'csrf-value',
      'Idempotency-Key': 'accept-key',
    });
    expect(admin.options.headers).not.toHaveProperty('X-Party-Token');
    for (const call of value.calls) {
      expect(call.path).not.toContain('request-token-value');
      expect(call.path).not.toContain('browser-key-value');
      expect(call.options.credentials).toBe('same-origin');
      expect(call.options.cache).toBe('no-store');
      expect(call.options.referrerPolicy).toBe('no-referrer');
    }
  });

  it('adopts the credential returned by request creation without exposing a setter', async () => {
    const value = fixture([
      ok({requestId: 'request', credential: 'new-credential', state: 'pending', expiresAt: 9}, 201),
      ok({requestId: 'request', state: 'pending', displayName: 'Ana', expiresAt: 9, participant: null}),
    ]);
    await value.api.createRequest({name: 'Ana', idempotencyKey: 'request-key'});
    await value.api.getRequest();
    expect(value.calls[1].options.headers['X-Party-Token']).toBe('new-credential');
    expect(value.api.requestToken).toBeUndefined();
  });

  it('uses keepalive for cancel and requested leave, with no abort signal', async () => {
    const value = fixture();
    await value.api.cancel({idempotencyKey: 'cancel-key'});
    await value.api.leave({idempotencyKey: 'leave-key', keepalive: true});
    for (const call of value.calls) {
      expect(call.options.keepalive).toBe(true);
      expect(call.options.signal).toBeUndefined();
    }
  });

  it('uses an eight-second abort timeout for ordinary requests', async () => {
    const signal = {name: 'party-timeout'};
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const value = fixture();
    await value.api.getStatus();
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(value.calls[0].options.signal).toBe(signal);
  });

  it('rejects invalid long-poll bounds before fetch and allows 25 seconds', async () => {
    const value = fixture();
    await expect(value.api.adminStatus({
      sessionId: 's', sinceRevision: 1, waitMs: -1,
    })).rejects.toMatchObject({code: 'INVALID_WAIT'});
    await expect(value.api.adminStatus({
      sessionId: 's', sinceRevision: 1, waitMs: 25001,
    })).rejects.toMatchObject({code: 'INVALID_WAIT'});
    expect(value.calls).toEqual([]);
    await value.api.adminStatus({sessionId: 's', sinceRevision: 1, waitMs: 25000});
    expect(value.calls[0].path).toContain('waitMs=25000');
  });
});


describe('party API validation and safe errors', () => {
  it('rejects non-object, array, malformed, and successful invalid JSON responses', async () => {
    const invalid = [
      ok(null), ok([]), ok('text'),
      {ok: true, status: 200, async json() { throw new Error('secret response'); }},
    ];
    for (const response of invalid) {
      const value = fixture([response]);
      await expect(value.api.getStatus()).rejects.toMatchObject({code: 'INVALID_RESPONSE'});
    }
  });

  it('throws only stable error metadata and never includes credential-bearing bodies', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 409,
      async json() {
        return {error: 'ROOM_FULL', token: 'server-secret-token', detail: 'private detail'};
      },
    }));
    const api = createPartyApi({
      fetchImpl, browserKey: 'browser-key', requestToken: 'request-secret-token',
    });
    let error;
    try { await api.join({idempotencyKey: 'join-key'}); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PartyApiError);
    expect(error).toMatchObject({code: 'ROOM_FULL', status: 409});
    expect(String(error)).not.toContain('server-secret-token');
    expect(String(error)).not.toContain('request-secret-token');
    expect(JSON.stringify(error)).not.toContain('server-secret-token');
  });

  it('maps network failures without retaining the original exception', async () => {
    const api = createPartyApi({
      fetchImpl: async () => { throw new Error('https://example/?token=secret'); },
      browserKey: 'browser-key',
    });
    await expect(api.getStatus()).rejects.toMatchObject({code: 'NETWORK', status: 0});
  });

  it.each([
    ['PARTY_DISABLED', 'Camera de invitați nu este disponibilă momentan.'],
    ['PARTY_CLOSED', 'Gazda a închis camera de invitați.'],
    ['INVALID_NAME', 'Alege un nume între 1 și 32 de caractere.'],
    ['AUTH_REQUIRED', 'Autentificarea gazdei a expirat.'],
    ['REQUEST_BINDING', 'Cererea nu mai aparține acestui browser.'],
    ['FORBIDDEN', 'Nu ai permisiunea pentru această acțiune.'],
    ['CSRF', 'Sesiunea de administrare trebuie reîmprospătată.'],
    ['ORIGIN', 'Cererea a fost blocată pentru siguranță.'],
    ['REQUEST_DECLINED', 'Gazda a refuzat cererea.'],
    ['ROOM_FULL', 'Camera este plină: maximum 9 persoane cu tot cu gazdă.'],
    ['JOIN_ALREADY_EXCHANGED', 'Invitația a fost deja folosită. Reconectează-te dacă ai ieșit din rețea.'],
    ['REVISION_CONFLICT', 'Lista s-a schimbat. A fost reîmprospătată.'],
    ['IDEMPOTENCY_CONFLICT', 'Aceeași acțiune a fost trimisă cu alte date.'],
    ['REQUEST_EXPIRED', 'Cererea a expirat. Ridică mâna din nou.'],
    ['JOIN_EXPIRED', 'Timpul pentru intrare a expirat. Ridică mâna din nou.'],
    ['RECONNECT_EXPIRED', 'Fereastra de reconectare a expirat.'],
    ['REMOVED', 'Gazda te-a scos din cameră.'],
    ['RATE_LIMIT', 'Ai încercat prea repede. Așteaptă puțin.'],
    ['LIVE_UNAVAILABLE', 'Serviciul video nu răspunde momentan.'],
  ])('maps %s to a Romanian message', (code, message) => {
    expect(partyFriendlyError({code})).toBe(message);
  });
});
