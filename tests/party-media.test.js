import {describe, expect, it, vi} from 'vitest';

import {createPartyMediaBridge} from '../studio/src/party-media.js';
import {PROGRAM_PROFILES, ProgramStream} from '../studio/src/program-stream.js';


function rawTrack(kind, name) {
  const value = {
    kind,
    name,
    enabled: true,
    readyState: 'live',
    stop: vi.fn(() => { value.readyState = 'ended'; }),
  };
  value.clone = vi.fn(() => rawTrack(kind, `${name}-clone`));
  return value;
}


function wrapper(track) {
  return {
    kind: track.kind,
    mediaStreamTrack: track,
    stop: vi.fn(() => track.stop()),
    mute: vi.fn(async () => { track.enabled = false; }),
    unmute: vi.fn(async () => { track.enabled = true; }),
  };
}


function drawingContext() {
  const methods = {
    clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(),
    fillText: vi.fn(), save: vi.fn(), restore: vi.fn(),
    translate: vi.fn(), scale: vi.fn(),
    createLinearGradient: vi.fn(() => ({addColorStop: vi.fn()})),
  };
  return methods;
}


function fixture() {
  const canvases = [];
  const canvasFactory = vi.fn(() => {
    const video = rawTrack('video', `canvas-${canvases.length}`);
    const canvas = {
      width: 0,
      height: 0,
      context: drawingContext(),
      captureStream: vi.fn(fps => ({
        fps,
        getVideoTracks: () => [video],
        getAudioTracks: () => [],
        getTracks: () => [video],
      })),
      getContext: vi.fn(() => canvas.context),
    };
    canvases.push(canvas);
    return canvas;
  });
  const scheduled = new Map();
  let scheduleId = 0;
  const schedulePartyFrame = vi.fn((callback, delay) => {
    const id = ++scheduleId;
    scheduled.set(id, {callback, delay});
    return id;
  });
  const cancelPartyFrame = vi.fn(id => scheduled.delete(id));
  const microphone = rawTrack('audio', 'microphone-source');
  const camera = rawTrack('video', 'camera-source');
  const program = new ProgramStream({
    profile: PROGRAM_PROFILES['720p24'],
    mediaDevices: {getUserMedia: vi.fn()},
    canvasFactory,
    videoFactory: () => ({play: vi.fn(), pause: vi.fn()}),
    mediaStreamFactory: tracks => ({tracks}),
    segmentation: {initialize: vi.fn(), close: vi.fn()},
    scheduleFrame: vi.fn(),
    cancelFrame: vi.fn(),
    schedulePartyFrame,
    cancelPartyFrame,
    trackFactories: {video: wrapper, audio: wrapper},
  });
  program.cameraSource = camera;
  program.microphoneSource = microphone;
  program.programCanvasTrack = rawTrack('video', 'public-program-source');
  program.standbyCanvasTrack = rawTrack('video', 'standby-source');
  program.segmentationReady = true;
  program.state = 'running';
  const bridge = createPartyMediaBridge({programStream: program});
  return {
    bridge, camera, cancelPartyFrame, canvases, microphone,
    program, schedulePartyFrame, scheduled,
  };
}


