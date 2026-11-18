import { expect, it } from 'vitest';

import { openReuse } from './openReuseDecision.js';
import type { OpenReuse, OpenReuseFacts } from './openReuseDecision.js';

const checkout = '/checkout';

it.each<{ name: string; facts: OpenReuseFacts; expected: OpenReuse }>([
  {
    name: 'a live recorded terminal is reused',
    facts: {
      checkout,
      liveTerminal: 't-architect',
      terminalRunsAsk: false,
      terminalLabeledAsk: false,
    },
    expected: { kind: 'reuse', terminal: 't-architect' },
  },
  {
    name: 'a live terminal that a running ask names is refused',
    facts: {
      checkout,
      liveTerminal: 't-architect',
      terminalRunsAsk: true,
      terminalLabeledAsk: false,
    },
    expected: { kind: 'refuse', checkout },
  },
  {
    name: 'a live terminal with the ask label is refused',
    facts: {
      checkout,
      liveTerminal: 't-architect',
      terminalRunsAsk: false,
      terminalLabeledAsk: true,
    },
    expected: { kind: 'refuse', checkout },
  },
  {
    name: 'a live terminal with both ask signals is refused',
    facts: {
      checkout,
      liveTerminal: 't-architect',
      terminalRunsAsk: true,
      terminalLabeledAsk: true,
    },
    expected: { kind: 'refuse', checkout },
  },
  {
    name: 'no live terminal is refused',
    facts: {
      checkout,
      liveTerminal: undefined,
      terminalRunsAsk: false,
      terminalLabeledAsk: false,
    },
    expected: { kind: 'refuse', checkout },
  },
])('$name', ({ facts, expected }) => {
  expect(openReuse(facts)).toEqual(expected);
});
