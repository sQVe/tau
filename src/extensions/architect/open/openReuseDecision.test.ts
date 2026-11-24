import { expect, it } from 'vitest';

import type { ArchitectOwner, SavedArchitectRecord } from '../record.js';
import { openCandidate, openReuse, openTerminal } from './openReuseDecision.js';
import type {
  OpenCandidate,
  OpenCandidateFacts,
  OpenReuse,
  OpenReuseFacts,
  OpenTerminal,
  OpenTerminalFacts,
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

const absentRecordFacts: OpenTerminalFacts = {
  root: '/checkout',
  holder,
  record: undefined,
  keptClaim: false,
};

const updatedAt = '2026-01-01T00:00:00.000Z';

const savedOwner = (owner: ArchitectOwner | null): SavedArchitectRecord => ({
  version: 2,
  sessionFile: null,
  leadTerminal: 't-lead',
  owner,
  updatedAt,
});

const version1Record = (terminal: string | null): SavedArchitectRecord => ({
  version: 1,
  sessionFile: null,
  terminal,
  leadTerminal: 't-lead',
  updatedAt,
});

const owner: ArchitectOwner = {
  lockToken: 'live',
  mode: 'visible',
  terminal: 't-architect',
  sessionId: 'session-architect',
};

const terminalFacts: OpenTerminalFacts = {
  root: '/checkout',
  holder,
  record: savedOwner(owner),
  keptClaim: false,
};

it.each<{ name: string; facts: OpenTerminalFacts; expected: OpenTerminal }>([
  {
    name: 'a matching token with a terminal',
    facts: terminalFacts,
    expected: { kind: 'lookup', terminal: 't-architect' },
  },
  {
    name: 'a tokenless version 1 record',
    facts: { ...terminalFacts, record: version1Record('t-architect') },
    expected: { kind: 'lookup', terminal: 't-architect' },
  },
  {
    name: 'an absent record',
    facts: absentRecordFacts,
    expected: { kind: 'starting' },
  },
  {
    name: 'an absent record in another checkout',
    facts: { ...absentRecordFacts, holder: { ...holder, checkout: '/other' } },
    expected: { kind: 'refuse', checkout: '/other' },
  },
  {
    name: 'a version 2 record with a null owner',
    facts: { ...terminalFacts, record: savedOwner(null) },
    expected: { kind: 'starting' },
  },
  {
    name: 'a version 2 record with a null owner in another checkout',
    facts: {
      ...terminalFacts,
      holder: { ...holder, checkout: '/other' },
      record: savedOwner(null),
    },
    expected: { kind: 'refuse', checkout: '/other' },
  },
  {
    name: 'a null terminal in a version 2 record',
    facts: { ...terminalFacts, record: savedOwner({ ...owner, terminal: null }) },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a null terminal in a version 1 record',
    facts: { ...terminalFacts, record: version1Record(null) },
    expected: { kind: 'refuse', checkout: '/checkout' },
  },
  {
    name: 'a different token in this checkout',
    facts: { ...terminalFacts, record: savedOwner({ ...owner, lockToken: 'previous' }) },
    expected: { kind: 'starting' },
  },
  {
    name: 'a different token with no terminal',
    facts: {
      ...terminalFacts,
      record: savedOwner({ ...owner, lockToken: 'previous', terminal: null }),
    },
    expected: { kind: 'starting' },
  },
  {
    name: 'a different token in another checkout',
    facts: {
      ...terminalFacts,
      holder: { ...holder, checkout: '/other' },
      record: savedOwner({ ...owner, lockToken: 'previous' }),
    },
    expected: { kind: 'refuse', checkout: '/other' },
  },
  {
    name: 'a kept claim in this checkout',
    facts: {
      ...terminalFacts,
      keptClaim: true,
      record: savedOwner({ ...owner, lockToken: 'previous' }),
    },
    expected: { kind: 'keptClaim' },
  },
  {
    name: 'a kept claim whose record names the holder',
    facts: { ...terminalFacts, keptClaim: true },
    expected: { kind: 'lookup', terminal: 't-architect' },
  },
  {
    name: 'a kept claim in another checkout',
    facts: {
      ...terminalFacts,
      keptClaim: true,
      holder: { ...holder, checkout: '/other' },
      record: savedOwner({ ...owner, lockToken: 'previous' }),
    },
    expected: { kind: 'refuse', checkout: '/other' },
  },
])('terminal: $name', ({ facts, expected }) => {
  expect(openTerminal(facts)).toEqual(expected);
});
