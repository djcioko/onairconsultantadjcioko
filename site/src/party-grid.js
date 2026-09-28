const text = (document, tag, className) => {
  const element = document.createElement(tag);
  element.className = className;
  return element;
};


function entryFrom(value) {
  const attributes = value?.attributes && typeof value.attributes === 'object'
    ? value.attributes : {};
  const rawRole = value?.role ?? attributes.role ?? 'guest';
  const role = rawRole === 'party-host' ? 'host'
    : rawRole === 'party-guest' ? 'guest' : rawRole;
  const sequence = Number(value?.displaySequence ?? attributes.display_sequence ?? 0);
  const generation = Number(value?.generation ?? attributes.generation ?? 0);
  return {
    identity: String(value?.identity ?? ''),
    role: role === 'host' ? 'host' : 'guest',
    displayName: String(value?.displayName ?? attributes.display_name ?? 'Participant'),
    displaySequence: Number.isFinite(sequence) ? sequence : 0,
    generation: Number.isFinite(generation) ? generation : 0,
    state: String(value?.state ?? value?.connectionState ?? 'active').toLowerCase(),
    microphone: value?.microphone
      ?? (value?.isMicrophoneEnabled === undefined ? 'off' : value.isMicrophoneEnabled),
    camera: value?.camera
      ?? (value?.isCameraEnabled === undefined ? 'off' : value.isCameraEnabled),
    connectionQuality: String(value?.connectionQuality ?? 'unknown').toLowerCase(),
  };
}


function initials(name) {
  return name.trim().split(/\s+/u).filter(Boolean).slice(0, 2)
    .map(part => Array.from(part)[0]?.toUpperCase() ?? '').join('') || '•';
}


function onState(value) {
  if (value === true) return 'on';
  const state = String(value ?? '').toLowerCase();
  return ['on', 'active', 'published', 'unmuted', 'enabled', 'true'].includes(state)
    ? 'on' : state === 'muted' ? 'muted' : 'off';
}


function mediaKind(value) {
  const kind = String(value ?? '').toLowerCase();
  return ['video', 'camera'].includes(kind) ? 'video'
    : ['audio', 'microphone'].includes(kind) ? 'audio' : '';
}


