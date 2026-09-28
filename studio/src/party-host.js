import {RoomEvent, Track, VideoPreset} from 'livekit-client';

import {partyFriendlyError} from '../../site/src/party-api.js';
import {approvedEndpoint} from '../../site/src/live-api.js';


const PARTY_LAYERS = Object.freeze([
  new VideoPreset(320, 180, 150_000, 15),
  new VideoPreset(640, 360, 400_000, 15),
]);


function idempotencyKey(action) {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `party-host-${action}-${random}`;
}


function nowMilliseconds(timers) {
  return typeof timers.now === 'function' ? timers.now() : Date.now();
}


function remainingSeconds(expiresAt, timers) {
  const value = Number(expiresAt);
  if (!Number.isFinite(value)) return 0;
  const deadline = value < 1_000_000_000_000 ? value * 1000 : value;
  return Math.max(0, Math.ceil((deadline - nowMilliseconds(timers)) / 1000));
}


function trackKind(publication, track = null) {
  const value = String(track?.kind ?? publication?.kind ?? publication?.source ?? '').toLowerCase();
  return value.includes('video') || value.includes('camera') ? 'video'
    : value.includes('audio') || value.includes('microphone') ? 'audio' : '';
}


function errorMessage(code) {
  if (code === 'PARTY_MICROPHONE_UNAVAILABLE') {
    return 'Camera cu invitați are nevoie de microfonul gazdei. Pornește camera și microfonul.';
  }
  if (code === 'IDENTITY_CHANGED') {
    return 'Identitatea camerei nu a putut fi verificată în siguranță.';
  }
  return partyFriendlyError({code});
}


export function setPartyHostAvailability({enabled, panel, legacyPanel}) {
  if (panel) panel.hidden = !enabled;
  if (legacyPanel) {
    legacyPanel.hidden = Boolean(enabled);
    legacyPanel.setAttribute('aria-hidden', String(Boolean(enabled)));
  }
}


