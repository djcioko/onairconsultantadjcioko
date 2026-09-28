// @vitest-environment jsdom

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {PartyApiError} from '../site/src/party-api.js';
import {createPartyGuest} from '../site/src/party-guest.js';
import {bootPartyGuest} from '../site/src/party-guest-entry.js';


function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.has(key) ? values.get(key) : null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn(key => values.delete(key)),
    value(key) { return values.get(key); },
  };
}


function manualTimers(now = 1_000_000) {
  let clock = now;
  let sequence = 0;
  const pending = new Map();
  return {
    setTimeout: vi.fn((callback, delay) => {
      const id = ++sequence;
      pending.set(id, {callback, delay});
      return id;
    }),
    clearTimeout: vi.fn(id => pending.delete(id)),
    now: () => clock,
    advance(milliseconds) { clock += milliseconds; },
    async runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [id, value] = entry;
      pending.delete(id);
      value.callback();
      await Promise.resolve();
      await Promise.resolve();
      return true;
    },
    get pendingCount() { return pending.size; },
    get delays() { return [...pending.values()].map(value => value.delay); },
  };
}


const pendingRequest = (overrides = {}) => ({
  requestId: 'request-1',
  state: 'pending',
  displayName: 'Ana',
  expiresAt: 1_090,
  participant: null,
  ...overrides,
});


function apiFixture(overrides = {}) {
  return {
    getStatus: vi.fn(async () => ({enabled: true, open: true, capacity: 9, available: 8})),
    createRequest: vi.fn(async () => ({
      requestId: 'request-1', credential: 'opaque-request-credential',
      state: 'pending', expiresAt: 1_090,
    })),
    getRequest: vi.fn(async () => pendingRequest()),
    cancel: vi.fn(async () => ({state: 'left'})),
    join: vi.fn(),
    reconnect: vi.fn(),
    leave: vi.fn(async () => ({state: 'left'})),
    ...overrides,
  };
}


function gridFixture() {
  return {
    applyRoster: vi.fn(), attachTrack: vi.fn(), detachTrack: vi.fn(),
    setTrackState: vi.fn(), setConnectionState: vi.fn(),
    setConnectionQuality: vi.fn(), setSpeaking: vi.fn(),
    remove: vi.fn(), clear: vi.fn(),
  };
}


function mediaTrack(kind) {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(function stop() { this.readyState = 'ended'; }),
  };
}


function mediaStream() {
  const video = mediaTrack('video');
  const audio = mediaTrack('audio');
  return {
    video,
    audio,
    getTracks: () => [video, audio],
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  };
}


function signedParticipant(identity, overrides = {}) {
  return {
    identity,
    attributes: {
      role: 'party-guest',
      display_name: 'Bea',
      display_sequence: '2',
      generation: '1',
    },
    isMicrophoneEnabled: true,
    isCameraEnabled: true,
    connectionQuality: 'good',
    trackPublications: new Map(),
    ...overrides,
  };
}


class FakeRoom {
  constructor(identity = 'guest-stable') {
    this.handlers = new Map();
    this.remoteParticipants = new Map();
    this.canPlaybackAudio = true;
    this.canPlaybackVideo = true;
    this.localParticipant = signedParticipant(identity, {
      attributes: {
        role: 'party-guest', display_name: 'Ana',
        display_sequence: '1', generation: '1',
      },
      publishTrack: vi.fn(async (track, options) => ({
        kind: track.kind,
        source: options.source,
        track: {
          kind: track.kind,
          attach: vi.fn(),
          detach: vi.fn(),
          mute: vi.fn(async () => { track.enabled = false; }),
          unmute: vi.fn(async () => { track.enabled = true; }),
        },
        isMuted: false,
      })),
    });
    this.connect = vi.fn(async () => {});
    this.disconnect = vi.fn(async () => {});
    this.startAudio = vi.fn(async () => { this.canPlaybackAudio = true; });
    this.startVideo = vi.fn(async () => { this.canPlaybackVideo = true; });
  }

  on(event, callback) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(callback);
    return this;
  }

  off(event, callback) {
    this.handlers.get(event)?.delete(callback);
    return this;
  }

  emit(event, ...args) {
    for (const callback of this.handlers.get(event) ?? []) callback(...args);
  }
}


