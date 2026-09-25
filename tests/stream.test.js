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
