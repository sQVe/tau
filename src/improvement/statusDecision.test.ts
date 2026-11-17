import { expect, it } from 'vitest';

import type { ImprovementEvent } from './event.ts';
import { decideCorrectDue, decideSweep, decideTasks, statusText } from './statusDecision.ts';
import type { CoverageCounts, ImprovementStatus, TaskToReview } from './statusDecision.ts';
import type { SweepOutcome } from './sweep.ts';
import type { SweepIndex, SweepIndexRead } from './sweepIndex.ts';

const pullRequestA = 'https://github.com/sQVe/tau/pull/562';
const pullRequestB = 'https://github.com/sQVe/tau/pull/564';

const pullRequestEvidence = (url: string): { kind: 'pullRequest'; url: string }[] => [
  { kind: 'pullRequest', url },
];

const merge = (
  overrides: {
    id?: string;
    pullRequest?: string;
    mergedAt?: string;
    createdAt?: string;
  } = {},
): ImprovementEvent => {
  const pullRequest = overrides.pullRequest ?? pullRequestA;

  return {
    version: 2,
    id: overrides.id ?? 'merge-562',
    kind: 'merge',
    createdAt: overrides.createdAt ?? '2026-11-15T12:00:00.000Z',
    evidence: pullRequestEvidence(pullRequest),
    repository: 'github.com/sQVe/tau',
    pullRequest,
    mergedAt: overrides.mergedAt ?? '2026-11-15T11:58:00.000Z',
  };
};

const facts = (
  overrides: {
    id?: string;
    pullRequest?: string;
    counts?: Record<string, number>;
    coverage?: 'complete' | 'managerOnly' | 'missing';
    createdAt?: string;
  } = {},
): ImprovementEvent => {
  const pullRequest = overrides.pullRequest ?? pullRequestA;

  return {
    version: 2,
    id: overrides.id ?? 'facts-562',
    kind: 'facts',
    createdAt: overrides.createdAt ?? '2026-11-15T12:00:00.000Z',
    evidence: pullRequestEvidence(pullRequest),
    pullRequest,
    facts: overrides.counts ?? {},
    coverage: overrides.coverage ?? 'complete',
  };
};

const review = (
  overrides: { id?: string; pullRequest?: string; createdAt?: string } = {},
): ImprovementEvent => {
  const pullRequest = overrides.pullRequest ?? pullRequestA;

  return {
    version: 2,
    id: overrides.id ?? 'review-562',
    kind: 'review',
    createdAt: overrides.createdAt ?? '2026-11-15T12:05:00.000Z',
    evidence: pullRequestEvidence(pullRequest),
    pullRequest,
    outcome: 'approved',
  };
};

const correction = (createdAt: string, id = 'correction-1'): ImprovementEvent => ({
  version: 2,
  id,
  kind: 'correction',
  createdAt,
  evidence: [],
  summary: 'Run the focused tests first.',
  cwd: '/code/tau',
});

const decision = (): ImprovementEvent => ({
  version: 2,
  id: 'decision-1',
  kind: 'decision',
  createdAt: '2026-11-15T12:03:00.000Z',
  evidence: [],
  subject: 'correction-1',
  choice: 'approved',
});

const backlog = (): ImprovementEvent => ({
  version: 2,
  id: 'backlog-1',
  kind: 'backlog',
  createdAt: '2026-11-15T12:04:00.000Z',
  evidence: pullRequestEvidence(pullRequestA),
  summary: 'Review the repeated review rounds.',
  pullRequest: pullRequestA,
});

const reviews = (count: number, createdAt: string): ImprovementEvent[] =>
  Array.from({ length: count }, (_value, index) => review({ id: `review-${index}`, createdAt }));

const noCoverage: CoverageCounts = { complete: 0, managerOnly: 0, missing: 0 };

