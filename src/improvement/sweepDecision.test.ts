import { array, assert, constantFrom, property, tuple, uniqueArray } from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ImprovementEvent } from './event.ts';
import { decideTranscriptRead, discoveryOrder, plannedEvents } from './sweepDecision.ts';
import type { DiscoveryCandidate } from './sweepDecision.ts';
import type { TaskCounts } from './taskFacts.ts';
import type { Task } from './taskMapping.ts';

const now = '2026-11-15T12:00:00.000Z';

const counts = (overrides: Partial<TaskCounts> = {}): TaskCounts => ({
  publications: 1,
  reviewCaptures: 2,
  fixCaptures: 0,
  feedbackRounds: 1,
  checkFailures: 0,
  qaLaunches: 0,
  launches: 1,
  ...overrides,
});

const task = (overrides: Partial<Task> = {}): Task => ({
  pullRequest: {
    repository: 'github.com/sQVe/tau',
    number: 562,
    url: 'https://github.com/sQVe/tau/pull/562',
    headBranch: 'me-1023-change',
    createdAt: '2026-11-01T00:00:00.000Z',
    mergedAt: '2026-11-15T11:58:00.000Z',
  },
  transcripts: ['/sessions/manager.jsonl'],
  publication: undefined,
  facts: [],
  missing: [],
  counts: counts(),
  coverage: 'complete',
  ...overrides,
});

describe('decideTranscriptRead', () => {
  it.each([
    {
      rule: 'a size below the cursor means the file was replaced',
      cursor: 10,
      size: 4,
      read: 'restart',
    },
    { rule: 'a size at the cursor means nothing new', cursor: 10, size: 10, read: 'unchanged' },
    { rule: 'a size above the cursor has new bytes', cursor: 10, size: 11, read: 'read' },
    { rule: 'an empty new file is unchanged', cursor: 0, size: 0, read: 'unchanged' },
  ] as const)('$rule', ({ cursor, size, read }) => {
    expect(decideTranscriptRead({ cursor, size })).toBe(read);
  });
});

describe('discoveryOrder', () => {
  it.each([
    {
      rule: 'reads unseen transcripts before retrying unresolved ones',
      candidates: [
        { path: '/sessions/retried.jsonl', status: 'unresolved' },
        { path: '/sessions/unseen.jsonl', status: 'new' },
      ],
      order: ['/sessions/unseen.jsonl', '/sessions/retried.jsonl'],
    },
    {
      rule: 'keeps the unseen transcripts in the order they were found',
      candidates: [
        { path: '/sessions/first.jsonl', status: 'new' },
        { path: '/sessions/retried.jsonl', status: 'unresolved' },
        { path: '/sessions/second.jsonl', status: 'new' },
      ],
      order: ['/sessions/first.jsonl', '/sessions/second.jsonl', '/sessions/retried.jsonl'],
    },
    {
      rule: 'skips a transcript that was already resolved',
      candidates: [
        { path: '/sessions/resolved.jsonl', status: 'resolved' },
        { path: '/sessions/unseen.jsonl', status: 'new' },
      ],
      order: ['/sessions/unseen.jsonl'],
    },
    {
      rule: 'reads nothing when there is no transcript',
      candidates: [],
      order: [],
    },
  ] as const)('$rule', ({ candidates, order }) => {
    expect(discoveryOrder(candidates)).toEqual(order);
  });

  it('keeps every unresolved path after every unseen path and drops resolved ones', () => {
    const candidate = tuple(
      uniqueArray(constantFrom('/sessions/a', '/sessions/b', '/sessions/c'), {
        minLength: 0,
        maxLength: 3,
      }),
      array(constantFrom('new', 'unresolved', 'resolved'), { minLength: 0, maxLength: 3 }),
    ).map(([paths, statuses]): DiscoveryCandidate[] =>
      paths.map((path, index) => ({
        path,
        status: statuses[index % statuses.length] ?? 'new',
      })),
    );

    assert(
      property(candidate, (candidates) => {
        const order = discoveryOrder(candidates);
        const kept = candidates.filter(({ status }) => status !== 'resolved');

        const unseen = order.filter(
          (path) => candidates.find((entry) => entry.path === path)?.status === 'new',
        );

        const retried = order.filter(
          (path) => candidates.find((entry) => entry.path === path)?.status === 'unresolved',
        );

        expect(order).toHaveLength(kept.length);
        expect(new Set(order).size).toBe(order.length);
        expect(order).toEqual([...unseen, ...retried]);

        expect(unseen).toEqual(
          candidates.filter(({ status }) => status === 'new').map(({ path }) => path),
        );

        expect(retried).toEqual(
          candidates.filter(({ status }) => status === 'unresolved').map(({ path }) => path),
        );
      }),
    );
  });
});