export function createPartyHost({
  api,
  grid,
  roomFactory,
  mediaBridge,
  timers = globalThis,
  onState = () => {},
}) {
  if (!api || !grid || typeof roomFactory !== 'function' || !mediaBridge) {
    throw new TypeError('party host dependencies required');
  }

  let snapshot = Object.freeze({
    status: 'closed', sessionId: '', identity: '', generation: 0,
    revision: -1, capacity: 9, occupancy: 0,
    requests: [], participants: [],
    microphoneEnabled: true, cameraEnabled: true,
    acceptDisabled: false, confirmationRequired: false,
    errorCode: '', message: '',
  });
  let epoch = 0;
  let room = null;
  let roomBindings = [];
  let tracks = null;
  let publications = {video: null, audio: null};
  let pollTimer = null;
  let pollInFlight = null;
  let openInFlight = null;
  let reconnectInFlight = null;
  let closeInFlight = null;
  let leaving = false;
  const actions = new Map();

  function emit(patch) {
    snapshot = Object.freeze({...snapshot, ...patch});
    onState(snapshot);
    return snapshot;
  }

  function fail(error) {
    const code = typeof error?.code === 'string' ? error.code : 'LIVE_UNAVAILABLE';
    emit({status: 'error', errorCode: code, message: errorMessage(code)});
  }

  function clearPoll() {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll(expectedEpoch = epoch) {
    clearPoll();
    if (!snapshot.sessionId || snapshot.status === 'closed' || expectedEpoch !== epoch) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void pollStatus({waitMs: 25000, expectedEpoch});
    }, 0);
  }

  function liveParticipants(activeRoom = room) {
    if (!activeRoom) return [];
    const values = [];
    if (activeRoom.localParticipant?.identity) values.push(activeRoom.localParticipant);
    if (activeRoom.remoteParticipants?.values) values.push(...activeRoom.remoteParticipants.values());
    return values;
  }

  function mergedRoster(activeRoom = room) {
    const roster = new Map(snapshot.participants.map(value => [value.identity, {...value}]));
    for (const participant of liveParticipants(activeRoom)) {
      const server = roster.get(participant.identity) ?? {};
      roster.set(participant.identity, {
        ...server,
        identity: participant.identity,
        attributes: participant.attributes,
        isMicrophoneEnabled: participant.isMicrophoneEnabled,
        isCameraEnabled: participant.isCameraEnabled,
        connectionQuality: participant.connectionQuality,
        state: server.state ?? 'active',
      });
    }
    return [...roster.values()];
  }

  function updateGrid(activeRoom = room) {
    if (!activeRoom) return;
    grid.applyRoster(mergedRoster(activeRoom));
    for (const participant of liveParticipants(activeRoom)) {
      const values = participant.trackPublications?.values
        ? [...participant.trackPublications.values()] : [];
      for (const publication of values) {
        if (publication.track) grid.attachTrack(participant.identity, publication.track, publication);
      }
    }
  }

  function listen(activeRoom, event, callback) {
    activeRoom.on?.(event, callback);
    roomBindings.push({activeRoom, event, callback});
  }

  function unbindRoom(activeRoom = room) {
    for (const binding of roomBindings) {
      if (!activeRoom || binding.activeRoom === activeRoom) {
        binding.activeRoom.off?.(binding.event, binding.callback);
      }
    }
    roomBindings = activeRoom
      ? roomBindings.filter(binding => binding.activeRoom !== activeRoom)
      : [];
  }

  function bindRoom(activeRoom) {
    listen(activeRoom, RoomEvent.ParticipantConnected, () => updateGrid(activeRoom));
    listen(activeRoom, RoomEvent.ParticipantDisconnected, participant => {
      if (participant?.identity) grid.setConnectionState(participant.identity, 'disconnected');
    });
    listen(activeRoom, RoomEvent.ParticipantAttributesChanged, () => updateGrid(activeRoom));
    listen(activeRoom, RoomEvent.ParticipantNameChanged, () => updateGrid(activeRoom));
    listen(activeRoom, RoomEvent.TrackSubscribed, (track, publication, participant) => {
      updateGrid(activeRoom);
      if (participant?.identity) grid.attachTrack(participant.identity, track, publication);
    });
    listen(activeRoom, RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (participant?.identity) grid.detachTrack(participant.identity, trackKind(publication, track));
    });
    listen(activeRoom, RoomEvent.TrackUnpublished, (publication, participant) => {
      if (participant?.identity) grid.detachTrack(participant.identity, trackKind(publication));
    });
    listen(activeRoom, RoomEvent.TrackMuted, (publication, participant) => {
      if (participant?.identity) grid.setTrackState(participant.identity, trackKind(publication), 'muted');
    });
    listen(activeRoom, RoomEvent.TrackUnmuted, (publication, participant) => {
      if (participant?.identity) grid.setTrackState(participant.identity, trackKind(publication), 'unmuted');
    });
    listen(activeRoom, RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant?.identity) grid.setConnectionQuality(participant.identity, String(quality).toLowerCase());
    });
    listen(activeRoom, RoomEvent.ActiveSpeakersChanged, speakers => {
      const speaking = new Set((speakers ?? []).map(participant => participant.identity));
      for (const participant of liveParticipants(activeRoom)) {
        grid.setSpeaking(participant.identity, speaking.has(participant.identity));
      }
    });
    listen(activeRoom, RoomEvent.Reconnecting, () => {
      if (activeRoom === room && !leaving) emit({status: 'reconnecting'});
    });
    listen(activeRoom, RoomEvent.Reconnected, () => {
      if (activeRoom === room && !leaving) {
        emit({status: 'open', errorCode: '', message: ''});
        updateGrid(activeRoom);
      }
    });
    listen(activeRoom, RoomEvent.Disconnected, reason => {
      if (activeRoom !== room || leaving) return;
      const value = String(reason ?? '').toLowerCase();
      if (value.includes('room_deleted') || value.includes('room deleted')) {
        void cleanup({releaseTracks: true}).then(() => emit({status: 'closed', occupancy: 0}));
      } else {
        void reconnect();
      }
    });
  }

  function videoOptions() {
    return {
      name: 'party-camera',
      source: Track.Source.Camera,
      simulcast: true,
      videoCodec: 'vp8',
      videoEncoding: {maxBitrate: 800_000, maxFramerate: 15},
      videoSimulcastLayers: PARTY_LAYERS,
    };
  }

  function audioOptions() {
    return {
      name: 'party-microphone',
      source: Track.Source.Microphone,
      audioPreset: {maxBitrate: 48_000},
      dtx: true,
      red: true,
    };
  }

  async function connectGrant(grant, expectedEpoch = epoch) {
    if (snapshot.identity && grant.identity !== snapshot.identity) {
      throw Object.assign(new Error('IDENTITY_CHANGED'), {code: 'IDENTITY_CHANGED'});
    }
    const activeRoom = roomFactory({adaptiveStream: true, dynacast: true});
    if (!activeRoom) throw Object.assign(new Error('LIVE_UNAVAILABLE'), {code: 'LIVE_UNAVAILABLE'});
    room = activeRoom;
    bindRoom(activeRoom);
    await activeRoom.connect(approvedEndpoint(grant.url), grant.token, {autoSubscribe: true});
    if (expectedEpoch !== epoch || room !== activeRoom) return false;
    if (activeRoom.localParticipant?.identity
        && activeRoom.localParticipant.identity !== grant.identity) {
      throw Object.assign(new Error('IDENTITY_CHANGED'), {code: 'IDENTITY_CHANGED'});
    }
    const video = await activeRoom.localParticipant.publishTrack(tracks.videoTrack, videoOptions());
    const audio = await activeRoom.localParticipant.publishTrack(tracks.audioTrack, audioOptions());
    publications = {video, audio};
    if (video?.track) grid.attachTrack(grant.identity, video.track, video);
    if (audio?.track) grid.attachTrack(grant.identity, audio.track, audio);
    updateGrid(activeRoom);
    return true;
  }

  async function cleanup({releaseTracks = true} = {}) {
    const activeRoom = room;
    room = null;
    publications = {video: null, audio: null};
    if (releaseTracks && tracks) {
      const owned = tracks;
      tracks = null;
      try { mediaBridge.stopOwnedTracks(owned); } catch { /* already released */ }
    }
    grid.clear();
    if (activeRoom) {
      unbindRoom(activeRoom);
      try { await activeRoom.disconnect?.(releaseTracks); } catch { /* already gone */ }
    }
  }

  function applyStatus(value) {
    const requests = (Array.isArray(value?.requests) ? value.requests : [])
      .filter(request => request.state === 'pending')
      .map(request => ({
        ...request,
        remainingSeconds: remainingSeconds(request.expiresAt, timers),
      }));
    const participants = Array.isArray(value?.participants) ? value.participants : [];
    const occupancy = Number(value?.occupancy) || 0;
    emit({
      status: value?.state === 'closed' ? 'closed' : 'open',
      revision: Number.isInteger(value?.revision) ? value.revision : snapshot.revision,
      capacity: Number(value?.capacity) || 9,
      occupancy,
      requests,
      participants,
      acceptDisabled: occupancy >= (Number(value?.capacity) || 9),
      confirmationRequired: false,
      errorCode: '',
      message: '',
    });
    updateGrid();
  }

  async function pollStatus({waitMs = 25000, expectedEpoch = epoch} = {}) {
    if (!snapshot.sessionId || expectedEpoch !== epoch) return;
    if (pollInFlight) return pollInFlight;
    pollInFlight = (async () => {
      try {
        const value = await api.adminStatus({
          sessionId: snapshot.sessionId,
          sinceRevision: snapshot.revision,
          waitMs,
        });
        if (expectedEpoch !== epoch) return;
        applyStatus(value);
        if (value.state === 'closed') {
          clearPoll();
          await cleanup({releaseTracks: true});
        } else {
          schedulePoll(expectedEpoch);
        }
      } catch (error) {
        if (expectedEpoch !== epoch) return;
        fail(error);
        schedulePoll(expectedEpoch);
      } finally {
        pollInFlight = null;
      }
    })();
    return pollInFlight;
  }

  function open() {
    if (openInFlight) return openInFlight;
    if (['opening', 'open', 'reconnecting'].includes(snapshot.status)) return Promise.resolve();
    const activeEpoch = ++epoch;
    clearPoll();
    emit({status: 'opening', errorCode: '', message: ''});
    openInFlight = (async () => {
      let allocated = false;
      try {
        tracks = mediaBridge.createOwnedTracks();
        const grant = await api.adminOpen({idempotencyKey: idempotencyKey('open')});
        allocated = true;
        if (activeEpoch !== epoch) return;
        emit({
          sessionId: grant.sessionId,
          identity: grant.identity,
          generation: Number(grant.generation) || 1,
          revision: Number.isInteger(grant.revision) ? grant.revision : 0,
          capacity: Number(grant.capacity) || 9,
          occupancy: Number(grant.occupancy) || 1,
          participants: [
            {identity: grant.identity, role: 'host', displayName: 'DJ Cioko', displaySequence: 0, state: 'reserved'},
          ],
        });
        await connectGrant(grant, activeEpoch);
        if (activeEpoch !== epoch) return;
        emit({status: 'open'});
        await pollStatus({waitMs: 0, expectedEpoch: activeEpoch});
      } catch (error) {
        const revision = snapshot.revision;
        await cleanup({releaseTracks: true});
        if (allocated && snapshot.sessionId) {
          try {
            await api.adminClose({
              sessionId: snapshot.sessionId,
              revision,
              idempotencyKey: idempotencyKey('failed-open-close'),
            });
          } catch { /* maintenance reconciles an unreachable room */ }
        }
        if (activeEpoch === epoch) fail(error);
      } finally {
        if (activeEpoch === epoch) openInFlight = null;
      }
    })();
    return openInFlight;
  }

  function runAction(key, callback) {
    if (actions.has(key)) return actions.get(key);
    const promise = (async () => {
      try {
        const result = await callback();
        emit({
          revision: Number.isInteger(result?.revision) ? result.revision : snapshot.revision,
          errorCode: '', message: '',
        });
        return result;
      } catch (error) {
        fail(error);
        return undefined;
      } finally {
        actions.delete(key);
      }
    })();
    actions.set(key, promise);
    return promise;
  }

  function accept(requestId) {
    if (snapshot.occupancy >= snapshot.capacity) {
      fail({code: 'ROOM_FULL'});
      emit({acceptDisabled: true});
      return Promise.resolve();
    }
    return runAction(`accept:${requestId}`, async () => {
      const result = await api.adminAccept({
        sessionId: snapshot.sessionId,
        requestId,
        revision: snapshot.revision,
        idempotencyKey: idempotencyKey(`accept-${requestId}`),
      });
      emit({
        requests: snapshot.requests.filter(request => request.requestId !== requestId),
        occupancy: Math.min(snapshot.capacity, snapshot.occupancy + 1),
      });
      return result;
    });
  }

  function decline(requestId) {
    return runAction(`decline:${requestId}`, async () => {
      const result = await api.adminDecline({
        sessionId: snapshot.sessionId,
        requestId,
        revision: snapshot.revision,
        idempotencyKey: idempotencyKey(`decline-${requestId}`),
      });
      emit({requests: snapshot.requests.filter(request => request.requestId !== requestId)});
      return result;
    });
  }

  function remove(memberId) {
    return runAction(`remove:${memberId}`, async () => {
      const target = snapshot.participants.find(participant => participant.memberId === memberId);
      const result = await api.adminRemove({
        sessionId: snapshot.sessionId,
        memberId,
        revision: snapshot.revision,
        idempotencyKey: idempotencyKey(`remove-${memberId}`),
      });
      emit({
        participants: snapshot.participants.filter(participant => participant.memberId !== memberId),
        occupancy: Math.max(1, snapshot.occupancy - 1),
      });
      if (target?.identity) grid.remove(target.identity);
      return result;
    });
  }

  async function setMicrophoneEnabled(enabled) {
    if (!tracks) return;
    await mediaBridge.setAudioEnabled(tracks, Boolean(enabled));
    grid.setTrackState(snapshot.identity, 'audio', enabled ? 'unmuted' : 'muted');
    emit({microphoneEnabled: Boolean(enabled)});
  }

  async function setCameraEnabled(enabled) {
    if (!tracks) return;
    await mediaBridge.setVideoEnabled(tracks, Boolean(enabled));
    grid.setTrackState(snapshot.identity, 'video', enabled ? 'unmuted' : 'muted');
    emit({cameraEnabled: Boolean(enabled)});
  }

  function reconnect() {
    if (reconnectInFlight) return reconnectInFlight;
    if (!snapshot.sessionId || !tracks) return Promise.resolve();
    const stableIdentity = snapshot.identity;
    const activeEpoch = ++epoch;
    clearPoll();
    emit({status: 'reconnecting', errorCode: '', message: ''});
    reconnectInFlight = (async () => {
      try {
        const grant = await api.adminRejoin({
          sessionId: snapshot.sessionId,
          idempotencyKey: idempotencyKey('rejoin'),
        });
        if (grant.identity !== stableIdentity) {
          throw Object.assign(new Error('IDENTITY_CHANGED'), {code: 'IDENTITY_CHANGED'});
        }
        leaving = true;
        await cleanup({releaseTracks: false});
        leaving = false;
        if (activeEpoch !== epoch) return;
        emit({
          revision: Number.isInteger(grant.revision) ? grant.revision : snapshot.revision,
          generation: Number(grant.generation) || snapshot.generation,
        });
        await connectGrant(grant, activeEpoch);
        emit({status: 'open', errorCode: '', message: ''});
        schedulePoll(activeEpoch);
      } catch (error) {
        await cleanup({releaseTracks: true});
        if (activeEpoch === epoch) fail(error);
      } finally {
        leaving = false;
        if (activeEpoch === epoch) reconnectInFlight = null;
      }
    })();
    return reconnectInFlight;
  }

  function close({confirmed = false} = {}) {
    if (snapshot.occupancy > 1 && !confirmed) {
      emit({confirmationRequired: true});
      return Promise.resolve({requiresConfirmation: true});
    }
    if (closeInFlight) return closeInFlight;
    const activeEpoch = ++epoch;
    clearPoll();
    leaving = true;
    closeInFlight = (async () => {
      try {
        if (snapshot.sessionId) {
          await api.adminClose({
            sessionId: snapshot.sessionId,
            revision: snapshot.revision,
            idempotencyKey: idempotencyKey('close'),
          });
        }
      } catch (error) {
        if (activeEpoch === epoch) fail(error);
        return undefined;
      } finally {
        await cleanup({releaseTracks: true});
        leaving = false;
      }
      if (activeEpoch === epoch) {
        emit({
          status: 'closed', sessionId: '', identity: '', generation: 0,
          revision: -1, occupancy: 0, requests: [], participants: [],
          acceptDisabled: false, confirmationRequired: false,
          microphoneEnabled: true, cameraEnabled: true,
          errorCode: '', message: '',
        });
      }
      return {requiresConfirmation: false};
    })().finally(() => {
      closeInFlight = null;
    });
    return closeInFlight;
  }

  async function destroy() {
    ++epoch;
    clearPoll();
    leaving = true;
    await cleanup({releaseTracks: true});
    leaving = false;
    emit({status: 'closed'});
  }

  return Object.freeze({
    get state() { return snapshot; },
    open,
    pollStatus,
    accept,
    decline,
    remove,
    setMicrophoneEnabled,
    setCameraEnabled,
    reconnect,
    close,
    destroy,
  });
}
