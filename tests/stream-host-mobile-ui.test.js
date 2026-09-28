// @vitest-environment jsdom

import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import {beforeEach, expect, test, vi} from 'vitest';


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
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <header><span data-peer-host-status>PEERJS GAZDĂ</span></header>
    <main class="main-content"></main>
  `;
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
