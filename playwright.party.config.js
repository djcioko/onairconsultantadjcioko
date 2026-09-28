const {defineConfig} = require('@playwright/test');


module.exports = defineConfig({
  testDir: './tests/pw',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {timeout: 5_000},
  reporter: [['line']],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175/tests/pw/fixture/index.html',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4175',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    video: 'off',
  },
});