const taskTable: {
  name: string;
  events: ImprovementEvent[];
  expected: { tasks: TaskToReview[]; coverage: CoverageCounts };
}[] = [
  {
    name: 'reviews a merged task whose stored signal fires and that has no review',
    events: [merge(), facts({ counts: { reviewCaptures: 5 } })],
    expected: {
      tasks: [
        {
          pullRequest: pullRequestA,
          mergedAt: '2026-11-15T11:58:00.000Z',
          signals: ['reviewRounds'],
        },
      ],
      coverage: { complete: 1, managerOnly: 0, missing: 0 },
    },
  },
  {
    name: 'does not review a merged task that already has a review',
    events: [merge(), facts({ counts: { reviewCaptures: 5 } }), review()],
    expected: { tasks: [], coverage: { complete: 1, managerOnly: 0, missing: 0 } },
  },
  {
    name: 'does not review a merged task whose stored signals do not fire',
    events: [merge(), facts({ counts: { reviewCaptures: 4 } })],
    expected: { tasks: [], coverage: { complete: 1, managerOnly: 0, missing: 0 } },
  },
  {
    name: 'counts a merge without a facts event as missing coverage and does not review it',
    events: [merge()],
    expected: { tasks: [], coverage: { complete: 0, managerOnly: 0, missing: 1 } },
  },
  {
    name: 'counts complete and manager-only facts in their coverage',
    events: [
      merge(),
      facts({ counts: { reviewCaptures: 4 } }),
      merge({ id: 'merge-564', pullRequest: pullRequestB }),
      facts({
        id: 'facts-564',
        pullRequest: pullRequestB,
        counts: { reviewCaptures: 4 },
        coverage: 'managerOnly',
      }),
    ],
    expected: { tasks: [], coverage: { complete: 1, managerOnly: 1, missing: 0 } },
  },
  {
    name: 'uses the later facts event for one pull request',
    events: [
      merge(),
      facts({
        id: 'facts-earlier',
        counts: { reviewCaptures: 5 },
        createdAt: '2026-11-15T12:00:00.000Z',
      }),
      facts({
        id: 'facts-later',
        counts: { reviewCaptures: 4 },
        createdAt: '2026-11-15T13:00:00.000Z',
      }),
    ],
    expected: { tasks: [], coverage: { complete: 1, managerOnly: 0, missing: 0 } },
  },
  {
    name: 'uses the later facts event when its id is smaller and it comes first',
    events: [
      merge(),
      facts({
        id: 'facts-a',
        counts: { reviewCaptures: 4 },
        createdAt: '2026-11-15T13:00:00.000Z',
      }),
      facts({
        id: 'facts-z',
        counts: { reviewCaptures: 5 },
        createdAt: '2026-11-15T12:00:00.000Z',
      }),
    ],
    expected: { tasks: [], coverage: { complete: 1, managerOnly: 0, missing: 0 } },
  },
  {
    name: 'uses the later merge event and counts one pull request once',
    events: [
      merge({ id: 'merge-earlier', mergedAt: '2026-11-15T10:00:00.000Z' }),
      merge({ id: 'merge-later', mergedAt: '2026-11-15T12:00:00.000Z' }),
      facts({ counts: { reviewCaptures: 5 } }),
    ],
    expected: {
      tasks: [
        {
          pullRequest: pullRequestA,
          mergedAt: '2026-11-15T12:00:00.000Z',
          signals: ['reviewRounds'],
        },
      ],
      coverage: { complete: 1, managerOnly: 0, missing: 0 },
    },
  },
  {
    name: 'lists fired signals in review, feedback, and check order',
    events: [
      merge(),
      facts({ counts: { reviewCaptures: 5, feedbackRounds: 3, checkFailures: 2 } }),
    ],
    expected: {
      tasks: [
        {
          pullRequest: pullRequestA,
          mergedAt: '2026-11-15T11:58:00.000Z',
          signals: ['reviewRounds', 'feedbackRounds', 'checkFailures'],
        },
      ],
      coverage: { complete: 1, managerOnly: 0, missing: 0 },
    },
  },
  {
    name: 'sorts tasks by merged time and then pull request',
    events: [
      merge({ id: 'merge-564', pullRequest: pullRequestB, mergedAt: '2026-11-15T10:00:00.000Z' }),
      facts({ id: 'facts-564', pullRequest: pullRequestB, counts: { reviewCaptures: 5 } }),
      merge({ id: 'merge-562', pullRequest: pullRequestA, mergedAt: '2026-11-15T12:00:00.000Z' }),
      facts({ id: 'facts-562', pullRequest: pullRequestA, counts: { reviewCaptures: 5 } }),
    ],
    expected: {
      tasks: [
        {
          pullRequest: pullRequestB,
          mergedAt: '2026-11-15T10:00:00.000Z',
          signals: ['reviewRounds'],
        },
        {
          pullRequest: pullRequestA,
          mergedAt: '2026-11-15T12:00:00.000Z',
          signals: ['reviewRounds'],
        },
      ],
      coverage: { complete: 2, managerOnly: 0, missing: 0 },
    },
  },
  {
    name: 'uses the greater facts id when createdAt is equal',
    events: [
      merge(),
      facts({
        id: 'facts-a',
        counts: { reviewCaptures: 5 },
        createdAt: '2026-11-15T12:00:00.000Z',
      }),
      facts({
        id: 'facts-b',
        counts: { reviewCaptures: 4 },
        createdAt: '2026-11-15T12:00:00.000Z',
      }),
    ],
    expected: { tasks: [], coverage: { complete: 1, managerOnly: 0, missing: 0 } },
  },
  {
    name: 'sorts equal merged times by pull request from unsorted input',
    events: [
      merge({ id: 'merge-564', pullRequest: pullRequestB, mergedAt: '2026-11-15T12:00:00.000Z' }),
      facts({ id: 'facts-564', pullRequest: pullRequestB, counts: { reviewCaptures: 5 } }),
      merge({ id: 'merge-562', pullRequest: pullRequestA, mergedAt: '2026-11-15T12:00:00.000Z' }),
      facts({ id: 'facts-562', pullRequest: pullRequestA, counts: { reviewCaptures: 5 } }),
    ],
    expected: {
      tasks: [
        {
          pullRequest: pullRequestA,
          mergedAt: '2026-11-15T12:00:00.000Z',
          signals: ['reviewRounds'],
        },
        {
          pullRequest: pullRequestB,
          mergedAt: '2026-11-15T12:00:00.000Z',
          signals: ['reviewRounds'],
        },
      ],
      coverage: { complete: 2, managerOnly: 0, missing: 0 },
    },
  },
  {
    name: 'ignores correction, decision, and backlog events',
    events: [
      merge(),
      facts({ counts: { reviewCaptures: 5 } }),
      correction('2026-11-15T12:02:00.000Z'),
      decision(),
      backlog(),
    ],
    expected: {
      tasks: [
        {
          pullRequest: pullRequestA,
          mergedAt: '2026-11-15T11:58:00.000Z',
          signals: ['reviewRounds'],
        },
      ],
      coverage: { complete: 1, managerOnly: 0, missing: 0 },
    },
  },
  {
    name: 'makes no task from a facts event without a merge event',
    events: [facts({ counts: { reviewCaptures: 5 } })],
    expected: { tasks: [], coverage: noCoverage },
  },
];

