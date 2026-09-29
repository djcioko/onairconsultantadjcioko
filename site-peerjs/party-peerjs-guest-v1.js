const HOST_PEER_ID = 'djcioko-studio-unic-id';
const NAME_KEY = 'djcioko.party.names.v1';
const CLIENT_KEY = 'djcioko.party.peerjs.client.v1';
const REQUEST_TIMEOUT_MS = 90_000;
const RECONNECT_DELAY_MS = 1500;

const MEDIA_CONSTRAINTS = Object.freeze({
  video: {
    width: {ideal: 640, max: 640},
    height: {ideal: 360, max: 360},
    frameRate: {ideal: 12, max: 12},
    facingMode: 'user',
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: {ideal: 1},
    sampleRate: {ideal: 48_000},
  },
});


function normalizeName(value) {
  const result = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  return result && Array.from(result).length <= 32 && !/[<>&\p{Cc}\p{Cf}]/u.test(result)
    ? result : '';
}


function readNames(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(NAME_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeName).filter(Boolean).filter((name, index, names) => (
      names.indexOf(name) === index
    )).slice(0, 3);
  } catch {
    return [];
  }
}


function rememberName(storage, value) {
  const name = normalizeName(value);
  if (!name) return [];
  const names = [name, ...readNames(storage).filter(saved => saved !== name)].slice(0, 3);
  try { storage?.setItem(NAME_KEY, JSON.stringify(names)); } catch { /* private mode */ }
  return names;
}


