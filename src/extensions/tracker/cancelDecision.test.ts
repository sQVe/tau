import { expect, it } from 'vitest';

import { decideCancel, decideConfirmedCancel } from './cancelDecision.js';
import type { ClosingPullRequestEvidence } from './cancelDecision.js';

it.each([
  { label: 'same preview', title: 'Work', state: 'In Progress', kind: 'cancel', reason: '' },
  {
    label: 'title changed',
    title: 'Other',
    state: 'In Progress',
    kind: 'refuse',
    reason: 'title changed',
  },
  {
    label: 'state changed',
    title: 'Work',
    state: 'In Review',
    kind: 'refuse',
    reason: 'state changed',
  },
])('checks confirmed cancellation: $label', ({ title, state, kind, reason }) => {
  const decision = decideConfirmedCancel(
    { title: 'Work', state: { name: 'In Progress' } },
    { title, state: { name: state } },
  );

  expect(decision.kind).toBe(kind);
  const message = 'reason' in decision ? decision.reason : '';
  expect(message).toContain(reason);
});

const merged = { url: 'https://github.com/a/b/pull/1', state: 'MERGED' };
const failed = { url: 'https://github.com/a/b/pull/2', error: 'network error' };

const cases: {
  label: string;
  state: string;
  closingPullRequests: ClosingPullRequestEvidence[];
  kind: string;
  reason?: string;
}[] = [
  { label: 'canceled', state: 'canceled', closingPullRequests: [], kind: 'unchanged' },
  {
    label: 'canceled even with merged PR',
    state: 'canceled',
    closingPullRequests: [merged],
    kind: 'unchanged',
  },
  {
    label: 'completed',
    state: 'completed',
    closingPullRequests: [],
    kind: 'refuse',
    reason: 'completed',
  },
  {
    label: 'merged PR',
    state: 'started',
    closingPullRequests: [merged],
    kind: 'refuse',
    reason: merged.url,
  },
  {
    label: 'failed PR read',
    state: 'started',
    closingPullRequests: [failed],
    kind: 'refuse',
    reason: failed.url,
  },
  { label: 'no PR', state: 'started', closingPullRequests: [], kind: 'cancel' },
  {
    label: 'open PR',
    state: 'backlog',
    closingPullRequests: [{ ...merged, state: 'OPEN' }],
    kind: 'cancel',
  },
  {
    label: 'closed PR',
    state: 'unstarted',
    closingPullRequests: [{ ...merged, state: 'CLOSED' }],
    kind: 'cancel',
  },
];

it.each(cases)('decides cancellation: $label', ({ state, closingPullRequests, kind, reason }) => {
  const decision = decideCancel(state, closingPullRequests);

  expect(decision.kind).toBe(kind);

  const message = 'reason' in decision ? decision.reason : '';

  expect(message).toContain(reason ?? '');
});
