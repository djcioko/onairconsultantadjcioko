// @vitest-environment jsdom

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {createPeerJsPartyGuest} from '../site-peerjs/party-peerjs-guest-v1.js';


class Emitter {
  constructor() {
    this.handlers = new Map();
  }

  on(type, callback) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(callback);
    return this;
  }

  off(type, callback) {
    this.handlers.get(type)?.delete(callback);
    return this;
  }

  async emit(type, ...values) {
    for (const callback of this.handlers.get(type) ?? []) {
      await callback(...values);
    }
  }
}


class FakeConnection extends Emitter {
  constructor(peer, options = {}) {
    super();
    this.peer = peer;
    this.label = options.label;
    this.metadata = options.metadata;
    this.open = false;
    this.sent = [];
    this.send = vi.fn(payload => this.sent.push(payload));
    this.close = vi.fn(() => {
      this.open = false;
    });
  }

  async openNow() {
    this.open = true;
    await this.emit('open');
  }
}


class FakeCall extends Emitter {
  constructor(peer, stream = null, options = {}) {
    super();
    this.peer = peer;
    this.localStream = stream;
    this.metadata = options.metadata ?? {};
    this.answer = vi.fn();
    this.close = vi.fn();
  }
}


class FakePeer extends Emitter {
  constructor() {
    super();
    this.id = '';
    this.open = false;
    this.destroyed = false;
    this.connections = [];
    this.calls = [];
    this.connect = vi.fn((peer, options) => {
      const connection = new FakeConnection(peer, options);
      this.connections.push(connection);
      return connection;
    });
    this.call = vi.fn((peer, stream, options) => {
      const call = new FakeCall(peer, stream, options);
      this.calls.push(call);
      return call;
    });
    this.reconnect = vi.fn();
    this.destroy = vi.fn(() => {
      this.destroyed = true;
      this.open = false;
    });
  }

  async openNow(id = 'guest-b') {
    this.id = id;
    this.open = true;
    await this.emit('open', id);
  }
}


function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.has(key) ? values.get(key) : null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    value: key => values.get(key),
  };
}


function manualTimers() {
  let sequence = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++sequence;
      pending.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [id, value] = entry;
      pending.delete(id);
      await value.callback();
      return true;
    },
    get delays() {
      return [...pending.values()].map(value => value.delay);
    },
  };
}


