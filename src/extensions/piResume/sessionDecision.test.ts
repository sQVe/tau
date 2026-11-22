import { expect, it } from 'vitest';

import { shouldClearLabels, shouldLabelSession, shouldReadTerminal } from './sessionDecision.js';
import type { StartFacts } from './sessionDecision.js';

const facts = (changes: Partial<StartFacts> = {}): StartFacts => ({
  interactive: true,
  terminalId: 't7',
  owner: true,
  sessionFile: '/sessions/a.jsonl',
  signalReceived: false,
  ...changes,
});

it.each([
  {
    name: 'reads the terminal for an interactive Pi with an hc address',
    facts: { interactive: true, terminalId: 't7' },
    read: true,
  },
  {
    name: 'skips the terminal read for a non-interactive Pi',
    facts: { interactive: false, terminalId: 't7' },
    read: false,
  },
  {
    name: 'skips the terminal read without an hc address',
    facts: { interactive: true, terminalId: undefined },
    read: false,
  },
])('$name', ({ facts: input, read }) => {
  expect(shouldReadTerminal(input)).toBe(read);
});

it.each([
  {
    name: 'labels the session when the interactive Pi owns the terminal',
    facts: facts(),
    label: true,
  },
  {
    name: 'skips a non-interactive Pi',
    facts: facts({ interactive: false }),
    label: false,
  },
  {
    name: 'skips a Pi without a terminal id',
    facts: facts({ terminalId: undefined }),
    label: false,
  },
  {
    name: 'skips a Pi that does not own the terminal',
    facts: facts({ owner: false }),
    label: false,
  },
  {
    name: 'skips a Pi without a session file',
    facts: facts({ sessionFile: undefined }),
    label: false,
  },
  {
    name: 'skips a Pi after a termination signal arrived',
    facts: facts({ signalReceived: true }),
    label: false,
  },
])('$name', ({ facts: input, label }) => {
  expect(shouldLabelSession(input)).toBe(label);
});

it.each([
  { name: 'clears labels on a quit without a signal', signalReceived: false, clear: true },
  { name: 'keeps labels after SIGTERM', signalReceived: true, clear: false },
])('$name', ({ signalReceived, clear }) => {
  expect(shouldClearLabels({ signalReceived })).toBe(clear);
});