it.each(taskTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideTasks(row.events)).toStrictEqual(row.expected);
});

const correctTable: {
  name: string;
  events: ImprovementEvent[];
  lastPassAt: string | undefined;
  now: Date;
  readFailed?: boolean;
  expected: boolean;
}[] = [
  {
    name: 'is due with no pass and one correction',
    events: [correction('2026-11-15T12:00:00.000Z')],
    lastPassAt: undefined,
    now: new Date('2026-11-15T13:00:00.000Z'),
    expected: true,
  },
  {
    name: 'is not due with no pass and no review or correction',
    events: [merge()],
    lastPassAt: undefined,
    now: new Date('2026-11-15T13:00:00.000Z'),
    expected: false,
  },
  {
    name: 'is due with five reviews after a pass one day ago',
    events: reviews(5, '2026-11-15T12:00:00.000Z'),
    lastPassAt: '2026-11-14T12:00:00.000Z',
    now: new Date('2026-11-15T13:00:00.000Z'),
    expected: true,
  },
  {
    name: 'is not due with four reviews after a pass one day ago',
    events: reviews(4, '2026-11-15T12:00:00.000Z'),
    lastPassAt: '2026-11-14T12:00:00.000Z',
    now: new Date('2026-11-15T13:00:00.000Z'),
    expected: false,
  },
  {
    name: 'is due with one correction seven days after the pass',
    events: [correction('2026-11-22T12:00:00.000Z')],
    lastPassAt: '2026-11-15T12:00:00.000Z',
    now: new Date('2026-11-22T13:00:00.000Z'),
    expected: true,
  },
  {
    name: 'is not due with one correction six days after the pass',
    events: [correction('2026-11-21T12:00:00.000Z')],
    lastPassAt: '2026-11-15T12:00:00.000Z',
    now: new Date('2026-11-21T13:00:00.000Z'),
    expected: false,
  },
  {
    name: 'ignores events created before the pass',
    events: [review({ createdAt: '2026-11-14T12:00:00.000Z' })],
    lastPassAt: '2026-11-15T12:00:00.000Z',
    now: new Date('2026-11-23T13:00:00.000Z'),
    expected: false,
  },
  {
    name: 'treats an event created exactly at the pass as old',
    events: [correction('2026-11-15T12:00:00.000Z')],
    lastPassAt: '2026-11-15T12:00:00.000Z',
    now: new Date('2026-11-23T13:00:00.000Z'),
    expected: false,
  },
  {
    name: 'is due exactly seven days after the pass with one correction',
    events: [correction('2026-11-22T12:00:00.000Z')],
    lastPassAt: '2026-11-15T12:00:00.000Z',
    now: new Date('2026-11-22T12:00:00.000Z'),
    expected: true,
  },
  {
    name: 'is not due with five corrections after a pass one day ago',
    events: Array.from({ length: 5 }, (_value, index) =>
      correction('2026-11-15T12:00:00.000Z', `correction-${index}`),
    ),
    lastPassAt: '2026-11-14T12:00:00.000Z',
    now: new Date('2026-11-15T13:00:00.000Z'),
    expected: false,
  },
  {
    name: 'is due when the event read failed, even after a recent pass',
    events: [],
    lastPassAt: '2026-11-14T12:00:00.000Z',
    now: new Date('2026-11-15T13:00:00.000Z'),
    readFailed: true,
    expected: true,
  },
];

