import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { eventDirectory, readEvents, writeEvent } from '../../improvement/event.js';
import type { ImprovementEvent, WriteOutcome } from '../../improvement/event.js';
import { findProjectRoot } from '../../improvement/projectRoot.js';
import type { RecordRequest } from './recordRequest.js';

export interface SessionFacts {
  cwd: string;
  sessionId: string;
  sessionFile: string | undefined;
  toolCallId: string;
  createdAt: string;
}

export interface CorrectionFacts extends SessionFacts {
  summary: string;
}

export interface ReviewFacts extends SessionFacts {
  projectRoot: string;
  pullRequest: string;
  outcome: string;
}

export interface BacklogFacts extends SessionFacts {
  projectRoot: string;
  review: string;
  item: number;
  summary: string;
}

export interface DecisionFacts extends SessionFacts {
  projectRoot: string;
  review: string;
  item: number;
  choice: 'approved' | 'rejected' | 'redirected';
}

export interface RecordResult {
  id: string;
  path: string;
  outcome: WriteOutcome;
}

type ReviewEvent = Extract<ImprovementEvent, { kind: 'review' }>;

export type StoredRecordRequest =
  | Extract<RecordRequest, { kind: 'correction' }>
  | Extract<RecordRequest, { kind: 'review' }>
  | Extract<RecordRequest, { kind: 'backlog' }>
  | Extract<RecordRequest, { kind: 'decision'; review: string }>;

const hashLength = 32;

export const eventId = (prefix: string, sessionId: string, toolCallId: string): string => {
  const hash = createHash('sha256').update(`${sessionId}\0${toolCallId}`).digest('hex');

  return `${prefix}-${hash.slice(0, hashLength)}`;
};

export const evidenceOf = (facts: SessionFacts): ImprovementEvent['evidence'][number] => {
  if (facts.sessionFile === undefined) {
    return { kind: 'session', sessionId: facts.sessionId, toolCallId: facts.toolCallId };
  }

  return { kind: 'transcript', path: facts.sessionFile, toolCallId: facts.toolCallId };
};

const isReviewEvent = (event: ImprovementEvent): event is ReviewEvent => event.kind === 'review';

const findReview = async (projectRoot: string, review: string): Promise<ReviewEvent> => {
  const { events, gaps } = await readEvents(projectRoot);
  const reviewGap = gaps.find(({ path }) => basename(path) === `${review}.json`);

  if (reviewGap !== undefined) {
    throw new Error(reviewGap.reason);
  }

  const event = events.find((candidate) => candidate.id === review);

  if (event === undefined || !isReviewEvent(event)) {
    throw new Error(`No review event ${review} in ${eventDirectory(projectRoot)}.`);
  }

  return event;
};

export const recordCorrection = async (facts: CorrectionFacts): Promise<RecordResult> => {
  const projectRoot = await findProjectRoot(facts.cwd);
  const id = eventId('correction', facts.sessionId, facts.toolCallId);

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 2,
    id,
    kind: 'correction',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts)],
    summary: facts.summary,
    cwd: facts.cwd,
  });

  return { id, path, outcome };
};

export const recordReview = async (facts: ReviewFacts): Promise<RecordResult> => {
  const { projectRoot } = facts;
  const id = eventId('review', facts.sessionId, facts.toolCallId);

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 2,
    id,
    kind: 'review',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts), { kind: 'pullRequest', url: facts.pullRequest }],
    pullRequest: facts.pullRequest,
    outcome: facts.outcome,
  });

  return { id, path, outcome };
};

export const recordBacklog = async (facts: BacklogFacts): Promise<RecordResult> => {
  const { projectRoot } = facts;
  const review = await findReview(projectRoot, facts.review);
  const id = `backlog-${facts.review}-${facts.item}`;

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 2,
    id,
    kind: 'backlog',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts), { kind: 'pullRequest', url: review.pullRequest }],
    summary: facts.summary,
    pullRequest: review.pullRequest,
  });

  return { id, path, outcome };
};

export const recordDecision = async (facts: DecisionFacts): Promise<RecordResult> => {
  const { projectRoot } = facts;

  await findReview(projectRoot, facts.review);

  const id = `decision-${facts.review}-${facts.item}`;

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 2,
    id,
    kind: 'decision',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts)],
    subject: facts.review,
    choice: facts.choice,
  });

  return { id, path, outcome };
};

export const sessionFacts = (toolCallId: string, context: ExtensionContext): SessionFacts => ({
  cwd: context.cwd,
  sessionId: context.sessionManager.getSessionId(),
  sessionFile: context.sessionManager.getSessionFile(),
  toolCallId,
  createdAt: new Date().toISOString(),
});

export const runRecord = async (
  toolCallId: string,
  request: StoredRecordRequest,
  context: ExtensionContext,
): Promise<RecordResult> => {
  const facts = sessionFacts(toolCallId, context);

  if (request.kind === 'correction') {
    return recordCorrection({ ...facts, summary: request.summary });
  }

  if (request.kind === 'review') {
    return recordReview({
      ...facts,
      projectRoot: request.projectRoot,
      pullRequest: request.pullRequest,
      outcome: request.outcome,
    });
  }

  if (request.kind === 'backlog') {
    return recordBacklog({
      ...facts,
      projectRoot: request.projectRoot,
      review: request.review,
      item: request.item,
      summary: request.summary,
    });
  }

  return recordDecision({
    ...facts,
    projectRoot: request.projectRoot,
    review: request.review,
    item: request.item,
    choice: request.choice,
  });
};
