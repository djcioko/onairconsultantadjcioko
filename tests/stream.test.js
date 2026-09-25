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
