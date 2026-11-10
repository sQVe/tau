import { expect, it } from 'vitest';

import { decideStatus, recommendStatus } from './statusDecisions.js';
import type { StatusFacts } from './statusDecisions.js';

const facts = (change: Partial<StatusFacts> = {}): StatusFacts => ({
  pr: 7,
  url: 'https://github.com/sQVe/tau/pull/7',
  expectedHead: 'abc123',
  head: 'abc123',
  draft: false,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: '',
  unresolvedThreads: 0,
  checks: [],
  reviews: [],
  bots: [],
  gaps: [],
  headMoved: false,
  ...change,
});

it.each<{ name: string; change: Partial<StatusFacts>; verdict: string; reasons: unknown[] }>([
  { name: 'clear snapshot', change: {}, verdict: 'clear', reasons: [] },
  {
    name: 'conflict',
    change: { mergeable: 'CONFLICTING' },
    verdict: 'action-required',
    reasons: [{ code: 'conflict' }],
  },
  {
    name: 'dirty merge state',
    change: { mergeStateStatus: 'DIRTY' },
    verdict: 'action-required',
    reasons: [{ code: 'conflict' }],
  },
  {
    name: 'behind',
    change: { mergeStateStatus: 'BEHIND' },
    verdict: 'action-required',
    reasons: [{ code: 'behind' }],
  },
  {
    name: 'unresolved threads',
    change: { unresolvedThreads: 2 },
    verdict: 'action-required',
    reasons: [{ code: 'unresolvedThreads', count: 2 }],
  },
  {
    name: 'failed and cancelled checks',
    change: {
      checks: [
        { name: 'test', bucket: 'fail' },
        { name: 'lint', bucket: 'cancel' },
      ],
    },
    verdict: 'action-required',
    reasons: [{ code: 'failingChecks', names: ['test', 'lint'] }],
  },
  {
    name: 'pending checks',
    change: { checks: [{ name: 'test', bucket: 'pending' }] },
    verdict: 'waiting-checks',
    reasons: [{ code: 'pendingChecks', names: ['test'] }],
  },
  {
    name: 'requested changes decision',
    change: { reviewDecision: 'CHANGES_REQUESTED' },
    verdict: 'action-required',
    reasons: [{ code: 'changesRequested', logins: [] }],
  },
  {
    name: 'latest requested changes',
    change: {
      reviews: [
        { id: 1, login: 'Alice', state: 'APPROVED' },
        { id: 2, login: 'alice', state: 'CHANGES_REQUESTED' },
      ],
    },
    verdict: 'action-required',
    reasons: [{ code: 'changesRequested', logins: ['alice'] }],
  },
  {
    name: 'superseded requested changes',
    change: {
      reviews: [
        { id: 2, login: 'alice', state: 'APPROVED' },
        { id: 1, login: 'Alice', state: 'CHANGES_REQUESTED' },
      ],
    },
    verdict: 'clear',
    reasons: [],
  },
  {
    name: 'comment after requested changes',
    change: {
      reviews: [
        { id: 1, login: 'Alice', state: 'CHANGES_REQUESTED' },
        { id: 2, login: 'alice', state: 'COMMENTED' },
      ],
    },
    verdict: 'action-required',
    reasons: [{ code: 'changesRequested', logins: ['Alice'] }],
  },
  {
    name: 'pending after requested changes',
    change: {
      reviews: [
        { id: 1, login: 'Alice', state: 'CHANGES_REQUESTED' },
        { id: 2, login: 'alice', state: 'PENDING' },
      ],
    },
    verdict: 'action-required',
    reasons: [{ code: 'changesRequested', logins: ['Alice'] }],
  },
  {
    name: 'dismissed requested changes',
    change: {
      reviews: [
        { id: 1, login: 'Alice', state: 'CHANGES_REQUESTED' },
        { id: 2, login: 'alice', state: 'DISMISSED' },
      ],
    },
    verdict: 'clear',
    reasons: [],
  },
  {
    name: 'separate deleted reviewers',
    change: {
      reviews: [
        { id: 1, login: null, state: 'CHANGES_REQUESTED' },
        { id: 2, login: null, state: 'APPROVED' },
      ],
    },
    verdict: 'action-required',
    reasons: [{ code: 'changesRequested', logins: [null] }],
  },
  {
    name: 'approval gate',
    change: { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' },
    verdict: 'waiting-human',
    reasons: [{ code: 'approvalRequired' }],
  },
  {
    name: 'unidentified blocked gate',
    change: { mergeStateStatus: 'BLOCKED', checks: [{ name: 'test', bucket: 'pass' }] },
    verdict: 'unknown',
    reasons: [{ code: 'blockedUnknown' }],
  },
  {
    name: 'blocked on checks',
    change: { mergeStateStatus: 'BLOCKED', checks: [{ name: 'test', bucket: 'pending' }] },
    verdict: 'waiting-checks',
    reasons: [{ code: 'pendingChecks', names: ['test'] }],
  },
  {
    name: 'configured bot pending',
    change: { mergeStateStatus: 'BLOCKED', bots: [{ login: 'configured', status: 'requested' }] },
    verdict: 'waiting-checks',
    reasons: [{ code: 'botReviewPending', logins: ['configured'] }],
  },
  {
    name: 'unrequested bot',
    change: { bots: [{ login: 'configured', status: 'request' }] },
    verdict: 'clear',
    reasons: [],
  },
  {
    name: 'reviewed bot',
    change: { bots: [{ login: 'configured', status: 'reviewed' }] },
    verdict: 'clear',
    reasons: [],
  },
  {
    name: 'draft',
    change: { draft: true, mergeStateStatus: 'BLOCKED' },
    verdict: 'waiting-human',
    reasons: [{ code: 'draft' }],
  },
  {
    name: 'draft with conflict and gaps',
    change: { draft: true, mergeable: 'CONFLICTING', gaps: ['reviews unread'] },
    verdict: 'action-required',
    reasons: [{ code: 'conflict' }, { code: 'draft' }, { code: 'readGap' }],
  },
  {
    name: 'closed',
    change: { state: 'CLOSED', head: 'other' },
    verdict: 'unknown',
    reasons: [{ code: 'closed' }],
  },
  {
    name: 'merged',
    change: { state: 'MERGED', head: 'other', mergeable: 'UNKNOWN', gaps: ['unread'] },
    verdict: 'clear',
    reasons: [{ code: 'merged' }],
  },
  {
    name: 'head moved before read',
    change: { head: 'other', mergeable: 'CONFLICTING' },
    verdict: 'unknown',
    reasons: [{ code: 'headMoved' }],
  },
  {
    name: 'head moved during reads',
    change: { headMoved: true },
    verdict: 'unknown',
    reasons: [{ code: 'headMoved' }],
  },
  {
    name: 'read gap before pending',
    change: { gaps: ['reviews unread'], checks: [{ name: 'test', bucket: 'pending' }] },
    verdict: 'unknown',
    reasons: [{ code: 'pendingChecks', names: ['test'] }, { code: 'readGap' }],
  },
  {
    name: 'unknown mergeability',
    change: { mergeable: 'UNKNOWN' },
    verdict: 'unknown',
    reasons: [{ code: 'mergeabilityUnknown' }],
  },
  {
    name: 'every blocker',
    change: {
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'BEHIND',
      unresolvedThreads: 1,
      checks: [{ name: 'test', bucket: 'fail' }],
      reviewDecision: 'CHANGES_REQUESTED',
    },
    verdict: 'action-required',
    reasons: [
      { code: 'conflict' },
      { code: 'behind' },
      { code: 'unresolvedThreads', count: 1 },
      { code: 'failingChecks', names: ['test'] },
      { code: 'changesRequested', logins: [] },
    ],
  },
])('decides $name', ({ change, verdict, reasons }) => {
  const input = facts(change);
  const result = decideStatus(input);

  expect(result).toMatchObject({
    pr: 7,
    url: input.url,
    head: input.head,
    draft: input.draft,
    gaps: input.gaps,
    verdict,
    reasons,
  });
});

it.each([
  {
    name: 'mixed stack',
    changes: [{ gaps: ['unread'] }, {}, { mergeable: 'CONFLICTING' }, { unresolvedThreads: 1 }],
    recommended: 3,
    attention: [1, 3, 4],
  },
  {
    name: 'several broken PRs',
    changes: [
      { mergeable: 'CONFLICTING' },
      { unresolvedThreads: 1 },
      { mergeStateStatus: 'BEHIND' },
    ],
    recommended: 1,
    attention: [1, 2, 3],
  },
  {
    name: 'only unknown needs attention',
    changes: [{}, { gaps: ['unread'] }, { mergeable: 'UNKNOWN' }],
    recommended: 2,
    attention: [2, 3],
  },
  {
    name: 'nothing needs attention',
    changes: [{}, { draft: true }],
    recommended: null,
    attention: [],
  },
])('recommends the lowest PR in $name', ({ changes, recommended, attention }) => {
  const results = changes.map((change, index) => decideStatus(facts({ ...change, pr: index + 1 })));
  const result = recommendStatus(results);

  expect(result.recommended).toBe(recommended);
  expect(result.attention).toEqual(attention);
  expect(result.reason === null).toBe(recommended === null);
});
