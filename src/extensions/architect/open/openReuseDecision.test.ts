import { expect, it } from 'vitest';

import { openCandidate, openGeneration, openReuse } from './openReuseDecision.js';
import type {
  OpenCandidate,
  OpenCandidateFacts,
  OpenGeneration,
  OpenGenerationFacts,
  OpenReuse,
  OpenReuseFacts,
} from './openReuseDecision.js';

const holder = { pid: 10, checkout: '/checkout', token: 'live' };

const candidateFacts: OpenCandidateFacts = {
  holder,
  liveTerminal: 't-architect',
  terminalRunsAsk: false,
  terminalLabeledAsk: false,
  terminalHasPane: true,
};

it.each<{ name: string; facts: OpenCandidateFacts; expected: OpenCandidate }>([
  {
    name: 'a live recorded terminal is a candidate',
    facts: candidateFacts,
    expected: { kind: 'candidate', terminal: 't-architect' },
  },
  {
    name: 'a live terminal that a running ask names is refused',
    facts: { ...candidateFacts, terminalRunsAsk: true },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a live terminal with the ask label is refused',
    facts: { ...candidateFacts, terminalLabeledAsk: true },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a live terminal with both ask signals is refused',
    facts: { ...candidateFacts, terminalRunsAsk: true, terminalLabeledAsk: true },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'no live terminal is refused',
    facts: { ...candidateFacts, liveTerminal: undefined },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a live terminal without a pane is parked',
    facts: { ...candidateFacts, terminalHasPane: false },
    expected: {
      kind: 'parked',
      message:
        'The architect terminal t-architect is parked: it still runs but has no pane. Give it a pane with herdr-app do terminal.keep --terminal t-architect, then call architect open again.',
    },
  },
  {
    name: 'an ask terminal without a pane is refused as running, not parked',
    facts: { ...candidateFacts, terminalRunsAsk: true, terminalHasPane: false },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'no live terminal and no pane is refused as running, not parked',
    facts: { ...candidateFacts, liveTerminal: undefined, terminalHasPane: false },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
])('candidate: $name', ({ facts, expected }) => {
  expect(openCandidate(facts)).toEqual(expected);
});

const reuseFacts: OpenReuseFacts = { holder, currentHolder: holder, terminal: 't-architect' };

it.each<{ name: string; facts: OpenReuseFacts; expected: OpenReuse }>([
  {
    name: 'the same holder reuses the terminal',
    facts: reuseFacts,
    expected: { kind: 'reuse', terminal: 't-architect' },
  },
  {
    name: 'a holder that is gone starts the architect',
    facts: { ...reuseFacts, currentHolder: undefined },
    expected: { kind: 'start' },
  },
  {
    name: 'a holder with a different process is refused with the new checkout',
    facts: { ...reuseFacts, currentHolder: { ...holder, pid: 11 } },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a holder with a different checkout is refused with the new checkout',
    facts: { ...reuseFacts, currentHolder: { ...holder, checkout: '/other' } },
    expected: { kind: 'refuse', checkout: '/other' },
  },
  {
    name: 'a holder with a different process and checkout is refused with the new checkout',
    facts: { ...reuseFacts, currentHolder: { ...holder, pid: 11, checkout: '/other' } },
    expected: { kind: 'refuse', checkout: '/other' },
  },
  {
    name: 'the same holder with a different token',
    facts: { ...reuseFacts, currentHolder: { ...holder, token: 'reloaded' } },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
])('reuse: $name', ({ facts, expected }) => {
  expect(openReuse(facts)).toEqual(expected);
});

const generationFacts: OpenGenerationFacts = {
  root: '/checkout',
  holder,
  record: { terminal: 't-architect', token: 'live' },
};

it.each<{ name: string; facts: OpenGenerationFacts; expected: OpenGeneration }>([
  {
    name: 'the same token is current',
    facts: generationFacts,
    expected: { kind: 'current', terminal: 't-architect' },
  },
  {
    name: 'no record token is current',
    facts: { ...generationFacts, record: { terminal: 't-architect', token: undefined } },
    expected: { kind: 'current', terminal: 't-architect' },
  },
  {
    name: 'a current record with no terminal',
    facts: { ...generationFacts, record: { terminal: null, token: 'live' } },
    expected: { kind: 'current', terminal: null },
  },
  {
    name: 'a different token in this checkout',
    facts: { ...generationFacts, record: { terminal: 't-architect', token: 'previous' } },
    expected: { kind: 'unrecorded' },
  },
  {
    name: 'a different token in another checkout',
    facts: {
      ...generationFacts,
      holder: { ...holder, checkout: '/other' },
      record: { terminal: 't-architect', token: 'previous' },
    },
    expected: { kind: 'refuse', checkout: '/other' },
  },
])('generation: $name', ({ facts, expected }) => {
  expect(openGeneration(facts)).toEqual(expected);
});
