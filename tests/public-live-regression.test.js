void (async () => {
  const assert = (await import('node:assert/strict')).default;
  const {createHash} = await import('node:crypto');
  const {readFile} = await import('node:fs/promises');
  const {resolve} = await import('node:path');
  const {test} = await import('node:test');

  const expectedHashes = Object.freeze({
    'stream.js': '53dedc239ff357b444ba05dd70673476cb79dbb3badc73591513a5cb07b10f43',
    'site-viewer-presence.js': 'ea1fd7f3c73b5cad353efc5323382b106888e4387d3242f4006c1c7dcafef3d9',
  });
  const root = resolve(process.cwd());
  const source = (path) => readFile(resolve(root, path), 'utf8');

  test('keeps the approved public PeerJS sources byte-for-byte unchanged', async () => {
    for (const [path, expected] of Object.entries(expectedHashes)) {
      const bytes = await readFile(resolve(root, path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, path);
    }
  });

  test('keeps ordinary public calls, presence, and canvas plus microphone broadcasting', async () => {
    const [html, studio, presence] = await Promise.all([
      source('index.html'),
      source('stream.js'),
      source('site-viewer-presence.js'),
    ]);

    assert.match(html, /peerjs@1\.5\.2\/dist\/peerjs\.min\.js/);
    assert.match(studio, /new\s+Peer\(\s*['"]djcioko-studio-unic-id['"]/);
    assert.match(studio, /createPeerBroadcastStream\(canvasEl\)/);
    assert.match(studio, /canvas\.captureStream\(15\)/);
    assert.match(studio, /broadcastStream\.addTrack\(\s*microphoneTrack\s*\)/);
    assert.match(studio, /call\.answer\(\s*broadcastStream\s*\)/);
    assert.match(presence, /label:\s*['"]viewer-presence['"]/);
    assert.match(presence, /message\.type\s*!==\s*['"]viewer-count['"]/);
    assert.match(studio, /type:\s*['"]viewer-count['"]/);
  });
})();