export function createPartyGrid({root, localIdentity = '', onRemove = null}) {
  if (!root || typeof root.append !== 'function') throw new TypeError('party grid root required');
  const document = root.ownerDocument;
  const tiles = new Map();
  root.classList.add('party-grid');
  root.dataset.count = '0';

  function createBadge(kind) {
    const badge = text(document, 'span', 'party-badge');
    badge.dataset.kind = kind;
    badge.setAttribute('role', 'status');
    return badge;
  }

  function createTile(identity) {
    const node = text(document, 'article', 'party-tile');
    node.dataset.identity = identity;
    const media = text(document, 'div', 'party-media');
    const video = document.createElement('video');
    video.className = 'party-video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = identity === localIdentity;
    const audio = document.createElement('audio');
    audio.className = 'party-audio';
    audio.autoplay = true;
    audio.hidden = true;
    const fallback = text(document, 'div', 'party-initials');
    fallback.setAttribute('aria-hidden', 'true');
    media.append(video, audio, fallback);
    const information = text(document, 'div', 'party-information');
    const name = text(document, 'strong', 'party-name');
    const badges = text(document, 'div', 'party-badges');
    const microphone = createBadge('microphone');
    const camera = createBadge('camera');
    const connection = createBadge('connection');
    const quality = createBadge('quality');
    badges.append(microphone, camera, connection, quality);
    information.append(name, badges);
    node.append(media, information);
    const tile = {
      identity, node, video, audio, fallback, name, badges,
      microphone, camera, connection, quality,
      tracks: new Map(), entry: null, removeButton: null,
    };
    tiles.set(identity, tile);
    return tile;
  }

  function ensure(identity) {
    return tiles.get(identity) ?? createTile(identity);
  }

  function updateRemove(tile, localRole) {
    const allowed = Boolean(
      onRemove && localRole === 'host' && tile.entry?.role === 'guest',
    );
    if (allowed && !tile.removeButton) {
      const button = text(document, 'button', 'party-remove');
      button.type = 'button';
      button.textContent = 'Elimină';
      button.addEventListener('click', () => onRemove(tile.identity));
      tile.node.append(button);
      tile.removeButton = button;
    } else if (!allowed && tile.removeButton) {
      tile.removeButton.remove();
      tile.removeButton = null;
    }
    if (tile.removeButton) {
      tile.removeButton.setAttribute('aria-label', `Elimină ${tile.entry.displayName}`);
    }
  }

  function updateTrackBadge(tile, kind, state) {
    const enabled = onState(state);
    if (kind === 'microphone') {
      tile.microphone.dataset.state = enabled;
      tile.microphone.textContent = enabled === 'on'
        ? 'Microfon pornit' : 'Microfon oprit';
      tile.microphone.setAttribute('aria-label', tile.microphone.textContent);
    } else {
      tile.camera.dataset.state = enabled;
      tile.camera.textContent = enabled === 'on' ? 'Cameră pornită' : 'Cameră oprită';
      tile.camera.setAttribute('aria-label', tile.camera.textContent);
      const cameraOn = enabled === 'on';
      tile.video.hidden = !cameraOn;
      tile.fallback.hidden = cameraOn;
    }
  }

  function updateConnection(tile, state) {
    const normalized = String(state ?? 'active').toLowerCase();
    tile.node.dataset.connection = normalized;
    tile.connection.dataset.state = normalized;
    tile.connection.textContent = ({
      reconnecting: 'Reconectare…',
      disconnected: 'Deconectat',
      reserved: 'În așteptare',
      active: 'Conectat',
      joined: 'Conectat',
    })[normalized] ?? 'Conectare…';
  }

  function updateQuality(tile, quality) {
    const normalized = String(quality ?? 'unknown').toLowerCase();
    tile.quality.dataset.state = normalized;
    tile.quality.textContent = ({
      excellent: 'Semnal excelent',
      good: 'Semnal bun',
      poor: 'Semnal slab',
      lost: 'Semnal pierdut',
    })[normalized] ?? 'Semnal necunoscut';
  }

  function updateTile(tile, entry, displayLabel, localRole) {
    tile.entry = entry;
    tile.node.dataset.role = entry.role;
    tile.node.dataset.sequence = String(entry.displaySequence);
    tile.node.dataset.generation = String(entry.generation);
    tile.name.textContent = displayLabel;
    tile.fallback.textContent = initials(entry.displayName);
    updateTrackBadge(tile, 'microphone', entry.microphone);
    updateTrackBadge(tile, 'camera', entry.camera);
    updateConnection(tile, entry.state);
    updateQuality(tile, entry.connectionQuality);
    updateRemove(tile, localRole);
  }

  function remove(identity) {
    const tile = tiles.get(identity);
    if (!tile) return;
    for (const [kind, binding] of tile.tracks) {
      try { binding.track?.detach?.(kind === 'video' ? tile.video : tile.audio); } catch { /* gone */ }
    }
    tile.tracks.clear();
    tile.video.srcObject = null;
    tile.audio.srcObject = null;
    tile.node.remove();
    tiles.delete(identity);
    root.dataset.count = String(tiles.size);
  }

  function applyRoster(snapshot) {
    const source = Array.isArray(snapshot) ? snapshot : snapshot?.participants;
    const entries = (Array.isArray(source) ? source : [])
      .map(entryFrom).filter(entry => entry.identity);
    const names = new Map();
    for (const entry of entries) {
      names.set(entry.displayName, (names.get(entry.displayName) ?? 0) + 1);
    }
    entries.sort((left, right) => {
      if (left.role !== right.role) return left.role === 'host' ? -1 : 1;
      return left.displaySequence - right.displaySequence
        || left.identity.localeCompare(right.identity);
    });
    const localRole = entries.find(entry => entry.identity === localIdentity)?.role;
    const current = new Set(entries.map(entry => entry.identity));
    for (const identity of tiles.keys()) {
      if (!current.has(identity)) remove(identity);
    }
    for (const entry of entries) {
      const tile = ensure(entry.identity);
      const duplicate = names.get(entry.displayName) > 1 && entry.role !== 'host';
      const label = duplicate
        ? `${entry.displayName} · #${entry.displaySequence}` : entry.displayName;
      updateTile(tile, entry, label, localRole);
      root.append(tile.node);
    }
    root.dataset.count = String(entries.length);
  }

  function attachTrack(identity, track, publication = {}) {
    const tile = ensure(identity);
    const kind = mediaKind(track?.kind ?? publication?.kind ?? publication?.source);
    if (!kind) return;
    const previous = tile.tracks.get(kind);
    const element = kind === 'video' ? tile.video : tile.audio;
    if (previous?.track && previous.track !== track) {
      try { previous.track.detach?.(element); } catch { /* replaced */ }
    }
    track?.attach?.(element);
    tile.tracks.set(kind, {track, publication});
    updateTrackBadge(
      tile, kind === 'video' ? 'camera' : 'microphone',
      publication?.isMuted ? 'muted' : 'on',
    );
  }

  function detachTrack(identity, kindValue) {
    const tile = tiles.get(identity);
    if (!tile) return;
    const kind = mediaKind(kindValue);
    const binding = tile.tracks.get(kind);
    const element = kind === 'video' ? tile.video : tile.audio;
    try { binding?.track?.detach?.(element); } catch { /* already detached */ }
    if (element) element.srcObject = null;
    tile.tracks.delete(kind);
    updateTrackBadge(tile, kind === 'video' ? 'camera' : 'microphone', 'off');
  }

  function setTrackState(identity, kindValue, state) {
    const tile = tiles.get(identity);
    if (!tile) return;
    const kind = mediaKind(kindValue);
    updateTrackBadge(tile, kind === 'video' ? 'camera' : 'microphone', state);
  }

  function clear() {
    for (const identity of [...tiles.keys()]) remove(identity);
    root.dataset.count = '0';
  }

  return Object.freeze({
    applyRoster,
    attachTrack,
    detachTrack,
    setTrackState,
    setConnectionState(identity, state) {
      const tile = tiles.get(identity);
      if (tile) updateConnection(tile, state);
    },
    setConnectionQuality(identity, quality) {
      const tile = tiles.get(identity);
      if (tile) updateQuality(tile, quality);
    },
    setSpeaking(identity, active) {
      tiles.get(identity)?.node.classList.toggle('is-speaking', Boolean(active));
    },
    remove,
    clear,
  });
}
