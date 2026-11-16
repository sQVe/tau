import { describe, expect, it } from 'vitest';

import { decideTranscriptRead, plannedEvents } from './sweepDecision.ts';
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

describe('plannedEvents', () => {
  const planned = (overrides: Parameters<typeof task>[0] = {}, existingIds: string[] = []) =>
    plannedEvents({
      tasks: [{ task: task(overrides), hash: 'abc123' }],
      existingIds: new Set(existingIds),
      now,
    });

  it('gives each task a merge event and a facts event', () => {
    expect(planned()).toEqual([
      {
        version: 1,
        id: 'merge-abc123',
        kind: 'merge',
        createdAt: now,
        evidence: [{ kind: 'pullRequest', url: 'https://github.com/sQVe/tau/pull/562' }],
        repository: 'github.com/sQVe/tau',
        pullRequest: 'https://github.com/sQVe/tau/pull/562',
        mergedAt: '2026-11-15T11:58:00.000Z',
      },
      {
        version: 1,
        id: 'facts-abc123',
        kind: 'facts',
        createdAt: now,
        evidence: [{ kind: 'pullRequest', url: 'https://github.com/sQVe/tau/pull/562' }],
        pullRequest: 'https://github.com/sQVe/tau/pull/562',
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
      },
    ]);
  });

  it('keeps only the numeric counts', () => {
    const facts = planned({ counts: counts({ publications: 'unknown', launches: 2 }) }).find(
      (event) => event.kind === 'facts',
    );

    expect(facts?.kind === 'facts' ? facts.facts : undefined).toEqual({
      reviewCaptures: 2,
      fixCaptures: 0,
      feedbackRounds: 1,
      checkFailures: 0,
      qaLaunches: 0,
      launches: 2,
    });
  });

  it('adds the publication as transcript evidence', () => {
    const facts = planned({
      publication: {
        path: '/sessions/manager.jsonl',
        callId: 'call-1',
        entryId: 'entry-1',
        timestamp: '2026-11-03T08:03:00.000Z',
      },
    }).find((event) => event.kind === 'facts');

    expect(facts?.evidence).toEqual([
      { kind: 'pullRequest', url: 'https://github.com/sQVe/tau/pull/562' },
      {
        kind: 'transcript',
        path: '/sessions/manager.jsonl',
        toolCallId: 'call-1',
        entryId: 'entry-1',
      },
    ]);
  });

  it('writes no facts event while coverage is unknown', () => {
    expect(planned({ coverage: 'unknown' }).map((event) => event.kind)).toEqual(['merge']);
  });

  it('skips an ID that already exists', () => {
    expect(planned({}, ['merge-abc123']).map((event) => event.id)).toEqual(['facts-abc123']);
  });

  it('skips a task whose every ID exists', () => {
    expect(planned({}, ['merge-abc123', 'facts-abc123'])).toEqual([]);
  });
});
