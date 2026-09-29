// @vitest-environment jsdom

import {readFileSync} from 'node:fs';
import vm from 'node:vm';

import {chromium} from '@playwright/test';
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


test('host-only grid keeps one muted first tile and updates its device state in place', async () => {
  const source = readFileSync('stream.js', 'utf8');
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play')
    .mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause')
    .mockImplementation(() => {});
  const hostStream = {id: 'host-broadcast'};
  const context = vm.createContext({
    clearTimeout,
    console,
    document,
    hostStream,
    navigator: {},
    setTimeout,
    window: {addEventListener() {}, confirm: () => true},
  });

  vm.runInContext(source, context);
  vm.runInContext(`
    broadcastStream = hostStream;
    audioEnabled = true;
    videoEnabled = true;
    renderPeerPartyHostState({
      roomOpen: true,
      peerStatus: 'online',
      peerReady: true,
      capacity: 9,
      occupancy: 1,
      pending: [],
      accepted: [],
      active: []
    });
  `, context);

  const grid = document.querySelector('#djPeerPartyGrid');
  const hostTile = grid.firstElementChild;
  const hostVideo = hostTile?.querySelector('video');
  const hostPlaceholder = hostTile?.querySelector('.dj-party-placeholder');

  expect(hostTile?.dataset.role).toBe('host');
  expect(hostTile?.classList.contains('dj-party-host')).toBe(true);
  expect(hostTile?.classList.contains('dj-party-tile--solo')).toBe(true);
  expect(grid.dataset.participantCount).toBe('1');
  expect(hostTile?.querySelector('.dj-party-meta strong').textContent)
    .toBe('DJCIOKOSTUDIO · Gazdă');
  expect(hostTile?.querySelector('.dj-party-remove')).toBeNull();
  expect(hostVideo?.muted).toBe(true);
  expect(hostVideo?.srcObject).toBe(hostStream);
  expect(hostPlaceholder?.hidden).toBe(true);
  expect(getComputedStyle(hostPlaceholder).display).toBe('none');
  expect(hostTile?.querySelector('.dj-party-state').textContent)
    .toContain('Microfon pornit');
  expect(hostTile?.querySelector('.dj-party-state').textContent)
    .toContain('Cameră pornită');

  const gridMutations = [];
  const observer = new MutationObserver((records) => gridMutations.push(...records));
  observer.observe(grid, {childList: true});

  vm.runInContext(`
    audioEnabled = false;
    videoEnabled = false;
    renderPeerPartyHostState({
      roomOpen: true,
      peerStatus: 'online',
      peerReady: true,
      capacity: 9,
      occupancy: 1,
      pending: [],
      accepted: [],
      active: []
    });
  `, context);
  await Promise.resolve();
  observer.disconnect();

  const rerenderedHostTile = grid.firstElementChild;
  expect(rerenderedHostTile).toBe(hostTile);
  expect(rerenderedHostTile.querySelector('video')).toBe(hostVideo);
  expect(hostVideo.srcObject).toBe(hostStream);
  expect(rerenderedHostTile.querySelector('.dj-party-state').textContent)
    .toContain('Microfon oprit');
  expect(rerenderedHostTile.querySelector('.dj-party-state').textContent)
    .toContain('Cameră oprită');
  expect(srcObjectAssignments.filter(({element}) => element === hostVideo))
    .toEqual([{element: hostVideo, stream: hostStream}]);
  expect(play).toHaveBeenCalledTimes(1);
  expect(gridMutations).toHaveLength(0);
});


test('active host and guest videos do not keep flex placeholders over them in Chromium', async () => {
  const browser = await chromium.launch({headless: true});

  try {
    const page = await browser.newPage();
    await page.setContent('<main class="main-content"></main>');
    await page.addScriptTag({content: readFileSync('stream.js', 'utf8')});

    const placeholders = await page.evaluate(() => {
      const hostStream = new MediaStream();
      const guestStream = new MediaStream();
      broadcastStream = hostStream;
      renderPeerPartyHostState({
        roomOpen: true,
        peerStatus: 'online',
        peerReady: true,
        capacity: 9,
        occupancy: 2,
        pending: [],
        accepted: [],
        active: [{
          clientId: 'client-alex',
          requestId: 'request-alex',
          peerId: 'peer-alex',
          name: 'Alex',
          mic: true,
          camera: true,
          state: 'active',
          stream: guestStream,
        }],
      });

      return ['[data-role="host"]', '[data-client-id="client-alex"]']
        .map((tileSelector) => {
          const placeholder = document.querySelector(
            `${tileSelector} .dj-party-placeholder`,
          );
          return {
            hidden: placeholder.hidden,
            display: getComputedStyle(placeholder).display,
          };
        });
    });

    expect(placeholders).toEqual([
      {hidden: true, display: 'none'},
      {hidden: true, display: 'none'},
    ]);
  } finally {
    await browser.close();
  }
});


