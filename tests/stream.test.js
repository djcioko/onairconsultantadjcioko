const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStreamScript() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'stream.js'), 'utf8');
  const context = {
    console,
    setTimeout: () => 0,
    window: { addEventListener: () => {} },
    document: {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

class FakeConnection {
  constructor(label = 'viewer-presence') {
    this.label = label;
    this.open = true;
    this.handlers = new Map();
    this.sent = [];
  }

  on(eventName, handler) {
    if (!this.handlers.has(eventName)) this.handlers.set(eventName, []);
    this.handlers.get(eventName).push(handler);
  }

  emit(eventName, value) {
    for (const handler of this.handlers.get(eventName) || []) handler(value);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

class FakeCall {
  constructor(peer, metadata = {}) {
    this.peer = peer;
    this.metadata = metadata;
    this.handlers = new Map();
    this.answeredWith = null;
    this.closed = false;
  }

  on(eventName, handler) {
    if (!this.handlers.has(eventName)) this.handlers.set(eventName, []);
    this.handlers.get(eventName).push(handler);
  }

  emit(eventName, value) {
    for (const handler of this.handlers.get(eventName) || []) handler(value);
  }

  answer(stream) {
    this.answeredWith = stream;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

function createFakeClock() {
  let current = 1_000;
  let sequence = 0;
  const tasks = new Map();

  return {
    now: () => current,
    setTimer(callback, delay) {
      sequence += 1;
      tasks.set(sequence, {callback, at: current + delay});
      return sequence;
    },
    clearTimer(id) {
      tasks.delete(id);
    },
    advance(milliseconds) {
      current += milliseconds;

      while (true) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= current)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);

        if (!due.length) return;
        const [id, task] = due[0];
        tasks.delete(id);
        task.callback();
      }
    },
  };
}

function guestRequest({requestId, peerId, clientId, name}) {
  return {type: 'guest-request', requestId, peerId, clientId, name};
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('viewer counter tracks active connections and ignores duplicate disconnects', () => {
  const context = loadStreamScript();
  const renderedValues = [];
  const counter = context.createOnlineViewerCounter((value) => renderedValues.push(value));

  const disconnectFirst = counter.connect();
  const disconnectSecond = counter.connect();

  assert.equal(counter.value, 2);
  disconnectFirst();
  disconnectFirst();
  assert.equal(counter.value, 1);
  disconnectSecond();
  assert.equal(counter.value, 0);
  assert.deepEqual(renderedValues, [0, 1, 2, 1, 0]);
});

test('presence hub counts a connection only after it reports a received live stream', () => {
  const context = loadStreamScript();
  const renderedValues = [];
  const hub = context.createViewerPresenceHub((value) => renderedValues.push(value));
  const first = new FakeConnection();
  const second = new FakeConnection();

  hub.attach(first);
  hub.attach(second);
  assert.equal(hub.value, 0);

  first.emit('data', { type: 'watching' });
  first.emit('data', { type: 'watching' });
  assert.equal(hub.value, 1);
  assert.equal(first.sent.at(-1).type, 'viewer-count');
  assert.equal(first.sent.at(-1).count, 1);
  assert.equal(second.sent.at(-1).type, 'viewer-count');
  assert.equal(second.sent.at(-1).count, 1);

  second.emit('data', { type: 'watching' });
  assert.equal(hub.value, 2);
  first.emit('close');
  first.emit('error');
  assert.equal(hub.value, 1);

  second.emit('data', { type: 'stopped' });
  assert.equal(hub.value, 0);
  assert.deepEqual(renderedValues, [0, 1, 2, 1, 0]);
});

test('presence hub ignores unrelated PeerJS data connections', () => {
  const context = loadStreamScript();
  const hub = context.createViewerPresenceHub(() => {});
  const unrelated = new FakeConnection('chat');

  hub.attach(unrelated);
  unrelated.emit('data', { type: 'watching' });

  assert.equal(hub.value, 0);
});

test('party host reports room availability before a spectator raises a hand', () => {
  const context = loadStreamScript();
  const host = context.createPeerPartyHostState();
  const connection = new FakeConnection('guest-request');

  host.attachConnection(connection);
  connection.emit('data', {type: 'party-status-request'});

  assert.deepEqual(plain(connection.sent.at(-1)), {
    type: 'party-status', open: true, capacity: 9, occupancy: 1,
  });
});

test('party host deduplicates reconnecting named requests and expires the latest request after 60 seconds', () => {
  const context = loadStreamScript();
  const clock = createFakeClock();
  const host = context.createPeerPartyHostState({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const first = new FakeConnection('guest-request');
  const reconnected = new FakeConnection('guest-request');

  host.attachConnection(first);
  first.emit('data', guestRequest({
    requestId: 'request-old', peerId: 'peer-old', clientId: 'client-ana', name: ' Ana ',
  }));
  host.attachConnection(reconnected);
  reconnected.emit('data', guestRequest({
    requestId: 'request-new', peerId: 'peer-new', clientId: 'client-ana', name: 'Ana Maria',
  }));

  assert.deepEqual(plain(host.snapshot().pending.map((entry) => ({
    requestId: entry.requestId,
    peerId: entry.peerId,
    clientId: entry.clientId,
    name: entry.name,
  }))), [{
    requestId: 'request-new', peerId: 'peer-new', clientId: 'client-ana', name: 'Ana Maria',
  }]);
  assert.equal(reconnected.sent.at(-1).type, 'guest-pending');

  clock.advance(59_999);
  assert.equal(host.snapshot().pending.length, 1);
  clock.advance(1);
  assert.equal(host.snapshot().pending.length, 0);
  assert.equal(reconnected.sent.at(-1).type, 'guest-expired');
});

test('party host enforces eight accepted guests and closes or reopens the room cleanly', () => {
  const context = loadStreamScript();
  const clock = createFakeClock();
  const host = context.createPeerPartyHostState({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const connections = [];

  for (let index = 1; index <= 9; index += 1) {
    const connection = new FakeConnection('guest-request');
    connections.push(connection);
    host.attachConnection(connection);
    connection.emit('data', guestRequest({
      requestId: `request-${index}`,
      peerId: `peer-${index}`,
      clientId: `client-${index}`,
      name: `Invitat ${index}`,
    }));
    if (index <= 8) assert.equal(host.acceptRequest(`request-${index}`), true);
  }

  assert.equal(host.snapshot().accepted.length, 8);
  assert.equal(host.acceptRequest('request-9'), false);
  assert.deepEqual(plain(connections[8].sent.at(-1)), {
    type: 'guest-busy', requestId: 'request-9', reason: 'room-full',
  });

  host.closeRoom();
  assert.equal(host.snapshot().roomOpen, false);
  assert.equal(host.snapshot().pending.length, 0);
  assert.equal(host.snapshot().accepted.length, 0);
  assert.equal(connections[0].sent.at(-1).type, 'room-closed');

  const whileClosed = new FakeConnection('guest-request');
  host.attachConnection(whileClosed);
  whileClosed.emit('data', guestRequest({
    requestId: 'request-closed', peerId: 'peer-closed', clientId: 'client-closed', name: 'Mara',
  }));
  assert.equal(whileClosed.sent.at(-1).type, 'room-closed');

  host.openRoom();
  whileClosed.emit('data', guestRequest({
    requestId: 'request-open', peerId: 'peer-open', clientId: 'client-closed', name: 'Mara',
  }));
  assert.equal(host.snapshot().pending.length, 1);
});

test('accepted guest calls receive the broadcast and every accepted guest receives a mesh roster', () => {
  const context = loadStreamScript();
  const clock = createFakeClock();
  const host = context.createPeerPartyHostState({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    getHostState: () => ({mic: true, camera: false}),
  });
  const anaConnection = new FakeConnection('guest-request');
  const ionConnection = new FakeConnection('guest-request');

  host.attachConnection(anaConnection);
  host.attachConnection(ionConnection);
  anaConnection.emit('data', guestRequest({
    requestId: 'request-ana', peerId: 'peer-ana', clientId: 'client-ana', name: 'Ana',
  }));
  ionConnection.emit('data', guestRequest({
    requestId: 'request-ion', peerId: 'peer-ion', clientId: 'client-ion', name: 'Ion',
  }));
  host.acceptRequest('request-ana');
  host.acceptRequest('request-ion');

  const program = {id: 'canvas-and-microphone'};
  const anaCall = new FakeCall('peer-ana', {
    type: 'guest-chat', requestId: 'request-ana', clientId: 'client-ana', mic: true, camera: true,
  });
  assert.equal(host.acceptMediaCall(anaCall, program), true);
  assert.equal(anaCall.answeredWith, program);

  const ionCall = new FakeCall('peer-ion', {
    type: 'guest-chat', requestId: 'request-ion', clientId: 'client-ion', mic: true, camera: true,
  });
  assert.equal(host.acceptMediaCall(ionCall, program), true);
  assert.equal(ionCall.answeredWith, program);

  const roster = anaConnection.sent.filter((message) => message.type === 'party-roster').at(-1);
  assert.deepEqual(plain(roster.participants), [
    {
      peerId: 'djcioko-studio-unic-id', name: 'DJCIOKOSTUDIO', role: 'host',
      mic: true, camera: false, microphoneEnabled: true, cameraEnabled: false,
    },
    {
      peerId: 'peer-ana', name: 'Ana', role: 'guest',
      mic: true, camera: true, microphoneEnabled: true, cameraEnabled: true,
    },
    {
      peerId: 'peer-ion', name: 'Ion', role: 'guest',
      mic: true, camera: true, microphoneEnabled: true, cameraEnabled: true,
    },
  ]);
  assert.deepEqual(
    plain(ionConnection.sent.filter((message) => message.type === 'party-roster').at(-1)),
    plain(roster),
  );

  ionConnection.emit('data', {
    type: 'guest-state', requestId: 'request-ion', clientId: 'client-ion',
    microphoneEnabled: false, cameraEnabled: true,
  });
  const updated = anaConnection.sent.filter((message) => message.type === 'party-roster').at(-1);
  const ion = updated.participants.find((participant) => participant.peerId === 'peer-ion');
  assert.equal(ion.mic, false);
  assert.equal(ion.microphoneEnabled, false);
});

test('party host preserves a seat for a media reconnect, replaces the peer without duplicates, and removes it cleanly', () => {
  const context = loadStreamScript();
  const clock = createFakeClock();
  const host = context.createPeerPartyHostState({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const firstConnection = new FakeConnection('guest-request');
  host.attachConnection(firstConnection);
  firstConnection.emit('data', guestRequest({
    requestId: 'request-one', peerId: 'peer-one', clientId: 'stable-client', name: 'Radu',
  }));
  host.acceptRequest('request-one');
  const firstCall = new FakeCall('peer-one', {
    type: 'guest-chat', requestId: 'request-one', clientId: 'stable-client', mic: true, camera: true,
  });
  host.acceptMediaCall(firstCall, {id: 'program'});

  firstCall.emit('close');
  assert.equal(host.snapshot().active.length, 0);
  assert.equal(host.snapshot().accepted.length, 1);

  const secondConnection = new FakeConnection('guest-request');
  host.attachConnection(secondConnection);
  secondConnection.emit('data', guestRequest({
    requestId: 'request-two', peerId: 'peer-two', clientId: 'stable-client', name: 'Radu',
  }));
  assert.equal(secondConnection.sent.at(-1).type, 'party-roster');
  assert.equal(secondConnection.sent.some((message) => message.type === 'guest-accepted'), true);

  const secondCall = new FakeCall('peer-two', {
    type: 'guest-chat', requestId: 'request-two', clientId: 'stable-client', mic: true, camera: true,
  });
  assert.equal(host.acceptMediaCall(secondCall, {id: 'program'}), true);
  assert.equal(host.snapshot().active.length, 1);
  assert.equal(host.snapshot().accepted.length, 0);
  assert.equal(host.snapshot().active[0].peerId, 'peer-two');

  assert.equal(host.removeParticipant('stable-client'), true);
  assert.equal(secondCall.closed, true);
  assert.equal(host.snapshot().active.length, 0);
  assert.equal(secondConnection.sent.some((message) => message.type === 'guest-removed'), true);
});