describe('plannedEvents', () => {
  const pullRequest = 'https://github.com/sQVe/tau/pull/562';

  const mergeEvent = (): ImprovementEvent => ({
    version: 2,
    id: 'merge-abc123',
    kind: 'merge',
    createdAt: now,
    evidence: [{ kind: 'pullRequest', url: pullRequest }],
    repository: 'github.com/sQVe/tau',
    pullRequest,
    mergedAt: '2026-11-15T11:58:00.000Z',
  });

  const factsEvent = (
    overrides: Partial<Extract<ImprovementEvent, { kind: 'facts' }>> = {},
  ): ImprovementEvent => ({
    version: 2,
    id: 'facts-abc123',
    kind: 'facts',
    createdAt: now,
    evidence: [{ kind: 'pullRequest', url: pullRequest }],
    pullRequest,
    facts: {
      publications: 1,
      reviewCaptures: 2,
      fixCaptures: 0,
      feedbackRounds: 1,
      checkFailures: 0,
      qaLaunches: 0,
      launches: 1,
    },
    coverage: 'complete',
    ...overrides,
  });

  const publication = {
    path: '/sessions/manager.jsonl',
    callId: 'call-1',
    entryId: 'entry-1',
    timestamp: '2026-11-03T08:03:00.000Z',
  };

  it.each([
    {
      rule: 'gives each task a merge event and a facts event',
      overrides: {},
      existingIds: [],
      events: [mergeEvent(), factsEvent()],
    },
    {
      rule: 'keeps only the numeric counts',
      overrides: { counts: counts({ publications: 'unknown', launches: 2 }) },
      existingIds: [],
      events: [
        mergeEvent(),
        factsEvent({
          facts: {
            reviewCaptures: 2,
            fixCaptures: 0,
            feedbackRounds: 1,
            checkFailures: 0,
            qaLaunches: 0,
            launches: 2,
          },
        }),
      ],
    },
    {
      rule: 'adds the publication as transcript evidence',
      overrides: { publication },
      existingIds: [],
      events: [
        mergeEvent(),
        factsEvent({
          evidence: [
            { kind: 'pullRequest', url: pullRequest },
            {
              kind: 'transcript',
              path: '/sessions/manager.jsonl',
              toolCallId: 'call-1',
              entryId: 'entry-1',
            },
          ],
        }),
      ],
    },
    {
      rule: 'writes no facts event while coverage is unknown',
      overrides: { coverage: 'unknown' as const },
      existingIds: [],
      events: [mergeEvent()],
    },
    {
      rule: 'writes no facts event while coverage is missing',
      overrides: { coverage: 'missing' as const },
      existingIds: [],
      events: [mergeEvent()],
    },
    {
      rule: 'skips an ID that already exists',
      overrides: {},
      existingIds: ['merge-abc123'],
      events: [factsEvent()],
    },
    {
      rule: 'skips a task whose every ID exists',
      overrides: {},
      existingIds: ['merge-abc123', 'facts-abc123'],
      events: [],
    },
  ])('$rule', ({ overrides, existingIds, events }) => {
    expect(
      plannedEvents({
        tasks: [{ task: task(overrides), hash: 'abc123' }],
        existingIds: new Set(existingIds),
        now,
      }),
    ).toEqual(events);
  });
});
