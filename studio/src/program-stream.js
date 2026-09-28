import {LocalAudioTrack, LocalVideoTrack} from 'livekit-client';

export const SEGMENTATION_BLOCK_MESSAGE = 'AI CUT nu este gata — camera nu va fi transmisă';
export const MEDIAPIPE_ASSET_BASE = '/admin/live-studio/mediapipe/';

export const PROGRAM_PROFILES = Object.freeze({
  '720p24': Object.freeze({width: 1280, height: 720, fps: 24, bitrate: 1_500_000}),
  '540p24': Object.freeze({width: 960, height: 540, fps: 24, bitrate: 900_000}),
});

const PROFILES_BY_SIGNATURE = new Map(
  Object.values(PROGRAM_PROFILES).map((profile) => [
    `${profile.width}x${profile.height}@${profile.fps}:${profile.bitrate}`,
    profile,
  ]),
);

const NOOP = () => {};

function rounded(value) {
  return Number(value.toFixed(4));
}

function sizedRect(x, y, width, height) {
  return {
    x: rounded(x),
    y: rounded(y),
    width: rounded(width),
    height: rounded(height),
  };
}

export function containRect(sourceWidth, sourceHeight, boxWidth, boxHeight) {
  if (![sourceWidth, sourceHeight, boxWidth, boxHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError('containRect requires positive finite dimensions');
  }
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return sizedRect((boxWidth - width) / 2, boxHeight - height, width, height);
}

export function containBustRect(sourceWidth, sourceHeight, boxWidth, boxHeight) {
  if (![sourceWidth, sourceHeight, boxWidth, boxHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError('containBustRect requires positive finite dimensions');
  }
  const maxHeight = boxHeight * 0.92;
  const scale = Math.min(boxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return sizedRect((boxWidth - width) / 2, boxHeight - height, width, height);
}

export function coverRect(sourceWidth, sourceHeight, boxWidth, boxHeight) {
  if (![sourceWidth, sourceHeight, boxWidth, boxHeight].every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError('coverRect requires positive finite dimensions');
  }
  const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return sizedRect((boxWidth - width) / 2, (boxHeight - height) / 2, width, height);
}

function validateProfile(profile) {
  if (typeof profile === 'string') {
    const namedProfile = PROGRAM_PROFILES[profile];
    if (!namedProfile) throw new TypeError('Unsupported program profile');
    return namedProfile;
  }
  if (!profile || !Object.isFrozen(profile)) {
    throw new TypeError('Program profile must be a frozen server-authorized profile');
  }
  const key = `${profile.width}x${profile.height}@${profile.fps}:${profile.bitrate}`;
  const authorizedProfile = PROFILES_BY_SIGNATURE.get(key);
  if (!authorizedProfile) {
    throw new TypeError('Unsupported program profile');
  }
  return authorizedProfile;
}

function cancellationError() {
  if (typeof globalThis.DOMException === 'function') {
    return new globalThis.DOMException('Media request was cancelled', 'AbortError');
  }
  const error = new Error('Media request was cancelled');
  error.name = 'AbortError';
  return error;
}

function isCancellation(error) {
  return error?.name === 'AbortError';
}

function sourceSize(source) {
  if (!source) return null;
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  if (!width || !height) return null;
  return {width, height};
}

function isDrawable(source) {
  if (!source) return false;
  if ('readyState' in source && source.readyState < 2) return false;
  if ('complete' in source && !source.complete) return false;
  return Boolean(sourceSize(source));
}

function defaultCanvasFactory() {
  if (!globalThis.document?.createElement) {
    throw new Error('Canvas creation requires a document or canvasFactory');
  }
  return globalThis.document.createElement('canvas');
}

function defaultVideoFactory() {
  if (!globalThis.document?.createElement) {
    throw new Error('Video creation requires a document or videoFactory');
  }
  const video = globalThis.document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  return video;
}

function defaultMediaStreamFactory(tracks) {
  return new MediaStream(tracks);
}

function defaultScheduleFrame(callback) {
  if (globalThis.requestAnimationFrame) return globalThis.requestAnimationFrame(callback);
  return globalThis.setTimeout(callback, 1000 / 24);
}

function defaultCancelFrame(handle) {
  if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(handle);
  else globalThis.clearTimeout(handle);
}

function defaultSchedulePartyFrame(callback, delay) {
  return globalThis.setTimeout(callback, delay);
}

function defaultCancelPartyFrame(handle) {
  globalThis.clearTimeout(handle);
}

function partyMediaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultTrackFactories() {
  return {
    video: (track) => new LocalVideoTrack(track, track.getConstraints?.(), true),
    audio: (track) => new LocalAudioTrack(track, track.getConstraints?.(), true),
  };
}

export function locateMediaPipeAsset(file, base = MEDIAPIPE_ASSET_BASE) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(file)) {
    throw new TypeError('Invalid MediaPipe asset name');
  }
  return `${base.replace(/\/?$/, '/')}${file}`;
}

export class LocalSelfieSegmenter {
  constructor({base = MEDIAPIPE_ASSET_BASE, constructorLoader} = {}) {
    this.base = base;
    this.constructorLoader = constructorLoader ?? (async () => {
      const module = await import('@mediapipe/selfie_segmentation');
      return module.SelfieSegmentation
        ?? module.default?.SelfieSegmentation
        ?? globalThis.SelfieSegmentation;
    });
    this.instance = null;
    this.pending = null;
    this.ready = false;
  }

  async initialize() {
    if (this.ready && this.instance) return;
    if (this.instance) {
      await this.close();
    }
    const Constructor = await this.constructorLoader();
    if (typeof Constructor !== 'function') {
      throw new Error('MediaPipe SelfieSegmentation is unavailable');
    }
    const instance = new Constructor({
      locateFile: (file) => locateMediaPipeAsset(file, this.base),
    });
    instance.setOptions({modelSelection: 1, selfieMode: false});
    instance.onResults((results) => {
      const pending = this.pending;
      this.pending = null;
      pending?.resolve(results);
    });
    await instance.initialize();
    this.instance = instance;
    this.ready = true;
  }

  async segment(image) {
    if (!this.ready || !this.instance) {
      throw new Error('MediaPipe segmentation is not initialized');
    }
    if (this.pending) {
      throw new Error('MediaPipe segmentation is already processing a frame');
    }
    const result = new Promise((resolve, reject) => {
      this.pending = {resolve, reject};
    });
    try {
      await this.instance.send({image});
    } catch (error) {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(error);
    }
    return result;
  }

  async close() {
    this.ready = false;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error('MediaPipe segmentation stopped'));
    const instance = this.instance;
    this.instance = null;
    await instance?.close?.();
  }
}

