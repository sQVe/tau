import { expect, it } from 'vitest';

import { openPlacement } from './openPlacementDecision.js';
import type { OpenPlacement, OpenPlacementFacts } from './openPlacementDecision.js';

const holder = { checkout: '/checkout' };

it.each<{ name: string; facts: OpenPlacementFacts; expected: OpenPlacement }>([
  {
    name: 'a lock holder and a live recorded terminal reuse the terminal',
    facts: {
      holder,
      liveTerminal: 't-architect',
      terminalRunsAsk: false,
      leadSpace: 'space-1',
    },
    expected: { kind: 'reuse', terminal: 't-architect' },
  },
  {
    name: 'a lock holder and a live terminal that runs an ask refuse',
    facts: {
      holder,
      liveTerminal: 't-architect',
      terminalRunsAsk: true,
      leadSpace: 'space-1',
    },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a lock holder and no live terminal refuse',
    facts: { holder, liveTerminal: undefined, terminalRunsAsk: false, leadSpace: 'space-1' },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'no lock holder and a live recorded terminal split',
    facts: {
      holder: undefined,
      liveTerminal: 't-architect',
      terminalRunsAsk: false,
      leadSpace: 'space-1',
    },
    expected: { kind: 'pane' },
  },
  {
    name: 'no lock holder and no terminal split',
    facts: {
      holder: undefined,
      liveTerminal: undefined,
      terminalRunsAsk: false,
      leadSpace: 'space-1',
    },
    expected: { kind: 'pane' },
  },
  {
    name: 'no lock holder and no lead space open a new space',
    facts: {
      holder: undefined,
      liveTerminal: undefined,
      terminalRunsAsk: false,
      leadSpace: undefined,
    },
    expected: { kind: 'newSpace' },
  },
  {
    name: 'an empty lead space counts as no space',
    facts: { holder: undefined, liveTerminal: undefined, terminalRunsAsk: false, leadSpace: '' },
    expected: { kind: 'newSpace' },
  },
])('$name', ({ facts, expected }) => {
  expect(openPlacement(facts)).toEqual(expected);
});
