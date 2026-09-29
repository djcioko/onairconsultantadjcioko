// @vitest-environment jsdom

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';


function parsedRules() {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve('site-peerjs/party-peerjs-room-v1.css'), 'utf8');
  document.head.append(style);
  const flatten = rules => [...rules].flatMap(rule => (
    rule.cssRules ? [rule, ...flatten(rule.cssRules)] : [rule]
  ));
  return flatten(style.sheet.cssRules);
}


function styleFor(rules, selector) {
  return rules.find(rule => rule.selectorText === selector)?.style;
}


describe('public PeerJS room responsive layout', () => {
  it('keeps one tile full width and two through nine tiles in two mobile columns', () => {
    const rules = parsedRules();
    expect(styleFor(rules, '.party-peerjs-grid').gridTemplateColumns)
      .toContain('repeat(2');
    expect(styleFor(rules, '.party-peerjs-grid .party-peerjs-tile:only-child').gridColumn)
      .toBe('1 / -1');
  });

  it('shows the full host frame with readable metadata and touch-sized controls', () => {
    const rules = parsedRules();
    const hostVideo = styleFor(
      rules,
      '.party-peerjs-tile[data-role="host"] .party-peerjs-media video',
    );
    const metadata = styleFor(rules, '.party-peerjs-meta span');
    const hostName = styleFor(
      rules,
      '.party-peerjs-tile[data-role="host"] .party-peerjs-meta strong',
    );
    const controls = styleFor(
      rules,
      '.party-peerjs-request-row input,\n.party-peerjs-request-row button,\n.party-peerjs-controls button,\n.party-peerjs-unmute',
    );

    expect(hostVideo.objectFit).toBe('contain');
    expect(metadata.fontSize).toMatch(/(?:\.75rem|12px)/u);
    expect(hostName.whiteSpace).toBe('normal');
    expect(hostName.overflowWrap).toBe('anywhere');
    expect(controls.minHeight).toMatch(/^(?:44|4[5-9])px$/u);
  });
});