function fixture({api = apiFixture(), session = {}, local = {}, timers = manualTimers()} = {}) {
  const root = document.createElement('section');
  document.body.append(root);
  const states = [];
  const grid = gridFixture();
  const controller = createPartyGuest({
    api,
    grid,
    roomFactory: vi.fn(),
    mediaDevices: {getUserMedia: vi.fn()},
    localStorage: memoryStorage(local),
    sessionStorage: memoryStorage(session),
    timers,
    onState: state => states.push(state),
  });
  return {
    api, controller, grid, root, states, timers,
    latest: () => states.at(-1),
  };
}


beforeEach(() => {
  document.body.textContent = '';
  vi.restoreAllMocks();
});


describe('party guest request lifecycle', () => {
  it('offers remembered names, normalizes the chosen name, and keeps one active request', async () => {
    const value = fixture({
      local: {'djcioko.party.names.v1': JSON.stringify(['Ana', 'Bea'])},
    });
    await value.controller.mount(value.root);
    expect([...value.root.querySelectorAll('datalist option')].map(option => option.value))
      .toEqual(['Ana', 'Bea']);

    const first = value.controller.raiseHand('  Ana Maria  ');
    const second = value.controller.raiseHand('Alt nume');
    await Promise.all([first, second]);

    expect(value.api.createRequest).toHaveBeenCalledTimes(1);
    expect(value.api.createRequest).toHaveBeenCalledWith(expect.objectContaining({name: 'Ana Maria'}));
    expect(value.latest()).toMatchObject({status: 'pending', displayName: 'Ana Maria'});
    expect(value.timers.pendingCount).toBe(1);
    expect(value.timers.delays).toEqual([2000]);
  });

  it('uses one epoch-safe poll timer and ignores a stale response after cancellation', async () => {
    let resolvePoll;
    const api = apiFixture({
      getRequest: vi.fn(() => new Promise(resolve => { resolvePoll = resolve; })),
    });
    const value = fixture({api});
    await value.controller.mount(value.root);
    await value.controller.raiseHand('Ana');
    const poll = value.controller.poll();
    await value.controller.leave();
    resolvePoll(pendingRequest({state: 'accepted', participant: {identity: 'guest-1'}}));
    await poll;
    expect(value.latest().status).toBe('idle');
    expect(value.api.cancel).toHaveBeenCalledTimes(1);
    expect(value.timers.pendingCount).toBe(0);
  });

  it('expires locally at 90 seconds and removes opaque request data from the session', async () => {
    const value = fixture();
    await value.controller.mount(value.root);
    await value.controller.raiseHand('Ana');
    expect(value.controller.state.status).toBe('pending');
    value.timers.advance(91_000);
    await value.timers.runNext();
    expect(value.latest()).toMatchObject({status: 'expired'});
    expect(value.controller.state.requestId).toBeNull();
  });

  it.each([
    ['declined', 'declined'],
    ['expired', 'expired'],
    ['removed', 'removed'],
    ['room_closed', 'room_closed'],
  ])('maps terminal server state %s and clears the active request', async (remote, expected) => {
    const value = fixture({api: apiFixture({
      getRequest: vi.fn(async () => pendingRequest({state: remote})),
    })});
    await value.controller.mount(value.root);
    await value.controller.raiseHand('Ana');
    await value.controller.poll();
    expect(value.latest().status).toBe(expected);
    expect(value.controller.state.requestId).toBeNull();
    expect(value.timers.pendingCount).toBe(0);
  });

  it('turns an accepted poll into an explicit join choice without requesting media', async () => {
    const value = fixture({api: apiFixture({
      getRequest: vi.fn(async () => pendingRequest({
        state: 'accepted',
        participant: {memberId: 'member-1', identity: 'guest-stable', generation: 1},
      })),
    })});
    await value.controller.mount(value.root);
    await value.controller.raiseHand('Ana');
    await value.controller.poll();
    expect(value.latest()).toMatchObject({status: 'accepted', identity: 'guest-stable'});
    expect(value.root.querySelector('[data-party-action="join"]')?.hidden).toBe(false);
  });

  it('restores an active opaque request after refresh and resumes polling', async () => {
    const saved = JSON.stringify({
      requestId: 'request-1', credential: 'opaque-request-credential',
      displayName: 'Ana', expiresAt: 1_090,
    });
    const value = fixture({session: {'djcioko.party.request.v1': saved}});
    await value.controller.mount(value.root);
    expect(value.api.createRequest).not.toHaveBeenCalled();
    expect(value.api.getRequest).toHaveBeenCalledTimes(1);
    expect(value.latest()).toMatchObject({status: 'pending', requestId: 'request-1'});
    expect(value.timers.pendingCount).toBe(1);
  });

  it('surfaces a full room without retaining a phantom request', async () => {
    const value = fixture({api: apiFixture({
      createRequest: vi.fn(async () => { throw new PartyApiError('ROOM_FULL', 409); }),
    })});
    await value.controller.mount(value.root);
    await expect(value.controller.raiseHand('Ana')).resolves.toBeUndefined();
    expect(value.latest()).toMatchObject({status: 'error', errorCode: 'ROOM_FULL'});
    expect(value.controller.state.requestId).toBeNull();
    expect(value.timers.pendingCount).toBe(0);
  });

  it('falls back cleanly when disabled and marks a closed room without a hand button', async () => {
    const disabled = fixture({api: apiFixture({
      getStatus: vi.fn(async () => ({enabled: false, open: false})),
    })});
    await disabled.controller.mount(disabled.root);
    expect(disabled.latest()).toMatchObject({status: 'idle', enabled: false, open: false});
    expect(disabled.root.hidden).toBe(true);

    const closed = fixture({api: apiFixture({
      getStatus: vi.fn(async () => ({enabled: true, open: false})),
    })});
    await closed.controller.mount(closed.root);
    expect(closed.latest()).toMatchObject({status: 'room_closed', enabled: true, open: false});
    expect(closed.root.querySelector('[data-party-action="raise"]')?.hidden).toBe(true);
    expect(closed.root.textContent).toContain('închis');
  });
});


