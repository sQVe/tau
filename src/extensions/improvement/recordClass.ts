import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { classEventId } from '../../improvement/classIdentity.js';
import type { ClassLevel } from '../../improvement/correctDecision.js';
import { writeEvent } from '../../improvement/event.js';
import type { ImprovementEvent } from '../../improvement/event.js';
import { findProjectRoot } from '../../improvement/projectRoot.js';
import { evidenceOf, sessionFacts } from './recordAction.js';
import type { RecordResult, SessionFacts } from './recordAction.js';
import type { RecordRequest } from './recordRequest.js';
import { findSavedEvent } from './savedEvent.js';

type ClassEvent = Extract<ImprovementEvent, { kind: 'class' }>;

type Choice = 'approved' | 'rejected' | 'redirected';

export interface ClassFacts extends SessionFacts {
  identity: string;
  level: ClassLevel;
  summary: string;
  occurrences: string[];
}

export interface ClassDecisionFacts extends SessionFacts {
  class: string;
  choice: Choice;
}

export type ClassRequest =
  | Extract<RecordRequest, { kind: 'class' }>
  | Extract<RecordRequest, { kind: 'decision'; class: string }>;

const findClass = (projectRoot: string, id: string): Promise<ClassEvent> =>
  findSavedEvent(projectRoot, id, 'class');

export const recordClass = async (facts: ClassFacts): Promise<RecordResult> => {
  const projectRoot = await findProjectRoot(facts.cwd);
  const id = classEventId(facts.identity, facts.occurrences);

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 2,
    id,
    kind: 'class',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts)],
    identity: facts.identity,
    level: facts.level,
    summary: facts.summary,
    occurrences: facts.occurrences,
  });

  return { id, path, outcome };
};

export const recordClassDecision = async (facts: ClassDecisionFacts): Promise<RecordResult> => {
  const projectRoot = await findProjectRoot(facts.cwd);

  await findClass(projectRoot, facts.class);

  const id = `decision-${facts.class}`;

  const { path, outcome } = await writeEvent(projectRoot, {
    version: 2,
    id,
    kind: 'decision',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts)],
    subject: facts.class,
    choice: facts.choice,
  });

  return { id, path, outcome };
};

export const runClass = async (
  toolCallId: string,
  request: ClassRequest,
  context: ExtensionContext,
): Promise<RecordResult> => {
  const facts = sessionFacts(toolCallId, context);

  if (request.kind === 'class') {
    return recordClass({ ...facts, ...request });
  }

  return recordClassDecision({ ...facts, class: request.class, choice: request.choice });
};
