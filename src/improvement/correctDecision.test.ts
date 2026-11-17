import { expect, it } from 'vitest';

import { classEventId } from './classIdentity.ts';
import type { ClassLevel, CorrectMeasures, ProposedClass, RankedClass } from './correctDecision.ts';
import { decideClasses, decideMeasures } from './correctDecision.ts';
import type { ImprovementEvent } from './event.ts';

type ClassEvent = Extract<ImprovementEvent, { kind: 'class' }>;

type DecisionEvent = Extract<ImprovementEvent, { kind: 'decision' }>;

type FactsEvent = Extract<ImprovementEvent, { kind: 'facts' }>;

const proposed = (overrides: Partial<ProposedClass> = {}): ProposedClass => ({
  identity: 'lint-await',
  level: 'lint',
  summary: 'The await keyword was missing before an async call.',
  occurrences: ['occurrence-1', 'occurrence-2'],
  reverted: false,
  qaMiss: false,
  ...overrides,
});

const ranked = (input: ProposedClass): RankedClass => ({
  ...input,
  id: classEventId(input.identity, input.occurrences),
  repeatCount: new Set(input.occurrences).size,
});

const classTable: {
  name: string;
  classes: ProposedClass[];
  rejected?: string[];
  expected: RankedClass[];
}[] = [
  {
    name: 'counts a class at two distinct occurrences',
    classes: [proposed()],
    expected: [ranked(proposed())],
  },
  {
    name: 'does not count a class at one occurrence',
    classes: [proposed({ occurrences: ['occurrence-1'] })],
    expected: [],
  },
  {
    name: 'counts a class at one revert or one QA miss',
    classes: [
      proposed({ identity: 'test-revert', occurrences: ['occurrence-1'], reverted: true }),
      proposed({ identity: 'prose-qa', occurrences: ['occurrence-1'], qaMiss: true }),
    ],
    expected: [
      ranked(proposed({ identity: 'prose-qa', occurrences: ['occurrence-1'], qaMiss: true })),
      ranked(proposed({ identity: 'test-revert', occurrences: ['occurrence-1'], reverted: true })),
    ],
  },
  {
    name: 'counts distinct occurrences once',
    classes: [proposed({ occurrences: ['a', 'a'] })],
    expected: [],
  },
  {
    name: 'skips a rejected class with the same occurrences',
    classes: [proposed()],
    rejected: [classEventId('lint-await', ['occurrence-1', 'occurrence-2'])],
    expected: [],
  },
  {
    name: 'proposes a rejected class again with a new occurrence',
    classes: [proposed({ occurrences: ['a', 'b', 'c'] })],
    rejected: [classEventId('lint-await', ['a', 'b'])],
    expected: [ranked(proposed({ occurrences: ['a', 'b', 'c'] }))],
  },
  {
    name: 'ranks by repeat count and then identity',
    classes: [
      proposed({ identity: 'lint-b', occurrences: ['a', 'b'] }),
      proposed({ identity: 'lint-a', occurrences: ['a', 'b'] }),
      proposed({ identity: 'lint-c', occurrences: ['a', 'b', 'c'] }),
    ],
    expected: [
      ranked(proposed({ identity: 'lint-c', occurrences: ['a', 'b', 'c'] })),
      ranked(proposed({ identity: 'lint-a', occurrences: ['a', 'b'] })),
      ranked(proposed({ identity: 'lint-b', occurrences: ['a', 'b'] })),
    ],
  },
  {
    name: 'shows at most five classes',
    classes: ['a', 'b', 'c', 'd', 'e', 'f'].map((identity) =>
      proposed({ identity: `lint-${identity}`, occurrences: ['a', 'b'] }),
    ),
    expected: ['a', 'b', 'c', 'd', 'e'].map((identity) =>
      ranked(proposed({ identity: `lint-${identity}`, occurrences: ['a', 'b'] })),
    ),
  },
  {
    name: 'keeps one class when two proposals share an ID',
    classes: [proposed(), proposed()],
    expected: [ranked(proposed())],
  },
];

it.each(classTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideClasses({ classes: row.classes, rejected: new Set(row.rejected) })).toStrictEqual(
    row.expected,
  );
});