export class ProgramCompositor {
  constructor({profile, canvasFactory = defaultCanvasFactory} = {}) {
    this.profile = validateProfile(profile);
    this.canvasFactory = canvasFactory;
    this.programCanvas = this.createCanvas();
    this.standbyCanvas = this.createCanvas();
    this.personCanvas = this.createCanvas();
    this.programContext = this.contextFor(this.programCanvas);
    this.standbyContext = this.contextFor(this.standbyCanvas);
    this.personContext = this.contextFor(this.personCanvas);
    this.background = 'studio';
    this.mask = null;
    this.logo = 'DJCIOKOSTUDIO';
    this.drawStandby();
    this.drawSafeProgram(SEGMENTATION_BLOCK_MESSAGE);
  }

  createCanvas() {
    const canvas = this.canvasFactory();
    canvas.width = this.profile.width;
    canvas.height = this.profile.height;
    return canvas;
  }

  contextFor(canvas) {
    const context = canvas.getContext('2d', {alpha: true});
    if (!context) throw new Error('2D canvas is unavailable');
    return context;
  }

  setBackground(value) {
    const allowedThemes = new Set(['club', 'sunset', 'studio']);
    if (value == null) this.background = 'studio';
    else if (typeof value === 'string' && allowedThemes.has(value)) this.background = value;
    else if (typeof value === 'object') this.background = value;
    else throw new TypeError('Background must be a theme name or drawable media element');
  }

  setMask(value) {
    if (value != null && typeof value !== 'object') {
      throw new TypeError('Mask must be a drawable media element or null');
    }
    this.mask = value;
  }

