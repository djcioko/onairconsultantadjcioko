import {describe, expect, it, vi} from 'vitest';

import {StudioRoomController} from '../../studio/src/room-controller.js';

function track(kind) {
  return {
    kind,
    stopped: false,
    mediaStreamTrack: {enabled: true},
    stop() { this.stopped = true; },
    async mute() { this.mediaStreamTrack.enabled = false; },
    async unmute() { this.mediaStreamTrack.enabled = true; },
  };
}

function fixture() {
  const history = [];
  const published = new Map();
  const room = {
    on() {},
    async connect() {},
    async disconnect() {},
    localParticipant: {
      async publishTrack(value, options) {
        published.set(value, options);
      },
      async unpublishTrack(value) {
        published.delete(value);
      },
    },
  };
  const media = {
    profile: {bitrate: 1_500_000},
    isReady: () => true,
    stop: vi.fn(),
    createRoomTracks: () => ({videoTrack: track('video'), audioTrack: track('audio')}),
  };
  const api = {
    async call(path, body) {
      history.push({path, body});
      if (path.endsWith('/start')) {
        return {token: 'public', url: 'wss://djcioko.ro', sessionId: 'session', generation: 1};
      }
      return {state: 'LIVE'};
    },
  };
  const controller = new StudioRoomController({api, media, roomFactory: () => room});
  return {api, controller, history, media, published};
}

describe('protected public studio baseline', () => {
  it('publishes only the existing public program and audio track names', async () => {
    const value = fixture();
    await value.controller.start();

    expect([...value.published.values()].map(({name}) => name)).toEqual([
      'public-program',
      'public-audio',
    ]);
    expect(value.history.map(({path}) => path)).toContain('/api/admin/live/public/published');

    const owned = {...value.controller.tracks};
    await value.controller.offAir();
    expect(owned.videoTrack.stopped).toBe(true);
    expect(owned.audioTrack.stopped).toBe(true);
    expect(value.media.stop).not.toHaveBeenCalled();
  });

  it('does not request a public grant before the capture pipeline is ready', async () => {
    const value = fixture();
    value.media.isReady = () => false;

    await expect(value.controller.start()).rejects.toThrow('CAMERA_NOT_READY');
    expect(value.history).toEqual([]);
  });
});
