import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {copyFile, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const MEDIAPIPE_ASSETS = Object.freeze([
  'selfie_segmentation.js',
  'selfie_segmentation.binarypb',
  'selfie_segmentation.tflite',
  'selfie_segmentation_landscape.tflite',
  'selfie_segmentation_solution_simd_wasm_bin.js',
  'selfie_segmentation_solution_simd_wasm_bin.wasm',
  'selfie_segmentation_solution_wasm_bin.js',
  'selfie_segmentation_solution_wasm_bin.wasm',
]);

const require = createRequire(import.meta.url);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function defaultSourceDir() {
  return dirname(require.resolve('@mediapipe/selfie_segmentation/package.json'));
}

function defaultOutputDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'live-studio', 'mediapipe');
}

export async function copyMediaPipeAssets({
  sourceDir = defaultSourceDir(),
  outputDir = defaultOutputDir(),
} = {}) {
  const sourceEntries = new Set(await readdir(sourceDir));
  for (const file of MEDIAPIPE_ASSETS) {
    if (!sourceEntries.has(file)) {
      throw new Error(`Missing MediaPipe asset: ${file}`);
    }
  }

  await rm(outputDir, {recursive: true, force: true});
  await mkdir(outputDir, {recursive: true});

  const assets = [];
  for (const file of MEDIAPIPE_ASSETS) {
    const sourcePath = resolve(sourceDir, file);
    const outputPath = resolve(outputDir, file);
    await copyFile(sourcePath, outputPath);
    const contents = await readFile(outputPath);
    assets.push({file, sha256: sha256(contents)});
  }

  const manifest = {
    schema: 1,
    package: '@mediapipe/selfie_segmentation',
    assets,
  };
  await writeFile(
    resolve(outputDir, 'asset-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const outputEntries = (await readdir(outputDir)).sort();
  const expectedEntries = [...MEDIAPIPE_ASSETS, 'asset-manifest.json'].sort();
  if (JSON.stringify(outputEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('MediaPipe output contains a missing or unexpected runtime asset');
  }

  return manifest;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  copyMediaPipeAssets().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
