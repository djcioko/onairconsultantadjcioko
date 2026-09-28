import {createPartyGrid} from '../../../site/src/party-grid.js';
import {createPartyGuest} from '../../../site/src/party-guest.js';
import {createPartyHost} from '../../../studio/src/party-host.js';
import '../../../site/styles/party-room.css';


const $ = selector => document.querySelector(selector);
const passiveTimers = {
  now: () => Date.now(),
  setTimeout: () => 1,
  clearTimeout: () => {},
};


function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}


function partyError(code, status = 409) {
  return Object.assign(new Error(code), {code, status});
}


function rawTrack(kind) {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    stop() { this.readyState = 'ended'; },
  };
}


function publishedTrack(raw, broker, room, publication) {
  return {
    kind: raw.kind,
    mediaStreamTrack: raw,
    attach(element) { element.dataset.fixtureTrack = raw.kind; return element; },
    detach(element) { delete element.dataset.fixtureTrack; return element; },
    async mute() {
      raw.enabled = false;
      publication.isMuted = true;
      broker.trackState(room, publication, true);
    },
    async unmute() {
      raw.enabled = true;
      publication.isMuted = false;
      broker.trackState(room, publication, false);
    },
  };
}


function participantView(record) {
  return {
    identity: record.identity,
    attributes: {
      role: record.role === 'host' ? 'party-host' : 'party-guest',
      display_name: record.displayName,
      display_sequence: String(record.displaySequence),
      generation: String(record.generation),
    },
    isMicrophoneEnabled: record.microphone !== false,
    isCameraEnabled: record.camera !== false,
    connectionQuality: record.connectionQuality ?? 'excellent',
    trackPublications: new Map(),
  };
}


class FakeRoom {
  constructor({service, broker, client}) {
    this.service = service;
    this.broker = broker;
    this.client = client;
    this.handlers = new Map();
    this.remoteParticipants = new Map();
    this.localParticipant = null;
    this.canPlaybackAudio = client?.autoplay !== false;
    this.canPlaybackVideo = client?.autoplay !== false;
  }

  on(event, callback) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(callback);
    return this;
  }

  off(event, callback) {
    this.handlers.get(event)?.delete(callback);
    return this;
  }

  emit(event, ...args) {
    for (const callback of this.handlers.get(event) ?? []) callback(...args);
  }

  async connect(_url, token) {
    const [, identity] = String(token).split('|');
    const record = this.service.participants.get(identity);
    if (!record) throw partyError('REMOVED', 410);
    this.localParticipant = participantView(record);
    this.localParticipant.publishTrack = async (track, options) => {
      const publication = {
        kind: track.kind,
        source: options.source,
        name: options.name,
        isMuted: false,
        track: null,
      };
      publication.track = publishedTrack(track, this.broker, this, publication);
      this.localParticipant.trackPublications.set(options.name, publication);
      this.broker.publish(this, publication);
      return publication;
    };
    this.broker.connect(this);
  }

  async disconnect() { this.broker.disconnect(this); }
  async startAudio() { this.canPlaybackAudio = true; this.emit('audioPlaybackChanged'); }
  async startVideo() { this.canPlaybackVideo = true; this.emit('videoPlaybackChanged'); }
}


class FakeRoomBroker {
  constructor(service) {
    this.service = service;
    this.rooms = new Set();
  }

  connect(room) {
    const existing = [...this.rooms];
    this.rooms.add(room);
    for (const other of existing) {
      const remoteForOther = participantView(this.service.participants.get(room.localParticipant.identity));
      const remoteForRoom = participantView(this.service.participants.get(other.localParticipant.identity));
      room.remoteParticipants.set(remoteForRoom.identity, remoteForRoom);
      other.remoteParticipants.set(remoteForOther.identity, remoteForOther);
      room.emit('participantConnected', remoteForRoom);
      other.emit('participantConnected', remoteForOther);
      for (const publication of other.localParticipant.trackPublications.values()) {
        remoteForRoom.trackPublications.set(publication.name, publication);
        room.emit('trackSubscribed', publication.track, publication, remoteForRoom);
      }
    }
  }