describe('party-owned media derivation', () => {
  it('creates a separate 960×540 canvas video at 15 fps and a microphone clone', () => {
    const value = fixture();
    const tracks = value.bridge.createOwnedTracks();
    const partyCanvas = value.canvases.at(-1);

    expect(partyCanvas).not.toBe(value.program.programCanvas);
    expect({width: partyCanvas.width, height: partyCanvas.height}).toEqual({width: 960, height: 540});
    expect(partyCanvas.captureStream).toHaveBeenCalledWith(15);
    expect(partyCanvas.context.drawImage).toHaveBeenCalledWith(
      value.program.programCanvas, 0, 0, 960, 540,
    );
    expect(value.schedulePartyFrame).toHaveBeenCalledWith(expect.any(Function), 1000 / 15);
    expect(tracks.videoTrack.mediaStreamTrack).not.toBe(value.program.programCanvasTrack);
    expect(value.microphone.clone).toHaveBeenCalledTimes(1);
    expect(tracks.audioTrack.mediaStreamTrack).not.toBe(value.microphone);
    expect(value.program.debugPartyTracks()).toHaveLength(1);
  });

  it('mutes only party tracks and never changes source or public-room tracks', async () => {
    const value = fixture();
    const publicTracks = value.program.createRoomTracks();
    const partyTracks = value.bridge.createOwnedTracks();

    await value.bridge.setAudioEnabled(partyTracks, false);
    await value.bridge.setVideoEnabled(partyTracks, false);
    expect(partyTracks.audioTrack.mediaStreamTrack.enabled).toBe(false);
    expect(partyTracks.videoTrack.mediaStreamTrack.enabled).toBe(false);
    expect(value.microphone.enabled).toBe(true);
    expect(value.camera.enabled).toBe(true);
    expect(publicTracks.audioTrack.mediaStreamTrack.enabled).toBe(true);
    expect(publicTracks.videoTrack.mediaStreamTrack.enabled).toBe(true);

    await value.bridge.setAudioEnabled(partyTracks, true);
    await value.bridge.setVideoEnabled(partyTracks, true);
    expect(partyTracks.audioTrack.unmute).toHaveBeenCalledTimes(1);
    expect(partyTracks.videoTrack.unmute).toHaveBeenCalledTimes(1);
  });

  it('cancels the 15-fps loop, stops owned tracks, and preserves sources on release', () => {
    const value = fixture();
    const publicTracks = value.program.createRoomTracks();
    const partyTracks = value.bridge.createOwnedTracks();
    const partyVideo = partyTracks.videoTrack.mediaStreamTrack;
    const partyAudio = partyTracks.audioTrack.mediaStreamTrack;

    value.bridge.stopOwnedTracks(partyTracks);

    expect(value.cancelPartyFrame).toHaveBeenCalledTimes(1);
    expect(partyVideo.stop).toHaveBeenCalledTimes(1);
    expect(partyAudio.stop).toHaveBeenCalledTimes(1);
    expect(value.program.debugPartyTracks()).toEqual([]);
    expect(value.program.programCanvasTrack.stop).not.toHaveBeenCalled();
    expect(value.microphone.stop).not.toHaveBeenCalled();
    expect(publicTracks.videoTrack.mediaStreamTrack.stop).not.toHaveBeenCalled();
    expect(publicTracks.audioTrack.mediaStreamTrack.stop).not.toHaveBeenCalled();
  });

  it('raises a stable visible error when the microphone is unavailable', () => {
    const value = fixture();
    value.program.microphoneSource = null;
    expect(() => value.bridge.createOwnedTracks()).toThrowError(
      expect.objectContaining({code: 'PARTY_MICROPHONE_UNAVAILABLE'}),
    );
    expect(value.program.debugPartyTracks()).toEqual([]);
  });

  it('releases every derived loop and track over repeated open/close cycles', () => {
    const value = fixture();
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const tracks = value.bridge.createOwnedTracks();
      expect(value.program.debugPartyTracks()).toHaveLength(1);
      value.bridge.stopOwnedTracks(tracks);
      expect(value.program.debugPartyTracks()).toEqual([]);
    }
    expect(value.schedulePartyFrame).toHaveBeenCalledTimes(4);
    expect(value.cancelPartyFrame).toHaveBeenCalledTimes(4);
    expect(value.scheduled.size).toBe(0);
  });

  it('rejects foreign track sets without stopping them', () => {
    const value = fixture();
    const foreign = {videoTrack: wrapper(rawTrack('video', 'foreign-video')), audioTrack: wrapper(rawTrack('audio', 'foreign-audio'))};
    expect(() => value.bridge.stopOwnedTracks(foreign)).toThrow(TypeError);
    expect(foreign.videoTrack.stop).not.toHaveBeenCalled();
    expect(foreign.audioTrack.stop).not.toHaveBeenCalled();
  });
});