function mediaTrack(kind) {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(function stop() {
      this.readyState = 'ended';
    }),
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


function fixture({
  storage = memoryStorage(),
  timers = manualTimers(),
  publicLive = 'playing',
  legacyStatus = null,
} = {}) {
  let legacyStatusText = null;
  if (legacyStatus !== null) {
    legacyStatusText = document.createElement('p');
    legacyStatusText.id = 'statusText';
    legacyStatusText.textContent = legacyStatus;
    document.body.append(legacyStatusText);
  }
  let publicLivePlayer = null;
  if (publicLive !== 'absent') {
    publicLivePlayer = document.createElement('video');
    publicLivePlayer.id = 'siteVideoPlayer';
    Object.defineProperty(publicLivePlayer, 'paused', {
      configurable: true, writable: true, value: true,
    });
    Object.defineProperty(publicLivePlayer, 'readyState', {
      configurable: true, writable: true, value: 0,
    });
    publicLivePlayer.srcObject = null;
    if (publicLive === 'playing') {
      publicLivePlayer.srcObject = mediaStream();
      publicLivePlayer.paused = false;
      publicLivePlayer.readyState = 4;
    }
    document.body.append(publicLivePlayer);
  }
  const root = document.createElement('section');
  root.dataset.partyLiveRoot = '';
  root.hidden = true;
  document.body.append(root);
  const peer = new FakePeer();
  const stream = mediaStream();
  const mediaDevices = {getUserMedia: vi.fn(async () => stream)};
  const states = [];
  const controller = createPeerJsPartyGuest({
    peerFactory: () => peer,
    mediaDevices,
    storage,
    timers,
    pageWindow: window,
    clientIdFactory: () => 'client-1',
    requestIdFactory: () => 'request-1',
    onState: state => states.push(state),
  });
  return {
    controller,
    host: () => peer.connections.at(-1),
    legacyStatusText,
    mediaDevices,
    peer,
    publicLivePlayer,
    root,
    states,
    storage,
    stream,
    timers,
  };
}


async function connectedFixture(options = {}) {
  const value = fixture(options);
  await value.controller.mount(value.root);
  await value.peer.openNow();
  await value.host().openNow();
  return value;
}


async function acceptedFixture(options = {}) {
  const value = await connectedFixture(options);
  await value.controller.raiseHand('Ana');
  await value.host().emit('data', {
    type: 'guest-accepted',
    requestId: 'request-1',
    clientId: 'client-1',
  });
  return value;
}


beforeEach(() => {
  document.body.textContent = '';
  vi.restoreAllMocks();
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  HTMLMediaElement.prototype.pause = vi.fn();
});


describe('PeerJS party request lifecycle', () => {
  it('shows the legacy receiver status only after both LIVE video and LIVE copy arrive', async () => {
    const value = await connectedFixture({
      publicLive: 'offline',
      legacyStatus: 'Se conectează la aplicația DJCIOKOSTUDIO...',
    });

    expect(value.legacyStatusText.hidden).toBe(true);
    expect(value.legacyStatusText.style.display).toBe('none');

    value.publicLivePlayer.srcObject = mediaStream();
    value.publicLivePlayer.dispatchEvent(new Event('playing'));
    expect(value.legacyStatusText.hidden).toBe(true);

    value.legacyStatusText.textContent = '🔴 LIVE DJCIOKOSTUDIO';
    await vi.waitFor(() => expect(value.legacyStatusText.hidden).toBe(false));
    expect(value.legacyStatusText.style.display).toBe('');

    value.legacyStatusText.textContent = 'Aștept aplicația de pe telefon...';
    await vi.waitFor(() => expect(value.legacyStatusText.hidden).toBe(true));
    expect(value.legacyStatusText.style.display).toBe('none');
  });

  it('hides a visible legacy LIVE status immediately when the video track disappears', async () => {
    const value = await connectedFixture({
      legacyStatus: '🔴 LIVE DJCIOKOSTUDIO',
    });

    expect(value.legacyStatusText.hidden).toBe(false);
    value.publicLivePlayer.srcObject = null;
    value.publicLivePlayer.dispatchEvent(new Event('emptied'));

    expect(value.legacyStatusText.hidden).toBe(true);
    expect(value.legacyStatusText.style.display).toBe('none');
  });

  it('fails closed when the public LIVE player is missing', async () => {
    const value = await connectedFixture({publicLive: 'absent'});
    await value.host().emit('data', {type: 'party-status', open: true, capacity: 9, occupancy: 1});

    expect(value.root.querySelector('[data-party-name]').disabled).toBe(true);
    expect(value.root.querySelector('[data-party-raise]').disabled).toBe(true);
    expect(value.root.querySelector('[data-party-status]').textContent)
      .toBe('Ne vedem curând LIVE!');
  });

  it('locks name and hand raise without public LIVE, then unlocks and relocks with playback', async () => {
    const value = await connectedFixture({publicLive: 'offline'});
    await value.host().emit('data', {type: 'party-status', open: true, capacity: 9, occupancy: 1});
    const input = value.root.querySelector('[data-party-name]');
    const raise = value.root.querySelector('[data-party-raise]');
    const status = value.root.querySelector('[data-party-status]');

    expect(input.disabled).toBe(true);
    expect(raise.disabled).toBe(true);
    expect(status.textContent).toBe('Ne vedem curând LIVE!');
    await expect(value.controller.raiseHand('Alex')).resolves.toBe(false);
    expect(value.host().sent.filter(message => message.type === 'guest-request')).toHaveLength(0);

    const liveStream = mediaStream();
    value.publicLivePlayer.srcObject = liveStream;
    value.publicLivePlayer.paused = false;
    value.publicLivePlayer.readyState = 4;
    value.publicLivePlayer.dispatchEvent(new Event('playing'));

    expect(input.disabled).toBe(false);
    expect(raise.disabled).toBe(false);
    expect(status.textContent).toContain('deschisă');
    await value.controller.raiseHand('Alex');
    expect(value.controller.state.status).toBe('pending');

    value.publicLivePlayer.srcObject = null;
    value.publicLivePlayer.paused = true;
    value.publicLivePlayer.readyState = 0;
    value.publicLivePlayer.dispatchEvent(new Event('pause'));
    await vi.waitFor(() => expect(value.controller.state.status).toBe('idle'));

    expect(input.disabled).toBe(true);
    expect(raise.disabled).toBe(true);
    expect(status.textContent).toBe('Ne vedem curând LIVE!');
    expect(value.controller.state.requestId).toBeNull();
    expect(value.timers.delays).not.toContain(90_000);
    expect(value.host().sent.filter(message => message.type === 'guest-left')).toHaveLength(1);
  });

  it('keeps requests available when the local player is paused but its LIVE track is active', async () => {
    const value = await connectedFixture();
    await value.host().emit('data', {type: 'party-status', open: true, capacity: 9, occupancy: 1});

    value.publicLivePlayer.paused = true;
    value.publicLivePlayer.readyState = 0;
    value.publicLivePlayer.dispatchEvent(new Event('pause'));

    expect(value.root.querySelector('[data-party-name]').disabled).toBe(false);
    expect(value.root.querySelector('[data-party-raise]').disabled).toBe(false);
    expect(value.root.querySelector('[data-party-status]').textContent).toContain('deschisă');
  });

  it('shows the room as ready after the host answers the initial status request', async () => {
    const value = await connectedFixture();

    expect(value.host().sent).toContainEqual(expect.objectContaining({type: 'party-status-request'}));
    await value.host().emit('data', {type: 'party-status', open: true, capacity: 9, occupancy: 1});

    expect(value.controller.state.status).toBe('idle');
    expect(value.root.querySelector('[data-party-status]').textContent).toContain('deschisă');
  });

  it('remembers the visitor name and sends one deduplicated hand raise to the stable host', async () => {
    const storage = memoryStorage({
      'djcioko.party.names.v1': JSON.stringify(['Mara']),
    });
    const value = await connectedFixture({storage});

    expect(value.root.hidden).toBe(false);
    expect(value.root.querySelector('[data-party-name]').value).toBe('Mara');
    await Promise.all([
      value.controller.raiseHand('  Ana  '),
      value.controller.raiseHand('Alt nume'),
    ]);

    expect(value.peer.connect).toHaveBeenCalledTimes(1);
    expect(value.peer.connect).toHaveBeenCalledWith(
      'djcioko-studio-unic-id',
      expect.objectContaining({label: 'guest-request', reliable: true}),
    );
    expect(value.host().sent).toContainEqual({
      type: 'guest-request',
      requestId: 'request-1',
      peerId: 'guest-b',
      clientId: 'client-1',
      name: 'Ana',
    });
    expect(value.storage.value('djcioko.party.names.v1')).toBe(JSON.stringify(['Ana', 'Mara']));
    expect(value.controller.state.status).toBe('pending');
  });

  it('maps rejection, busy, and request timeout without asking for media', async () => {
    for (const [message, expected] of [
      [{type: 'guest-rejected', requestId: 'request-1'}, 'rejected'],
      [{type: 'guest-busy', requestId: 'request-1'}, 'busy'],
      [{type: 'guest-expired', requestId: 'request-1'}, 'expired'],
    ]) {
      const value = await connectedFixture();
      await value.controller.raiseHand('Ana');
      await value.host().emit('data', message);
      expect(value.controller.state.status).toBe(expected);
      expect(value.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      await value.controller.destroy();
    }

    const timeout = await connectedFixture();
    await timeout.controller.raiseHand('Ana');
    expect(timeout.timers.delays).toContain(90_000);
    await timeout.timers.runNext();
    expect(timeout.controller.state.status).toBe('expired');
    expect(timeout.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('reconnects the host data channel with the same request and no duplicate identity', async () => {
    const value = await connectedFixture();
    await value.controller.raiseHand('Ana');
    const first = value.host();
    await first.emit('close');
    expect(value.timers.delays).toContain(1500);

    await value.timers.runNext();
    const second = value.host();
    expect(second).not.toBe(first);
    await second.openNow();

    expect(value.peer.connect).toHaveBeenCalledTimes(2);
    expect(second.sent.filter(message => message.type === 'guest-request')).toEqual([
      expect.objectContaining({
        requestId: 'request-1', clientId: 'client-1', peerId: 'guest-b', name: 'Ana',
      }),
    ]);
    expect(value.controller.state.requestId).toBe('request-1');
  });

  it('cancels a waiting request when LIVE ends and never resends it after reconnect', async () => {
    const value = await connectedFixture();
    await value.controller.raiseHand('Ana');
    const first = value.host();
    await first.emit('close');
    expect(value.controller.state.status).toBe('waiting_host');

    value.publicLivePlayer.srcObject = null;
    value.publicLivePlayer.dispatchEvent(new Event('emptied'));
    await vi.waitFor(() => expect(value.controller.state.requestId).toBeNull());

    await value.timers.runNext();
    const second = value.host();
    await second.openNow();

    expect(value.controller.state.status).toBe('idle');
    expect(second.sent.filter(message => message.type === 'guest-request')).toHaveLength(0);
    expect(value.root.querySelector('[data-party-status]').textContent)
      .toBe('Ne vedem curând LIVE!');
  });

  it('rebinds an accepted guest with the same request without reacquiring media or redialing', async () => {
    const value = await acceptedFixture();
    const first = value.host();
    await first.emit('close');
    await value.timers.runNext();
    const second = value.host();
    await second.openNow();

    expect(second.sent.filter(message => message.type === 'guest-request')).toEqual([
      expect.objectContaining({
        requestId: 'request-1', clientId: 'client-1', peerId: 'guest-b', name: 'Ana',
      }),
    ]);
    expect(value.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(value.peer.calls.filter(call => call.metadata.type === 'guest-chat')).toHaveLength(1);
  });
});


describe('PeerJS party media and mesh', () => {
  it('captures bounded 540p media after acceptance and starts the verified host call', async () => {
    const value = await acceptedFixture();

    expect(value.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      video: {
        width: {ideal: 960, max: 960},
        height: {ideal: 540, max: 540},
        frameRate: {ideal: 15, max: 15},
        facingMode: 'user',
      },
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
    });
    expect(value.peer.call).toHaveBeenCalledWith(
      'djcioko-studio-unic-id',
      value.stream,
      {metadata: {
        type: 'guest-chat',
        requestId: 'request-1',
        clientId: 'client-1',
        name: 'Ana',
      }},
    );
    expect(value.controller.state.status).toBe('joined');
    expect(value.root.querySelector('[data-party-peer="guest-b"]')).not.toBeNull();

    await value.peer.calls[0].emit('stream', mediaStream());
    expect(value.root.querySelector('[data-party-peer="djcioko-studio-unic-id"] video').srcObject)
      .not.toBeNull();
  });

  it('redials the host after a media reconnect request without reacquiring local media', async () => {
    const value = await acceptedFixture();
    const first = value.peer.calls.find(call => call.metadata.type === 'guest-chat');
    await first.emit('close');

    await value.host().emit('data', {type: 'guest-reconnect', requestId: 'request-1'});

    const hostCalls = value.peer.calls.filter(call => call.metadata.type === 'guest-chat');
    expect(hostCalls).toHaveLength(2);
    expect(hostCalls[1].localStream).toBe(value.stream);
    expect(value.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(value.stream.video.stop).not.toHaveBeenCalled();
    expect(value.stream.audio.stop).not.toHaveBeenCalled();
    expect(value.controller.state.status).toBe('joined');
  });

  it('uses a verified roster for deterministic full-mesh calls and rejects unknown callers', async () => {
    const value = await acceptedFixture();
    await value.host().emit('data', {
      type: 'party-roster',
      requestId: 'request-1',
      participants: [
        {peerId: 'djcioko-studio-unic-id', role: 'host', name: 'DJ Cioko'},
        {peerId: 'guest-a', role: 'guest', name: 'Alex', microphoneEnabled: true, cameraEnabled: true},
        {peerId: 'guest-b', role: 'guest', name: 'Ana', microphoneEnabled: true, cameraEnabled: true},
        {peerId: 'guest-c', role: 'guest', name: 'Carmen', mic: false, camera: true},
      ],
    });

    const meshCalls = value.peer.calls.filter(call => call.metadata.type === 'party-mesh');
    expect(meshCalls.map(call => call.peer)).toEqual(['guest-c']);
    expect(meshCalls[0].metadata).toMatchObject({
      type: 'party-mesh', clientId: 'client-1', name: 'Ana', fromPeerId: 'guest-b',
    });

    const verifiedIncoming = new FakeCall('guest-a', null, {
      metadata: {type: 'party-mesh', fromPeerId: 'guest-a'},
    });
    await value.peer.emit('call', verifiedIncoming);
    expect(verifiedIncoming.answer).toHaveBeenCalledWith(value.stream);

    const unknownIncoming = new FakeCall('intruder', null, {
      metadata: {type: 'party-mesh', fromPeerId: 'intruder'},
    });
    await value.peer.emit('call', unknownIncoming);
    expect(unknownIncoming.answer).not.toHaveBeenCalled();
    expect(unknownIncoming.close).toHaveBeenCalled();

    await verifiedIncoming.emit('stream', mediaStream());
    expect(value.root.querySelector('[data-party-peer="guest-a"] video').srcObject).not.toBeNull();
    expect(value.root.querySelector('[data-party-peer="guest-c"] [data-party-mic]').textContent)
      .toContain('oprit');
  });

  it('retries a dropped deterministic mesh call while the peer remains in the roster', async () => {
    const value = await acceptedFixture();
    await value.host().emit('data', {
      type: 'party-roster',
      requestId: 'request-1',
      participants: [
        {peerId: 'djcioko-studio-unic-id', role: 'host', name: 'DJ Cioko'},
        {peerId: 'guest-b', role: 'guest', name: 'Ana'},
        {peerId: 'guest-c', role: 'guest', name: 'Carmen'},
      ],
    });
    const first = value.peer.calls.find(call => call.metadata.type === 'party-mesh');

    await first.emit('close');
    expect(value.timers.delays).toContain(1500);
    await value.timers.runNext();

    expect(value.peer.calls.filter(call => call.metadata.type === 'party-mesh')).toHaveLength(2);
    expect(value.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('sends device state, leaves once, and stops every local track and call', async () => {
    const value = await acceptedFixture();
    await value.controller.setMicrophoneEnabled(false);
    await value.controller.setCameraEnabled(false);

    expect(value.stream.audio.enabled).toBe(false);
    expect(value.stream.video.enabled).toBe(false);
    expect(value.host().sent.filter(message => message.type === 'guest-state')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({clientId: 'client-1', microphoneEnabled: false}),
        expect.objectContaining({clientId: 'client-1', cameraEnabled: false}),
      ]),
    );

    await Promise.all([value.controller.leave(), value.controller.leave()]);
    expect(value.host().sent.filter(message => message.type === 'guest-left')).toHaveLength(1);
    expect(value.host().sent.find(message => message.type === 'guest-left')).toMatchObject({
      requestId: 'request-1', clientId: 'client-1', peerId: 'guest-b', state: 'left',
    });
    expect(value.stream.video.stop).toHaveBeenCalledTimes(1);
    expect(value.stream.audio.stop).toHaveBeenCalledTimes(1);
    expect(value.peer.calls.every(call => call.close.mock.calls.length === 1)).toBe(true);
    expect(value.root.querySelector('[data-party-grid]').children).toHaveLength(0);
    expect(value.controller.state.status).toBe('idle');
  });

  it.each(['guest-removed', 'host-removed', 'host-ended', 'room-closed', 'party-closed'])(
    'cleans up media when the host sends %s',
    async type => {
      const value = await acceptedFixture();
      await value.host().emit('data', {type, requestId: 'request-1'});
      expect(value.stream.video.stop).toHaveBeenCalledTimes(1);
      expect(value.stream.audio.stop).toHaveBeenCalledTimes(1);
      expect(value.controller.state.status).toBe(
        ['guest-removed', 'host-removed'].includes(type)
          ? 'removed'
          : ['room-closed', 'party-closed'].includes(type) ? 'room_closed' : 'ended',
      );
    },
  );
});
