import {Room} from 'livekit-client';

import {createPartyApi} from './party-api.js';
import {createPartyGrid} from './party-grid.js';
import {createPartyGuest, PARTY_REQUEST_SESSION_KEY} from './party-guest.js';
import {loadOrCreatePartyBrowserKey} from './party-names.js';
import '../styles/party-room.css';


function savedRequest(storage) {
  let value;
  try { value = JSON.parse(storage?.getItem(PARTY_REQUEST_SESSION_KEY) ?? 'null'); } catch { return {}; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}


function createMutableGrid({root, createGrid, initialIdentity = ''}) {
  let identity = initialIdentity;
  let implementation = createGrid({root, localIdentity: identity});
  const methods = [
    'applyRoster', 'attachTrack', 'detachTrack', 'setTrackState',
    'setConnectionState', 'setConnectionQuality', 'setSpeaking',
    'remove', 'clear',
  ];
  const proxy = {};
  for (const method of methods) {
    proxy[method] = (...args) => implementation[method]?.(...args);
  }
  proxy.useIdentity = nextIdentity => {
    if (!nextIdentity || nextIdentity === identity) return;
    implementation.clear?.();
    root.replaceChildren();
    identity = nextIdentity;
    implementation = createGrid({root, localIdentity: identity});
  };
  return Object.freeze(proxy);
}


export async function bootPartyGuest({
  document = globalThis.document,
  window = globalThis.window,
  fetchImpl = (...args) => globalThis.fetch(...args),
  cryptoImpl = globalThis.crypto,
  createApi = createPartyApi,
  createGrid = createPartyGrid,
  createController = createPartyGuest,
  roomFactory = options => new Room(options),
} = {}) {
  const root = document?.querySelector?.('[data-party-live-root]');
  if (!root) return null;
  if (root.__partyGuestBoot) return root.__partyGuestBoot;

  const localStorage = window?.localStorage;
  const sessionStorage = window?.sessionStorage;
  const restored = savedRequest(sessionStorage);
  const browserKey = loadOrCreatePartyBrowserKey(localStorage, cryptoImpl);
  const api = createApi({
    fetchImpl,
    browserKey,
    requestToken: typeof restored.credential === 'string' ? restored.credential : '',
  });

  const gridRoot = document.createElement('section');
  gridRoot.className = 'party-grid';
  gridRoot.dataset.partyGrid = '';
  gridRoot.setAttribute('aria-label', 'Participanții din camera LIVE');
  const grid = createMutableGrid({
    root: gridRoot,
    createGrid,
    initialIdentity: typeof restored.identity === 'string' ? restored.identity : '',
  });
  let currentIdentity = typeof restored.identity === 'string' ? restored.identity : '';
  const controller = createController({
    api,
    grid,
    roomFactory,
    mediaDevices: window?.navigator?.mediaDevices ?? globalThis.navigator?.mediaDevices,
    localStorage,
    sessionStorage,
    timers: document.defaultView ?? window ?? globalThis,
    onState(state) {
      if (state.identity && state.identity !== currentIdentity) {
        currentIdentity = state.identity;
        grid.useIdentity(currentIdentity);
      }
    },
  });

  const resultPromise = (async () => {
    await controller.mount(root);
    root.querySelector('[data-party-grid-slot]')?.append(gridRoot);
    const enabled = controller.state.enabled === true;
    if (enabled) {
      for (const legacy of document.querySelectorAll([
        '[data-legacy-guest-widget]',
        '[data-party-legacy]',
        '#djGuestViewerUi',
        '#djGuestRequest',
        '#djGuestChat',
      ].join(','))) {
        legacy.hidden = true;
        legacy.setAttribute('aria-hidden', 'true');
      }
    }
    return Object.freeze({controller, api, grid, root, gridRoot});
  })();
  root.__partyGuestBoot = resultPromise;
  return resultPromise;
}


async function autoBoot() {
  try { await bootPartyGuest(); } catch { /* the public LIVE must remain usable */ }
}


if (typeof document !== 'undefined' && !globalThis.process?.env?.VITEST) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoBoot, {once: true});
  } else {
    void autoBoot();
  }
}
