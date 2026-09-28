import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {
  MEDIAPIPE_ASSETS,
  copyMediaPipeAssets,
} from '../../scripts/copy-mediapipe-assets.mjs';

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, {recursive: true, force: true})));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'djcioko-mediapipe-'));
  tempRoots.push(root);
  const sourceDir = join(root, 'source');
  const outputDir = join(root, 'admin', 'live-studio', 'mediapipe');
  await mkdir(sourceDir, {recursive: true});
  for (const name of MEDIAPIPE_ASSETS) {
    await writeFile(join(sourceDir, name), `fixture:${name}`);
  }
  return {sourceDir, outputDir};
}

describe('local protected-studio MediaPipe assets', () => {
  it('copies only the eight pinned runtime files with deterministic hashes', async () => {
    const {sourceDir, outputDir} = await fixture();

    const manifest = await copyMediaPipeAssets({sourceDir, outputDir});

    expect((await readdir(outputDir)).sort()).toEqual([
      ...MEDIAPIPE_ASSETS,
      'asset-manifest.json',
    ].sort());
    expect(manifest.assets.map(({file}) => file)).toEqual(MEDIAPIPE_ASSETS);
    expect(manifest.assets.every(({sha256}) => /^[a-f0-9]{64}$/.test(sha256))).toBe(true);
    expect(JSON.parse(await readFile(join(outputDir, 'asset-manifest.json'), 'utf8'))).toEqual(manifest);
  });

  it('fails closed when a pinned runtime file is missing', async () => {
    const {sourceDir, outputDir} = await fixture();
    await rm(join(sourceDir, MEDIAPIPE_ASSETS[3]));

    await expect(copyMediaPipeAssets({sourceDir, outputDir})).rejects.toThrow(
      `Missing MediaPipe asset: ${MEDIAPIPE_ASSETS[3]}`,
    );
  });

  it('removes stale runtime files from the protected-studio asset directory', async () => {
    const {sourceDir, outputDir} = await fixture();
    await mkdir(outputDir, {recursive: true});
    await writeFile(join(outputDir, 'unexpected-runtime.js'), 'stale');

    await copyMediaPipeAssets({sourceDir, outputDir});

    expect(await readdir(outputDir)).not.toContain('unexpected-runtime.js');
  });
});
