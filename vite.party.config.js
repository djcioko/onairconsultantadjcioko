module.exports = {
  build: {
    outDir: 'dist/party-raw',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: 'site/src/party-guest-entry.js',
      formats: ['es'],
      fileName: () => 'party-guest-v1.js',
    },
  },
};