  setLogo(value) {
    this.logo = String(value ?? '').trim().slice(0, 28) || 'DJCIOKOSTUDIO';
    this.drawStandby();
  }

  drawTheme(context, theme) {
    const {width, height} = this.profile;
    const gradient = context.createLinearGradient?.(0, 0, width, height);
    if (gradient?.addColorStop) {
      if (theme === 'club') {
        gradient.addColorStop(0, '#03040d');
        gradient.addColorStop(0.5, '#40104f');
        gradient.addColorStop(1, '#003a58');
      } else if (theme === 'sunset') {
        gradient.addColorStop(0, '#f27457');
        gradient.addColorStop(0.5, '#702c69');
        gradient.addColorStop(1, '#071830');
      } else {
        gradient.addColorStop(0, '#071018');
        gradient.addColorStop(0.6, '#10334b');
        gradient.addColorStop(1, '#071018');
      }
      context.fillStyle = gradient;
    } else {
      context.fillStyle = '#071018';
    }
    context.fillRect(0, 0, width, height);
  }

  drawBackground(context) {
    const {width, height} = this.profile;
    if (typeof this.background === 'string') {
      this.drawTheme(context, this.background);
      return;
    }
    if (!isDrawable(this.background)) {
      this.drawTheme(context, 'studio');
      return;
    }
    const size = sourceSize(this.background);
    const rect = coverRect(size.width, size.height, width, height);
    context.drawImage(this.background, rect.x, rect.y, rect.width, rect.height);
  }

  drawBrand(context) {
    const {width, height} = this.profile;
    context.save();
    context.fillStyle = '#b9e4ff';
    context.font = `700 ${Math.max(22, Math.round(height * 0.045))}px Georgia, serif`;
    context.textAlign = 'right';
    context.textBaseline = 'top';
    context.fillText(this.logo, width - width * 0.035, height * 0.035);
    context.restore();
  }

  drawMask() {
    if (!isDrawable(this.mask)) return;
    const size = sourceSize(this.mask);
    const maxWidth = this.profile.width * 0.36;
    const maxHeight = this.profile.height * 0.36;
    const rect = containRect(size.width, size.height, maxWidth, maxHeight);
    this.programContext.drawImage(
      this.mask,
      (this.profile.width - rect.width) / 2,
      this.profile.height * 0.14,
      rect.width,
      rect.height,
    );
  }

  drawSafeProgram(message = SEGMENTATION_BLOCK_MESSAGE) {
    const context = this.programContext;
    const {width, height} = this.profile;
    context.clearRect(0, 0, width, height);
    this.drawBackground(context);
    context.save();
    context.fillStyle = 'rgba(0, 0, 0, 0.58)';
    context.fillRect(0, height * 0.68, width, height * 0.32);
    context.fillStyle = '#ffffff';
    context.font = `700 ${Math.max(20, Math.round(height * 0.04))}px Georgia, serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(message, width / 2, height * 0.83);
    context.restore();
    this.drawBrand(context);
  }

  drawStandby() {
    const context = this.standbyContext;
    const {width, height} = this.profile;
    context.clearRect(0, 0, width, height);
    this.drawTheme(context, 'studio');
    context.save();
    context.fillStyle = 'rgba(0, 0, 0, 0.34)';
    context.fillRect(width * 0.08, height * 0.25, width * 0.84, height * 0.5);
    context.fillStyle = '#ffffff';
    context.font = `700 ${Math.max(30, Math.round(height * 0.075))}px Georgia, serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Revin imediat', width / 2, height / 2);
    context.restore();
    this.drawBrand(context);
  }