describe('party guest media lifecycle', () => {
  async function acceptedFixture({api: overrides = {}, room, rooms} = {}) {
    const stream = mediaStream();
    const mediaDevices = {getUserMedia: vi.fn(async () => stream)};
    const createdRooms = rooms ?? [room ?? new FakeRoom()];
    const roomFactory = vi.fn(() => createdRooms.shift());
    const api = apiFixture({
      getRequest: vi.fn(async () => pendingRequest({
        state: 'accepted',
        participant: {memberId: 'member-1', identity: 'guest-stable', generation: 1},
      })),
      join: vi.fn(async () => ({
        url: 'wss://live.example.test', room: 'party-room', token: 'join-token',
        identity: 'guest-stable', generation: 1, expiresAt: 1_045,
      })),
      reconnect: vi.fn(async () => ({
        url: 'wss://live.example.test', room: 'party-room', token: 'reconnect-token',
        identity: 'guest-stable', generation: 2, expiresAt: 1_075,
      })),
      ...overrides,
    });
    const root = document.createElement('section');
    document.body.append(root);
    const states = [];
    const grid = gridFixture();
    const timers = manualTimers();
    const controller = createPartyGuest({
      api, grid, roomFactory, mediaDevices,
      localStorage: memoryStorage(), sessionStorage: memoryStorage(), timers,
      onState: state => states.push(state),
    });
    await controller.mount(root);
    await controller.raiseHand('Ana');
    await controller.poll();
    return {
      api, controller, grid, latest: () => states.at(-1), mediaDevices,
      roomFactory, root, states, stream, timers,
    };
  }

  it('waits for explicit consent, then uses bounded mobile capture and publishes one named track per kind', async () => {
    const room = new FakeRoom();
    const value = await acceptedFixture({room});
    expect(value.mediaDevices.getUserMedia).not.toHaveBeenCalled();

    await Promise.all([value.controller.join(), value.controller.join()]);

    expect(value.api.join).toHaveBeenCalledTimes(1);
    expect(value.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(value.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: {
        width: {ideal: 960, max: 960}, height: {ideal: 540, max: 540},
        frameRate: {ideal: 15, max: 15}, facingMode: 'user',
      },
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
    });
    expect(value.roomFactory).toHaveBeenCalledWith({adaptiveStream: true, dynacast: true});
    expect(room.connect).toHaveBeenCalledWith('wss://live.example.test', 'join-token', {
      autoSubscribe: true,
    });
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(room.localParticipant.publishTrack.mock.calls.map(call => call[1].name))
      .toEqual(['party-camera', 'party-microphone']);
    expect(room.localParticipant.publishTrack.mock.calls[0][1]).toMatchObject({
      source: 'camera', simulcast: true,
    });
    expect(room.localParticipant.publishTrack.mock.calls[1][1]).toMatchObject({source: 'microphone'});
    expect(value.latest()).toMatchObject({status: 'joined', identity: 'guest-stable'});
  });

  it('releases the reserved seat immediately when media permission is denied', async () => {
    const value = await acceptedFixture();
    value.mediaDevices.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await value.controller.join();
    expect(value.api.leave).toHaveBeenCalledTimes(1);
    expect(value.latest()).toMatchObject({status: 'error', errorCode: 'MEDIA_PERMISSION'});
    expect(value.controller.state.requestId).toBeNull();
  });

  it('treats a 45-second spent invitation as expired without asking for media', async () => {
    const value = await acceptedFixture({api: {
      join: vi.fn(async () => { throw new PartyApiError('JOIN_EXPIRED', 410); }),
    }});
    await value.controller.join();
    expect(value.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(value.latest().status).toBe('expired');
  });

  it('maps signed roster, subscribed tracks, mute, quality, speaking, and reconnect events into the grid', async () => {
    const room = new FakeRoom();
    const remote = signedParticipant('guest-remote');
    room.remoteParticipants.set(remote.identity, remote);
    const value = await acceptedFixture({room});
    await value.controller.join();
    expect(value.grid.applyRoster).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({identity: 'guest-remote', attributes: expect.objectContaining({display_name: 'Bea'})}),
    ]));

    const track = {kind: 'video', attach: vi.fn(), detach: vi.fn()};
    const publication = {kind: 'video', source: 'camera', isMuted: false};
    room.emit('trackSubscribed', track, publication, remote);
    room.emit('trackMuted', publication, remote);
    room.emit('trackUnmuted', publication, remote);
    room.emit('connectionQualityChanged', 'poor', remote);
    room.emit('activeSpeakersChanged', [remote]);
    room.emit('trackUnsubscribed', track, publication, remote);
    room.emit('reconnecting');
    room.emit('reconnected');

    expect(value.grid.attachTrack).toHaveBeenCalledWith('guest-remote', track, publication);
    expect(value.grid.setTrackState).toHaveBeenCalledWith('guest-remote', 'video', 'muted');
    expect(value.grid.setTrackState).toHaveBeenCalledWith('guest-remote', 'video', 'unmuted');
    expect(value.grid.setConnectionQuality).toHaveBeenCalledWith('guest-remote', 'poor');
    expect(value.grid.setSpeaking).toHaveBeenCalledWith('guest-remote', true);
    expect(value.grid.detachTrack).toHaveBeenCalledWith('guest-remote', 'video');
    expect(value.states.map(state => state.status)).toContain('reconnecting');
    expect(value.latest().status).toBe('joined');
  });

  it('mutes and unmutes local publications and always stops raw tracks on leave', async () => {
    const room = new FakeRoom();
    const value = await acceptedFixture({room});
    await value.controller.join();
    const [videoPublication, audioPublication] = await Promise.all(
      room.localParticipant.publishTrack.mock.results.map(result => result.value),
    );
    await value.controller.setMicrophoneEnabled(false);
    await value.controller.setMicrophoneEnabled(true);
    await value.controller.setCameraEnabled(false);
    await value.controller.setCameraEnabled(true);
    expect(audioPublication.track.mute).toHaveBeenCalledTimes(1);
    expect(audioPublication.track.unmute).toHaveBeenCalledTimes(1);
    expect(videoPublication.track.mute).toHaveBeenCalledTimes(1);
    expect(videoPublication.track.unmute).toHaveBeenCalledTimes(1);

    await value.controller.leave();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(value.api.leave).toHaveBeenCalledTimes(1);
    expect(value.stream.video.stop).toHaveBeenCalledTimes(1);
    expect(value.stream.audio.stop).toHaveBeenCalledTimes(1);
    expect(value.grid.clear).toHaveBeenCalled();
  });

  it('reconnects with the same stable identity and does not ask for media again', async () => {
    const firstRoom = new FakeRoom();
    const secondRoom = new FakeRoom();
    const value = await acceptedFixture({rooms: [firstRoom, secondRoom]});
    await value.controller.join();
    await value.controller.reconnect();
    expect(value.api.reconnect).toHaveBeenCalledTimes(1);
    expect(value.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(secondRoom.connect).toHaveBeenCalledWith(
      'wss://live.example.test', 'reconnect-token', {autoSubscribe: true},
    );
    expect(value.latest()).toMatchObject({
      status: 'joined', identity: 'guest-stable', generation: 2,
    });
  });

  it('rejects a reconnect grant that changes identity and releases the seat', async () => {
    const value = await acceptedFixture({
      rooms: [new FakeRoom(), new FakeRoom('other-identity')],
      api: {reconnect: vi.fn(async () => ({
        url: 'wss://live.example.test', token: 'bad-token',
        identity: 'other-identity', generation: 2, expiresAt: 1_075,
      }))},
    });
    await value.controller.join();
    await value.controller.reconnect();
    expect(value.latest()).toMatchObject({status: 'error', errorCode: 'IDENTITY_CHANGED'});
    expect(value.api.leave).toHaveBeenCalled();
  });

  it('shows a user-gesture fallback when autoplay is blocked', async () => {
    const room = new FakeRoom();
    const value = await acceptedFixture({room});
    await value.controller.join();
    room.canPlaybackAudio = false;
    room.emit('audioPlaybackChanged');
    const resume = value.root.querySelector('[data-party-action="resume-media"]');
    expect(resume?.hidden).toBe(false);
    resume.click();
    await Promise.resolve();
    expect(room.startAudio).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pending', 'cancel'],
    ['accepted', 'leave'],
    ['joined', 'leave'],
  ])('uses a keepalive %s request on pagehide and stops any local tracks', async (target, method) => {
    const room = new FakeRoom();
    const value = await acceptedFixture({room});
    if (target === 'joined') await value.controller.join();
    else if (target === 'pending') {
      await value.controller.leave({notify: false});
      await value.controller.raiseHand('Ana');
    }
    window.dispatchEvent(new Event('pagehide'));
    expect(value.api[method]).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.any(String),
      ...(method === 'leave' ? {keepalive: true} : {}),
    }));
    if (target === 'joined') {
      expect(value.stream.video.stop).toHaveBeenCalled();
      expect(value.stream.audio.stop).toHaveBeenCalled();
    }
    await value.controller.destroy();
  });
});