function randomId(prefix, cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return `${prefix}-${cryptoImpl.randomUUID()}`;
  const bytes = new Uint8Array(16);
  cryptoImpl?.getRandomValues?.(bytes);
  const token = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${token || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}


function loadClientId(storage, factory) {
  try {
    const saved = storage?.getItem(CLIENT_KEY);
    if (typeof saved === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(saved)) return saved;
  } catch { /* private mode */ }
  const created = String(factory());
  try { storage?.setItem(CLIENT_KEY, created); } catch { /* page-lifetime identity still works */ }
  return created;
}


function safeClose(value) {
  try { value?.close?.(); } catch { /* already closed */ }
}


async function prioritizePartyCall(call) {
  const senders = call?.peerConnection?.getSenders?.();
  if (!Array.isArray(senders)) return false;
  let updated = false;
  for (const sender of senders) {
    const kind = sender?.track?.kind;
    if (
      (kind !== 'video' && kind !== 'audio')
      || typeof sender.getParameters !== 'function'
      || typeof sender.setParameters !== 'function'
    ) continue;
    const parameters = sender.getParameters() || {};
    const encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings = encodings;
    if (kind === 'video') {
      encodings.forEach(encoding => {
        encoding.maxBitrate = 350_000;
        encoding.maxFramerate = 12;
      });
      parameters.degradationPreference = 'balanced';
    } else {
      encodings.forEach(encoding => { encoding.maxBitrate = 48_000; });
    }
    try {
      await sender.setParameters(parameters);
      updated = true;
    } catch { /* browser keeps its negotiated defaults */ }
  }
  return updated;
}


function safeSend(connection, payload) {
  if (!connection?.open) return false;
  try {
    connection.send(payload);
    return true;
  } catch {
    return false;
  }
}


function statusCopy(status) {
  return ({
    idle: 'Camera de invitați este deschisă.',
    connecting: 'Se conectează la DJCIOKOSTUDIO…',
    waiting_host: 'Aștept aplicația DJCIOKOSTUDIO…',
    pending: 'Mâna este ridicată. Așteaptă răspunsul gazdei.',
    accepted: 'Ai fost acceptat. Se pregătesc camera și microfonul…',
    joining: 'Se conectează camera și microfonul…',
    joined: 'Ești în camera LIVE.',
    rejected: 'Gazda a respins cererea.',
    busy: 'Camera este ocupată. Încearcă din nou puțin mai târziu.',
    expired: 'Cererea a expirat. Poți ridica mâna din nou.',
    removed: 'Gazda te-a scos din cameră.',
    ended: 'Gazda a încheiat conversația.',
    room_closed: 'Camera cu invitați este închisă.',
    media_error: 'Permite camera și microfonul pentru a intra.',
    error: 'Conexiunea nu este disponibilă momentan.',
  })[status] ?? '';
}


function legacyStatusSaysLive(value) {
  return /^(?:🔴\s*)?LIVE(?:\s+DJCIOKOSTUDIO)?[!.]?$/iu.test(String(value ?? '').trim());
}


function renderShell(root, names) {
  root.innerHTML = `
    <div class="party-peerjs-card">
      <form data-party-request novalidate>
        <label for="party-peerjs-name">Numele tău</label>
        <div class="party-peerjs-request-row">
          <input id="party-peerjs-name" data-party-name list="party-peerjs-names"
                 maxlength="32" autocomplete="name" required>
          <datalist id="party-peerjs-names"></datalist>
          <button type="submit" data-party-raise>✋ Ridică mâna</button>
        </div>
      </form>
      <p class="party-peerjs-status" data-party-status role="status" aria-live="polite"></p>
      <div class="party-peerjs-grid" data-party-grid aria-label="Participanți LIVE"></div>
      <div class="party-peerjs-controls" data-party-controls hidden>
        <button type="button" data-party-microphone aria-pressed="true">🎙 Microfon</button>
        <button type="button" data-party-camera aria-pressed="true">📹 Cameră</button>
        <button type="button" data-party-hangup class="party-peerjs-hangup">Închide</button>
      </div>
    </div>`;
  const input = root.querySelector('[data-party-name]');
  const datalist = root.querySelector('#party-peerjs-names');
  for (const name of names) {
    const option = root.ownerDocument.createElement('option');
    option.value = name;
    datalist.append(option);
  }
  input.value = names[0] ?? '';
  return {
    form: root.querySelector('[data-party-request]'),
    input,
    raise: root.querySelector('[data-party-raise]'),
    status: root.querySelector('[data-party-status]'),
    grid: root.querySelector('[data-party-grid]'),
    controls: root.querySelector('[data-party-controls]'),
    microphone: root.querySelector('[data-party-microphone]'),
    camera: root.querySelector('[data-party-camera]'),
    hangup: root.querySelector('[data-party-hangup]'),
  };
}


export function createPeerJsPartyGuest({
  peerFactory = () => new globalThis.Peer(),
  mediaDevices = globalThis.navigator?.mediaDevices,
  storage = globalThis.localStorage,
  timers = globalThis,
  pageWindow = globalThis.window,
  cryptoImpl = globalThis.crypto,
  clientIdFactory = () => randomId('client', cryptoImpl),
  requestIdFactory = () => randomId('request', cryptoImpl),
  onState = () => {},
} = {}) {
  const clientId = loadClientId(storage, clientIdFactory);
  let snapshot = {
    status: 'idle', requestId: null, clientId, peerId: '', name: '',
    microphoneEnabled: true, cameraEnabled: true, liveAvailable: false,
  };
  let root = null;
  let ui = null;
  let peer = null;
  let hostConnection = null;
  let localStream = null;
  let requestTimer = null;
  let reconnectTimer = null;
  let joining = null;
  let leaving = null;
  let mounted = false;
  let destroyed = false;
  let epoch = 0;
  let publicLiveVideo = null;
  let publicLiveTrack = null;
  const publicLiveCleanups = [];
  let publicLiveAudioState = null;
  let legacyStatusText = null;
  let legacyStatusObserver = null;
  let legacyStatusOriginal = null;
  const roster = new Map();
  const calls = new Map();
  const tiles = new Map();
  const meshReconnectTimers = new Map();

  function emit(patch = {}) {
    snapshot = Object.freeze({...snapshot, ...patch});
    render();
    onState(snapshot);
    return snapshot;
  }

  function render() {
    if (!ui) return;
    const liveLocked = snapshot.liveAvailable === false && snapshot.status !== 'joined';
    ui.status.textContent = liveLocked ? 'Ne vedem curând LIVE!' : statusCopy(snapshot.status);
    const pending = ['pending', 'accepted', 'joining', 'joined'].includes(snapshot.status);
    ui.raise.disabled = pending || liveLocked;
    ui.input.disabled = pending || liveLocked;
    ui.controls.hidden = snapshot.status !== 'joined';
    ui.microphone.setAttribute('aria-pressed', String(snapshot.microphoneEnabled));
    ui.camera.setAttribute('aria-pressed', String(snapshot.cameraEnabled));
    ui.microphone.textContent = snapshot.microphoneEnabled ? '🎙 Microfon' : '🔇 Microfon oprit';
    ui.camera.textContent = snapshot.cameraEnabled ? '📹 Cameră' : '🚫 Cameră oprită';
    syncPublicLiveAudioExclusivity();
    syncLegacyStatusVisibility();
  }

  function restorePublicLiveAudio() {
    const state = publicLiveAudioState;
    if (!state) return;
    publicLiveAudioState = null;
    state.player.removeEventListener('volumechange', state.enforceMuted);
    state.player.defaultMuted = state.defaultMuted;
    state.player.volume = state.volume;
    state.player.muted = state.muted;
  }

  function syncPublicLiveAudioExclusivity() {
    const partyAudioActive = ['accepted', 'joining', 'joined'].includes(snapshot.status);
    if (!partyAudioActive) {
      restorePublicLiveAudio();
      return;
    }
    if (!publicLiveVideo) return;
    if (!publicLiveAudioState) {
      const player = publicLiveVideo;
      const enforceMuted = () => {
        if (publicLiveAudioState?.player === player && !player.muted) player.muted = true;
      };
      publicLiveAudioState = {
        player,
        muted: player.muted,
        defaultMuted: player.defaultMuted,
        volume: player.volume,
        enforceMuted,
      };
      player.addEventListener('volumechange', enforceMuted);
    }
    publicLiveAudioState.enforceMuted();
  }

  function restoreLegacyStatus() {
    if (!legacyStatusText || !legacyStatusOriginal) return;
    legacyStatusText.hidden = legacyStatusOriginal.hidden;
    legacyStatusText.style.display = legacyStatusOriginal.display;
  }

  function findLegacyStatus() {
    const next = root?.ownerDocument?.getElementById('statusText') ?? null;
    if (next === legacyStatusText) return next;
    restoreLegacyStatus();
    legacyStatusText = next;
    legacyStatusOriginal = next ? {
      hidden: next.hidden,
      display: next.style.display,
    } : null;
    return next;
  }

  function syncLegacyStatusVisibility() {
    const status = findLegacyStatus();
    if (!status) return;
    const visible = snapshot.liveAvailable && legacyStatusSaysLive(status.textContent);
    status.hidden = !visible;
    status.style.display = visible ? '' : 'none';
  }

  function bindLegacyStatusGate() {
    syncLegacyStatusVisibility();
    const Observer = root?.ownerDocument?.defaultView?.MutationObserver
      ?? globalThis.MutationObserver;
    if (!Observer || !root?.ownerDocument?.documentElement) return;
    legacyStatusObserver = new Observer(syncLegacyStatusVisibility);
    legacyStatusObserver.observe(root.ownerDocument.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function unbindLegacyStatusGate() {
    legacyStatusObserver?.disconnect?.();
    legacyStatusObserver = null;
    restoreLegacyStatus();
    legacyStatusText = null;
    legacyStatusOriginal = null;
  }

  function publicLiveIsPlaying() {
    if (!publicLiveVideo) return false;
    const stream = publicLiveVideo.srcObject;
    const tracks = stream?.getVideoTracks?.() ?? [];
    return tracks.some(track => (
      track.readyState === 'live'
      && track.enabled !== false
      && track.muted !== true
    ));
  }

  function bindPublicLiveTrack() {
    const nextTrack = publicLiveVideo?.srcObject?.getVideoTracks?.()[0] ?? null;
    if (nextTrack === publicLiveTrack) return;
    publicLiveTrack = nextTrack;
    if (!nextTrack?.addEventListener) return;
    for (const eventName of ['mute', 'unmute', 'ended']) {
      nextTrack.addEventListener(eventName, syncPublicLiveAvailability);
      publicLiveCleanups.push(() => {
        nextTrack.removeEventListener?.(eventName, syncPublicLiveAvailability);
      });
    }
  }

  function syncPublicLiveAvailability() {
    bindPublicLiveTrack();
    const liveAvailable = publicLiveIsPlaying();
    if (snapshot.liveAvailable !== liveAvailable) emit({liveAvailable});
    if (
      !liveAvailable
      && snapshot.requestId
      && ['pending', 'waiting_host', 'accepted', 'joining'].includes(snapshot.status)
    ) {
      void leave({notify: true, finalStatus: 'idle'});
    }
  }

  function bindPublicLiveGate() {
    publicLiveVideo = root?.ownerDocument?.getElementById('siteVideoPlayer') ?? null;
    if (!publicLiveVideo) return;
    for (const eventName of ['playing', 'play', 'pause', 'ended', 'emptied', 'abort']) {
      publicLiveVideo.addEventListener(eventName, syncPublicLiveAvailability);
      publicLiveCleanups.push(() => {
        publicLiveVideo?.removeEventListener(eventName, syncPublicLiveAvailability);
      });
    }
    syncPublicLiveAvailability();
  }

  function unbindPublicLiveGate() {
    while (publicLiveCleanups.length) publicLiveCleanups.pop()();
    publicLiveTrack = null;
    publicLiveVideo = null;
  }

  function clearRequestTimer() {
    if (requestTimer != null) timers.clearTimeout(requestTimer);
    requestTimer = null;
  }

  function armRequestTimer() {
    clearRequestTimer();
    requestTimer = timers.setTimeout(() => {
      requestTimer = null;
      if (snapshot.status !== 'pending') return;
      safeSend(hostConnection, message('guest-left', {state: 'expired'}));
      emit({status: 'expired', requestId: null});
    }, REQUEST_TIMEOUT_MS);
  }

  function message(type, extra = {}) {
    return {
      type,
      requestId: snapshot.requestId,
      peerId: snapshot.peerId,
      clientId,
      ...extra,
    };
  }

  function sendRequest() {
    return safeSend(hostConnection, message('guest-request', {name: snapshot.name}));
  }

  function sendState(extra = {}) {
    return safeSend(hostConnection, message('guest-state', {
      name: snapshot.name,
      state: snapshot.status,
      microphoneEnabled: snapshot.microphoneEnabled,
      cameraEnabled: snapshot.cameraEnabled,
      ...extra,
    }));
  }

  function scheduleHostReconnect() {
    if (destroyed || reconnectTimer != null) return;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connectHost();
    }, RECONNECT_DELAY_MS);
  }

  function bindHost(connection) {
    connection.on('open', () => {
      if (connection !== hostConnection) return;
      if (snapshot.liveAvailable === false) {
        if (snapshot.requestId) void leave({notify: true, finalStatus: 'idle'});
        else safeSend(connection, message('party-status-request'));
        return;
      }
      if (snapshot.status === 'pending' || snapshot.status === 'waiting_host') {
        emit({status: 'pending'});
        sendRequest();
        armRequestTimer();
      } else if (['accepted', 'joining', 'joined'].includes(snapshot.status)) {
        sendRequest();
        sendState();
      } else {
        safeSend(connection, message('party-status-request'));
      }
    });
    connection.on('data', data => handleHostMessage(data));
    const disconnected = () => {
      if (connection !== hostConnection) return;
      hostConnection = null;
      clearRequestTimer();
      if (!['idle', 'rejected', 'busy', 'expired', 'removed', 'ended', 'room_closed'].includes(snapshot.status)) {
        const acceptedMediaActive = ['accepted', 'joining', 'joined'].includes(snapshot.status);
        emit({status: acceptedMediaActive ? snapshot.status : 'waiting_host'});
      }
      scheduleHostReconnect();
    };
    connection.on('close', disconnected);
    connection.on('error', disconnected);
  }

  function connectHost() {
    if (destroyed || !peer?.open || hostConnection) return hostConnection;
    const connection = peer.connect(HOST_PEER_ID, {
      label: 'guest-request',
      reliable: true,
      metadata: {protocol: 'party-peerjs-v1', clientId},
    });
    hostConnection = connection;
    bindHost(connection);
    return connection;
  }

  function createTile(peerId, entry = {}) {
    let tile = tiles.get(peerId);
    if (!tile) {
      const node = root.ownerDocument.createElement('article');
      node.className = 'party-peerjs-tile';
      node.dataset.partyPeer = peerId;
      node.innerHTML = `
        <div class="party-peerjs-media"><video autoplay playsinline></video><span data-party-fallback>•</span></div>
        <div class="party-peerjs-meta"><strong data-party-display-name></strong><div>
          <span data-party-mic></span><span data-party-cam></span>
        </div></div>`;
      tile = {
        node,
        video: node.querySelector('video'),
        fallback: node.querySelector('[data-party-fallback]'),
        name: node.querySelector('[data-party-display-name]'),
        mic: node.querySelector('[data-party-mic]'),
        cam: node.querySelector('[data-party-cam]'),
      };
      tile.video.muted = peerId === snapshot.peerId;
      tiles.set(peerId, tile);
      ui.grid.append(node);
    }
    updateTile(peerId, entry);
    return tile;
  }

  function updateTile(peerId, entry = {}) {
    const tile = tiles.get(peerId);
    if (!tile) return;
    const name = normalizeName(entry.name ?? entry.displayName)
      || (peerId === HOST_PEER_ID ? 'DJ Cioko' : peerId === snapshot.peerId ? snapshot.name : 'Invitat');
    const microphoneEnabled = entry.microphoneEnabled ?? entry.microphone ?? true;
    const cameraEnabled = entry.cameraEnabled ?? entry.camera ?? true;
    tile.name.textContent = peerId === snapshot.peerId ? `${name} (tu)` : name;
    tile.mic.textContent = microphoneEnabled ? '🎙 pornit' : '🔇 oprit';
    tile.cam.textContent = cameraEnabled ? '📹 pornită' : '🚫 oprită';
    tile.mic.dataset.state = microphoneEnabled ? 'on' : 'off';
    tile.cam.dataset.state = cameraEnabled ? 'on' : 'off';
    tile.node.dataset.role = entry.role === 'host' ? 'host' : 'guest';
  }

  function attachStream(peerId, stream, entry = {}) {
    const tile = createTile(peerId, entry);
    tile.video.srcObject = stream;
    tile.video.hidden = false;
    tile.fallback.hidden = true;
    Promise.resolve(tile.video.play?.()).catch(() => {});
  }

  function removeTile(peerId) {
    const tile = tiles.get(peerId);
    if (!tile) return;
    try { tile.video.pause?.(); } catch { /* detached */ }
    tile.video.srcObject = null;
    tile.node.remove();
    tiles.delete(peerId);
  }

  function clearMeshReconnect(peerId) {
    const timer = meshReconnectTimers.get(peerId);
    if (timer != null) timers.clearTimeout(timer);
    meshReconnectTimers.delete(peerId);
  }

  function scheduleMeshReconnect(peerId) {
    if (
      destroyed
      || meshReconnectTimers.has(peerId)
      || snapshot.status !== 'joined'
      || !localStream
      || !roster.has(peerId)
      || snapshot.peerId >= peerId
    ) return;
    const timer = timers.setTimeout(() => {
      meshReconnectTimers.delete(peerId);
      const entry = roster.get(peerId);
      if (entry) startMeshCall(entry);
    }, RECONNECT_DELAY_MS);
    meshReconnectTimers.set(peerId, timer);
  }

  function bindCall(call, peerId, entry = {}) {
    const existing = calls.get(peerId);
    if (existing && existing !== call) {
      safeClose(call);
      return false;
    }
    calls.set(peerId, call);
    call.on('stream', stream => attachStream(peerId, stream, roster.get(peerId) ?? entry));
    const closed = () => {
      if (calls.get(peerId) !== call) return;
      calls.delete(peerId);
      const tile = tiles.get(peerId);
      if (tile) {
        tile.video.srcObject = null;
        tile.video.hidden = true;
        tile.fallback.hidden = false;
      }
      if (peerId !== HOST_PEER_ID) scheduleMeshReconnect(peerId);
    };
    call.on('close', closed);
    call.on('error', closed);
    return true;
  }

  function startMeshCall(entry) {
    if (!localStream || calls.has(entry.peerId) || snapshot.peerId >= entry.peerId) return;
    clearMeshReconnect(entry.peerId);
    const call = peer.call(entry.peerId, localStream, {
      metadata: {
        type: 'party-mesh',
        requestId: snapshot.requestId,
        clientId,
        name: snapshot.name,
        fromPeerId: snapshot.peerId,
      },
    });
    if (call && bindCall(call, entry.peerId, entry)) {
      void prioritizePartyCall(call);
    } else scheduleMeshReconnect(entry.peerId);
  }

  function applyRoster(data) {
    if (!localStream || snapshot.status !== 'joined') return;
    const source = Array.isArray(data.participants) ? data.participants
      : Array.isArray(data.roster) ? data.roster : [];
    const next = new Map();
    for (const raw of source) {
      const peerId = String(raw?.peerId ?? raw?.peer ?? '');
      if (!peerId || peerId.length > 128) continue;
      const entry = {
        peerId,
        role: raw.role === 'host' || peerId === HOST_PEER_ID ? 'host' : 'guest',
        name: normalizeName(raw.name ?? raw.displayName) || (peerId === HOST_PEER_ID ? 'DJ Cioko' : 'Invitat'),
        microphoneEnabled: raw.microphoneEnabled ?? raw.microphone ?? raw.mic ?? true,
        cameraEnabled: raw.cameraEnabled ?? raw.camera ?? raw.cam ?? true,
      };
      next.set(peerId, entry);
      createTile(peerId, entry);
    }
    next.set(snapshot.peerId, next.get(snapshot.peerId) ?? {
      peerId: snapshot.peerId, role: 'guest', name: snapshot.name,
      microphoneEnabled: snapshot.microphoneEnabled, cameraEnabled: snapshot.cameraEnabled,
    });
    createTile(snapshot.peerId, next.get(snapshot.peerId));
    attachStream(snapshot.peerId, localStream, next.get(snapshot.peerId));
    for (const [peerId, call] of calls) {
      if (peerId !== HOST_PEER_ID && !next.has(peerId)) {
        clearMeshReconnect(peerId);
        calls.delete(peerId);
        safeClose(call);
        removeTile(peerId);
      }
    }
    for (const peerId of [...tiles.keys()]) {
      if (peerId !== HOST_PEER_ID && !next.has(peerId)) {
        clearMeshReconnect(peerId);
        removeTile(peerId);
      }
    }
    roster.clear();
    for (const [peerId, entry] of next) roster.set(peerId, entry);
    [...next.values()]
      .filter(entry => entry.role === 'guest' && entry.peerId !== snapshot.peerId)
      .sort((left, right) => left.peerId.localeCompare(right.peerId))
      .forEach(startMeshCall);
  }

  function callHostWithLocalStream({replace = false} = {}) {
    if (!localStream || !snapshot.requestId || !peer) return false;
    const previous = calls.get(HOST_PEER_ID);
    if (previous && !replace) return true;
    if (previous) {
      calls.delete(HOST_PEER_ID);
      safeClose(previous);
    }
    const call = peer.call(HOST_PEER_ID, localStream, {
      metadata: {
        type: 'guest-chat',
        requestId: snapshot.requestId,
        clientId,
        name: snapshot.name,
      },
    });
    const bound = Boolean(
      call && bindCall(call, HOST_PEER_ID, {name: 'DJ Cioko', role: 'host'}),
    );
    if (bound) void prioritizePartyCall(call);
    return bound;
  }

  async function startAcceptedMedia() {
    if (joining || !snapshot.requestId) return joining;
    const activeEpoch = ++epoch;
    clearRequestTimer();
    emit({status: 'accepted'});
    joining = (async () => {
      try {
        if (!mediaDevices?.getUserMedia) throw new Error('MEDIA_UNAVAILABLE');
        const stream = await mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
        if (activeEpoch !== epoch) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        localStream = stream;
        stream.getAudioTracks().forEach(track => {
          if ('contentHint' in track) {
            try { track.contentHint = 'speech'; } catch { /* unsupported */ }
          }
        });
        emit({status: 'joining', microphoneEnabled: true, cameraEnabled: true});
        createTile(snapshot.peerId, {name: snapshot.name, role: 'guest'});
        attachStream(snapshot.peerId, stream, {name: snapshot.name, role: 'guest'});
        createTile(HOST_PEER_ID, {name: 'DJ Cioko', role: 'host'});
        if (!callHostWithLocalStream()) throw new Error('HOST_CALL_UNAVAILABLE');
        emit({status: 'joined'});
        sendState({state: 'joined'});
      } catch (error) {
        if (activeEpoch !== epoch) return;
        safeSend(hostConnection, message('guest-media-error', {reason: error?.name ?? 'unavailable'}));
        await cleanupMedia();
        emit({status: 'media_error'});
      } finally {
        joining = null;
      }
    })();
    return joining;
  }

  function matchesActive(data) {
    if (data?.requestId && String(data.requestId) !== snapshot.requestId) return false;
    if (data?.clientId && String(data.clientId) !== clientId) return false;
    return true;
  }

  async function handleHostMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'party-status') {
      if (data.open === false && !['joined', 'joining'].includes(snapshot.status)) {
        clearRequestTimer();
        emit({status: 'room_closed', requestId: null});
      } else if (
        data.open !== false
        && !snapshot.requestId
        && ['connecting', 'waiting_host', 'room_closed'].includes(snapshot.status)
      ) {
        emit({status: 'idle'});
      }
      return;
    }
    if (data.type === 'party-roster') {
      if (matchesActive(data)) applyRoster(data);
      return;
    }
    if (!matchesActive(data)) return;
    if (data.type === 'guest-accepted') {
      if (snapshot.status === 'pending' || snapshot.status === 'waiting_host') {
        await startAcceptedMedia();
      }
      return;
    }
    if (
      data.type === 'guest-reconnect'
      && localStream
      && ['accepted', 'joining', 'joined'].includes(snapshot.status)
    ) {
      emit({status: 'joining'});
      if (callHostWithLocalStream({replace: true})) {
        emit({status: 'joined'});
        sendState({state: 'joined'});
      } else {
        emit({status: 'error'});
      }
      return;
    }
    if (data.type === 'guest-rejected' || data.type === 'guest-busy') {
      clearRequestTimer();
      emit({status: data.type === 'guest-busy' ? 'busy' : 'rejected', requestId: null});
      return;
    }
    if (data.type === 'guest-expired') {
      clearRequestTimer();
      emit({status: 'expired', requestId: null});
      return;
    }
    const terminal = {
      'guest-removed': 'removed',
      'host-removed': 'removed',
      removed: 'removed',
      'host-ended': 'ended',
      'room-closed': 'room_closed',
      'party-closed': 'room_closed',
    }[data.type];
    if (terminal) await finishTerminal(terminal);
  }

  async function handleIncomingCall(call) {
    const metadata = call?.metadata ?? {};
    const remote = String(call?.peer ?? '');
    const entry = roster.get(remote);
    const verified = metadata.type === 'party-mesh'
      && entry?.role === 'guest'
      && metadata.fromPeerId === remote
      && remote < snapshot.peerId
      && localStream
      && snapshot.status === 'joined';
    if (!verified || calls.has(remote)) {
      safeClose(call);
      return;
    }
    if (!bindCall(call, remote, entry)) return;
    try {
      call.answer(localStream);
      void prioritizePartyCall(call);
    } catch { safeClose(call); }
  }

  async function cleanupMedia() {
    for (const call of new Set(calls.values())) safeClose(call);
    calls.clear();
    for (const timer of meshReconnectTimers.values()) timers.clearTimeout(timer);
    meshReconnectTimers.clear();
    if (localStream) {
      for (const track of localStream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    }
    localStream = null;
    roster.clear();
    for (const peerId of [...tiles.keys()]) removeTile(peerId);
  }

  async function finishTerminal(status) {
    ++epoch;
    clearRequestTimer();
    await cleanupMedia();
    emit({status, requestId: null});
  }

  async function setDevice(kind, enabled) {
    if (!localStream || snapshot.status !== 'joined') return;
    const tracks = kind === 'microphone'
      ? localStream.getAudioTracks() : localStream.getVideoTracks();
    tracks.forEach(track => { track.enabled = Boolean(enabled); });
    const patch = kind === 'microphone'
      ? {microphoneEnabled: Boolean(enabled)} : {cameraEnabled: Boolean(enabled)};
    emit(patch);
    updateTile(snapshot.peerId, {
      name: snapshot.name,
      microphoneEnabled: snapshot.microphoneEnabled,
      cameraEnabled: snapshot.cameraEnabled,
    });
    sendState(patch);
  }

  function setMicrophoneEnabled(enabled) {
    return setDevice('microphone', enabled);
  }

  function setCameraEnabled(enabled) {
    return setDevice('camera', enabled);
  }

  function raiseHand(value) {
    if (snapshot.liveAvailable === false) return Promise.resolve(false);
    if (['pending', 'accepted', 'joining', 'joined'].includes(snapshot.status)) {
      return Promise.resolve(false);
    }
    const name = normalizeName(value);
    if (!name) {
      emit({status: 'error'});
      ui?.input.focus();
      return Promise.resolve(false);
    }
    rememberName(storage, name);
    emit({status: 'pending', requestId: String(requestIdFactory()), name});
    armRequestTimer();
    if (!sendRequest()) connectHost();
    return Promise.resolve(true);
  }

  function leave({notify = true, finalStatus = 'idle'} = {}) {
    if (leaving) return leaving;
    const activeRequest = snapshot.requestId;
    if (!activeRequest && !localStream && calls.size === 0) {
      emit({status: finalStatus});
      return Promise.resolve();
    }
    ++epoch;
    clearRequestTimer();
    leaving = (async () => {
      if (notify && activeRequest) {
        safeSend(hostConnection, message('guest-left', {state: 'left'}));
      }
      await cleanupMedia();
      emit({
        status: finalStatus,
        requestId: null,
        name: finalStatus === 'idle' ? snapshot.name : snapshot.name,
        microphoneEnabled: true,
        cameraEnabled: true,
      });
    })().finally(() => { leaving = null; });
    return leaving;
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (reconnectTimer != null) timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    pageWindow?.removeEventListener?.('pagehide', pageHide);
    unbindPublicLiveGate();
    unbindLegacyStatusGate();
    await leave({notify: true});
    safeClose(hostConnection);
    hostConnection = null;
    try { peer?.destroy?.(); } catch { /* already gone */ }
    root?.replaceChildren();
    mounted = false;
  }

  function pageHide() {
    void leave({notify: true});
  }

  async function mount(target) {
    if (mounted) return api;
    if (!target?.querySelector) throw new TypeError('party root required');
    root = target;
    ui = renderShell(root, readNames(storage));
    root.hidden = false;
    root.dataset.partyPeerjsMounted = 'true';
    bindLegacyStatusGate();
    bindPublicLiveGate();
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      void raiseHand(ui.input.value);
    });
    ui.microphone.addEventListener('click', () => {
      void setMicrophoneEnabled(!snapshot.microphoneEnabled);
    });
    ui.camera.addEventListener('click', () => {
      void setCameraEnabled(!snapshot.cameraEnabled);
    });
    ui.hangup.addEventListener('click', () => { void leave(); });
    peer = peerFactory();
    if (!peer?.on) throw new Error('PEERJS_UNAVAILABLE');
    peer.on('open', id => {
      emit({peerId: String(id), status: snapshot.status === 'idle' ? 'connecting' : snapshot.status});
      connectHost();
    });
    peer.on('call', call => handleIncomingCall(call));
    peer.on('disconnected', () => {
      try { if (!peer.destroyed) peer.reconnect(); } catch { /* retry through PeerJS */ }
    });
    peer.on('error', error => {
      if (error?.type === 'peer-unavailable' && !hostConnection?.open) {
        emit({status: snapshot.status === 'pending' ? 'waiting_host' : snapshot.status});
        scheduleHostReconnect();
      }
    });
    pageWindow?.addEventListener?.('pagehide', pageHide);
    mounted = true;
    emit({status: 'connecting'});
    return api;
  }

  const api = Object.freeze({
    get state() { return snapshot; },
    mount,
    raiseHand,
    setMicrophoneEnabled,
    setCameraEnabled,
    leave,
    destroy,
  });
  return api;
}


export function bootPeerJsPartyGuest(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  const root = documentRef?.querySelector?.('[data-party-live-root]');
  if (!root || root.dataset.partyPeerjsMounted === 'true') return null;
  const controller = createPeerJsPartyGuest(options);
  void controller.mount(root);
  return controller;
}


if (typeof document !== 'undefined') {
  const boot = () => bootPeerJsPartyGuest();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, {once: true});
  } else {
    queueMicrotask(boot);
  }
}