const classEvent = (
  overrides: {
    id?: string;
    identity?: string;
    occurrences?: string[];
    createdAt?: string;
    level?: ClassLevel;
  } = {},
): ClassEvent => {
  const identity = overrides.identity ?? 'lint-await';
  const occurrences = overrides.occurrences ?? ['occurrence-1'];

  return {
    version: 2,
    id: overrides.id ?? classEventId(identity, occurrences),
    kind: 'class',
    createdAt: overrides.createdAt ?? '2026-11-15T12:00:00.000Z',
    evidence: [],
    identity,
    level: overrides.level ?? 'lint',
    summary: 'The await keyword was missing before an async call.',
    occurrences,
  };
};

const decisionEvent = (overrides: {
  id?: string;
  subject: string;
  choice: 'approved' | 'rejected' | 'redirected';
  createdAt?: string;
}): DecisionEvent => ({
  version: 2,
  id: overrides.id ?? 'decision-1',
  kind: 'decision',
  createdAt: overrides.createdAt ?? '2026-11-15T12:00:00.000Z',
  evidence: [],
  subject: overrides.subject,
  choice: overrides.choice,
});

const factsEvent = (overrides: {
  id?: string;
  facts?: Record<string, number>;
  createdAt?: string;
}): FactsEvent => ({
  version: 2,
  id: overrides.id ?? 'facts-1',
  kind: 'facts',
  createdAt: overrides.createdAt ?? '2026-11-15T12:00:00.000Z',
  evidence: [],
  pullRequest: 'https://github.com/sQVe/tau/pull/562',
  facts: overrides.facts ?? {},
  coverage: 'complete',
});

const noMeasures: CorrectMeasures = {
  repeatRateAfterCheck: { value: undefined, coverage: 0 },
  medianFixRounds: { value: undefined, coverage: 0 },
  acceptanceRate: { value: undefined, coverage: 0 },
};

const repeatedClassA = classEvent({ id: 'class-a', identity: 'lint-a' });
const repeatedClassB = classEvent({ id: 'class-b', identity: 'lint-b' });

const approvedA = decisionEvent({
  id: 'decision-a',
  subject: 'class-a',
  choice: 'approved',
  createdAt: '2026-11-15T12:01:00.000Z',
});

const approvedB = decisionEvent({
  id: 'decision-b',
  subject: 'class-b',
  choice: 'approved',
  createdAt: '2026-11-15T12:01:00.000Z',
});

const repeatTable: {
  name: string;
  classes: ClassEvent[];
  decisions: DecisionEvent[];
  expected: number | undefined;
  coverage: number;
}[] = [
  {
    name: 'measures the repeat rate after a check',
    classes: [
      repeatedClassA,
      repeatedClassB,
      classEvent({
        id: 'class-a-repeat',
        identity: 'lint-a',
        createdAt: '2026-11-15T12:02:00.000Z',
      }),
    ],
    decisions: [approvedA, approvedB],
    expected: 0.5,
    coverage: 2,
  },
  {
    name: 'does not count a recurrence before the approval',
    classes: [
      repeatedClassA,
      classEvent({
        id: 'class-a-earlier',
        identity: 'lint-a',
        createdAt: '2026-11-15T11:59:00.000Z',
      }),
    ],
    decisions: [approvedA],
    expected: 0,
    coverage: 1,
  },
  {
    name: 'does not count a class with another identity after the approval',
    classes: [
      repeatedClassA,
      classEvent({
        id: 'class-b-later',
        identity: 'lint-b',
        createdAt: '2026-11-15T12:02:00.000Z',
      }),
    ],
    decisions: [approvedA],
    expected: 0,
    coverage: 1,
  },
  {
    name: 'does not count a class at the approval timestamp',
    classes: [
      repeatedClassA,
      classEvent({
        id: 'class-a-same-time',
        identity: 'lint-a',
        createdAt: '2026-11-15T12:01:00.000Z',
      }),
    ],
    decisions: [approvedA],
    expected: 0,
    coverage: 1,
  },
  {
    name: 'has no repeat rate without an approved class',
    classes: [],
    decisions: [],
    expected: undefined,
    coverage: 0,
  },
];

it.each(repeatTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  const measures = decideMeasures({
    classes: row.classes,
    decisions: row.decisions,
    factsEvents: [],
  });

  expect(measures.repeatRateAfterCheck).toStrictEqual({
    value: row.expected,
    coverage: row.coverage,
  });
});

