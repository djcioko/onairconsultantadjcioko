const {defineConfig} = require('@playwright/test');
const path = require('node:path');


const required = [
  'PARTY_TEST_BASE_URL',
  'PARTY_TEST_OWNER_STORAGE_STATE',
  'PARTY_TEST_TURN_HOST',
  'PARTY_TEST_METRICS_URL',
  'PARTY_TEST_METRICS_TOKEN',
  'PARTY_TEST_REPORT_DIR',
];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  throw new Error(`Real transport probe requires: ${missing.join(', ')}`);
}

const baseURL = new URL(process.env.PARTY_TEST_BASE_URL);
if (baseURL.hostname === 'djcioko.ro' && process.env.PARTY_TEST_ALLOW_PRODUCTION !== '1') {
  throw new Error('Refusing the literal production site without PARTY_TEST_ALLOW_PRODUCTION=1');
}


module.exports = defineConfig({
  testDir: './tests/pw-transport',
  fullyParallel: false,
  workers: 1,
  timeout: Number(process.env.PARTY_TEST_DURATION_MS || 1_200_000) + 180_000,
  reporter: [['line']],
  outputDir: path.resolve(process.env.PARTY_TEST_REPORT_DIR, 'playwright'),
  use: {
    baseURL: baseURL.toString(),
    browserName: 'chromium',
    permissions: ['camera', 'microphone'],
    trace: 'on',
    video: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
});
