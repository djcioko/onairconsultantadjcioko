/** One controlled media sink. Audio never attaches before explicit consent. */
export class RemotePlayback {
  constructor({video, room, role, videoNames, audioName, soundButton, onBlocked = () => {}}) {
    Object.assign(this, {video, room, role, videoNames, audioName, soundButton, onBlocked});
    this.videoTrack = null;
    this.audioTrack = null;
    this.attachedAudio = null;
    this.consent = false;
    this.closed = false;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    this.soundClick = () => this.enableSound();
    soundButton?.addEventListener('click', this.soundClick);
  }
  accept(track, publication, participant) {
    if (this.closed || participant?.attributes?.role !== this.role) return false;
    const name = publication.trackName ?? publication.name;
    if (track.kind === 'video' && this.videoNames.includes(name)) {
      this.videoTrack?.detach(this.video);
      this.videoTrack = track;
      track.attach(this.video);
      this.video.muted = !this.consent || !this.room.canPlaybackAudio;
      Promise.resolve(this.video.play()).catch(() => this.onBlocked('Apasă pe imagine pentru a porni redarea.'));
      return true;
    }
    if (track.kind === 'audio' && name === this.audioName) {
      this.attachedAudio?.detach(this.video);
      this.attachedAudio = null;
      this.audioTrack = track;
      if (this.consent && this.room.canPlaybackAudio) this.attachAudio();
      return true;
    }
    return false;
  }
  attachAudio() {
    if (this.closed || !this.consent || !this.audioTrack) return;
    if (this.attachedAudio !== this.audioTrack) {
      this.attachedAudio?.detach(this.video);
      this.audioTrack.attach(this.video);
      this.attachedAudio = this.audioTrack;
    }
    this.video.muted = !this.room.canPlaybackAudio;
    if (this.soundButton) this.soundButton.hidden = !this.video.muted;
  }
  async enableSound() {
    if (this.closed) return;
    this.consent = true;
    this.video.muted = true;
    // Attach only after explicit consent, still muted, so startAudio sees
    // this sink synchronously in the button gesture (including Safari).
    if (this.audioTrack && this.attachedAudio !== this.audioTrack) {
      this.attachedAudio?.detach(this.video);
      this.audioTrack.attach(this.video);
      this.attachedAudio = this.audioTrack;
    }
    try {
      // startAudio must be invoked directly from the sound button's gesture.
      await this.room.startAudio();
      if (this.closed) return;
      if (!this.room.canPlaybackAudio) throw new Error('blocked');
      this.attachAudio();
      await this.video.play();
    } catch {
      this.video.muted = true;
      if (this.soundButton) this.soundButton.hidden = false;
      this.onBlocked('Apasă PORNEȘTE SUNETUL pentru a auzi emisia.');
    }
  }
  playbackChanged() {
    if (!this.room.canPlaybackAudio) {
      this.video.muted = true;
      if (this.soundButton) this.soundButton.hidden = false;
    } else if (this.consent) this.attachAudio();
  }
  remove(track) {
    if (track === this.videoTrack) { track.detach(this.video); this.videoTrack = null; }
    if (track === this.audioTrack) {
      this.attachedAudio?.detach(this.video);
      this.audioTrack = this.attachedAudio = null;
      this.video.muted = true;
    }
  }
  close() {
    this.closed = true;
    this.videoTrack?.detach(this.video);
    this.attachedAudio?.detach(this.video);
    this.videoTrack = this.audioTrack = this.attachedAudio = null;
    this.video.srcObject = null;
    this.video.muted = true;
    this.soundButton?.removeEventListener('click', this.soundClick);
  }
}
