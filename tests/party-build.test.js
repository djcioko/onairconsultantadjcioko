import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {resolve} from 'node:path';

import {describe, expect, it} from 'vitest';


const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');


describe('deterministic party release', () => {
  it('emits stable guest filenames with byte-accurate hashes and no source maps', () => {
    const root = resolve('dist/party');
    const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(manifest.assets.map(asset => asset.file)).toEqual([
      'party-guest-v1.js', 'party-room-v1.css',
    ]);
    for (const asset of manifest.assets) {
      const path = resolve(root, asset.file);
      expect(asset.sha256).toBe(hash(path));
      expect(asset.size).toBe(statSync(path).size);
    }
    expect(readdirSync(root).some(file => file.endsWith('.map'))).toBe(false);
  });

  it('bundles LiveKit locally and adds no PeerJS, LiveKit, or MediaPipe CDN', () => {
    const javascript = readFileSync(resolve('dist/party/party-guest-v1.js'), 'utf8');
    expect(javascript).toContain('livekit');
    expect(javascript).not.toMatch(/(?:unpkg\.com|cdn\.jsdelivr\.net|cdn\.skypack\.dev)/u);
    expect(javascript).not.toMatch(/peerjs@|selfie_segmentation@/u);
  });

  it('keeps protected studio at its fixed base with local MediaPipe runtime', () => {
    const html = readFileSync(resolve('dist/studio/index.html'), 'utf8');
    expect(html).toMatch(/\/admin\/live-studio\/assets\//u);
    expect(existsSync(resolve('dist/studio/mediapipe/selfie_segmentation.js'))).toBe(true);
  });

  it('tracks the approved PeerJS host and keeps GitHub Pages self-contained', () => {
    expect(hash(resolve('stream.js'))).toBe('53dedc239ff357b444ba05dd70673476cb79dbb3badc73591513a5cb07b10f43');
    expect(hash(resolve('site-viewer-presence.js'))).toBe('ea1fd7f3c73b5cad353efc5323382b106888e4387d3242f4006c1c7dcafef3d9');
    const html = readFileSync(resolve('index.html'), 'utf8');
    expect(html).toContain('data-peer-host-status');
    expect(html).not.toContain('href="/admin/live-studio/"');
    expect(html).not.toContain('/api/admin/live/party/');
  });
});
