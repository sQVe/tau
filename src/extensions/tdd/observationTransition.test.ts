import { expect, it } from 'vitest';

import {
  checkpoint,
  checkpointNeedsInputHash,
  compareInputs,
  completeRun,
  identity,
  startRun,
} from './observationTransition.js';
import type {
  CycleState,
  CycleTransition,
  LatestRun,
  RunCompletedFacts,
} from './observationTransition.js';

const behavior = { behavior: 'value', testFullName: 'value works', files: ['value.test.ts'] };
const otherBehavior = { behavior: 'other', testFullName: 'other works', files: ['other.test.ts'] };

const key = identity(behavior);
const otherKey = identity(otherBehavior);

const state = (saved: Partial<CycleState> = {}): CycleState => ({
  active: null,
  observedRed: false,
  latest: null,
  shownHints: new Set(),
  staleHintInput: null,
  ...saved,
});

const run = (saved: Partial<LatestRun> = {}): LatestRun => ({
  behavior,
  scope: 'focused',
  kind: 'pass',
  fingerprint: 'hash-after',
  freshness: 'fresh',
  ...saved,
});

const facts = (saved: Partial<RunCompletedFacts> = {}): RunCompletedFacts => ({
  behavior,
  scope: 'focused',
  kind: 'pass',
  fingerprint: 'hash-after',
  freshness: 'fresh',
  selectionFailed: false,
  thrownErrorType: null,
  ...saved,
});

const stateSummary = (cycle: CycleState) => ({
  active: cycle.active,
  observedRed: cycle.observedRed,
  hints: [...cycle.shownHints].toSorted(),
  staleHintInput: cycle.staleHintInput,
});

const summary = (transition: CycleTransition) => ({
  active: transition.state.active,
  observedRed: transition.state.observedRed,
  hints: [...transition.state.shownHints].toSorted(),
  staleHintInput: transition.state.staleHintInput,
  freshness: transition.state.latest?.freshness,
  hint: transition.hint?.kind,
  errorType: transition.hint?.errorType,
});

it('does not mutate the previous cycle state or its hint set', () => {
  const before = state({ active: key, observedRed: true, shownHints: new Set(['stale']) });
  const snapshot = { ...before, shownHints: [...before.shownHints].toSorted() };

  completeRun(before, facts({ kind: 'fail', selectionFailed: true, thrownErrorType: 'TypeError' }));
  checkpoint(before, { kind: 'value', hash: 'hash-new' }, true);
  startRun(before, otherBehavior);

  expect({ ...before, shownHints: [...before.shownHints].toSorted() }).toEqual(snapshot);
});

