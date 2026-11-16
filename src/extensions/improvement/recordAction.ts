import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { eventDirectory, readEvents, writeEvent } from '../../improvement/event.js';
import type { ImprovementEvent, WriteOutcome } from '../../improvement/event.js';
import { findProjectRoot } from '../../improvement/projectRoot.js';
import { parseRecordRequest } from './recordRequest.js';
import type { RecordInput } from './recordRequest.js';

interface SessionFacts {
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
  pullRequest: string;
  outcome: string;
}

export interface BacklogFacts extends SessionFacts {
  review: string;
  item: number;
  summary: string;
}

export interface DecisionFacts extends SessionFacts {
  review: string;
  item: number;
  choice: 'approved' | 'rejected' | 'redirected';
}

interface RecordResult {
  id: string;
  path: string;
  outcome: WriteOutcome;
}

type ReviewEvent = Extract<ImprovementEvent, { kind: 'review' }>;

const hashLength = 32;

const eventId = (prefix: string, sessionId: string, toolCallId: string) => {
  const hash = createHash('sha256').update(`${sessionId}\0${toolCallId}`).digest('hex');

  return `${prefix}-${hash.slice(0, hashLength)}`;
};

const evidenceOf = (facts: SessionFacts): ImprovementEvent['evidence'][number] => {
  if (facts.sessionFile === undefined) {
    return { kind: 'session', sessionId: facts.sessionId, toolCallId: facts.toolCallId };
  }

  return { kind: 'transcript', path: facts.sessionFile, toolCallId: facts.toolCallId };
};

const isReviewEvent = (event: ImprovementEvent): event is ReviewEvent => event.kind === 'review';

const findReview = async (projectRoot: string, review: string): Promise<ReviewEvent> => {
  const { events, skipped } = await readEvents(projectRoot);
  const skippedReview = skipped.find(({ path }) => basename(path) === `${review}.json`);

  if (skippedReview !== undefined) {
    throw new Error(skippedReview.notice);
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
    version: 1,
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
  const projectRoot = await findProjectRoot(facts.cwd);
  const id = eventId('review', facts.sessionId, facts.toolCallId);

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 1,
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
  const projectRoot = await findProjectRoot(facts.cwd);
  const review = await findReview(projectRoot, facts.review);
  const id = `backlog-${facts.review}-${facts.item}`;

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 1,
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
  const projectRoot = await findProjectRoot(facts.cwd);

  await findReview(projectRoot, facts.review);

  const id = `decision-${facts.review}-${facts.item}`;

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 1,
    id,
    kind: 'decision',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts)],
    subject: facts.review,
    choice: facts.choice,
  });

  return { id, path, outcome };
};

export const runRecord = async (
  toolCallId: string,
  input: RecordInput,
  context: ExtensionContext,
): Promise<RecordResult> => {
  const request = parseRecordRequest(input);

  const facts = {
    cwd: context.cwd,
    sessionId: context.sessionManager.getSessionId(),
    sessionFile: context.sessionManager.getSessionFile(),
    toolCallId,
    createdAt: new Date().toISOString(),
  };

  if (request.kind === 'correction') {
    return recordCorrection({ ...facts, summary: request.summary });
  }

  if (request.kind === 'review') {
    return recordReview({
      ...facts,
      pullRequest: request.pullRequest,
      outcome: request.outcome,
    });
  }

  if (request.kind === 'backlog') {
    return recordBacklog({
      ...facts,
      review: request.review,
      item: request.item,
      summary: request.summary,
    });
  }

  return recordDecision({
    ...facts,
    review: request.review,
    item: request.item,
    choice: request.choice,
  });
};
