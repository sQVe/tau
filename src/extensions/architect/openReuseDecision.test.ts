import { expect, it } from 'vitest';

import { openCandidate, openReuse } from './openReuseDecision.js';
import type {
  OpenCandidate,
  OpenCandidateFacts,
  OpenReuse,
  OpenReuseFacts,
} from './openReuseDecision.js';

const holder = { pid: 10, checkout: '/checkout' };

const candidateFacts: OpenCandidateFacts = {
  holder,
  liveTerminal: 't-architect',
  terminalRunsAsk: false,
  terminalLabeledAsk: false,
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
    facts: { ...reuseFacts, currentHolder: { pid: 11, checkout: '/checkout' } },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a holder with a different checkout is refused with the new checkout',
    facts: { ...reuseFacts, currentHolder: { pid: 10, checkout: '/other' } },
    expected: { kind: 'refuse', checkout: '/other' },
  },
  {
    name: 'a holder with a different process and checkout is refused with the new checkout',
    facts: { ...reuseFacts, currentHolder: { pid: 11, checkout: '/other' } },
    expected: { kind: 'refuse', checkout: '/other' },
  },
])('reuse: $name', ({ facts, expected }) => {
  expect(openReuse(facts)).toEqual(expected);
});