const fixTable: {
  name: string;
  factsEvents: FactsEvent[];
  expected: number | undefined;
  coverage: number;
}[] = [
  {
    name: 'measures the median fix rounds',
    factsEvents: [
      factsEvent({ id: 'facts-1', facts: { fixCaptures: 1 } }),
      factsEvent({ id: 'facts-2', facts: { fixCaptures: 2 } }),
      factsEvent({ id: 'facts-3', facts: { fixCaptures: 3 } }),
    ],
    expected: 2,
    coverage: 3,
  },
  {
    name: 'measures an even median',
    factsEvents: [
      factsEvent({ id: 'facts-1', facts: { fixCaptures: 1 } }),
      factsEvent({ id: 'facts-2', facts: { fixCaptures: 2 } }),
      factsEvent({ id: 'facts-3', facts: { fixCaptures: 3 } }),
      factsEvent({ id: 'facts-4', facts: { fixCaptures: 4 } }),
    ],
    expected: 2.5,
    coverage: 4,
  },
  {
    name: 'skips a facts event without a fix count',
    factsEvents: [
      factsEvent({ id: 'facts-1', facts: { fixCaptures: 2 } }),
      factsEvent({ id: 'facts-2', facts: {} }),
    ],
    expected: 2,
    coverage: 1,
  },
  {
    name: 'has no median fix rounds without a fix count',
    factsEvents: [factsEvent({ id: 'facts-1', facts: {} })],
    expected: undefined,
    coverage: 0,
  },
];

it.each(fixTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  const measures = decideMeasures({ classes: [], decisions: [], factsEvents: row.factsEvents });

  expect(measures.medianFixRounds).toStrictEqual({ value: row.expected, coverage: row.coverage });
});

const acceptanceTable: {
  name: string;
  classes: ClassEvent[];
  decisions: DecisionEvent[];
  expected: number | undefined;
  coverage: number;
}[] = [
  {
    name: 'measures the acceptance rate',
    classes: [repeatedClassA, repeatedClassB, classEvent({ id: 'class-c', identity: 'lint-c' })],
    decisions: [
      approvedA,
      approvedB,
      decisionEvent({ id: 'decision-c', subject: 'class-c', choice: 'rejected' }),
    ],
    expected: 2 / 3,
    coverage: 3,
  },
  {
    name: 'counts a redirected decision in the acceptance rate',
    classes: [repeatedClassA, repeatedClassB],
    decisions: [
      approvedA,
      decisionEvent({ id: 'decision-b', subject: 'class-b', choice: 'redirected' }),
    ],
    expected: 0.5,
    coverage: 2,
  },
  {
    name: 'uses the latest decision for one subject',
    classes: [repeatedClassA],
    decisions: [
      decisionEvent({
        id: 'decision-rejected',
        subject: 'class-a',
        choice: 'rejected',
        createdAt: '2026-11-15T12:01:00.000Z',
      }),
      decisionEvent({
        id: 'decision-approved',
        subject: 'class-a',
        choice: 'approved',
        createdAt: '2026-11-15T12:02:00.000Z',
      }),
    ],
    expected: 1,
    coverage: 1,
  },
  {
    name: 'uses the higher ID when two decisions share a timestamp',
    classes: [repeatedClassA],
    decisions: [
      decisionEvent({
        id: 'decision-a',
        subject: 'class-a',
        choice: 'rejected',
        createdAt: '2026-11-15T12:01:00.000Z',
      }),
      decisionEvent({
        id: 'decision-b',
        subject: 'class-a',
        choice: 'approved',
        createdAt: '2026-11-15T12:01:00.000Z',
      }),
    ],
    expected: 1,
    coverage: 1,
  },
  {
    name: 'keeps the first decision when two share an ID and a timestamp',
    classes: [repeatedClassA],
    decisions: [
      decisionEvent({
        id: 'decision-a',
        subject: 'class-a',
        choice: 'approved',
        createdAt: '2026-11-15T12:01:00.000Z',
      }),
      decisionEvent({
        id: 'decision-a',
        subject: 'class-a',
        choice: 'rejected',
        createdAt: '2026-11-15T12:01:00.000Z',
      }),
    ],
    expected: 1,
    coverage: 1,
  },
  {
    name: 'has no acceptance rate without class decisions',
    classes: [repeatedClassA],
    decisions: [
      decisionEvent({ id: 'decision-other', subject: 'class-other', choice: 'approved' }),
    ],
    expected: undefined,
    coverage: 0,
  },
];

it.each(acceptanceTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  const measures = decideMeasures({
    classes: row.classes,
    decisions: row.decisions,
    factsEvents: [],
  });

  expect(measures.acceptanceRate).toStrictEqual({ value: row.expected, coverage: row.coverage });
});

it('reports no measures without records', () => {
  expect(decideMeasures({ classes: [], decisions: [], factsEvents: [] })).toStrictEqual(noMeasures);
});