  publish(room, publication) {
    for (const other of this.rooms) {
      if (other === room) continue;
      const participant = other.remoteParticipants.get(room.localParticipant.identity);
      if (!participant) continue;
      participant.trackPublications.set(publication.name, publication);
      other.emit('trackSubscribed', publication.track, publication, participant);
    }
  }

  trackState(room, publication, muted) {
    for (const other of this.rooms) {
      if (other !== room) {
        const participant = other.remoteParticipants.get(room.localParticipant.identity);
        if (participant) other.emit(muted ? 'trackMuted' : 'trackUnmuted', publication, participant);
      }
    }
  }

  disconnect(room) {
    if (!this.rooms.delete(room) || !room.localParticipant) return;
    for (const other of this.rooms) {
      const participant = other.remoteParticipants.get(room.localParticipant.identity);
      other.remoteParticipants.delete(room.localParticipant.identity);
      if (participant) other.emit('participantDisconnected', participant);
    }
  }

  terminate(identity, reason) {
    for (const room of [...this.rooms]) {
      if (room.localParticipant?.identity === identity) {
        this.disconnect(room);
        room.emit('disconnected', reason);
      }
    }
  }

  closeAll() {
    for (const room of [...this.rooms]) {
      this.disconnect(room);
      room.emit('disconnected', 'room_deleted');
    }
  }
}


class PartyService {
  constructor() {
    this.open = false;
    this.revision = 0;
    this.sequence = 0;
    this.requests = new Map();
    this.participants = new Map();
    this.broker = null;
    this.queueSync = () => {};
  }

  occupancy() { return this.participants.size; }
  bump() { this.revision += 1; }
  grant(record) {
    return {
      url: 'wss://djcioko.ro', room: 'fixture-party',
      token: `fixture|${record.identity}|${record.generation}`,
      identity: record.identity, generation: record.generation,
      expiresAt: Date.now() + 30_000,
    };
  }

  publicApi(client) {
    const service = this;
    return {
      async getStatus() {
        return {enabled: true, open: service.open, capacity: 9, available: 9 - service.occupancy()};
      },
      async createRequest({name}) {
        const current = service.requests.get(client.id);
        if (current && ['pending', 'accepted', 'joined', 'reconnecting'].includes(current.state)) {
          return {...current, credential: `credential-${client.id}`};
        }
        if (!service.open) throw partyError('PARTY_CLOSED', 409);
        if (service.occupancy() >= 9) throw partyError('ROOM_FULL', 409);
        const request = {
          requestId: `request-${client.id}`, clientId: client.id,
          displayName: name, displaySequence: ++service.sequence,
          state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 90_000,
          participant: null,
        };
        service.requests.set(client.id, request);
        service.bump();
        service.queueSync();
        return {...request, credential: `credential-${client.id}`};
      },
      async getRequest() {
        const request = service.requests.get(client.id);
        if (!request) return {requestId: `request-${client.id}`, state: 'expired'};
        return {...request};
      },
      async cancel() { service.dropClient(client.id, 'left'); return {state: 'left'}; },
      async join() {
        const request = service.requests.get(client.id);
        if (!request || request.state !== 'accepted') throw partyError('JOIN_EXPIRED', 410);
        request.state = 'joined';
        const record = service.participants.get(request.participant.identity);
        record.state = 'active';
        service.bump();
        service.queueSync();
        return service.grant(record);
      },
      async reconnect() {
        const request = service.requests.get(client.id);
        const record = request && service.participants.get(request.participant?.identity);
        if (!record) throw partyError('RECONNECT_EXPIRED', 410);
        record.generation += 1;
        request.participant.generation = record.generation;
        request.state = 'joined';
        service.bump();
        service.queueSync();
        return service.grant(record);
      },
      async leave() { service.dropClient(client.id, 'left'); return {state: 'left'}; },
    };
  }

