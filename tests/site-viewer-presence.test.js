const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeDataConnection {
  constructor() {
    this.open = false;
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

function loadClientScript() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site-viewer-presence.js'), 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('visitor announces watching only after both data connection and live stream are ready', () => {
  const context = loadClientScript();
  const connection = new FakeDataConnection();
  const peer = {
    connect(peerId, options) {
      assert.equal(peerId, 'djcioko-studio-unic-id');
      assert.equal(options.label, 'viewer-presence');
      return connection;
    },
  };
  const rendered = [];
  const client = context.createViewerPresenceClient(peer, (count) => rendered.push(count));

  client.setWatching(true);
  assert.equal(connection.sent.length, 0);
  connection.open = true;
  connection.emit('open');
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].type, 'watching');

  connection.emit('data', { type: 'viewer-count', count: 3 });
  assert.deepEqual(rendered, [3]);

  client.setWatching(false);
  client.setWatching(false);
  assert.equal(connection.sent.length, 2);
  assert.equal(connection.sent[1].type, 'stopped');
});

test('visitor ignores invalid viewer counts', () => {
  const context = loadClientScript();
  const connection = new FakeDataConnection();
  const peer = { connect: () => connection };
  const rendered = [];
  context.createViewerPresenceClient(peer, (count) => rendered.push(count));

  connection.emit('data', { type: 'viewer-count', count: -1 });
  connection.emit('data', { type: 'viewer-count', count: '2' });
  connection.emit('data', { type: 'other', count: 4 });

  assert.deepEqual(rendered, []);
});
