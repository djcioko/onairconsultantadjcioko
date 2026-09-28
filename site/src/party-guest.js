import {partyFriendlyError} from './party-api.js';
import {
  loadPartyNames,
  normalizePartyName,
  rememberPartyName,
} from './party-names.js';
import {RoomEvent, Track} from 'livekit-client';


export const PARTY_REQUEST_SESSION_KEY = 'djcioko.party.request.v1';
const ACTIVE_REQUEST_STATES = new Set(['pending', 'accepted', 'joining', 'joined', 'reconnecting']);
const TERMINAL_REMOTE_STATES = new Map([
  ['declined', 'declined'],
  ['expired', 'expired'],
  ['removed', 'removed'],
  ['room_closed', 'room_closed'],
  ['closed', 'room_closed'],
]);
const VIDEO_CONSTRAINTS = Object.freeze({
  width: Object.freeze({ideal: 960, max: 960}),
  height: Object.freeze({ideal: 540, max: 540}),
  frameRate: Object.freeze({ideal: 15, max: 15}),
  facingMode: 'user',
});
const AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});


function idempotencyKey(action) {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `party-${action}-${random}`;
}


function expiresAtMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}


function readSession(storage) {
  let parsed;
  try { parsed = JSON.parse(storage?.getItem(PARTY_REQUEST_SESSION_KEY) ?? 'null'); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.requestId !== 'string' || typeof parsed.credential !== 'string') return null;
  if (!parsed.requestId || !parsed.credential) return null;
  return {
    requestId: parsed.requestId,
    credential: parsed.credential,
    displayName: normalizePartyName(parsed.displayName) || '',
    expiresAt: Number(parsed.expiresAt) || 0,
    identity: typeof parsed.identity === 'string' ? parsed.identity : '',
    generation: Number(parsed.generation) || 0,
  };
}


function writeSession(storage, value) {
  try { storage?.setItem(PARTY_REQUEST_SESSION_KEY, JSON.stringify(value)); } catch { /* optional */ }
}


function clearSession(storage) {
  try { storage?.removeItem(PARTY_REQUEST_SESSION_KEY); } catch { /* optional */ }
}


function participantIdentity(response) {
  return typeof response?.participant?.identity === 'string'
    ? response.participant.identity : '';
}


function participantGeneration(response) {
  const value = Number(response?.participant?.generation);
  return Number.isFinite(value) ? value : 0;
}


function makeElement(document, tag, className, text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}


