import {describe, expect, it} from 'vitest';

import {
  loadOrCreatePartyBrowserKey,
  loadPartyNames,
  normalizePartyName,
  rememberPartyName,
} from '../site/src/party-names.js';


function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    value: key => values.get(key),
  };
}


describe('party display names', () => {
  it('normalizes NFC, trims edges, and preserves ordinary Unicode text', () => {
    expect(normalizePartyName('  Ma\u0301r Ioana  ')).toBe('Már Ioana');
    expect(normalizePartyName(' DJ Cioko ')).toBe('DJ Cioko');
    expect(normalizePartyName('Ana 🎧')).toBe('Ana 🎧');
  });

  it('requires 1–32 visible code points and rejects markup/control/bidi text', () => {
    for (const value of [
      '', '   ', 'A'.repeat(33), 'Ana\nMaria', 'Ana\u0000Maria',
      'Ana\u200bMaria', 'Ana\u202eMaria', '<b>Ana</b>', 'Ana & Maria',
    ]) {
      expect(normalizePartyName(value)).toBe('');
    }
    expect(normalizePartyName('A'.repeat(32))).toBe('A'.repeat(32));
    expect(normalizePartyName(null)).toBe('');
  });

  it('stores the three most-recent distinct normalized names', () => {
    const value = storage();
    expect(rememberPartyName(value, ' Ana ')).toEqual(['Ana']);
    rememberPartyName(value, 'Bea');
    rememberPartyName(value, 'Cezar');
    expect(rememberPartyName(value, 'Ana')).toEqual(['Ana', 'Cezar', 'Bea']);
    expect(rememberPartyName(value, 'Daria')).toEqual(['Daria', 'Ana', 'Cezar']);
    expect(loadPartyNames(value)).toEqual(['Daria', 'Ana', 'Cezar']);
  });

  it('recovers safely from malformed or hostile storage values', () => {
    const malformed = storage({'djcioko.party.names.v1': '{not json'});
    expect(loadPartyNames(malformed)).toEqual([]);
    expect(malformed.value('djcioko.party.names.v1')).toBe('[]');

    const mixed = storage({'djcioko.party.names.v1': JSON.stringify([
      ' Ana ', 7, '<img src=x>', 'Ana', 'B'.repeat(33), 'Bea', 'Cezar', 'Daria',
    ])});
    expect(loadPartyNames(mixed)).toEqual(['Ana', 'Bea', 'Cezar']);
  });
});


describe('party browser key', () => {
  it('generates at least 128 random bits once and reuses the base64url value', () => {
    const value = storage();
    let calls = 0;
    const cryptoImpl = {
      getRandomValues(bytes) {
        calls += 1;
        bytes.forEach((_, index) => { bytes[index] = index + 1; });
        return bytes;
      },
    };
    const first = loadOrCreatePartyBrowserKey(value, cryptoImpl);
    const second = loadOrCreatePartyBrowserKey(value, cryptoImpl);
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length * 6).toBeGreaterThanOrEqual(128);
    expect(calls).toBe(1);
    expect(value.value('djcioko.party.browser.v1')).toBe(first);
  });

  it('replaces malformed or too-short persisted keys', () => {
    const value = storage({'djcioko.party.browser.v1': 'tiny'});
    const cryptoImpl = {
      getRandomValues(bytes) {
        bytes.fill(255);
        return bytes;
      },
    };
    const result = loadOrCreatePartyBrowserKey(value, cryptoImpl);
    expect(result).not.toBe('tiny');
    expect(result.length * 6).toBeGreaterThanOrEqual(128);
  });
});