describe('party guest entry integration', () => {
  function entryDocument() {
    document.body.innerHTML = `
      <section data-legacy-guest-widget>Widget vechi</section>
      <section data-party-live-root hidden></section>
    `;
    return {
      legacy: document.querySelector('[data-legacy-guest-widget]'),
      root: document.querySelector('[data-party-live-root]'),
    };
  }

  it.each([
    [{enabled: false, open: false}, false, true],
    [{enabled: true, open: false}, true, true],
    [{enabled: true, open: true}, true, false],
  ])('hides legacy only when enabled and exposes the hand only while open', async (
    status, legacyHidden, handHidden,
  ) => {
    const elements = entryDocument();
    const api = apiFixture({getStatus: vi.fn(async () => status)});
    const result = await bootPartyGuest({
      document,
      window,
      createApi: vi.fn(() => api),
      createGrid: vi.fn(() => gridFixture()),
      roomFactory: vi.fn(() => new FakeRoom()),
      cryptoImpl: {getRandomValues: bytes => bytes.fill(7)},
    });
    expect(elements.legacy.hidden).toBe(legacyHidden);
    expect(elements.root.querySelector('[data-party-action="raise"]')?.hidden).toBe(handHidden);
    await result.controller.destroy();
  });

  it('reuses the browser key and restores the opaque credential into the API client', async () => {
    entryDocument();
    const browserKey = 'A'.repeat(24);
    const localStorage = memoryStorage({'djcioko.party.browser.v1': browserKey});
    const sessionStorage = memoryStorage({
      'djcioko.party.request.v1': JSON.stringify({
        requestId: 'request-1', credential: 'saved-opaque-credential',
        displayName: 'Ana', expiresAt: 1_090,
      }),
    });
    const createApi = vi.fn(() => apiFixture());
    const result = await bootPartyGuest({
      document,
      window: {...window, localStorage, sessionStorage},
      createApi,
      createGrid: vi.fn(() => gridFixture()),
      roomFactory: vi.fn(() => new FakeRoom()),
      cryptoImpl: {getRandomValues: vi.fn()},
    });
    expect(createApi).toHaveBeenCalledWith(expect.objectContaining({
      browserKey,
      requestToken: 'saved-opaque-credential',
    }));
    expect(localStorage.setItem).not.toHaveBeenCalledWith(
      'djcioko.party.browser.v1', expect.any(String),
    );
    await result.controller.destroy();
  });
});