test('host party layout stays readable at phone width and expands only on wide screens', () => {
  const source = readFileSync('stream.js', 'utf8');
  const context = vm.createContext({
    clearTimeout,
    console,
    document,
    navigator: {},
    setTimeout,
    window: {addEventListener() {}, confirm: () => true},
  });

  vm.runInContext(source, context);
  vm.runInContext(`
    renderPeerPartyHostState({
      roomOpen: true,
      peerStatus: 'online',
      peerReady: true,
      capacity: 9,
      occupancy: 1,
      pending: [],
      accepted: [],
      active: []
    });
  `, context);

  const style = document.querySelector('#djPeerPartyHostStyle');
  const mediaRules = [...style.sheet.cssRules]
    .filter((rule) => typeof rule.conditionText === 'string');
  const hostTile = document.querySelector('[data-role="host"]');
  const hostVideo = hostTile.querySelector('video');
  const actionButton = document.querySelector('#djPeerPartyOpen');
  const stateLabel = hostTile.querySelector('.dj-party-state');

  expect(getComputedStyle(hostTile).gridColumn.replace(/\s/g, '')).toBe('1/-1');
  expect(getComputedStyle(hostTile).width).toBe('100%');
  expect(getComputedStyle(hostTile).maxWidth).toBe('none');
  expect(getComputedStyle(hostTile).boxShadow).not.toBe('none');
  expect(getComputedStyle(hostVideo).objectFit).toBe('contain');
  expect(getComputedStyle(actionButton).minHeight).toBe('44px');
  expect(parseFloat(getComputedStyle(actionButton).fontSize)).toBeGreaterThanOrEqual(14);
  expect(parseFloat(getComputedStyle(stateLabel).fontSize)).toBeGreaterThanOrEqual(13);
  expect(mediaRules.some((rule) => /min-width:\s*390px/.test(rule.conditionText)))
    .toBe(false);
  expect(mediaRules.some((rule) => /min-width:\s*700px/.test(rule.conditionText)))
    .toBe(true);
});


test('host rerender preserves active guest media and removes only absent tiles', async () => {
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
  const alexPlaceholder = alexTile.querySelector('.dj-party-placeholder');
  const mariaTile = document.querySelector('[data-client-id="client-maria"]');
  const hostTile = document.querySelector('[data-role="host"]');

  expect(document.querySelector('#djPeerPartyGrid').firstElementChild)
    .toBe(hostTile);
  expect(hostTile.classList.contains('dj-party-tile--solo')).toBe(false);
  expect(alexPlaceholder.hidden).toBe(true);
  expect(getComputedStyle(alexPlaceholder).display).toBe('none');

  const gridMutations = [];
  const observer = new MutationObserver((records) => gridMutations.push(...records));
  observer.observe(document.querySelector('#djPeerPartyGrid'), {childList: true});

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
  await Promise.resolve();
  observer.disconnect();

  const rerenderedAlexTile = document.querySelector(
    '[data-client-id="client-alex"]',
  );
  expect(document.querySelector('#djPeerPartyGrid').firstElementChild)
    .toBe(hostTile);
  expect(document.querySelector('[data-role="host"]')).toBe(hostTile);
  expect(rerenderedAlexTile).toBe(alexTile);
  expect(rerenderedAlexTile.querySelector('video')).toBe(alexVideo);
  expect(alexVideo.srcObject).toBe(alexStream);
  expect(rerenderedAlexTile.querySelector('.dj-party-state').textContent)
    .toContain('🔇');
  expect(rerenderedAlexTile.querySelector('.dj-party-state').textContent)
    .toContain('Microfon oprit');
  expect(mariaTile.isConnected).toBe(false);
  expect(document.querySelector('[data-client-id="client-maria"]')).toBeNull();
  expect(gridMutations.some((record) =>
    [...record.removedNodes].includes(alexTile))).toBe(false);
  expect(srcObjectAssignments.filter(({element}) => element === alexVideo))
    .toEqual([{element: alexVideo, stream: alexStream}]);
  expect(play).toHaveBeenCalledTimes(2);
});
