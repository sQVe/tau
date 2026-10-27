import { expect, it } from 'vitest';

import { decideWatchOutcome } from './watchOutcome.js';
import type { WatchFacts } from './watchOutcome.js';

const open = { state: 'OPEN', mergedAt: null };
const merged = { state: 'MERGED', mergedAt: '2026-10-27T10:00:00Z' };
const failed = { name: 'test', bucket: 'fail' };
const cancelled = { name: 'lint', bucket: 'cancel' };
const passed = { name: 'build', bucket: 'pass' };
const pending = { name: 'deploy', bucket: 'pending' };

const facts = (saved: Partial<WatchFacts> = {}): WatchFacts => ({
  pullRequest: open,
  checks: [passed, pending],
  ...saved,
});

const table: { name: string; facts: WatchFacts; outcome: ReturnType<typeof decideWatchOutcome> }[] =
  [
    { name: 'waits while checks run', facts: facts(), outcome: { kind: 'waiting' } },
    {
      name: 'waits when the pull request has no required checks',
      facts: facts({ checks: [] }),
      outcome: { kind: 'waiting' },
    },
    {
      name: 'reports a merge',
      facts: facts({ pullRequest: merged }),
      outcome: { kind: 'merged' },
    },
    {
      name: 'reports a merge before a failed check in the same poll',
      facts: facts({ pullRequest: merged, checks: [failed] }),
      outcome: { kind: 'merged' },
    },
    {
      name: 'reports a merge when the checks read failed',
      facts: facts({ pullRequest: merged, checks: undefined }),
      outcome: { kind: 'merged' },
    },
    {
      name: 'reports a pull request closed without merging',
      facts: facts({ pullRequest: { state: 'CLOSED', mergedAt: null }, checks: [failed] }),
      outcome: { kind: 'closed', state: 'CLOSED' },
    },
    {
      name: 'names each failed and cancelled required check',
      facts: facts({ checks: [failed, passed, cancelled, pending] }),
      outcome: { kind: 'checksFailed', checks: ['test', 'lint'] },
    },
    {
      name: 'waits for the next poll when the pull request read failed',
      facts: facts({ pullRequest: undefined, checks: [failed] }),
      outcome: { kind: 'waiting' },
    },
    {
      name: 'waits for the next poll when the checks read failed',
      facts: facts({ checks: undefined }),
      outcome: { kind: 'waiting' },
    },
  ];

it.each(table.map((row) => [row.name, row] as const))(
  '%s',
  (_name, { facts: watched, outcome }) => {
    expect(decideWatchOutcome(watched)).toEqual(outcome);
  },
);
