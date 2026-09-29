// @vitest-environment jsdom

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {afterEach, describe, expect, test, vi} from 'vitest';

const pageHtml = readFileSync(resolve('index.html'), 'utf8');
const studioLifecycleListeners = [];

function createCanvasContext() {
  const gradient = {addColorStop() {}};
  return {
    arc() {},
    beginPath() {},
    clearRect() {},
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    drawImage() {},
    fillRect() {},
    fillText() {},
    restore() {},
    save() {},
    scale() {},
    stroke() {},
    translate() {},
  };
}

function createCameraStream() {
  const audioTrack = {kind: 'audio', enabled: true, stop: vi.fn()};
  const videoTrack = {kind: 'video', enabled: true, stop: vi.fn()};
  return {
    getAudioTracks: () => [audioTrack],
    getTracks: () => [audioTrack, videoTrack],
    getVideoTracks: () => [videoTrack],
  };
}

function createPreviewStream() {
  const tracks = [];
  return {
    addTrack: (track) => tracks.push(track),
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  };
}

function createWakeLockSentinel() {
  const releaseListeners = new Set();
  return {
    released: false,
    addEventListener(type, listener) {
      if (type === 'release') releaseListeners.add(listener);
    },
    release: vi.fn(async function release() {
      if (this.released) return;
      this.released = true;
      releaseListeners.forEach((listener) => listener());
    }),
  };
}

async function flushAsyncWork() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function loadStudio({wakeLock = 'available'} = {}) {
  const parsed = new DOMParser().parseFromString(pageHtml, 'text/html');
  const inlineScript = [...parsed.querySelectorAll('script:not([src])')]
    .map((script) => script.textContent)
    .find((source) => source.includes('async function startCamera'));

  document.body.innerHTML = parsed.body.innerHTML;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
    writable: true,
  });

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => createCanvasContext());
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockReturnValue('data:image/jpeg;base64,studio');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});

  const previewStreams = [];
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: vi.fn(() => {
      const stream = createPreviewStream();
      previewStreams.push(stream);
      return stream;
    }),
  });

  const cameraStream = createCameraStream();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {getUserMedia: vi.fn().mockResolvedValue(cameraStream)},
  });

  const wakeLockRequests = [];
  if (wakeLock === 'available') {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: vi.fn(async () => {
          const sentinel = createWakeLockSentinel();
          wakeLockRequests.push(sentinel);
          return sentinel;
        }),
      },
    });
  } else if (wakeLock === 'rejected') {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {request: vi.fn().mockRejectedValue(new Error('denied'))},
    });
  } else {
    delete navigator.wakeLock;
  }

  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  const addDocumentListener = document.addEventListener.bind(document);
  const addWindowListener = window.addEventListener.bind(window);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    addDocumentListener(type, listener, options);
    if (type === 'visibilitychange') studioLifecycleListeners.push([document, type, listener, options]);
  });
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    addWindowListener(type, listener, options);
    if (type === 'pagehide') studioLifecycleListeners.push([window, type, listener, options]);
  });
  window.eval(inlineScript);

  return {
    cameraStream,
    captureStream: HTMLCanvasElement.prototype.captureStream,
    previewStreams,
    wakeLockRequests,
  };
}

afterEach(() => {
  studioLifecycleListeners.splice(0).forEach(([target, type, listener, options]) => {
    target.removeEventListener(type, listener, options);
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete navigator.mediaDevices;
  delete navigator.wakeLock;
  delete HTMLCanvasElement.prototype.captureStream;
  document.body.innerHTML = '';
});

describe('camera and ON AIR lifecycle', () => {
  test('a successful camera start immediately goes ON AIR and holds a screen wake lock', async () => {
    const studio = loadStudio();

    document.getElementById('btnStartCam').click();
    await flushAsyncWork();

    expect(document.getElementById('recBtn').classList.contains('rec')).toBe(true);
    expect(document.getElementById('topLiveBadge').classList.contains('active')).toBe(true);
    expect(navigator.wakeLock.request).toHaveBeenCalledWith('screen');
    expect(studio.wakeLockRequests).toHaveLength(1);
  });

  test('camera capture requests speech-optimized microphone audio', async () => {
    const studio = loadStudio();
    const microphoneTrack = studio.cameraStream.getAudioTracks()[0];
    microphoneTrack.contentHint = '';

    document.getElementById('btnStartCam').click();
    await flushAsyncWork();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: {ideal: 1},
        sampleRate: {ideal: 48_000},
      },
      video: {
        facingMode: 'user',
        width: {ideal: 720},
        height: {ideal: 1280},
      },
    });
    expect(microphoneTrack.contentHint).toBe('speech');
  });

  test('ON AIR does not create a duplicate local canvas capture or player stream', async () => {
    const studio = loadStudio();
    const recButton = document.getElementById('recBtn');

    document.getElementById('btnStartCam').click();
    await flushAsyncWork();
    recButton.click();
    await flushAsyncWork();
    recButton.click();
    await flushAsyncWork();

    expect(studio.captureStream).not.toHaveBeenCalled();
    expect(studio.previewStreams).toHaveLength(0);
  });

  test('the REC button stops and restarts ON AIR, including the wake lock', async () => {
    const studio = loadStudio();
    const recButton = document.getElementById('recBtn');

    document.getElementById('btnStartCam').click();
    await flushAsyncWork();
    recButton.click();
    await flushAsyncWork();

    expect(recButton.classList.contains('rec')).toBe(false);
    expect(document.getElementById('topLiveBadge').classList.contains('active')).toBe(false);
    expect(studio.wakeLockRequests[0].release).toHaveBeenCalledTimes(1);

    recButton.click();
    await flushAsyncWork();

    expect(recButton.classList.contains('rec')).toBe(true);
    expect(studio.captureStream).not.toHaveBeenCalled();
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  test('page lifecycle releases and reacquires the wake lock while ON AIR', async () => {
    const studio = loadStudio();

    document.getElementById('btnStartCam').click();
    await flushAsyncWork();
    window.dispatchEvent(new Event('pagehide'));
    await flushAsyncWork();

    expect(studio.wakeLockRequests[0].release).toHaveBeenCalledTimes(1);

    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAsyncWork();

    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  test.each(['unsupported', 'rejected'])(
    'ON AIR still starts when screen wake lock is %s',
    async (wakeLock) => {
      const studio = loadStudio({wakeLock});

      document.getElementById('btnStartCam').click();
      await flushAsyncWork();

      expect(document.getElementById('recBtn').classList.contains('rec')).toBe(true);
      expect(document.getElementById('topLiveBadge').classList.contains('active')).toBe(true);
      expect(studio.captureStream).not.toHaveBeenCalled();
    },
  );
});