export function createPartyGuest({
  api,
  grid,
  roomFactory,
  mediaDevices,
  localStorage,
  sessionStorage,
  timers = globalThis,
  onState = () => {},
}) {
  if (!api || !grid || typeof roomFactory !== 'function') {
    throw new TypeError('party guest dependencies required');
  }

  let root = null;
  let ui = null;
  let pollTimer = null;
  let epoch = 0;
  let requestInFlight = null;
  let joinInFlight = null;
  let reconnectInFlight = null;
  let mounted = false;
  let room = null;
  let roomBindings = [];
  let localStream = null;
  let localTracks = {video: null, audio: null};
  let localPublications = {video: null, audio: null};
  let leaving = false;
  let pageWindow = null;
  let returnFocus = null;
  let snapshot = Object.freeze({
    status: 'idle', enabled: null, open: false,
    requestId: null, displayName: '', expiresAt: 0,
    identity: '', generation: 0, errorCode: '', message: '',
    microphoneEnabled: true, cameraEnabled: true,
  });

  function render() {
    if (!root || !ui) return;
    root.dataset.partyState = snapshot.status;
    ui.raise.hidden = !snapshot.enabled || !snapshot.open || ACTIVE_REQUEST_STATES.has(snapshot.status);
    ui.join.hidden = snapshot.status !== 'accepted';
    ui.cancel.hidden = !['pending', 'accepted'].includes(snapshot.status);
    ui.name.disabled = ACTIVE_REQUEST_STATES.has(snapshot.status);
    const roomVisible = ['accepted', 'joining', 'joined', 'reconnecting'].includes(snapshot.status);
    const wasHidden = ui.dialog.hidden;
    ui.dialog.hidden = !roomVisible;
    ui.controls.hidden = !['joined', 'reconnecting'].includes(snapshot.status);
    ui.microphone.setAttribute('aria-pressed', String(snapshot.microphoneEnabled !== false));
    ui.camera.setAttribute('aria-pressed', String(snapshot.cameraEnabled !== false));
    if (roomVisible && wasHidden) {
      returnFocus = root.ownerDocument.activeElement;
      queueMicrotask(() => {
        const target = snapshot.status === 'accepted' ? ui.join : ui.hangup;
        if (!target.hidden) target.focus();
      });
    } else if (!roomVisible && !wasHidden && returnFocus?.focus) {
      returnFocus.focus();
      returnFocus = null;
    }
    const messages = {
      idle: snapshot.open ? 'Camera de invitați este deschisă.' : '',
      pending: 'Cererea a fost trimisă. Așteaptă răspunsul gazdei.',
      accepted: 'Gazda te-a acceptat. Intră când ești pregătit.',
      joining: 'Se pregătesc camera și microfonul…',
      joined: 'Ești în camera LIVE.',
      reconnecting: 'Se reface legătura video…',
      declined: 'Gazda a refuzat cererea.',
      expired: 'Cererea a expirat. Poți ridica mâna din nou.',
      removed: 'Gazda te-a scos din cameră.',
      room_closed: 'Gazda a închis camera de invitați.',
      error: snapshot.message || 'Cererea nu a reușit.',
    };
    ui.status.textContent = messages[snapshot.status] ?? '';
  }

  function emit(patch) {
    snapshot = Object.freeze({...snapshot, ...patch});
    render();
    onState(snapshot);
    return snapshot;
  }

  function participantList(activeRoom = room) {
    if (!activeRoom) return [];
    const participants = [];
    if (activeRoom.localParticipant?.identity) participants.push(activeRoom.localParticipant);
    const remotes = activeRoom.remoteParticipants;
    if (remotes?.values) participants.push(...remotes.values());
    else if (Array.isArray(remotes)) participants.push(...remotes);
    return participants;
  }

  function publicationKind(publication, track = null) {
    const value = String(track?.kind ?? publication?.kind ?? publication?.source ?? '').toLowerCase();
    return value.includes('video') || value.includes('camera') ? 'video'
      : value.includes('audio') || value.includes('microphone') ? 'audio' : '';
  }

  function updateRoster(activeRoom = room) {
    if (!activeRoom) return;
    const participants = participantList(activeRoom);
    grid.applyRoster(participants);
    for (const participant of participants) {
      const publications = participant.trackPublications;
      const values = publications?.values ? [...publications.values()]
        : Array.isArray(publications) ? publications : [];
      for (const publication of values) {
        if (publication?.track) {
          grid.attachTrack(participant.identity, publication.track, publication);
        }
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

  function showPlaybackFallback(activeRoom) {
    if (!ui || activeRoom !== room) return;
    ui.resume.hidden = activeRoom.canPlaybackAudio !== false
      && activeRoom.canPlaybackVideo !== false;
  }

  function bindRoom(activeRoom) {
    listen(activeRoom, RoomEvent.ParticipantConnected, () => updateRoster(activeRoom));
    listen(activeRoom, RoomEvent.ParticipantDisconnected, participant => {
      grid.remove(participant?.identity);
      updateRoster(activeRoom);
    });
    listen(activeRoom, RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
      if (participant) updateRoster(activeRoom);
    });
    listen(activeRoom, RoomEvent.ParticipantNameChanged, (_name, participant) => {
      if (participant) updateRoster(activeRoom);
    });
    listen(activeRoom, RoomEvent.TrackSubscribed, (track, publication, participant) => {
      updateRoster(activeRoom);
      if (participant?.identity) grid.attachTrack(participant.identity, track, publication);
    });
    listen(activeRoom, RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (participant?.identity) {
        grid.detachTrack(participant.identity, publicationKind(publication, track));
      }
    });
    listen(activeRoom, RoomEvent.TrackUnpublished, (publication, participant) => {
      if (participant?.identity) grid.detachTrack(participant.identity, publicationKind(publication));
    });
    listen(activeRoom, RoomEvent.TrackMuted, (publication, participant) => {
      if (participant?.identity) {
        grid.setTrackState(participant.identity, publicationKind(publication), 'muted');
      }
    });
    listen(activeRoom, RoomEvent.TrackUnmuted, (publication, participant) => {
      if (participant?.identity) {
        grid.setTrackState(participant.identity, publicationKind(publication), 'unmuted');
      }
    });
    listen(activeRoom, RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant?.identity) grid.setConnectionQuality(participant.identity, String(quality).toLowerCase());
    });
    listen(activeRoom, RoomEvent.ActiveSpeakersChanged, speakers => {
      const active = new Set((speakers ?? []).map(participant => participant.identity));
      for (const participant of participantList(activeRoom)) {
        grid.setSpeaking(participant.identity, active.has(participant.identity));
      }
    });
    listen(activeRoom, RoomEvent.Reconnecting, () => {
      if (activeRoom !== room || leaving) return;
      emit({status: 'reconnecting'});
      for (const participant of participantList(activeRoom)) {
        grid.setConnectionState(participant.identity, 'reconnecting');
      }
    });
    listen(activeRoom, RoomEvent.Reconnected, () => {
      if (activeRoom !== room || leaving) return;
      emit({status: 'joined', errorCode: '', message: ''});
      updateRoster(activeRoom);
    });
    listen(activeRoom, RoomEvent.Disconnected, reason => {
      if (activeRoom !== room || leaving) return;
      const normalized = String(reason ?? '').toLowerCase();
      if (normalized.includes('removed')) {
        stopLocalTracks();
        terminal('removed');
      } else if (normalized.includes('room_deleted') || normalized.includes('room deleted')) {
        stopLocalTracks();
        terminal('room_closed');
      } else {
        void reconnect();
      }
    });
    listen(activeRoom, RoomEvent.AudioPlaybackStatusChanged, () => showPlaybackFallback(activeRoom));
    listen(activeRoom, RoomEvent.VideoPlaybackStatusChanged, () => showPlaybackFallback(activeRoom));
  }

  function stopLocalTracks() {
    const tracks = localStream?.getTracks?.() ?? Object.values(localTracks).filter(Boolean);
    for (const track of new Set(tracks)) {
      if (track?.readyState !== 'ended') {
        try { track?.stop?.(); } catch { /* device already gone */ }
      }
    }
    localStream = null;
    localTracks = {video: null, audio: null};
    localPublications = {video: null, audio: null};
  }

  async function disconnectRoom({stopTracks = true} = {}) {
    const activeRoom = room;
    room = null;
    if (stopTracks) stopLocalTracks();
    else localPublications = {video: null, audio: null};
    grid.clear();
    if (ui) ui.resume.hidden = true;
    if (activeRoom) {
      unbindRoom(activeRoom);
      try { await activeRoom.disconnect?.(); } catch { /* already disconnected */ }
    }
  }

  function clearPoll() {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function clearRequest() {
    clearPoll();
    clearSession(sessionStorage);
    requestInFlight = null;
    emit({requestId: null, expiresAt: 0, identity: '', generation: 0});
  }

  function terminal(status, patch = {}) {
    epoch += 1;
    if (room || localStream) void disconnectRoom({stopTracks: true});
    clearRequest();
    emit({status, ...patch});
  }

  function saveRequest({requestId, credential, displayName, expiresAt, identity = '', generation = 0}) {
    writeSession(sessionStorage, {
      requestId, credential, displayName, expiresAt, identity, generation,
    });
  }

  function updateNameOptions() {
    if (!ui) return;
    ui.names.textContent = '';
    for (const name of loadPartyNames(localStorage)) {
      const option = root.ownerDocument.createElement('option');
      option.value = name;
      ui.names.append(option);
    }
  }

  function schedulePoll(expectedEpoch = epoch) {
    clearPoll();
    if (snapshot.status !== 'pending' || expectedEpoch !== epoch) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void poll(expectedEpoch);
    }, 2000);
  }

  function expired() {
    const deadline = expiresAtMilliseconds(snapshot.expiresAt);
    const now = typeof timers.now === 'function' ? timers.now() : Date.now();
    return deadline > 0 && now >= deadline;
  }

  function setApiError(error, {terminalError = false} = {}) {
    const code = typeof error?.code === 'string' ? error.code : 'LIVE_UNAVAILABLE';
    const mapped = new Map([
      ['PARTY_CLOSED', 'room_closed'],
      ['REQUEST_DECLINED', 'declined'],
      ['REQUEST_EXPIRED', 'expired'],
      ['JOIN_EXPIRED', 'expired'],
      ['RECONNECT_EXPIRED', 'removed'],
      ['REMOVED', 'removed'],
    ]).get(code);
    if (mapped) terminal(mapped, {errorCode: code, message: partyFriendlyError(error)});
    else if (terminalError) terminal('error', {errorCode: code, message: partyFriendlyError(error)});
    else emit({errorCode: code, message: partyFriendlyError(error)});
  }

  async function poll(expectedEpoch = epoch) {
    const activeEpoch = expectedEpoch;
    if (!snapshot.requestId || !['pending', 'accepted'].includes(snapshot.status)) return;
    if (expired()) {
      if (activeEpoch === epoch) terminal('expired');
      return;
    }
    let response;
    try {
      response = await api.getRequest();
    } catch (error) {
      if (activeEpoch !== epoch) return;
      setApiError(error);
      if (snapshot.status === 'pending') schedulePoll(activeEpoch);
      return;
    }
    if (activeEpoch !== epoch || !snapshot.requestId) return;
    const remoteState = String(response?.state ?? '').toLowerCase();
    const terminalState = TERMINAL_REMOTE_STATES.get(remoteState);
    if (terminalState) {
      terminal(terminalState);
      return;
    }
    if (remoteState === 'left' || remoteState === 'cancelled') {
      terminal('idle');
      return;
    }
    if (remoteState === 'accepted' || remoteState === 'reserved') {
      const identity = participantIdentity(response);
      const generation = participantGeneration(response);
      const saved = readSession(sessionStorage);
      if (saved) saveRequest({...saved, identity, generation, expiresAt: response.expiresAt});
      clearPoll();
      emit({
        status: 'accepted', expiresAt: response.expiresAt,
        identity, generation, errorCode: '', message: '',
      });
      return;
    }
    if (remoteState === 'pending') {
      emit({status: 'pending', expiresAt: response.expiresAt, errorCode: '', message: ''});
      if (expired()) terminal('expired');
      else schedulePoll(activeEpoch);
      return;
    }
    terminal('error', {errorCode: 'INVALID_RESPONSE', message: 'Serverul a trimis un răspuns neașteptat.'});
  }

  function raiseHand(value) {
    if (requestInFlight) return requestInFlight;
    if (ACTIVE_REQUEST_STATES.has(snapshot.status)) return Promise.resolve();
    const name = normalizePartyName(value);
    if (!name) {
      emit({status: 'error', errorCode: 'INVALID_NAME', message: partyFriendlyError({code: 'INVALID_NAME'})});
      return Promise.resolve();
    }
    const activeEpoch = ++epoch;
    clearPoll();
    requestInFlight = (async () => {
      try {
        const response = await api.createRequest({
          name, idempotencyKey: idempotencyKey('request'),
        });
        if (activeEpoch !== epoch) return;
        rememberPartyName(localStorage, name);
        updateNameOptions();
        saveRequest({...response, displayName: name});
        emit({
          status: 'pending', requestId: response.requestId,
          displayName: name, expiresAt: response.expiresAt,
          identity: '', generation: 0, errorCode: '', message: '',
        });
        schedulePoll(activeEpoch);
      } catch (error) {
        if (activeEpoch === epoch) setApiError(error, {terminalError: true});
      } finally {
        if (activeEpoch === epoch) requestInFlight = null;
      }
    })();
    return requestInFlight;
  }

  async function leave({notify = true, keepalive = false} = {}) {
    const previousStatus = snapshot.status;
    const hadRequest = Boolean(snapshot.requestId);
    leaving = true;
    epoch += 1;
    clearPoll();
    requestInFlight = null;
    joinInFlight = null;
    reconnectInFlight = null;
    let notification = Promise.resolve();
    try {
      if (notify && hadRequest && previousStatus === 'pending') {
        notification = api.cancel({idempotencyKey: idempotencyKey('cancel')});
      } else if (notify && hadRequest && ['accepted', 'joining', 'joined', 'reconnecting'].includes(previousStatus)) {
        notification = api.leave({idempotencyKey: idempotencyKey('leave'), keepalive});
      }
    } catch { /* sync failure still permits cleanup */ }
    await disconnectRoom({stopTracks: true});
    try { await notification; } catch { /* local cleanup already finished */ }
    clearSession(sessionStorage);
    emit({
      status: 'idle', requestId: null, displayName: '', expiresAt: 0,
      identity: '', generation: 0, errorCode: '', message: '',
      microphoneEnabled: true, cameraEnabled: true,
    });
    leaving = false;
  }

  function build(rootElement) {
    const document = rootElement.ownerDocument;
    rootElement.textContent = '';
    rootElement.classList.add('party-guest');
    const status = makeElement(document, 'p', 'party-guest-status');
    status.dataset.partyStatus = '';
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('role', 'status');
    const label = makeElement(document, 'label', 'party-name-label', 'Numele tău');
    const name = document.createElement('input');
    name.className = 'party-name-input';
    name.dataset.partyName = '';
    name.maxLength = 32;
    name.autocomplete = 'name';
    name.setAttribute('list', 'party-saved-names');
    label.append(name);
    const names = document.createElement('datalist');
    names.id = 'party-saved-names';
    const actions = makeElement(document, 'div', 'party-request-actions');
    const raise = makeElement(document, 'button', 'party-raise', 'Ridică mâna');
    raise.type = 'button';
    raise.dataset.partyAction = 'raise';
    const joinButton = makeElement(document, 'button', 'party-join', 'Intră în cameră');
    joinButton.type = 'button';
    joinButton.dataset.partyAction = 'join';
    joinButton.hidden = true;
    const cancel = makeElement(document, 'button', 'party-cancel', 'Anulează cererea');
    cancel.type = 'button';
    cancel.dataset.partyAction = 'cancel';
    cancel.hidden = true;
    actions.append(raise, cancel);

    const dialog = makeElement(document, 'section', 'party-room-dialog');
    dialog.dataset.partyDialog = '';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'party-room-title');
    dialog.hidden = true;
    const title = makeElement(document, 'h2', 'party-room-title', 'Camera LIVE cu invitați');
    title.id = 'party-room-title';
    const gridSlot = makeElement(document, 'div', 'party-grid-slot');
    gridSlot.dataset.partyGridSlot = '';
    const controls = makeElement(document, 'div', 'party-controls');
    controls.hidden = true;
    const microphone = makeElement(document, 'button', 'party-control-microphone', 'Microfon');
    microphone.type = 'button';
    microphone.dataset.partyAction = 'microphone';
    microphone.setAttribute('aria-label', 'Pornește sau oprește microfonul');
    const camera = makeElement(document, 'button', 'party-control-camera', 'Cameră');
    camera.type = 'button';
    camera.dataset.partyAction = 'camera';
    camera.setAttribute('aria-label', 'Pornește sau oprește camera');
    const hangup = makeElement(document, 'button', 'party-control-hangup', 'Ieși');
    hangup.type = 'button';
    hangup.dataset.partyAction = 'hangup';
    hangup.setAttribute('aria-label', 'Ieși din camera LIVE');
    const resume = makeElement(document, 'button', 'party-control-resume', 'Pornește sunetul');
    resume.type = 'button';
    resume.dataset.partyAction = 'resume-media';
    resume.setAttribute('aria-label', 'Pornește redarea sunetului și a imaginii');
    resume.hidden = true;
    controls.append(microphone, camera, resume, hangup);
    dialog.append(title, joinButton, gridSlot, controls);
    rootElement.append(status, label, names, actions, dialog);
    ui = {
      status, label, name, names, actions, raise, join: joinButton, cancel,
      dialog, title, gridSlot, controls, microphone, camera, hangup, resume,
    };
    updateNameOptions();
    raise.addEventListener('click', () => { void raiseHand(name.value); });
    joinButton.addEventListener('click', () => { void join(); });
    cancel.addEventListener('click', () => { void leave(); });
    microphone.addEventListener('click', () => {
      void setMicrophoneEnabled(snapshot.microphoneEnabled === false);
    });
    camera.addEventListener('click', () => {
      void setCameraEnabled(snapshot.cameraEnabled === false);
    });
    hangup.addEventListener('click', () => { void leave(); });
    resume.addEventListener('click', async () => {
      const activeRoom = room;
      if (!activeRoom) return;
      try {
        await activeRoom.startAudio?.();
        await activeRoom.startVideo?.();
      } finally {
        showPlaybackFallback(activeRoom);
      }
    });
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab' || dialog.hidden) return;
      const focusable = [...dialog.querySelectorAll('button:not([hidden]):not(:disabled), input:not([hidden]):not(:disabled)')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  function handlePageHide() {
    const currentStatus = snapshot.status;
    const hadRequest = Boolean(snapshot.requestId);
    epoch += 1;
    clearPoll();
    leaving = true;
    if (hadRequest && currentStatus === 'pending') {
      void api.cancel({idempotencyKey: idempotencyKey('pagehide-cancel')});
    } else if (hadRequest && ['accepted', 'joining', 'joined', 'reconnecting'].includes(currentStatus)) {
      void api.leave({
        idempotencyKey: idempotencyKey('pagehide-leave'),
        keepalive: true,
      });
    }
    stopLocalTracks();
    unbindRoom();
    try { room?.disconnect?.(); } catch { /* document is unloading */ }
    room = null;
    grid.clear();
    clearSession(sessionStorage);
  }

  async function mount(rootElement) {
    if (!rootElement || typeof rootElement.append !== 'function') {
      throw new TypeError('party guest root required');
    }
    if (!mounted) {
      root = rootElement;
      build(rootElement);
      mounted = true;
      pageWindow = rootElement.ownerDocument.defaultView;
      pageWindow?.addEventListener('pagehide', handlePageHide);
    }
    let status;
    try {
      status = await api.getStatus();
    } catch (error) {
      setApiError(error, {terminalError: true});
      root.hidden = true;
      return snapshot;
    }
    const enabled = status?.enabled === true;
    const open = enabled && status?.open === true;
    root.hidden = !enabled;
    emit({enabled, open});
    if (!enabled) {
      emit({status: 'idle'});
      return snapshot;
    }
    const saved = readSession(sessionStorage);
    if (saved) {
      emit({status: 'pending', ...saved, errorCode: '', message: ''});
      await poll(epoch);
      return snapshot;
    }
    emit({status: open ? 'idle' : 'room_closed'});
    return snapshot;
  }

  async function acquireMedia() {
    if (localTracks.video && localTracks.audio) return;
    localStream = await mediaDevices.getUserMedia({
      video: VIDEO_CONSTRAINTS,
      audio: AUDIO_CONSTRAINTS,
    });
    localTracks = {
      video: localStream?.getVideoTracks?.()[0] ?? null,
      audio: localStream?.getAudioTracks?.()[0] ?? null,
    };
    if (!localTracks.video || !localTracks.audio) {
      stopLocalTracks();
      throw Object.assign(new Error('MEDIA_PERMISSION'), {code: 'MEDIA_PERMISSION'});
    }
  }

  async function connectGrant(grant, {reuseMedia = false, expectedEpoch = epoch} = {}) {
    if (!grant || typeof grant.url !== 'string' || typeof grant.token !== 'string'
        || typeof grant.identity !== 'string') {
      throw Object.assign(new Error('INVALID_RESPONSE'), {code: 'INVALID_RESPONSE'});
    }
    if (snapshot.identity && grant.identity !== snapshot.identity) {
      throw Object.assign(new Error('IDENTITY_CHANGED'), {code: 'IDENTITY_CHANGED'});
    }
    if (!reuseMedia) await acquireMedia();
    else if (!localTracks.video || !localTracks.audio) {
      throw Object.assign(new Error('MEDIA_ENDED'), {code: 'MEDIA_ENDED'});
    }
    if (expectedEpoch !== epoch) return false;
    const nextRoom = roomFactory({adaptiveStream: true, dynacast: true});
    if (!nextRoom) throw Object.assign(new Error('LIVE_UNAVAILABLE'), {code: 'LIVE_UNAVAILABLE'});
    room = nextRoom;
    bindRoom(nextRoom);
    await nextRoom.connect(grant.url, grant.token, {autoSubscribe: true});
    if (expectedEpoch !== epoch || room !== nextRoom) {
      unbindRoom(nextRoom);
      try { await nextRoom.disconnect?.(); } catch { /* superseded */ }
      return false;
    }
    const connectedIdentity = nextRoom.localParticipant?.identity;
    if (connectedIdentity && connectedIdentity !== grant.identity) {
      throw Object.assign(new Error('IDENTITY_CHANGED'), {code: 'IDENTITY_CHANGED'});
    }
    const videoPublication = await nextRoom.localParticipant.publishTrack(localTracks.video, {
      name: 'party-camera',
      source: Track.Source.Camera,
      simulcast: true,
    });
    const audioPublication = await nextRoom.localParticipant.publishTrack(localTracks.audio, {
      name: 'party-microphone',
      source: Track.Source.Microphone,
    });
    localPublications = {video: videoPublication, audio: audioPublication};
    const generation = Number(grant.generation) || snapshot.generation;
    const saved = readSession(sessionStorage);
    if (saved) saveRequest({...saved, identity: grant.identity, generation});
    emit({
      status: 'joined', identity: grant.identity, generation,
      microphoneEnabled: true, cameraEnabled: true,
      errorCode: '', message: '',
    });
    updateRoster(nextRoom);
    if (videoPublication?.track) {
      grid.attachTrack(grant.identity, videoPublication.track, videoPublication);
    }
    if (audioPublication?.track) {
      grid.attachTrack(grant.identity, audioPublication.track, audioPublication);
    }
    showPlaybackFallback(nextRoom);
    return true;
  }

  async function releaseSeatWithError(code) {
    leaving = true;
    try {
      if (snapshot.requestId) {
        await api.leave({idempotencyKey: idempotencyKey('release')});
      }
    } catch { /* local safety cleanup wins */ }
    await disconnectRoom({stopTracks: true});
    clearSession(sessionStorage);
    emit({
      status: 'error', requestId: null, expiresAt: 0,
      errorCode: code,
      message: code === 'MEDIA_PERMISSION'
        ? 'Permite accesul la cameră și microfon pentru a intra.'
        : code === 'IDENTITY_CHANGED'
          ? 'Sesiunea video nu a putut fi verificată în siguranță.'
          : partyFriendlyError({code}),
    });
    leaving = false;
  }

  function join() {
    if (joinInFlight) return joinInFlight;
    if (snapshot.status !== 'accepted' || !snapshot.requestId) return Promise.resolve();
    const activeEpoch = ++epoch;
    clearPoll();
    emit({status: 'joining', errorCode: '', message: ''});
    joinInFlight = (async () => {
      let grantIssued = false;
      try {
        const grant = await api.join({idempotencyKey: idempotencyKey('join')});
        grantIssued = true;
        if (activeEpoch !== epoch) {
          try { await api.leave({idempotencyKey: idempotencyKey('stale-join')}); } catch { /* gone */ }
          return;
        }
        await connectGrant(grant, {expectedEpoch: activeEpoch});
      } catch (error) {
        if (activeEpoch !== epoch) return;
        const code = typeof error?.code === 'string'
          ? error.code
          : error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
            ? 'MEDIA_PERMISSION' : 'LIVE_UNAVAILABLE';
        if (!grantIssued && ['JOIN_EXPIRED', 'REQUEST_EXPIRED', 'PARTY_CLOSED', 'REMOVED'].includes(code)) {
          setApiError(error, {terminalError: true});
        } else {
          await releaseSeatWithError(code);
        }
      } finally {
        if (activeEpoch === epoch) joinInFlight = null;
      }
    })();
    return joinInFlight;
  }

  function reconnect() {
    if (reconnectInFlight) return reconnectInFlight;
    if (!['joined', 'reconnecting'].includes(snapshot.status) || !snapshot.requestId) {
      return Promise.resolve();
    }
    const stableIdentity = snapshot.identity;
    const activeEpoch = ++epoch;
    emit({status: 'reconnecting', errorCode: '', message: ''});
    reconnectInFlight = (async () => {
      try {
        const grant = await api.reconnect({idempotencyKey: idempotencyKey('reconnect')});
        if (grant?.identity !== stableIdentity) {
          throw Object.assign(new Error('IDENTITY_CHANGED'), {code: 'IDENTITY_CHANGED'});
        }
        if (activeEpoch !== epoch) return;
        leaving = true;
        await disconnectRoom({stopTracks: false});
        leaving = false;
        await connectGrant(grant, {reuseMedia: true, expectedEpoch: activeEpoch});
      } catch (error) {
        if (activeEpoch !== epoch) return;
        const code = typeof error?.code === 'string' ? error.code : 'LIVE_UNAVAILABLE';
        if (['RECONNECT_EXPIRED', 'REMOVED', 'PARTY_CLOSED'].includes(code)) {
          setApiError(error, {terminalError: true});
        } else {
          await releaseSeatWithError(code);
        }
      } finally {
        leaving = false;
        if (activeEpoch === epoch) reconnectInFlight = null;
      }
    })();
    return reconnectInFlight;
  }

  async function setTrackEnabled(kind, enabled) {
    const publication = localPublications[kind];
    const publishedTrack = publication?.track;
    const rawTrack = localTracks[kind];
    if (!publication || !rawTrack) return;
    if (enabled) {
      if (typeof publishedTrack?.unmute === 'function') await publishedTrack.unmute();
      else rawTrack.enabled = true;
    } else {
      if (typeof publishedTrack?.mute === 'function') await publishedTrack.mute();
      else rawTrack.enabled = false;
    }
    rawTrack.enabled = enabled;
    grid.setTrackState(snapshot.identity, kind, enabled ? 'unmuted' : 'muted');
    emit(kind === 'audio'
      ? {microphoneEnabled: enabled}
      : {cameraEnabled: enabled});
  }

  async function setMicrophoneEnabled(enabled) {
    await setTrackEnabled('audio', Boolean(enabled));
  }

  async function setCameraEnabled(enabled) {
    await setTrackEnabled('video', Boolean(enabled));
  }

  async function destroy() {
    pageWindow?.removeEventListener('pagehide', handlePageHide);
    pageWindow = null;
    await leave({notify: false});
    root?.replaceChildren();
    root = null;
    ui = null;
    mounted = false;
  }

  return Object.freeze({
    get state() { return snapshot; },
    mount,
    raiseHand,
    poll,
    join,
    reconnect,
    setMicrophoneEnabled,
    setCameraEnabled,
    leave,
    destroy,
  });
}