  drawSegmented(video, segmentationMask, {mirror = false} = {}) {
    if (!isDrawable(video) || !isDrawable(segmentationMask)) {
      this.drawSafeProgram();
      return false;
    }
    const {width, height} = this.profile;
    const size = sourceSize(video);
    const rect = containBustRect(size.width, size.height, width, height);
    const person = this.personContext;
    person.clearRect(0, 0, width, height);
    person.globalCompositeOperation = 'source-over';
    person.drawImage(video, rect.x, rect.y, rect.width, rect.height);
    person.globalCompositeOperation = 'destination-in';
    person.drawImage(segmentationMask, rect.x, rect.y, rect.width, rect.height);
    person.globalCompositeOperation = 'source-over';

    const context = this.programContext;
    context.clearRect(0, 0, width, height);
    this.drawBackground(context);
    context.save();
    if (mirror) {
      context.translate(width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(this.personCanvas, 0, 0, width, height);
    context.restore();
    this.drawMask();
    this.drawBrand(context);
    return true;
  }
}

export class ProgramStream {
  constructor({
    profile,
    mediaDevices = globalThis.navigator?.mediaDevices,
    canvasFactory = defaultCanvasFactory,
    videoFactory = defaultVideoFactory,
    mediaStreamFactory = defaultMediaStreamFactory,
    segmentation = new LocalSelfieSegmenter(),
    onStatus = NOOP,
    scheduleFrame = defaultScheduleFrame,
    cancelFrame = defaultCancelFrame,
    schedulePartyFrame = defaultSchedulePartyFrame,
    cancelPartyFrame = defaultCancelPartyFrame,
    trackFactories = defaultTrackFactories(),
  } = {}) {
    this.profile = validateProfile(profile);
    if (!mediaDevices?.getUserMedia) {
      throw new TypeError('ProgramStream requires MediaDevices.getUserMedia');
    }
    this.mediaDevices = mediaDevices;
    this.canvasFactory = canvasFactory;
    this.videoFactory = videoFactory;
    this.mediaStreamFactory = mediaStreamFactory;
    this.segmentation = segmentation;
    this.onStatus = onStatus;
    this.scheduleFrame = scheduleFrame;
    this.cancelFrame = cancelFrame;
    this.schedulePartyFrame = schedulePartyFrame;
    this.cancelPartyFrame = cancelPartyFrame;
    this.trackFactories = trackFactories;

    this.videoElement = this.videoFactory();
    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    this.compositor = new ProgramCompositor({profile: this.profile, canvasFactory: this.canvasFactory});
    this.programCanvas = this.compositor.programCanvas;
    this.standbyCanvas = this.compositor.standbyCanvas;

    this.cameraSource = null;
    this.microphoneSource = null;
    this.pendingCameraTrack = null;
    this.pendingMicrophoneTrack = null;
    this.programCanvasTrack = null;
    this.standbyCanvasTrack = null;
    this.roomClones = new Set();
    this.microphoneClones = new Set();
    this.audioWrappers = new Map();
    this.partyTracks = new Map();
    this.releasedPartyTracks = new WeakSet();
    this.facingMode = 'user';
    this.segmentationReady = false;
    this.segmentationPaused = false;
    this.renderHandle = null;
    this.rendering = false;
    this.stopPromise = null;
    this.stoppedTracks = new WeakSet();
    this.captureEpoch = 0;
    this.state = 'idle';
  }

  emitStatus(code, message, retryable = false) {
    this.onStatus({code, message, retryable});
  }

  assertCurrentCapture(epoch, stream) {
    if (epoch === this.captureEpoch && this.state !== 'stopping' && this.state !== 'stopped') {
      return;
    }
    stream?.getTracks?.().forEach((track) => this.stopTrack(track));
    throw cancellationError();
  }

  cancelRenderLoop() {
    if (this.renderHandle == null) return;
    this.cancelFrame(this.renderHandle);
    this.renderHandle = null;
  }

  setProfile(profile) {
    const next = validateProfile(profile);
    if (
      this.cameraSource
      || this.microphoneSource
      || this.programCanvasTrack?.readyState === 'live'
      || this.standbyCanvasTrack?.readyState === 'live'
      || [...this.roomClones].some((track) => track.readyState === 'live')
      || this.partyTracks.size > 0
    ) {
      throw new Error('Profile cannot change while preview or room tracks are active');
    }
    this.profile = next;
    this.compositor = new ProgramCompositor({profile: next, canvasFactory: this.canvasFactory});
    this.programCanvas = this.compositor.programCanvas;
    this.standbyCanvas = this.compositor.standbyCanvas;
    return this;
  }

  setBackground(value) {
    this.compositor.setBackground(value);
    if (!this.segmentationReady) this.compositor.drawSafeProgram();
    return this;
  }

  setMask(value) {
    this.compositor.setMask(value);
    return this;
  }

  setLogo(value) {
    this.compositor.setLogo(value);
    return this;
  }

  cameraConstraints(facingMode) {
    return {
      audio: false,
      video: {
        facingMode: {ideal: facingMode},
        width: {ideal: this.profile.width},
        height: {ideal: this.profile.height},
        aspectRatio: {ideal: 16 / 9},
        frameRate: {ideal: this.profile.fps, max: this.profile.fps},
      },
    };
  }

  microphoneConstraints() {
    return {
      video: false,
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };
  }

  firstTrack(stream, kind) {
    const tracks = kind === 'video' ? stream?.getVideoTracks?.() : stream?.getAudioTracks?.();
    const track = tracks?.[0];
    if (!track) throw new Error(`No ${kind} track was returned by the browser`);
    for (const extra of tracks.slice(1)) this.stopTrack(extra);
    return track;
  }

  async bindCamera(track) {
    this.videoElement.srcObject = this.mediaStreamFactory([track]);
    await this.videoElement.play?.();
  }

  ensureCanvasTracks() {
    if (!this.programCanvasTrack || this.programCanvasTrack.readyState === 'ended') {
      this.programCanvasTrack = this.firstTrack(
        this.programCanvas.captureStream(this.profile.fps),
        'video',
      );
    }
    if (!this.standbyCanvasTrack || this.standbyCanvasTrack.readyState === 'ended') {
      this.standbyCanvasTrack = this.firstTrack(
        this.standbyCanvas.captureStream(this.profile.fps),
        'video',
      );
    }
  }

  async initializeSegmentation(epoch = this.captureEpoch) {
    try {
      await this.segmentation.initialize();
      this.assertCurrentCapture(epoch);
      this.segmentationReady = true;
      this.emitStatus('READY', 'Camera și AI CUT sunt gata', false);
      return true;
    } catch (error) {
      this.segmentationReady = false;
      if (isCancellation(error)) throw error;
      this.compositor.drawSafeProgram(SEGMENTATION_BLOCK_MESSAGE);
      this.emitStatus('SEGMENTATION_UNAVAILABLE', SEGMENTATION_BLOCK_MESSAGE, true);
      return false;
    }
  }

  async startCamera({facingMode = 'user'} = {}) {
    if (facingMode !== 'user' && facingMode !== 'environment') {
      throw new TypeError('facingMode must be user or environment');
    }
    if (this.state === 'stopping') {
      await this.stopPromise;
    }
    if (this.state === 'stopped') {
      this.state = 'idle';
    }
    if (this.cameraSource && this.microphoneSource) {
      if (this.facingMode !== facingMode) await this.replaceCamera({facingMode});
      return this;
    }
    if (!this.cameraSource && this.microphoneSource) {
      return this.replaceCamera({facingMode});
    }

    const epoch = ++this.captureEpoch;
    this.state = 'starting';

    let cameraStream;
    let cameraTrack;
    let phase = 'camera';
    try {
      cameraStream = await this.mediaDevices.getUserMedia(this.cameraConstraints(facingMode));
      this.assertCurrentCapture(epoch, cameraStream);
      cameraTrack = this.firstTrack(cameraStream, 'video');
      this.pendingCameraTrack = cameraTrack;
    } catch (error) {
      cameraStream?.getTracks?.().forEach((track) => this.stopTrack(track));
      if (epoch === this.captureEpoch && this.state === 'starting') this.state = 'idle';
      if (!isCancellation(error)) {
        this.emitStatus('CAMERA_DENIED', 'Camera nu a putut fi pornită', true);
      }
      throw error;
    }

    let microphoneStream;
    let microphoneTrack;
    try {
      phase = 'microphone';
      microphoneStream = await this.mediaDevices.getUserMedia(this.microphoneConstraints());
      this.assertCurrentCapture(epoch, microphoneStream);
      microphoneTrack = this.firstTrack(microphoneStream, 'audio');
      this.pendingMicrophoneTrack = microphoneTrack;
      phase = 'preview';
      await this.bindCamera(cameraTrack);
      this.assertCurrentCapture(epoch, cameraStream);
    } catch (error) {
      cameraStream?.getTracks?.().forEach((track) => this.stopTrack(track));
      microphoneStream?.getTracks?.().forEach((track) => this.stopTrack(track));
      if (this.pendingCameraTrack === cameraTrack) this.pendingCameraTrack = null;
      if (this.pendingMicrophoneTrack === microphoneTrack) this.pendingMicrophoneTrack = null;
      if (epoch === this.captureEpoch && this.state === 'starting') this.state = 'idle';
      if (!isCancellation(error)) {
        if (phase === 'microphone') {
          this.emitStatus('MICROPHONE_DENIED', 'Microfonul nu a putut fi pornit', true);
        } else {
          this.emitStatus('CAMERA_FAILED', 'Previzualizarea camerei nu a pornit', true);
        }
      }
      throw error;
    }

    this.cameraSource = cameraTrack;
    this.microphoneSource = microphoneTrack;
    this.pendingCameraTrack = null;
    this.pendingMicrophoneTrack = null;
    this.facingMode = facingMode;
    this.ensureCanvasTracks();
    try {
      await this.initializeSegmentation(epoch);
      this.assertCurrentCapture(epoch);
    } catch (error) {
      if (isCancellation(error)) throw error;
      throw error;
    }
    this.state = 'running';
    this.startRenderLoop();
    return this;
  }

  async retrySegmentation() {
    if (!this.cameraSource || !this.microphoneSource) {
      throw new Error('Camera and microphone must be started before retrying AI CUT');
    }
    const ready = await this.initializeSegmentation();
    if (!ready) throw new Error(SEGMENTATION_BLOCK_MESSAGE);
    return this;
  }

  async replaceCamera({facingMode} = {}) {
    if (facingMode !== 'user' && facingMode !== 'environment') {
      throw new TypeError('facingMode must be user or environment');
    }
    if (this.state === 'stopping') await this.stopPromise;
    if (!this.microphoneSource) {
      return this.startCamera({facingMode});
    }
    if (this.cameraSource && this.facingMode === facingMode) return this;

    const epoch = ++this.captureEpoch;
    this.state = 'flipping';
    this.cancelRenderLoop();
    const previous = this.cameraSource;
    this.cameraSource = null;
    this.videoElement.pause?.();
    this.videoElement.srcObject = null;
    this.compositor.drawSafeProgram(SEGMENTATION_BLOCK_MESSAGE);
    this.stopTrack(previous);

    let replacementStream;
    let replacement;
    try {
      replacementStream = await this.mediaDevices.getUserMedia(this.cameraConstraints(facingMode));
      this.assertCurrentCapture(epoch, replacementStream);
      replacement = this.firstTrack(replacementStream, 'video');
      this.pendingCameraTrack = replacement;
      await this.bindCamera(replacement);
      this.assertCurrentCapture(epoch, replacementStream);
      this.cameraSource = replacement;
      this.pendingCameraTrack = null;
      this.facingMode = facingMode;
      this.state = 'running';
      this.startRenderLoop();
      this.emitStatus('CAMERA_REPLACED', 'Camera a fost schimbată', false);
      return this;
    } catch (error) {
      replacementStream?.getTracks?.().forEach((track) => this.stopTrack(track));
      if (this.pendingCameraTrack === replacement) this.pendingCameraTrack = null;
      if (epoch === this.captureEpoch && this.state === 'flipping') this.state = 'idle';
      if (!isCancellation(error)) {
        this.emitStatus('CAMERA_REPLACE_FAILED', 'Camera nu a putut fi schimbată', true);
      }
      throw error;
    }
  }

  startRenderLoop() {
    if (this.renderHandle != null || this.state !== 'running') return;
    const tick = async () => {
      this.renderHandle = null;
      if (this.state !== 'running') return;
      if (!this.rendering) {
        this.rendering = true;
        try {
          await this.renderOnce();
        } finally {
          this.rendering = false;
        }
      }
      if (this.state === 'running') this.renderHandle = this.scheduleFrame(tick);
    };
    this.renderHandle = this.scheduleFrame(tick);
  }

  async renderOnce() {
    const epoch = this.captureEpoch;
    if (
      !this.cameraSource
      || this.cameraSource.readyState === 'ended'
      || this.segmentationPaused
      || !this.segmentationReady
    ) {
      if (!this.segmentationPaused) this.compositor.drawSafeProgram(SEGMENTATION_BLOCK_MESSAGE);
      return false;
    }
    try {
      const results = await this.segmentation.segment(this.videoElement);
      if (epoch !== this.captureEpoch || this.state !== 'running') return false;
      if (!results?.segmentationMask) throw new Error('Segmentation mask is missing');
      return this.compositor.drawSegmented(this.videoElement, results.segmentationMask, {
        mirror: this.facingMode === 'user',
      });
    } catch (error) {
      if (epoch !== this.captureEpoch || this.state === 'stopping' || this.state === 'stopped') {
        return false;
      }
      this.segmentationReady = false;
      this.compositor.drawSafeProgram(SEGMENTATION_BLOCK_MESSAGE);
      this.emitStatus('SEGMENTATION_UNAVAILABLE', SEGMENTATION_BLOCK_MESSAGE, true);
      return false;
    }
  }

  pauseSegmentation() {
    this.segmentationPaused = true;
  }

  resumeSegmentation() {
    if (this.cameraSource?.readyState === 'live') this.segmentationPaused = false;
  }

  isReady() {
    return Boolean(
      this.segmentationReady
      && this.cameraSource?.readyState === 'live'
      && this.microphoneSource?.readyState === 'live'
      && this.programCanvasTrack?.readyState === 'live'
      && this.standbyCanvasTrack?.readyState === 'live',
    );
  }

  assertReady() {
    if (!this.isReady()) throw new Error(SEGMENTATION_BLOCK_MESSAGE);
  }

  createRoomTracks() {
    this.assertReady();
    const videoClone = this.programCanvasTrack.clone();
    const audioClone = this.microphoneSource.clone();
    audioClone.enabled = this.microphoneSource.enabled;
    this.roomClones.add(videoClone);
    this.roomClones.add(audioClone);
    this.microphoneClones.add(audioClone);
    const videoTrack = this.trackFactories.video(videoClone);
    const audioTrack = this.trackFactories.audio(audioClone);
    this.audioWrappers.set(audioClone, audioTrack);
    return {videoTrack, audioTrack};
  }

  createPartyTracks({width = 960, height = 540, fps = 15} = {}) {
    if (!this.microphoneSource || this.microphoneSource.readyState !== 'live'
        || typeof this.microphoneSource.clone !== 'function') {
      throw partyMediaError(
        'PARTY_MICROPHONE_UNAVAILABLE',
        'Microfonul gazdei nu este disponibil pentru camera cu invitați.',
      );
    }
    this.assertReady();
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(fps)
        || width < 1 || height < 1 || fps <= 0
        || width > 960 || height > 540 || fps > 15) {
      throw new TypeError('Party media is limited to 960x540 at 15 fps');
    }

    const canvas = this.canvasFactory();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) throw partyMediaError('PARTY_VIDEO_UNAVAILABLE', 'Imaginea camerei nu poate fi pregătită.');
    const record = {
      tracks: null,
      canvas,
      context,
      width,
      height,
      fps,
      handle: null,
      released: false,
      rawVideo: null,
      rawAudio: null,
    };
    const draw = () => {
      record.handle = null;
      if (record.released) return;
      context.clearRect?.(0, 0, width, height);
      context.drawImage(this.programCanvas, 0, 0, width, height);
      if (!record.released) {
        record.handle = this.schedulePartyFrame(draw, 1000 / fps);
      }
    };

    try {
      draw();
      record.rawVideo = this.firstTrack(canvas.captureStream(fps), 'video');
      record.rawAudio = this.microphoneSource.clone();
      record.rawAudio.enabled = this.microphoneSource.enabled;
      const tracks = {
        videoTrack: this.trackFactories.video(record.rawVideo),
        audioTrack: this.trackFactories.audio(record.rawAudio),
      };
      record.tracks = tracks;
      this.partyTracks.set(tracks, record);
      return tracks;
    } catch (error) {
      record.released = true;
      if (record.handle != null) this.cancelPartyFrame(record.handle);
      this.stopTrack(record.rawVideo);
      this.stopTrack(record.rawAudio);
      throw error;
    }
  }

