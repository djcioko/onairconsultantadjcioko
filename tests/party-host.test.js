// @vitest-environment jsdom

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {PartyApiError} from '../site/src/party-api.js';
import {
  createPartyHost,
  setPartyHostAvailability,
} from '../studio/src/party-host.js';


function manualTimers(now = 1_000_000) {
  let clock = now;
  let id = 0;
  const pending = new Map();
  return {
    now: () => clock,
    setTimeout: vi.fn((callback, delay) => {
      const key = ++id;
      pending.set(key, {callback, delay});
      return key;
    }),
    clearTimeout: vi.fn(key => pending.delete(key)),
    advance(value) { clock += value; },
    async runNext() {
      const next = pending.entries().next().value;
      if (!next) return;
      const [key, task] = next;
      pending.delete(key);
      task.callback();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    get pendingCount() { return pending.size; },
    get delays() { return [...pending.values()].map(task => task.delay); },
  };
}


function localTrack(kind) {
  return {
    kind,
    mediaStreamTrack: {kind, enabled: true, readyState: 'live'},
    attach: vi.fn(),
    detach: vi.fn(),
    mute: vi.fn(async function mute() { this.mediaStreamTrack.enabled = false; }),
    unmute: vi.fn(async function unmute() { this.mediaStreamTrack.enabled = true; }),
  };
}


function partyTracks() {
  return {videoTrack: localTrack('video'), audioTrack: localTrack('audio')};
}


function participant(identity, overrides = {}) {
  return {
    identity,
    attributes: {
      role: identity === 'host-stable' ? 'party-host' : 'party-guest',
      display_name: identity === 'host-stable' ? 'DJ Cioko' : 'Ana',
      display_sequence: identity === 'host-stable' ? '0' : '1',
      generation: '1',
    },
    isMicrophoneEnabled: true,
    isCameraEnabled: true,
    connectionQuality: 'excellent',
    trackPublications: new Map(),
    ...overrides,
  };
}


class FakeRoom {
  constructor(identity = 'host-stable') {
    this.handlers = new Map();
    this.remoteParticipants = new Map();
    this.localParticipant = participant(identity, {
      publishTrack: vi.fn(async (track, options) => ({
        kind: track.kind, source: options.source, track, isMuted: false,
      })),
    });
    this.connect = vi.fn(async () => {});
    this.disconnect = vi.fn(async () => {});
  }
  on(event, callback) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(callback);
    return this;
  }
  off(event, callback) { this.handlers.get(event)?.delete(callback); return this; }
  emit(event, ...args) {
    for (const callback of this.handlers.get(event) ?? []) callback(...args);
  }
}


const hostRoster = (state = 'active') => ({
  memberId: null,
  identity: 'host-stable',
  role: 'host',
  displayName: 'DJ Cioko',
  displaySequence: 0,
  state,
});


const waitingRequest = (overrides = {}) => ({
  requestId: 'request-1', displayName: 'Ana', displaySequence: 1,
  state: 'pending', createdAt: 995, expiresAt: 1_090,
  ...overrides,
});


const statusSnapshot = (overrides = {}) => ({
  sessionId: 'session-1', revision: 1, state: 'open', capacity: 9,
  occupancy: 1, requests: [], participants: [hostRoster()],
  ...overrides,
});


