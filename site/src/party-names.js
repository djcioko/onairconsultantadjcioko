const NAMES_KEY = 'djcioko.party.names.v1';
const BROWSER_KEY = 'djcioko.party.browser.v1';
const UNSAFE_TEXT = /[<>&\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;


export function normalizePartyName(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFC').trim();
  const characters = Array.from(normalized);
  if (characters.length < 1 || characters.length > 32) return '';
  if (UNSAFE_TEXT.test(normalized)) return '';
  return normalized;
}


function saveNames(storage, names) {
  try { storage?.setItem(NAMES_KEY, JSON.stringify(names)); } catch { /* private mode */ }
  return names;
}


export function loadPartyNames(storage) {
  let raw;
  try { raw = storage?.getItem(NAMES_KEY); } catch { return []; }
  if (raw == null) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return saveNames(storage, []); }
  if (!Array.isArray(parsed)) return saveNames(storage, []);
  const names = [];
  for (const value of parsed) {
    const name = normalizePartyName(value);
    if (name && !names.includes(name)) names.push(name);
    if (names.length === 3) break;
  }
  if (JSON.stringify(names) !== raw) saveNames(storage, names);
  return names;
}


export function rememberPartyName(storage, value) {
  const name = normalizePartyName(value);
  if (!name) return loadPartyNames(storage);
  return saveNames(storage, [
    name,
    ...loadPartyNames(storage).filter(saved => saved !== name),
  ].slice(0, 3));
}


function validBrowserKey(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]+$/.test(value)
    && value.length * 6 >= 128
    && value.length <= 128;
}


function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}


export function loadOrCreatePartyBrowserKey(storage, cryptoImpl = globalThis.crypto) {
  let existing = null;
  try { existing = storage?.getItem(BROWSER_KEY); } catch { /* private mode */ }
  if (validBrowserKey(existing)) return existing;
  if (!cryptoImpl || typeof cryptoImpl.getRandomValues !== 'function') {
    throw new Error('PARTY_RANDOM_UNAVAILABLE');
  }
  const random = new Uint8Array(24);
  cryptoImpl.getRandomValues(random);
  const created = base64url(random);
  try { storage?.setItem(BROWSER_KEY, created); } catch { /* still usable this page */ }
  return created;
}