  adminApi() {
    const service = this;
    return {
      async adminOpen() {
        service.open = true;
        let host = service.participants.get('host-stable');
        if (!host) {
          host = {
            memberId: null, identity: 'host-stable', role: 'host', displayName: 'DJ Cioko',
            displaySequence: 0, generation: 1, state: 'active', microphone: true, camera: true,
          };
          service.participants.set(host.identity, host);
        }
        service.bump();
        return {
          sessionId: 'session-fixture', revision: service.revision,
          state: 'open', capacity: 9, occupancy: service.occupancy(),
          ...service.grant(host),
        };
      },
      async adminRejoin() {
        const host = service.participants.get('host-stable');
        host.generation += 1;
        service.bump();
        return {sessionId: 'session-fixture', revision: service.revision, ...service.grant(host)};
      },
      async adminStatus() { return service.snapshot(); },
      async adminAccept({requestId}) {
        if (service.occupancy() >= 9) throw partyError('ROOM_FULL', 409);
        const request = [...service.requests.values()].find(value => value.requestId === requestId);
        if (!request || request.state !== 'pending') throw partyError('REQUEST_EXPIRED', 410);
        const record = {
          memberId: `member-${request.clientId}`, identity: `guest-${request.displaySequence}`,
          role: 'guest', displayName: request.displayName,
          displaySequence: request.displaySequence, generation: 1, state: 'reserved',
          microphone: true, camera: true,
        };
        service.participants.set(record.identity, record);
        request.state = 'accepted';
        request.participant = {
          memberId: record.memberId, identity: record.identity, generation: record.generation,
        };
        service.bump();
        service.queueSync();
        return {...request.participant, requestId, state: 'accepted', revision: service.revision};
      },
      async adminDecline({requestId}) {
        const request = [...service.requests.values()].find(value => value.requestId === requestId);
        if (request) request.state = 'declined';
        service.bump();
        service.queueSync();
        return {requestId, state: 'declined', revision: service.revision};
      },
      async adminRemove({memberId}) {
        const record = [...service.participants.values()].find(value => value.memberId === memberId);
        if (!record) throw partyError('REMOVED', 410);
        service.participants.delete(record.identity);
        const request = [...service.requests.values()].find(value => value.participant?.identity === record.identity);
        if (request) request.state = 'removed';
        service.bump();
        service.broker.terminate(record.identity, 'removed');
        service.queueSync();
        return {memberId, identity: record.identity, state: 'removed', revision: service.revision};
      },
      async adminClose() {
        service.open = false;
        for (const request of service.requests.values()) request.state = 'room_closed';
        service.participants.clear();
        service.bump();
        service.broker.closeAll();
        service.queueSync(false);
        return {sessionId: 'session-fixture', state: 'closed', revision: service.revision};
      },
    };
  }

  dropClient(clientId, state) {
    const request = this.requests.get(clientId);
    const identity = request?.participant?.identity;
    if (request) request.state = state;
    if (identity) {
      this.participants.delete(identity);
      this.broker.terminate(identity, state === 'removed' ? 'removed' : 'client_initiated');
    }
    this.bump();
    this.queueSync();
  }

  snapshot() {
    return {
      sessionId: 'session-fixture', revision: this.revision,
      state: this.open ? 'open' : 'closed', capacity: 9, occupancy: this.occupancy(),
      requests: [...this.requests.values()].filter(value => value.state === 'pending').map(value => ({...value})),
      participants: [...this.participants.values()].map(value => ({...value})),
    };
  }
}


const service = new PartyService();
const broker = new FakeRoomBroker(service);
service.broker = broker;
const guestControllers = new Map();
let hostController;
let syncing = false;
let syncAgain = false;


async function syncControllers(includeHost = true) {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    if (includeHost && hostController?.state.sessionId) {
      await hostController.pollStatus({waitMs: 0});
    }
    await Promise.all([...guestControllers.values()].map(({controller}) => (
      controller.state.requestId ? controller.poll() : Promise.resolve()
    )));
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      queueMicrotask(() => syncControllers(includeHost));
    }
  }
}


