const NOOP = () => {};

export class MediaLifecycle {
  constructor({
    document = globalThis.document,
    window = globalThis.window,
    wakeLock = globalThis.navigator?.wakeLock,
    cleanup,
    onStatus = NOOP,
    pauseSegmentation = NOOP,
    resumeSegmentation = NOOP,
  } = {}) {
    if (typeof cleanup !== 'function') {
      throw new TypeError('MediaLifecycle requires a cleanup callback');
    }
    this.document = document;
    this.window = window;
    this.wakeLock = wakeLock;
    this.cleanup = cleanup;
    this.onStatus = onStatus;
    this.pauseSegmentation = pauseSegmentation;
    this.resumeSegmentation = resumeSegmentation;

    this.attached = false;
    this.destroyed = false;
    this.live = false;
    this.cleanupPromise = null;
    this.wakeLockSentinel = null;
    this.wakeLockPromise = null;

    this.handlePageHide = () => {
      void this.cleanupOnce('pagehide');
    };
    this.handleVisibilityChange = () => {
      void this.onVisibilityChange();
    };
  }

  attach() {
    if (this.attached || this.destroyed) return this;
    this.window?.addEventListener?.('pagehide', this.handlePageHide);
    this.document?.addEventListener?.('visibilitychange', this.handleVisibilityChange);
    this.attached = true;
    return this;
  }

  async setLive(live) {
    if (this.destroyed) return;
    this.live = Boolean(live);
    if (this.live) {
      await this.acquireWakeLock();
    } else {
      await this.releaseWakeLock();
    }
  }

  async acquireWakeLock() {
    if (
      !this.live
      || this.destroyed
      || this.document?.visibilityState === 'hidden'
      || !this.wakeLock?.request
      || (this.wakeLockSentinel && !this.wakeLockSentinel.released)
    ) {
      return this.wakeLockSentinel;
    }
    if (this.wakeLockPromise) return this.wakeLockPromise;

    this.wakeLockPromise = Promise.resolve(this.wakeLock.request('screen'))
      .then((sentinel) => {
        if (!this.live || this.destroyed) {
          void sentinel?.release?.();
          return null;
        }
        this.wakeLockSentinel = sentinel;
        sentinel?.addEventListener?.('release', () => {
          if (this.wakeLockSentinel === sentinel) this.wakeLockSentinel = null;
        }, {once: true});
        return sentinel;
      })
      .catch(() => null)
      .finally(() => {
        this.wakeLockPromise = null;
      });
    return this.wakeLockPromise;
  }

  async releaseWakeLock() {
    const pending = this.wakeLockPromise;
    if (pending) await pending;
    const sentinel = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    if (sentinel && !sentinel.released) {
      await sentinel.release();
    }
  }

  async onVisibilityChange() {
    if (this.destroyed) return;
    if (this.document?.visibilityState === 'hidden') {
      await this.releaseWakeLock();
      if (this.live) {
        this.onStatus('RECONNECTING');
      } else {
        this.pauseSegmentation();
      }
      return;
    }

    if (this.live) {
      this.onStatus('RECONNECTING');
      await this.acquireWakeLock();
    } else {
      this.resumeSegmentation();
    }
  }

  cleanupOnce(reason) {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.live = false;
    this.cleanupPromise = Promise.resolve()
      .then(() => this.releaseWakeLock())
      .then(() => this.cleanup(reason));
    return this.cleanupPromise;
  }

  offAir() {
    return this.cleanupOnce('off-air');
  }

  logout() {
    return this.cleanupOnce('logout');
  }

  fatalSessionExpiry() {
    return this.cleanupOnce('session-expired');
  }

  async destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      if (this.attached) {
        this.window?.removeEventListener?.('pagehide', this.handlePageHide);
        this.document?.removeEventListener?.('visibilitychange', this.handleVisibilityChange);
        this.attached = false;
      }
    }
    await this.cleanupOnce('destroy');
  }
}
