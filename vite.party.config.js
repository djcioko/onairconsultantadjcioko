module.exports = {
  build: {
    outDir: 'dist/party-raw',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: 'site/src/party-guest-entry.js',
      formats: ['es'],
      fileName: () => 'party-guest-v1.js',
      cssFileName: 'party-room-v1',
    },
  },
};
