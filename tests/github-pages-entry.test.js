import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {expect, test} from 'vitest';

test('GitHub Pages opens the PeerJS host directly without a broken server-studio link', () => {
  const html = readFileSync(resolve('index.html'), 'utf8');

  expect(html).not.toMatch(/href=["']\/admin\/live-studio\//);
  expect(html).toMatch(/data-peer-host-status/);
  expect(html).toMatch(/PEERJS GAZDĂ/);
  expect(html).toContain('stream.js?v=party-peerjs-v5');
});
