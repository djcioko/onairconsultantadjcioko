function requireOwned(active, known, tracks) {
  if (!known.has(tracks)) {
    throw new TypeError('Party tracks are not owned by this media bridge');
  }
  if (!active.has(tracks)) {
    throw new TypeError('Party tracks have already been released');
  }
}


async function setEnabled(track, enabled) {
  if (!track?.mediaStreamTrack) {
    throw new TypeError('Party media track is unavailable');
  }
  if (enabled) await track.unmute?.();
  else await track.mute?.();
  track.mediaStreamTrack.enabled = Boolean(enabled);
}


export function createPartyMediaBridge({programStream} = {}) {
  if (!programStream?.createPartyTracks || !programStream?.releasePartyTracks) {
    throw new TypeError('ProgramStream with party media support is required');
  }
  const known = new WeakSet();
  const active = new WeakSet();

  return Object.freeze({
    createOwnedTracks() {
      const tracks = programStream.createPartyTracks({width: 960, height: 540, fps: 15});
      known.add(tracks);
      active.add(tracks);
      return tracks;
    },

    async setAudioEnabled(tracks, enabled) {
      requireOwned(active, known, tracks);
      await setEnabled(tracks.audioTrack, Boolean(enabled));
    },

    async setVideoEnabled(tracks, enabled) {
      requireOwned(active, known, tracks);
      await setEnabled(tracks.videoTrack, Boolean(enabled));
    },

    stopOwnedTracks(tracks) {
      if (!known.has(tracks)) {
        throw new TypeError('Party tracks are not owned by this media bridge');
      }
      if (!active.has(tracks)) return;
      active.delete(tracks);
      programStream.releasePartyTracks(tracks);
    },
  });
}
