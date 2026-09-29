// @vitest-environment jsdom

import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import {afterEach, beforeEach, expect, test, vi} from 'vitest';


let originalSrcObjectDescriptor;
let srcObjectAssignments;
let attachedStreams;


class FakeConnection {
  constructor() {
    this.label = 'guest-request';
    this.open = true;
    this.handlers = new Map();
    this.sent = [];
  }

  on(eventName, handler) {
    if (!this.handlers.has(eventName)) this.handlers.set(eventName, []);
    this.handlers.get(eventName).push(handler);
  }

  emit(eventName, payload) {
    for (const handler of this.handlers.get(eventName) || []) handler(payload);
  }

  send(payload) {
    this.sent.push(payload);
  }
}


beforeEach(() => {
  originalSrcObjectDescriptor = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'srcObject',
  );
  srcObjectAssignments = [];
  attachedStreams = new WeakMap();
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() {
      return attachedStreams.get(this) ?? null;
    },
    set(stream) {
      attachedStreams.set(this, stream);
      srcObjectAssignments.push({element: this, stream});
    },
  });

  document.head.innerHTML = '';
  document.body.innerHTML = `
    <header><span data-peer-host-status>PEERJS GAZDĂ</span></header>
    <main class="main-content"></main>
  `;
});


afterEach(() => {
  vi.restoreAllMocks();
  if (originalSrcObjectDescriptor) {
    Object.defineProperty(
      HTMLMediaElement.prototype,
      'srcObject',
      originalSrcObjectDescriptor,
    );
  } else {
    delete HTMLMediaElement.prototype.srcObject;
  }
});


test('a raised hand is immediately visible and vibrates once on the host phone', () => {
  const source = readFileSync('stream.js', 'utf8');
  const vibrate = vi.fn();
  const connection = new FakeConnection();
  const context = vm.createContext({
    clearTimeout,
    console,
    connection,
    document,
    navigator: {vibrate},
    setTimeout,
    window: {addEventListener() {}, confirm: () => true},
  });

  vm.runInContext(source, context);
  vm.runInContext(`
    peerPartyHost = createPeerPartyHostState({
      render: renderPeerPartyHostState
    });
    peerPartyHost.attachConnection(connection);
  `, context);

  connection.emit('data', {
    type: 'guest-request',
    requestId: 'request-mobile',
    peerId: 'peer-mobile',
    clientId: 'client-mobile',
    name: 'Alex',
    microphoneEnabled: true,
    cameraEnabled: true,
  });

  const alert = document.querySelector('#djPeerPartyAlert');
  expect(alert.hidden).toBe(false);
  expect(alert.textContent).toContain('Alex vrea să intre LIVE');
  expect(document.querySelector('#djPeerPartyAlertAccept').disabled).toBe(false);
  expect(document.querySelector('#djPeerPartyAlertReject').disabled).toBe(false);
  expect(document.querySelector('[data-peer-host-status]').textContent)
    .toBe('✋ 1 CERERE');
  expect(vibrate).toHaveBeenCalledTimes(1);
  expect(vibrate).toHaveBeenCalledWith([220, 100, 220]);

  vm.runInContext('peerPartyHost.refresh()', context);
  expect(vibrate).toHaveBeenCalledTimes(1);

  document.querySelector('#djPeerPartyAlertAccept').click();
  expect(alert.hidden).toBe(true);
  expect(connection.sent).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: 'guest-accepted',
      requestId: 'request-mobile',
    }),
  ]));
});


test('host rerender preserves active guest media and removes only absent tiles', () => {
  const source = readFileSync('stream.js', 'utf8');
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    .mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause')
    .mockImplementation(() => {});
  const alexStream = {id: 'stream-alex'};
  const mariaStream = {id: 'stream-maria'};
  const context = vm.createContext({
    clearTimeout,
    console,
    document,
    navigator: {},
    setTimeout,
    window: {addEventListener() {}, confirm: () => true},
    alexStream,
    mariaStream,
  });

  vm.runInContext(source, context);
  vm.runInContext(`
    renderPeerPartyHostState({
      roomOpen: true,
      peerStatus: 'online',
      peerReady: true,
      capacity: 9,
      occupancy: 3,
      pending: [],
      accepted: [],
      active: [
        {
          clientId: 'client-alex',
          requestId: 'request-alex',
          peerId: 'peer-alex',
          name: 'Alex',
          mic: true,
          camera: true,
          state: 'active',
          stream: alexStream
        },
        {
          clientId: 'client-maria',
          requestId: 'request-maria',
          peerId: 'peer-maria',
          name: 'Maria',
          mic: true,
          camera: true,
          state: 'active',
          stream: mariaStream
        }
      ]
    });
  `, context);

  const alexTile = document.querySelector('[data-client-id="client-alex"]');
  const alexVideo = alexTile.querySelector('video');
  const mariaTile = document.querySelector('[data-client-id="client-maria"]');

  vm.runInContext(`
    renderPeerPartyHostState({
      roomOpen: true,
      peerStatus: 'online',
      peerReady: true,
      capacity: 9,
      occupancy: 2,
      pending: [],
      accepted: [],
      active: [
        {
          clientId: 'client-alex',
          requestId: 'request-alex',
          peerId: 'peer-alex',
          name: 'Alex',
          mic: false,
          camera: true,
          state: 'active',
          stream: alexStream
        }
      ]
    });
  `, context);

  const rerenderedAlexTile = document.querySelector(
    '[data-client-id="client-alex"]',
  );
  expect(rerenderedAlexTile).toBe(alexTile);
  expect(rerenderedAlexTile.querySelector('video')).toBe(alexVideo);
  expect(alexVideo.srcObject).toBe(alexStream);
  expect(rerenderedAlexTile.querySelector('.dj-party-state').textContent)
    .toContain('🔇');
  expect(mariaTile.isConnected).toBe(false);
  expect(document.querySelector('[data-client-id="client-maria"]')).toBeNull();
  expect(srcObjectAssignments.filter(({element}) => element === alexVideo))
    .toEqual([{element: alexVideo, stream: alexStream}]);
  expect(play).toHaveBeenCalledTimes(2);
});
