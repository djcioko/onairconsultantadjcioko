module.exports = {
  test: {
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      'tests/pw/**',
      'tests/pw-transport/**',
      'tests/stream.test.js',
      'tests/site-viewer-presence.test.js',
      'tests/tooling-contract.test.js',
      'tests/public-live-regression.test.js',
    ],
  },
};
