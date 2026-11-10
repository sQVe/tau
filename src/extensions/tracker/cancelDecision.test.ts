import { expect, it } from 'vitest';

import { decideCancel } from './cancelDecision.js';
import type { PullRequestEvidence } from './cancelDecision.js';

const merged = { url: 'https://github.com/a/b/pull/1', state: 'MERGED' };
const failed = { url: 'https://github.com/a/b/pull/2', error: 'network error' };

const cases: {
  label: string;
  state: string;
  pullRequests: PullRequestEvidence[];
  kind: string;
  reason?: string;
}[] = [
  { label: 'canceled', state: 'canceled', pullRequests: [], kind: 'unchanged' },
  {
    label: 'canceled even with merged PR',
    state: 'canceled',
    pullRequests: [merged],
    kind: 'unchanged',
  },
  { label: 'completed', state: 'completed', pullRequests: [], kind: 'refuse', reason: 'completed' },
  {
    label: 'merged PR',
    state: 'started',
    pullRequests: [merged],
    kind: 'refuse',
    reason: merged.url,
  },
  {
    label: 'failed PR read',
    state: 'started',
    pullRequests: [failed],
    kind: 'refuse',
    reason: failed.url,
  },
  { label: 'no PR', state: 'started', pullRequests: [], kind: 'cancel' },
  {
    label: 'open PR',
    state: 'backlog',
    pullRequests: [{ ...merged, state: 'OPEN' }],
    kind: 'cancel',
  },
  {
    label: 'closed PR',
    state: 'unstarted',
    pullRequests: [{ ...merged, state: 'CLOSED' }],
    kind: 'cancel',
  },
];

it.each(cases)('decides cancellation: $label', ({ state, pullRequests, kind, reason }) => {
  const decision = decideCancel(state, pullRequests);

  expect(decision.kind).toBe(kind);

  const message = 'reason' in decision ? decision.reason : '';

  expect(message).toContain(reason ?? '');
});