function apiFixture(overrides = {}) {
  return {
    adminOpen: vi.fn(async () => ({
      sessionId: 'session-1', revision: 1, state: 'open',
      capacity: 9, occupancy: 1, identity: 'host-stable', generation: 1,
      url: 'wss://djcioko.ro', token: 'host-token',
    })),
    adminRejoin: vi.fn(async () => ({
      sessionId: 'session-1', revision: 3, identity: 'host-stable', generation: 2,
      url: 'wss://djcioko.ro', token: 'rejoin-token', expiresAt: 1_030,
    })),
    adminStatus: vi.fn(async () => statusSnapshot()),
    adminAccept: vi.fn(async () => ({
      requestId: 'request-1', memberId: 'member-1', identity: 'guest-1',
      state: 'accepted', generation: 1, revision: 2,
    })),
    adminDecline: vi.fn(async () => ({requestId: 'request-2', state: 'declined', revision: 3})),
    adminRemove: vi.fn(async () => ({memberId: 'member-1', identity: 'guest-1', state: 'removed', revision: 4})),
    adminClose: vi.fn(async () => ({sessionId: 'session-1', state: 'closed', revision: 5})),
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


function mediaFixture() {
  const tracks = partyTracks();
  return {
    tracks,
    bridge: {
      createOwnedTracks: vi.fn(() => tracks),
      setAudioEnabled: vi.fn(async (_tracks, enabled) => {
        tracks.audioTrack.mediaStreamTrack.enabled = enabled;
      }),
      setVideoEnabled: vi.fn(async (_tracks, enabled) => {
        tracks.videoTrack.mediaStreamTrack.enabled = enabled;
      }),
      stopOwnedTracks: vi.fn(),
    },
  };
}


function fixture({api = apiFixture(), rooms, media = mediaFixture(), timers = manualTimers()} = {}) {
  const roomList = rooms ?? [new FakeRoom()];
  const roomFactory = vi.fn(() => roomList.shift());
  const states = [];
  const grid = gridFixture();
  const controller = createPartyHost({
    api, grid, roomFactory, mediaBridge: media.bridge, timers,
    onState: state => states.push(state),
  });
  return {
    api, controller, grid, media, roomFactory, states, timers,
    latest: () => states.at(-1),
  };
}


beforeEach(() => {
  document.body.textContent = '';
  vi.restoreAllMocks();
});


describe('party host room lifecycle', () => {
  it('opens at 1/9 and publishes exactly one bounded named camera and microphone track', async () => {
    const room = new FakeRoom();
    const value = fixture({rooms: [room]});
    await value.controller.open();

    expect(value.media.bridge.createOwnedTracks).toHaveBeenCalledTimes(1);
    expect(value.api.adminOpen).toHaveBeenCalledTimes(1);
    expect(value.roomFactory).toHaveBeenCalledWith({adaptiveStream: true, dynacast: true});
    expect(room.connect).toHaveBeenCalledWith('wss://djcioko.ro', 'host-token', {autoSubscribe: true});
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    const options = room.localParticipant.publishTrack.mock.calls.map(call => call[1]);
    expect(options.map(value => value.name)).toEqual(['party-camera', 'party-microphone']);
    expect(options[0]).toMatchObject({source: 'camera', simulcast: true});
    expect(options[0].videoEncoding.maxFramerate).toBeLessThanOrEqual(15);
    expect(options[0].videoSimulcastLayers.every(layer => (
      layer.width <= 960 && layer.height <= 540 && layer.encoding.maxFramerate <= 15
    ))).toBe(true);
    expect(options[1]).toMatchObject({source: 'microphone'});
    expect(value.latest()).toMatchObject({status: 'open', occupancy: 1, capacity: 9});
  });

  it('uses revision-based 25-second long polling and exposes named countdowns', async () => {
    const api = apiFixture({
      adminStatus: vi.fn()
        .mockResolvedValueOnce(statusSnapshot())
        .mockResolvedValueOnce(statusSnapshot({
          revision: 2,
          requests: [waitingRequest()],
        })),
    });
    const value = fixture({api});
    await value.controller.open();
    expect(value.timers.pendingCount).toBe(1);
    await value.timers.runNext();
    expect(api.adminStatus).toHaveBeenLastCalledWith({
      sessionId: 'session-1', sinceRevision: 1, waitMs: 25000,
    });
    expect(value.latest().requests[0]).toMatchObject({
      requestId: 'request-1', displayName: 'Ana', remainingSeconds: 90,
    });
    expect(value.latest().revision).toBe(2);
  });

  it('deduplicates repeated accept/decline actions and applies returned revisions', async () => {
    const api = apiFixture({
      adminStatus: vi.fn(async () => statusSnapshot({
        revision: 5,
        requests: [waitingRequest(), waitingRequest({requestId: 'request-2', displayName: 'Bea'})],
      })),
    });
    const value = fixture({api});
    await value.controller.open();
    await Promise.all([
      value.controller.accept('request-1'),
      value.controller.accept('request-1'),
    ]);
    await Promise.all([
      value.controller.decline('request-2'),
      value.controller.decline('request-2'),
    ]);
    expect(api.adminAccept).toHaveBeenCalledTimes(1);
    expect(api.adminAccept).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', requestId: 'request-1', revision: 5,
    }));
    expect(api.adminDecline).toHaveBeenCalledTimes(1);
  });

  it('blocks a ninth guest at 9/9 and surfaces the same server capacity error when state is stale', async () => {
    const fullApi = apiFixture({adminStatus: vi.fn(async () => statusSnapshot({
      occupancy: 9, requests: [waitingRequest()],
    }))});
    const full = fixture({api: fullApi});
    await full.controller.open();
    await full.controller.accept('request-1');
    expect(fullApi.adminAccept).not.toHaveBeenCalled();
    expect(full.latest()).toMatchObject({errorCode: 'ROOM_FULL', acceptDisabled: true});

    const staleApi = apiFixture({
      adminStatus: vi.fn(async () => statusSnapshot({occupancy: 8, requests: [waitingRequest()]})),
      adminAccept: vi.fn(async () => { throw new PartyApiError('ROOM_FULL', 409); }),
    });
    const stale = fixture({api: staleApi});
    await stale.controller.open();
    await stale.controller.accept('request-1');
    expect(stale.latest()).toMatchObject({errorCode: 'ROOM_FULL'});
  });

  it('keeps stable roster tiles while mapping LiveKit track, mute, quality and reconnect events', async () => {
    const room = new FakeRoom();
    const remote = participant('guest-1');
    room.remoteParticipants.set(remote.identity, remote);
    const api = apiFixture({adminStatus: vi.fn(async () => statusSnapshot({
      occupancy: 2,
      participants: [hostRoster(), {
        memberId: 'member-1', identity: 'guest-1', role: 'guest',
        displayName: 'Ana', displaySequence: 1, state: 'active',
      }],
    }))});
    const value = fixture({api, rooms: [room]});
    await value.controller.open();
    const track = {kind: 'video', attach: vi.fn(), detach: vi.fn()};
    const publication = {kind: 'video', source: 'camera'};
    room.emit('trackSubscribed', track, publication, remote);
    room.emit('trackMuted', publication, remote);
    room.emit('trackUnmuted', publication, remote);
    room.emit('connectionQualityChanged', 'poor', remote);
    room.emit('activeSpeakersChanged', [remote]);
    room.emit('trackUnsubscribed', track, publication, remote);
    room.emit('reconnecting');
    room.emit('reconnected');

    expect(value.grid.applyRoster).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({identity: 'guest-1', displayName: 'Ana'}),
    ]));
    expect(value.grid.attachTrack).toHaveBeenCalledWith('guest-1', track, publication);
    expect(value.grid.setTrackState).toHaveBeenCalledWith('guest-1', 'video', 'muted');
    expect(value.grid.setTrackState).toHaveBeenCalledWith('guest-1', 'video', 'unmuted');
    expect(value.grid.setConnectionQuality).toHaveBeenCalledWith('guest-1', 'poor');
    expect(value.grid.setSpeaking).toHaveBeenCalledWith('guest-1', true);
    expect(value.grid.detachTrack).toHaveBeenCalledWith('guest-1', 'video');
    expect(value.states.map(state => state.status)).toContain('reconnecting');
    expect(value.latest().status).toBe('open');
  });

  it('removes one participant by stable member id and revision', async () => {
    const api = apiFixture({adminStatus: vi.fn(async () => statusSnapshot({
      revision: 7,
      occupancy: 2,
      participants: [hostRoster(), {
        memberId: 'member-1', identity: 'guest-1', role: 'guest',
        displayName: 'Ana', displaySequence: 1, state: 'active',
      }],
    }))});
    const value = fixture({api});
    await value.controller.open();
    await value.controller.remove('member-1');
    expect(api.adminRemove).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', memberId: 'member-1', revision: 7,
    }));
  });

  it('rejoins within the host window with the stable identity and reuses owned tracks', async () => {
    const first = new FakeRoom();
    const second = new FakeRoom();
    const value = fixture({rooms: [first, second]});
    await value.controller.open();
    await value.controller.reconnect();
    expect(value.api.adminRejoin).toHaveBeenCalledTimes(1);
    expect(value.media.bridge.createOwnedTracks).toHaveBeenCalledTimes(1);
    expect(second.connect).toHaveBeenCalledWith('wss://djcioko.ro', 'rejoin-token', {autoSubscribe: true});
    expect(second.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(value.latest()).toMatchObject({status: 'open', identity: 'host-stable', generation: 2});
  });

  it('controls only party microphone/camera tracks', async () => {
    const value = fixture();
    await value.controller.open();
    await value.controller.setMicrophoneEnabled(false);
    await value.controller.setCameraEnabled(false);
    await value.controller.setMicrophoneEnabled(true);
    await value.controller.setCameraEnabled(true);
    expect(value.media.bridge.setAudioEnabled.mock.calls.map(call => call[1])).toEqual([false, true]);
    expect(value.media.bridge.setVideoEnabled.mock.calls.map(call => call[1])).toEqual([false, true]);
    expect(value.latest()).toMatchObject({microphoneEnabled: true, cameraEnabled: true});
  });

  it('requires confirmation with guests, then closes and releases every local resource', async () => {
    const room = new FakeRoom();
    const api = apiFixture({adminStatus: vi.fn(async () => statusSnapshot({occupancy: 3}))});
    const value = fixture({api, rooms: [room]});
    await value.controller.open();
    const prompt = await value.controller.close({confirmed: false});
    expect(prompt).toEqual({requiresConfirmation: true});
    expect(api.adminClose).not.toHaveBeenCalled();
    await value.controller.close({confirmed: true});
    expect(api.adminClose).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(value.media.bridge.stopOwnedTracks).toHaveBeenCalledTimes(1);
    expect(value.grid.clear).toHaveBeenCalled();
    expect(value.latest()).toMatchObject({status: 'closed', occupancy: 0});
  });

  it('shows a host-visible media error and does not allocate a room when the microphone is missing', async () => {
    const media = mediaFixture();
    media.bridge.createOwnedTracks.mockImplementation(() => {
      throw Object.assign(new Error('microphone missing'), {code: 'PARTY_MICROPHONE_UNAVAILABLE'});
    });
    const value = fixture({media});
    await value.controller.open();
    expect(value.api.adminOpen).not.toHaveBeenCalled();
    expect(value.latest()).toMatchObject({
      status: 'error', errorCode: 'PARTY_MICROPHONE_UNAVAILABLE',
    });
    expect(value.latest().message).toContain('microfon');
  });
});


describe('party host feature availability', () => {
  it.each([
    [false, true, false],
    [true, false, true],
  ])('hides the legacy private panel only while the party host flag is active', (
    enabled, partyHidden, legacyHidden,
  ) => {
    document.body.innerHTML = '<section id="party"></section><section id="legacy"></section>';
    const panel = document.getElementById('party');
    const legacyPanel = document.getElementById('legacy');
    setPartyHostAvailability({enabled, panel, legacyPanel});
    expect(panel.hidden).toBe(partyHidden);
    expect(legacyPanel.hidden).toBe(legacyHidden);
  });
});
