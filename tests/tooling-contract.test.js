void (async () => {
  const {test} = await import('node:test');
  const assert = (await import('node:assert/strict')).default;
  const {existsSync, readFileSync} = await import('node:fs');
  const {resolve} = await import('node:path');

  test('pins the multiparty build toolchain and protected studio inputs', () => {
    const root = resolve(process.cwd());
    const manifestPath = resolve(root, 'package.json');
    assert.equal(existsSync(manifestPath), true, 'package.json must exist');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.dependencies, {
      '@mediapipe/selfie_segmentation': '0.1.1675465747',
      'livekit-client': '2.22.3',
    });
    assert.deepEqual(manifest.devDependencies, {
      '@playwright/test': '1.63.0',
      'jsdom': '30.1.1',
      'vite': '8.3.0',
      'vitest': '5.0.1',
    });

    for (const name of [
      'test:legacy',
      'test',
      'assets:mediapipe',
      'build:studio',
      'build:party',
      'build:release',
      'test:browser',
    ]) {
      assert.equal(typeof manifest.scripts?.[name], 'string', `missing script ${name}`);
    }

    for (const path of [
      'vitest.config.js',
      'vite.studio.config.js',
      'vite.party.config.js',
      'studio/index.html',
      'studio/src/main.js',
      'studio/src/media-lifecycle.js',
      'studio/src/program-stream.js',
      'studio/src/room-controller.js',
      'studio/src/studio.css',
      'site/src/live-api.js',
      'site/src/remote-playback.js',
      'scripts/copy-mediapipe-assets.mjs',
    ]) {
      assert.equal(existsSync(resolve(root, path)), true, `missing protected studio input ${path}`);
    }
  });
})();