it.each(correctTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  const dueFacts = {
    events: row.events,
    lastPassAt: row.lastPassAt,
    now: row.now,
    readFailed: row.readFailed ?? false,
  };

  expect(decideCorrectDue(dueFacts)).toBe(row.expected);
});

const projectRoot = '/code/tau';

const index = (overrides: Partial<SweepIndex> = {}): SweepIndex => ({
  version: 1,
  transcripts: {},
  projects: {},
  lastSweep: { startedAt: '2026-11-15T12:00:00.000Z', outcome: 'caughtUp' },
  ...overrides,
});

const readIndex = (overrides: Partial<SweepIndex> = {}): SweepIndexRead => ({
  status: 'read',
  index: index(overrides),
});

const sweepTable: {
  name: string;
  index: SweepIndexRead;
  projectRoot: string | null;
  sessionSweep?: SweepOutcome | undefined;
  expected: 'complete' | 'incomplete';
}[] = [
  {
    name: 'is complete with a caught-up sweep and a read project',
    index: readIndex({
      projects: {
        [projectRoot]: {
          repository: 'sqve/tau',
          merged: { status: 'read', at: '2026-11-15T12:00:00.000Z', count: 1 },
        },
      },
    }),
    projectRoot,
    expected: 'complete',
  },
  {
    name: 'is incomplete when the last sweep ran out of budget',
    index: readIndex({
      lastSweep: { startedAt: '2026-11-15T12:00:00.000Z', outcome: 'budget' },
    }),
    projectRoot,
    expected: 'incomplete',
  },
  {
    name: 'is incomplete when the last sweep failed',
    index: readIndex({
      lastSweep: { startedAt: '2026-11-15T12:00:00.000Z', outcome: 'failed' },
    }),
    projectRoot,
    expected: 'incomplete',
  },
  {
    name: 'is incomplete when no sweep has run',
    index: readIndex({ lastSweep: null }),
    projectRoot,
    expected: 'incomplete',
  },
  {
    name: 'is incomplete when the index is missing',
    index: { status: 'missing' },
    projectRoot,
    expected: 'incomplete',
  },
  {
    name: 'is incomplete when the index is malformed',
    index: { status: 'malformed', reason: 'not JSON' },
    projectRoot,
    expected: 'incomplete',
  },
  {
    name: 'is incomplete when the index has a newer format',
    index: { status: 'newer', notice: 'Update Tau.' },
    projectRoot,
    expected: 'incomplete',
  },
  {
    name: 'is incomplete when the project merged read is unknown',
    index: readIndex({
      projects: {
        [projectRoot]: {
          repository: 'sqve/tau',
          merged: {
            status: 'unknown',
            at: '2026-11-15T12:00:00.000Z',
            reason: 'gh failed',
          },
        },
      },
    }),
    projectRoot,
    expected: 'incomplete',
  },
  {
    name: 'is complete when the project has no entry',
    index: readIndex(),
    projectRoot,
    expected: 'complete',
  },
  {
    name: 'is complete with a caught-up sweep and no project root',
    index: readIndex(),
    projectRoot: null,
    expected: 'complete',
  },
  {
    name: "is incomplete when this session's latest sweep failed",
    index: readIndex(),
    projectRoot,
    sessionSweep: { outcome: 'failed', reason: 'lock failed' },
    expected: 'incomplete',
  },
  {
    name: "keeps the index rule when this session's latest sweep ran out of budget",
    index: readIndex(),
    projectRoot,
    sessionSweep: { outcome: 'budget' },
    expected: 'complete',
  },
  {
    name: 'keeps the index rule when this session has no sweep outcome',
    index: readIndex(),
    projectRoot,
    sessionSweep: undefined,
    expected: 'complete',
  },
];