  releasePartyTracks(tracks) {
    const record = this.partyTracks.get(tracks);
    if (!record) {
      if (this.releasedPartyTracks.has(tracks)) return;
      throw new TypeError('Party tracks are not owned by this ProgramStream');
    }
    record.released = true;
    if (record.handle != null) {
      this.cancelPartyFrame(record.handle);
      record.handle = null;
    }
    for (const [wrapper, raw] of [
      [tracks.videoTrack, record.rawVideo],
      [tracks.audioTrack, record.rawAudio],
    ]) {
      try { wrapper?.stop?.(); } catch { /* raw track cleanup follows */ }
      if (raw?.readyState !== 'ended') this.stopTrack(raw);
      else if (raw) this.stoppedTracks.add(raw);
    }
    this.partyTracks.delete(tracks);
    this.releasedPartyTracks.add(tracks);
  }

  createStandbyVideoTrack() {
    if (!this.standbyCanvasTrack || this.standbyCanvasTrack.readyState !== 'live') {
      throw new Error('Standby video is unavailable');
    }
    const clone = this.standbyCanvasTrack.clone();
    this.roomClones.add(clone);
    return this.trackFactories.video(clone);
  }

  async setRoomAudioEnabled(localAudioTrack, enabled) {
    const track = localAudioTrack?.mediaStreamTrack;
    if (!track || !this.microphoneClones.has(track)) {
      throw new TypeError('Audio track is not owned by this ProgramStream');
    }
    if (enabled) await localAudioTrack.unmute?.();
    else await localAudioTrack.mute?.();
    track.enabled = Boolean(enabled);
  }

