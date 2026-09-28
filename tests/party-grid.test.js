// @vitest-environment jsdom

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {createPartyGrid} from '../site/src/party-grid.js';


const participant = (identity, overrides = {}) => ({
  identity,
  role: 'guest',
  displayName: 'Ana',
  displaySequence: 1,
  state: 'active',
  microphone: 'unmuted',
  camera: 'published',
  connectionQuality: 'excellent',
  ...overrides,
});


function fixture({localIdentity = 'host', onRemove = vi.fn()} = {}) {
  const root = document.createElement('section');
  document.body.append(root);
  const grid = createPartyGrid({root, localIdentity, onRemove});
  return {grid, onRemove, root};
}


beforeEach(() => { document.body.textContent = ''; });


describe('stable party grid', () => {
  it('creates one safely rendered tile per opaque identity with the host first', () => {
    const {grid, root} = fixture();
    grid.applyRoster({participants: [
      participant('guest-b', {displayName: '<img src=x onerror=alert(1)>', displaySequence: 2}),
      participant('host', {role: 'host', displayName: 'DJ Cioko', displaySequence: 0}),
      participant('guest-a', {displayName: 'Ana', displaySequence: 1}),
    ]});
    const tiles = [...root.querySelectorAll('.party-tile')];
    expect(tiles).toHaveLength(3);
    expect(tiles.map(tile => tile.dataset.identity)).toEqual(['host', 'guest-a', 'guest-b']);
    expect(tiles[2].querySelector('.party-name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(tiles[2].querySelector('img')).toBeNull();
    expect(root.dataset.count).toBe('3');
  });

  it('parses signed LiveKit attributes without exposing opaque identity as a name', () => {
    const {grid, root} = fixture({localIdentity: 'guest-opaque'});
    grid.applyRoster([
      {
        identity: 'guest-opaque',
        attributes: {
          role: 'party-guest', display_name: 'Măr Ioana',
          display_sequence: '7', generation: '2',
        },
        isMicrophoneEnabled: true,
        isCameraEnabled: false,
        connectionQuality: 'good',
      },
    ]);
    const tile = root.querySelector('.party-tile');
    expect(tile.querySelector('.party-name').textContent).toBe('Măr Ioana');
    expect(tile.textContent).not.toContain('guest-opaque');
    expect(tile.dataset.generation).toBe('2');
    expect(tile.querySelector('[data-kind="camera"]').dataset.state).toBe('off');
  });

  it('reuses tiles and media elements across reconnect/name/status updates', () => {
    const {grid, root} = fixture();
    grid.applyRoster([
      participant('host', {role: 'host', displayName: 'DJ Cioko', displaySequence: 0}),
      participant('guest', {state: 'disconnected'}),
    ]);
    const tile = root.querySelector('[data-identity="guest"]');
    const video = tile.querySelector('video');
    const audio = tile.querySelector('audio');
    grid.applyRoster([
      participant('host', {role: 'host', displayName: 'DJ Cioko', displaySequence: 0}),
      participant('guest', {displayName: 'Ana Maria', state: 'active', connectionQuality: 'poor'}),
    ]);
    expect(root.querySelector('[data-identity="guest"]')).toBe(tile);
    expect(tile.querySelector('video')).toBe(video);
    expect(tile.querySelector('audio')).toBe(audio);
    expect(tile.querySelector('.party-name').textContent).toBe('Ana Maria');
  });

  it('adds a sequence suffix only where duplicate display names need disambiguation', () => {
    const {grid, root} = fixture();
    grid.applyRoster([
      participant('host', {role: 'host', displayName: 'DJ Cioko', displaySequence: 0}),
      participant('one', {displayName: 'Ana', displaySequence: 1}),
      participant('two', {displayName: 'Ana', displaySequence: 2}),
      participant('three', {displayName: 'Bea', displaySequence: 3}),
    ]);
    expect(root.querySelector('[data-identity="one"] .party-name').textContent).toBe('Ana · #1');
    expect(root.querySelector('[data-identity="two"] .party-name').textContent).toBe('Ana · #2');
    expect(root.querySelector('[data-identity="three"] .party-name').textContent).toBe('Bea');
  });

  it('attaches and detaches tracks without removing the participant tile', () => {
    const {grid, root} = fixture();
    grid.applyRoster([participant('guest')]);
    const tile = root.querySelector('.party-tile');
    const video = tile.querySelector('video');
    const track = {kind: 'video', attach: vi.fn(), detach: vi.fn()};
    const publication = {kind: 'video', isMuted: false};
    grid.attachTrack('guest', track, publication);
    expect(track.attach).toHaveBeenCalledWith(video);
    expect(tile.querySelector('[data-kind="camera"]').dataset.state).toBe('on');
    grid.detachTrack('guest', 'video');
    expect(track.detach).toHaveBeenCalledWith(video);
    expect(root.querySelector('.party-tile')).toBe(tile);
    expect(tile.querySelector('[data-kind="camera"]').dataset.state).toBe('off');
    expect(tile.querySelector('.party-initials').hidden).toBe(false);
  });

  it('updates mute, publication, reconnect, quality, and speaking indicators', () => {
    const {grid, root} = fixture();
    grid.applyRoster([participant('guest')]);
    const tile = root.querySelector('.party-tile');
    grid.setTrackState('guest', 'microphone', 'muted');
    grid.setTrackState('guest', 'camera', 'unpublished');
    grid.setConnectionState('guest', 'reconnecting');
    grid.setConnectionQuality('guest', 'poor');
    grid.setSpeaking('guest', true);
    expect(tile.querySelector('[data-kind="microphone"]').dataset.state).toBe('muted');
    expect(tile.querySelector('[data-kind="camera"]').dataset.state).toBe('off');
    expect(tile.querySelector('[data-kind="connection"]').textContent).toContain('Reconectare');
    expect(tile.querySelector('[data-kind="quality"]').dataset.state).toBe('poor');
    expect(tile.classList.contains('is-speaking')).toBe(true);
    grid.setTrackState('guest', 'microphone', 'unmuted');
    grid.setTrackState('guest', 'camera', 'published');
    expect(tile.querySelector('[data-kind="microphone"]').dataset.state).toBe('on');
    expect(tile.querySelector('[data-kind="camera"]').dataset.state).toBe('on');
  });

  it('shows Remove only to a local host and never on the host tile', () => {
    const host = fixture();
    host.grid.applyRoster([
      participant('host', {role: 'host', displayName: 'DJ Cioko', displaySequence: 0}),
      participant('guest'),
    ]);
    expect(host.root.querySelector('[data-identity="host"] .party-remove')).toBeNull();
    const remove = host.root.querySelector('[data-identity="guest"] .party-remove');
    expect(remove).not.toBeNull();
    remove.click();
    expect(host.onRemove).toHaveBeenCalledWith('guest');

    const guest = fixture({localIdentity: 'guest'});
    guest.grid.applyRoster([
      participant('host', {role: 'host', displayName: 'DJ Cioko', displaySequence: 0}),
      participant('guest'),
    ]);
    expect(guest.root.querySelector('.party-remove')).toBeNull();
  });

  it('removes individual identities and clears attached media deterministically', () => {
    const {grid, root} = fixture();
    grid.applyRoster([participant('one'), participant('two', {displaySequence: 2})]);
    const track = {kind: 'audio', attach: vi.fn(), detach: vi.fn()};
    grid.attachTrack('one', track, {kind: 'audio'});
    grid.remove('one');
    expect(track.detach).toHaveBeenCalled();
    expect(root.querySelector('[data-identity="one"]')).toBeNull();
    grid.clear();
    expect(root.childElementCount).toBe(0);
    expect(root.dataset.count).toBe('0');
  });
});


describe('party grid responsive CSS contract', () => {
  it('defines 1/2/3-column layouts, touch targets, safe areas, and reduced motion', () => {
    const css = readFileSync(resolve('site/styles/party-room.css'), 'utf8');
    expect(css).toMatch(/data-count=['"]1['"]/u);
    expect(css).toContain('repeat(2');
    expect(css).toContain('repeat(3');
    expect(css).toMatch(/min-(?:width|height):\s*44px/u);
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('text-overflow:ellipsis');
  });
});
