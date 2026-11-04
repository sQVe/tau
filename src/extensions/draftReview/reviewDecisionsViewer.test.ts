import { expect, it } from 'vitest';

import { decideViewerReply, decideViewerSource } from './reviewDecisions.js';
import type {
  ViewerReplyDecision,
  ViewerReplyFacts,
  ViewerSourceDecision,
  ViewerSourceFacts,
} from './reviewDecisions.js';

const base: ViewerReplyFacts = {
  state: { kind: 'open' },
  claimedReviewId: 'review-AbC123',
  reviewId: 'review-AbC123',
  files: ['01-notes/1-title.md'],
  stagedPaths: ['01-notes/1-title.md', '01-notes/2-body.md'],
};

it.each<{ name: string; facts: Partial<ViewerReplyFacts>; decision: ViewerReplyDecision }>([
  { name: 'the reply matches the review', facts: {}, decision: { kind: 'accepted' } },
  {
    name: 'the viewer submitted the review',
    facts: { state: { kind: 'submitted' } },
    decision: { kind: 'accepted' },
  },
  { name: 'no comment names a file', facts: { files: [] }, decision: { kind: 'accepted' } },
  {
    name: 'the reply claims another review ID',
    facts: { claimedReviewId: 'review-Other9' },
    decision: { kind: 'foreign-review', claimedReviewId: 'review-Other9' },
  },
  {
    name: 'the reply names a file the review did not stage',
    facts: { files: ['01-notes/3-other.md'] },
    decision: { kind: 'unknown-file', file: '01-notes/3-other.md' },
  },
  {
    name: 'one of several files is unknown',
    facts: { files: ['01-notes/1-title.md', '01-notes/3-other.md'] },
    decision: { kind: 'unknown-file', file: '01-notes/3-other.md' },
  },
  {
    name: 'the viewer reported an error',
    facts: { state: { kind: 'error', reason: 'The viewer could not open the drafts.' } },
    decision: { kind: 'viewer-error', reason: 'The viewer could not open the drafts.' },
  },
])('decides the reply when $name', ({ facts, decision }) => {
  expect(decideViewerReply({ ...base, ...facts })).toEqual(decision);
});

it.each<{ name: string; facts: ViewerSourceFacts; decision: ViewerSourceDecision }>([
  {
    name: 'a first collect with a viewer reply',
    facts: { savedTuicrComments: 0, viewerReplyExists: true },
    decision: 'accepted',
  },
  {
    name: 'a saved plan with no tuicr comments',
    facts: { savedTuicrComments: 0, viewerReplyExists: false },
    decision: 'accepted',
  },
  {
    name: 'a saved plan with tuicr comments and no viewer reply',
    facts: { savedTuicrComments: 2, viewerReplyExists: false },
    decision: 'accepted',
  },
  {
    name: 'a saved plan with tuicr comments and a viewer reply',
    facts: { savedTuicrComments: 2, viewerReplyExists: true },
    decision: 'refuse-switch',
  },
])('decides $decision for $name', ({ facts, decision }) => {
  expect(decideViewerSource(facts)).toBe(decision);
});