it.each(sweepTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(
    decideSweep({
      index: row.index,
      projectRoot: row.projectRoot,
      sessionSweep: row.sessionSweep,
    }),
  ).toBe(row.expected);
});

const status = (overrides: Partial<ImprovementStatus> = {}): ImprovementStatus => ({
  projectRoot,
  tasks: [],
  correctDue: false,
  coverage: noCoverage,
  sweep: 'complete',
  gaps: [],
  ...overrides,
});

const task = (pullRequest: string): TaskToReview => ({
  pullRequest,
  mergedAt: '2026-11-15T11:58:00.000Z',
  signals: ['reviewRounds'],
});

const textTable: {
  name: string;
  status: ImprovementStatus;
  expected: string | undefined;
}[] = [
  {
    name: 'has no text when nothing applies',
    status: status(),
    expected: undefined,
  },
  {
    name: 'shows one task and a due correct pass',
    status: status({ tasks: [task(pullRequestA)], correctDue: true }),
    expected: 'improve: 1 task to review · correct due',
  },
  {
    name: 'shows two tasks',
    status: status({ tasks: [task(pullRequestA), task(pullRequestB)] }),
    expected: 'improve: 2 tasks to review',
  },
  {
    name: 'shows an incomplete sweep alone',
    status: status({ sweep: 'incomplete' }),
    expected: 'improve: sweep incomplete',
  },
];

it.each(textTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(statusText(row.status)).toBe(row.expected);
});