service.queueSync = (includeHost = true) => queueMicrotask(() => syncControllers(includeHost));


const hostGrid = createPartyGrid({
  root: $('[data-host-grid]'),
  localIdentity: 'host-stable',
  onRemove(identity) {
    const participant = hostController.state.participants.find(value => value.identity === identity);
    if (participant?.memberId) void hostController.remove(participant.memberId);
  },
});


function hostTrack(kind) {
  const track = rawTrack(kind);
  return {
    kind,
    mediaStreamTrack: track,
    attach(element) { element.dataset.fixtureTrack = kind; },
    detach(element) { delete element.dataset.fixtureTrack; },
    async mute() { track.enabled = false; },
    async unmute() { track.enabled = true; },
  };
}


const hostMedia = {
  createOwnedTracks: () => ({videoTrack: hostTrack('video'), audioTrack: hostTrack('audio')}),
  async setAudioEnabled(tracks, enabled) { tracks.audioTrack.mediaStreamTrack.enabled = enabled; },
  async setVideoEnabled(tracks, enabled) { tracks.videoTrack.mediaStreamTrack.enabled = enabled; },
  stopOwnedTracks(tracks) {
    tracks.videoTrack.mediaStreamTrack.stop();
    tracks.audioTrack.mediaStreamTrack.stop();
  },
};