  async setMicrophoneEnabled(enabled) {
    const target = Boolean(enabled);
    if (!this.microphoneSource) throw new Error('Microphone is not started');
    this.microphoneSource.enabled = target;
    await Promise.all([...this.microphoneClones].map(async (track) => {
      const wrapper = this.audioWrappers.get(track);
      if (target) await wrapper?.unmute?.();
      else await wrapper?.mute?.();
      track.enabled = target;
    }));
  }

  sourceTrackCount() {
    return [this.cameraSource, this.microphoneSource]
      .filter((track) => track?.readyState === 'live').length;
  }

  debugSources() {
    return {camera: this.cameraSource, microphone: this.microphoneSource};
  }

  debugClones() {
    return [...this.roomClones];
  }

  debugPartyTracks() {
    return [...this.partyTracks.keys()];
  }

  stopTrack(track) {
    if (!track || this.stoppedTracks.has(track)) return;
    this.stoppedTracks.add(track);
    track.stop?.();
  }

  stop() {
    if (this.state === 'stopping') return this.stopPromise;
    if (this.state === 'stopped') return Promise.resolve();

    ++this.captureEpoch;
    this.state = 'stopping';
    this.cancelRenderLoop();
    for (const tracks of [...this.partyTracks.keys()]) this.releasePartyTracks(tracks);

    const ownedTracks = new Set([
      ...this.roomClones,
      this.programCanvasTrack,
      this.standbyCanvasTrack,
      this.cameraSource,
      this.microphoneSource,
      this.pendingCameraTrack,
      this.pendingMicrophoneTrack,
    ].filter(Boolean));

    this.roomClones.clear();
    this.microphoneClones.clear();
    this.audioWrappers.clear();
    this.programCanvasTrack = null;
    this.standbyCanvasTrack = null;
    this.cameraSource = null;
    this.microphoneSource = null;
    this.pendingCameraTrack = null;
    this.pendingMicrophoneTrack = null;
    this.segmentationReady = false;
    this.segmentationPaused = false;
    this.videoElement.pause?.();
    this.videoElement.srcObject = null;
    for (const track of ownedTracks) this.stopTrack(track);
    this.compositor.drawSafeProgram(SEGMENTATION_BLOCK_MESSAGE);

    this.stopPromise = (async () => {
      try {
        await this.segmentation.close?.();
      } finally {
        this.state = 'stopped';
        this.stopPromise = null;
        this.emitStatus('STOPPED', 'Camera și microfonul au fost oprite', false);
      }
    })();
    return this.stopPromise;
  }
}