it.each([
  {
    name: 'a fresh focused pass',
    start: state({ active: key }),
    facts: facts(),
    expected: { observedRed: false, freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a fresh focused selection failure',
    start: state({ active: key }),
    facts: facts({ kind: 'fail', selectionFailed: true }),
    expected: { observedRed: true, hints: [], hint: undefined },
  },
  {
    name: 'a fresh focused selection failure from a thrown error',
    start: state({ active: key }),
    facts: facts({ kind: 'fail', selectionFailed: true, thrownErrorType: 'TypeError' }),
    expected: { observedRed: true, hint: 'thrown', errorType: 'TypeError', staleHintInput: null },
  },
  {
    name: 'a fresh focused selection failure from a failed assertion',
    start: state({ active: key }),
    facts: facts({ kind: 'fail', selectionFailed: true }),
    expected: { observedRed: true, hint: undefined },
  },
  {
    name: 'a stale focused pass',
    start: state({ active: key }),
    facts: facts({ freshness: 'stale' }),
    expected: {
      observedRed: false,
      freshness: 'stale',
      hint: 'stale',
      staleHintInput: 'hash-after',
    },
  },
  {
    name: 'an unknown focused pass',
    start: state({ active: key }),
    facts: facts({ freshness: 'unknown' }),
    expected: { freshness: 'unknown', hint: 'unknown', staleHintInput: 'hash-after' },
  },
  {
    name: 'a stale focused pass whose stale hint was already shown',
    start: state({ active: key, latest: run(), shownHints: new Set(['stale']) }),
    facts: facts({ freshness: 'stale' }),
    expected: { hint: undefined },
  },
  {
    name: 'a stale focused selection failure',
    start: state({ active: key }),
    facts: facts({ kind: 'fail', freshness: 'stale', selectionFailed: true }),
    expected: { observedRed: false, freshness: 'stale', hint: 'stale' },
  },
  {
    name: 'a fresh full pass',
    start: state({ active: key, observedRed: true, shownHints: new Set(['red']) }),
    facts: facts({ scope: 'full' }),
    expected: { active: null, observedRed: false, hints: [], freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a fresh full failure',
    start: state({ active: key }),
    facts: facts({ scope: 'full', kind: 'fail', selectionFailed: true }),
    expected: { observedRed: false, freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a fresh full failure after observed RED',
    start: state({ active: key, observedRed: true }),
    facts: facts({ scope: 'full', kind: 'fail' }),
    expected: { observedRed: true, freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a fresh focused selection failure after an earlier RED hint',
    start: state({ active: key, shownHints: new Set(['red']), latest: run() }),
    facts: facts({ kind: 'fail', selectionFailed: true }),
    expected: { observedRed: true, hints: [], hint: undefined },
  },
  {
    name: 'a fresh focused selection failure when RED was already observed',
    start: state({ active: key, observedRed: true, shownHints: new Set(['red']), latest: run() }),
    facts: facts({ kind: 'fail', selectionFailed: true }),
    expected: { observedRed: true, hints: ['red'], hint: undefined },
  },
  {
    name: 'a fresh focused pass after a stale previous run',
    start: state({ active: key, shownHints: new Set(['stale']) }),
    facts: facts(),
    expected: { hints: [], freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a fresh focused pass after observed RED',
    start: state({ active: key, observedRed: true }),
    facts: facts(),
    expected: { observedRed: true, hint: undefined },
  },
  {
    name: 'a stale run whose stale hint was replaced by a RED hint',
    start: state({ active: key, shownHints: new Set(['red']) }),
    facts: facts({ freshness: 'stale' }),
    expected: { freshness: 'stale', hint: 'stale', staleHintInput: 'hash-after' },
  },
  {
    name: 'a thrown hint that was already shown',
    start: state({
      active: key,
      observedRed: true,
      shownHints: new Set(['thrown']),
      latest: run(),
    }),
    facts: facts({ kind: 'fail', selectionFailed: true, thrownErrorType: 'TypeError' }),
    expected: { observedRed: true, hint: undefined },
  },
] as const)('completes $name', ({ start, facts: runFacts, expected }) => {
  const transition = completeRun(start, runFacts);

  expect(summary(transition)).toMatchObject(expected);
});

it.each([
  'timeout',
  'cancelled',
  'compile-error',
  'runner-missing',
  'runner-resolution-error',
] as const)('keeps RED through a fresh focused %s after observed RED', (kind) => {
  const transition = completeRun(
    state({ active: key, observedRed: true, latest: run() }),
    facts({ kind }),
  );

  expect(summary(transition)).toMatchObject({
    observedRed: true,
    freshness: 'fresh',
    hint: undefined,
  });
});

it.each([
  'timeout',
  'cancelled',
  'compile-error',
  'runner-missing',
  'runner-resolution-error',
] as const)('keeps RED through an unknown focused %s after observed RED', (kind) => {
  const transition = completeRun(
    state({ active: key, observedRed: true, latest: run() }),
    facts({ kind, freshness: 'unknown' }),
  );

  expect(summary(transition)).toMatchObject({
    observedRed: true,
    freshness: 'unknown',
    hint: 'unknown',
    staleHintInput: 'hash-after',
  });
});

it.each([
  {
    name: 'a first edit without any run',
    start: state(),
    input: { kind: 'skipped' } as const,
    productionEdit: true,
    expected: { hints: ['red'], hint: 'red' },
  },
  {
    name: 'a non-production checkpoint without any run',
    start: state(),
    input: { kind: 'skipped' } as const,
    productionEdit: false,
    expected: { hint: undefined },
  },
  {
    name: 'a matching hash after a fresh full pass',
    start: state({ active: null, latest: run({ scope: 'full' }) }),
    input: { kind: 'value', hash: 'hash-after' } as const,
    productionEdit: true,
    expected: { freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a changed hash after a fresh focused pass',
    start: state({ active: key, latest: run() }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: 'stale', staleHintInput: 'hash-new' },
  },
  {
    name: 'a matching hash after a fresh focused pass',
    start: state({ active: key, latest: run() }),
    input: { kind: 'value', hash: 'hash-after' } as const,
    productionEdit: true,
    expected: { freshness: 'fresh', hint: 'red' },
  },
  {
    name: 'a matching hash that recovers an unknown full pass',
    start: state({ active: null, latest: run({ scope: 'full', freshness: 'unknown' }) }),
    input: { kind: 'value', hash: 'hash-after' } as const,
    productionEdit: true,
    expected: { freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a matching hash that does not revive a stale run',
    start: state({
      active: key,
      latest: run({ freshness: 'stale' }),
      shownHints: new Set(['stale']),
      staleHintInput: 'hash-after',
    }),
    input: { kind: 'value', hash: 'hash-after' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: undefined },
  },
  {
    name: 'an unreadable hash after a fresh run',
    start: state({ active: key, latest: run() }),
    input: { kind: 'unavailable' } as const,
    productionEdit: true,
    expected: { freshness: 'unknown', hint: 'unknown', staleHintInput: null },
  },
  {
    name: 'an unreadable hash after observed RED',
    start: state({ active: key, observedRed: true, latest: run({ kind: 'fail' }) }),
    input: { kind: 'unavailable' } as const,
    productionEdit: true,
    expected: { freshness: 'unknown', hint: 'unknown' },
  },
  {
    name: 'an unreadable hash after an unknown run',
    start: state({
      active: key,
      latest: run({ freshness: 'unknown' }),
      shownHints: new Set(['unknown']),
      staleHintInput: 'hash-after',
    }),
    input: { kind: 'unavailable' } as const,
    productionEdit: true,
    expected: { freshness: 'unknown', hint: undefined },
  },
  {
    name: 'a skipped hash when a matching fingerprint is unknown',
    start: state({
      active: key,
      latest: run({ freshness: 'unknown', fingerprint: null }),
      shownHints: new Set(['unknown']),
    }),
    input: { kind: 'skipped' } as const,
    productionEdit: true,
    expected: { freshness: 'unknown', hint: undefined },
  },
  {
    name: 'an implementation edit after observed focused RED',
    start: state({ active: key, observedRed: true, latest: run({ freshness: 'stale' }) }),
    input: { kind: 'skipped' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: undefined },
  },
  {
    name: 'a changed hash during implementation after observed focused RED',
    start: state({ active: key, observedRed: true, latest: run({ freshness: 'stale' }) }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: undefined },
  },
  {
    name: 'a later input change after a stale hint',
    start: state({
      active: key,
      latest: run({ freshness: 'stale' }),
      shownHints: new Set(['stale']),
      staleHintInput: 'hash-old',
    }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: 'red', staleHintInput: 'hash-old' },
  },
  {
    name: 'a repeated input after a stale hint',
    start: state({
      active: key,
      latest: run({ freshness: 'stale' }),
      shownHints: new Set(['stale']),
      staleHintInput: 'hash-new',
    }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: undefined },
  },
  {
    name: 'an earlier input state after an unknown run',
    start: state({
      active: key,
      latest: run({ freshness: 'unknown', fingerprint: 'hash-second' }),
      shownHints: new Set(['stale', 'unknown']),
      staleHintInput: 'hash-second',
    }),
    input: { kind: 'value', hash: 'hash-first' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: 'red' },
  },
  {
    name: 'a changed hash after a full pass',
    start: state({ active: null, latest: run({ scope: 'full' }) }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: 'stale' },
  },
  {
    name: 'a changed hash after a failing full run',
    start: state({ active: key, latest: run({ scope: 'full', kind: 'fail' }) }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: 'stale' },
  },
  {
    name: 'a matching hash after a failing full run',
    start: state({ active: key, latest: run({ scope: 'full', kind: 'fail' }) }),
    input: { kind: 'value', hash: 'hash-after' } as const,
    productionEdit: true,
    expected: { freshness: 'fresh', hint: 'red' },
  },
  {
    name: 'a changed hash without a production edit',
    start: state({ active: key, latest: run() }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: false,
    expected: { freshness: 'stale', hint: undefined },
  },
  {
    name: 'a repeated edit after the RED hint was shown',
    start: state({ active: key, shownHints: new Set(['red']) }),
    input: { kind: 'skipped' } as const,
    productionEdit: true,
    expected: { hint: undefined },
  },
  {
    name: 'a skipped hash on a fresh focused pass',
    start: state({ active: key, latest: run() }),
    input: { kind: 'skipped' } as const,
    productionEdit: false,
    expected: { freshness: 'fresh', hint: undefined },
  },
  {
    name: 'a skipped hash on a stale full run after observed RED',
    start: state({
      active: key,
      observedRed: true,
      latest: run({ scope: 'full', freshness: 'stale' }),
    }),
    input: { kind: 'skipped' } as const,
    productionEdit: true,
    expected: { freshness: 'stale', hint: 'stale' },
  },
  {
    name: 'a valued hash when the latest fingerprint is unknown',
    start: state({
      active: key,
      latest: run({ freshness: 'unknown', fingerprint: null }),
      shownHints: new Set(['unknown']),
    }),
    input: { kind: 'value', hash: 'hash-new' } as const,
    productionEdit: true,
    expected: { freshness: 'unknown', hint: undefined },
  },
  {
    name: 'a fresh focused pass after observed RED',
    start: state({ active: key, observedRed: true, latest: run() }),
    input: { kind: 'value', hash: 'hash-after' } as const,
    productionEdit: true,
    expected: { hint: undefined },
  },
  {
    name: 'an unreadable hash after a stale run',
    start: state({ active: key, latest: run({ freshness: 'stale' }) }),
    input: { kind: 'unavailable' } as const,
    productionEdit: true,
    expected: { freshness: 'stale' },
  },
] as const)('checkpoints through $name', ({ start, input, productionEdit, expected }) => {
  const transition = checkpoint(start, input, productionEdit);

  expect(summary(transition)).toMatchObject(expected);
});

it.each([
  [
    'a stale full pass through an unavailable hash and a matching hash',
    state({ active: null, latest: run({ scope: 'full', freshness: 'stale' }) }),
  ],
] as const)('%s stays stale', (_name, stale) => {
  const unavailable = checkpoint(stale, { kind: 'unavailable' }, true);
  const matching = checkpoint(unavailable.state, { kind: 'value', hash: 'hash-after' }, true);

  expect(summary(unavailable)).toMatchObject({ freshness: 'stale' });
  expect(summary(matching)).toMatchObject({ freshness: 'stale' });
  expect(matching.hint).toBeDefined();
});

it.each([
  {
    name: 'a different behavior that matches the latest idle run',
    start: state({
      active: otherKey,
      observedRed: true,
      shownHints: new Set(['stale']),
      staleHintInput: 'hash',
      latest: run(),
    }),
    expected: { active: key, observedRed: false, hints: [], staleHintInput: 'hash' },
  },
  {
    name: 'the same active behavior',
    start: state({
      active: key,
      observedRed: true,
      shownHints: new Set(['red']),
      staleHintInput: 'hash',
    }),
    expected: { active: key, observedRed: true, hints: ['red'], staleHintInput: 'hash' },
  },
  {
    name: 'the behavior of the latest run while idle',
    start: state({
      active: null,
      observedRed: true,
      shownHints: new Set(['stale']),
      staleHintInput: 'hash',
      latest: run(),
    }),
    expected: { active: key, observedRed: true, hints: ['stale'], staleHintInput: 'hash' },
  },
  {
    name: 'a different behavior than the latest run',
    start: state({
      active: null,
      observedRed: true,
      shownHints: new Set(['stale']),
      staleHintInput: 'hash',
      latest: run({ behavior: otherBehavior }),
    }),
    expected: { active: key, observedRed: false, hints: [], staleHintInput: 'hash' },
  },
] as const)('starts a run of $name', ({ start, expected }) => {
  expect(stateSummary(startRun(start, behavior))).toMatchObject(expected);
});

it.each([
  ['no latest run', state(), false],
  ['a latest run without a fingerprint', state({ latest: run({ fingerprint: null }) }), false],
  ['a fresh latest run', state({ latest: run() }), true],
  ['a fresh latest run after observed RED', state({ observedRed: true, latest: run() }), true],
  ['an unknown latest run', state({ latest: run({ freshness: 'unknown' }) }), true],
  ['a stale run that can still suggest RED', state({ latest: run({ freshness: 'stale' }) }), true],
  [
    'a stale run after observed RED',
    state({ observedRed: true, latest: run({ freshness: 'stale' }) }),
    false,
  ],
  [
    'a stale run after the RED hint',
    state({ shownHints: new Set(['red']), latest: run({ freshness: 'stale' }) }),
    false,
  ],
] as const)('decides whether %s must hash inputs', (_name, before, expected) => {
  expect(checkpointNeedsInputHash(before)).toBe(expected);
});

it.each([
  [null, null, 'unknown'],
  [null, 'after', 'unknown'],
  ['before', null, 'unknown'],
  ['same', 'same', 'fresh'],
  ['before', 'after', 'stale'],
] as const)('compares %s and %s as %s', (before, after, expected) => {
  expect(compareInputs(before, after)).toBe(expected);
});