function renderHost(state) {
  $('[data-host-occupancy]').textContent = `${state.occupancy}/${state.capacity}`;
  $('[data-host-status]').textContent = ({
    closed: 'Camera este închisă.', opening: 'Se deschide camera…',
    open: 'Camera este deschisă.', reconnecting: 'Se reconectează…',
    error: state.message || 'Camera nu răspunde.',
  })[state.status] ?? state.status;
  $('[data-host-open]').disabled = ['opening', 'open', 'reconnecting'].includes(state.status);
  $('[data-host-close]').disabled = !state.sessionId;
  $('[data-host-microphone]').disabled = !state.sessionId;
  $('[data-host-camera]').disabled = !state.sessionId;
  $('[data-host-microphone]').setAttribute('aria-pressed', String(state.microphoneEnabled));
  $('[data-host-camera]').setAttribute('aria-pressed', String(state.cameraEnabled));
  $('[data-host-confirm]').hidden = !state.confirmationRequired;

  const rows = state.requests.map(request => {
    const row = document.createElement('div');
    row.className = 'fixture-request';
    const name = document.createElement('strong');
    name.textContent = request.displayName;
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.textContent = 'Acceptă';
    accept.setAttribute('aria-label', `Acceptă ${request.displayName}`);
    accept.disabled = state.acceptDisabled;
    accept.addEventListener('click', () => void hostController.accept(request.requestId));
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.textContent = 'Respinge';
    decline.setAttribute('aria-label', `Respinge ${request.displayName}`);
    decline.addEventListener('click', () => void hostController.decline(request.requestId));
    row.append(name, accept, decline);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.textContent = 'Nicio cerere momentan.';
    rows.push(empty);
  }
  $('[data-host-requests]').replaceChildren(...rows);
}


hostController = createPartyHost({
  api: service.adminApi(),
  grid: hostGrid,
  roomFactory: () => new FakeRoom({service, broker, client: {autoplay: true}}),
  mediaBridge: hostMedia,
  timers: passiveTimers,
  onState: renderHost,
});


$('[data-host-open]').addEventListener('click', () => void hostController.open());
$('[data-host-close]').addEventListener('click', () => void hostController.close());
$('[data-host-confirm-yes]').addEventListener('click', () => void hostController.close({confirmed: true}));
$('[data-host-confirm-no]').addEventListener('click', () => renderHost({...hostController.state, confirmationRequired: false}));
$('[data-host-microphone]').addEventListener('click', () => (
  void hostController.setMicrophoneEnabled(!hostController.state.microphoneEnabled)
));
$('[data-host-camera]').addEventListener('click', () => (
  void hostController.setCameraEnabled(!hostController.state.cameraEnabled)
));


async function addGuest() {
  const number = guestControllers.size + 1;
  const client = {id: String(number), permission: true, autoplay: true};
  const card = document.createElement('section');
  card.className = 'guest-card';
  card.setAttribute('aria-label', `Spectator ${number}`);
  const heading = document.createElement('h2');
  heading.textContent = `Spectator ${number}`;
  const options = document.createElement('div');
  options.className = 'guest-options';
  options.innerHTML = `
    <label><input type="checkbox" data-permission checked> Permite camera și microfonul</label>
    <label><input type="checkbox" data-autoplay checked> Permite redarea automată</label>
    <button type="button" data-reconnect disabled>Reconectează participantul</button>
  `;
  const root = document.createElement('section');
  const gridRoot = document.createElement('section');
  gridRoot.className = 'party-grid';
  gridRoot.setAttribute('aria-label', `Grila video spectator ${number}`);
  card.append(heading, options, root);
  $('[data-guests]').append(card);
  const grid = createPartyGrid({root: gridRoot});
  const controller = createPartyGuest({
    api: service.publicApi(client),
    grid,
    roomFactory: () => new FakeRoom({service, broker, client}),
    mediaDevices: {
      async getUserMedia() {
        if (!client.permission) throw new DOMException('denied', 'NotAllowedError');
        const video = rawTrack('video');
        const audio = rawTrack('audio');
        return {
          getTracks: () => [video, audio],
          getVideoTracks: () => [video],
          getAudioTracks: () => [audio],
        };
      },
    },
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    timers: passiveTimers,
    onState(state) {
      options.querySelector('[data-reconnect]').disabled = state.status !== 'joined';
    },
  });
  guestControllers.set(client.id, {client, card, controller, grid});
  options.querySelector('[data-permission]').addEventListener('change', event => {
    client.permission = event.target.checked;
  });
  options.querySelector('[data-autoplay]').addEventListener('change', event => {
    client.autoplay = event.target.checked;
  });
  options.querySelector('[data-reconnect]').addEventListener('click', () => void controller.reconnect());
  await controller.mount(root);
  root.querySelector('[data-party-grid-slot]')?.append(gridRoot);
}


$('[data-add-guest]').addEventListener('click', () => void addGuest());


$('[data-public-reconnect]').addEventListener('click', () => {
  const status = $('[data-public-status]');
  status.textContent = 'Reconectare…';
  queueMicrotask(() => { status.textContent = 'Conectat'; });
});


renderHost(hostController.state);


const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #050a12; color: #eef7ff; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  main { width: min(1180px, 100%); margin: auto; padding: max(12px, env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom)); }
  button, input { min-width: 44px; min-height: 44px; font: inherit; }
  button { border: 1px solid #52789a; border-radius: 9px; padding: 8px 12px; background: #173654; color: white; }
  .public-live, .host-panel, .guest-lab, .guest-card { margin: 10px 0; border: 1px solid #2e4962; border-radius: 12px; padding: 12px; background: #0a1522; }
  .public-live, .host-panel header, .host-actions, .guest-options, .fixture-request { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .host-panel header { justify-content: space-between; }
  .fixture-request { margin: 6px 0; }
  .fixture-request strong { min-width: 120px; }
  [data-guests] { display: grid; gap: 10px; }
  .guest-card .party-room-dialog { position: relative; inset: auto; z-index: auto; min-height: 0; margin-top: 8px; padding: 10px; }
  .guest-card .party-grid-slot { max-height: 540px; }
  .host-confirm { position: fixed; inset: 25% 12px auto; z-index: 20; width: min(420px, calc(100% - 24px)); margin: auto; padding: 18px; border: 2px solid #85cfff; border-radius: 12px; background: #0a1522; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
document.head.append(style);
