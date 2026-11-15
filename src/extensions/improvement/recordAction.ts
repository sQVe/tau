import { createHash } from 'node:crypto';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { eventPath, writeEvent } from '../../improvement/event.js';
import type { ImprovementEvent, WriteOutcome } from '../../improvement/event.js';
import { findProjectRoot } from '../../improvement/projectRoot.js';

export interface CorrectionFacts {
  cwd: string;
  sessionId: string;
  sessionFile: string | undefined;
  toolCallId: string;
  summary: string;
  createdAt: string;
}

interface RecordResult {
  id: string;
  path: string;
  outcome: WriteOutcome;
}

const hashLength = 32;

// A tool call ID may hold characters a file name cannot, so the ID hashes it with the session ID.
// A retried call then maps to the same event.
const correctionId = (sessionId: string, toolCallId: string) => {
  const hash = createHash('sha256').update(`${sessionId}\0${toolCallId}`).digest('hex');

  return `correction-${hash.slice(0, hashLength)}`;
};

const evidenceOf = (facts: CorrectionFacts): ImprovementEvent['evidence'][number] => {
  if (facts.sessionFile === undefined) {
    return { kind: 'session', sessionId: facts.sessionId, toolCallId: facts.toolCallId };
  }

  return { kind: 'transcript', path: facts.sessionFile, toolCallId: facts.toolCallId };
};

export const recordCorrection = async (facts: CorrectionFacts): Promise<RecordResult> => {
  const projectRoot = await findProjectRoot(facts.cwd);
  const id = correctionId(facts.sessionId, facts.toolCallId);

  const outcome = await writeEvent(projectRoot, {
    version: 1,
    id,
    kind: 'correction',
    createdAt: facts.createdAt,
    evidence: [evidenceOf(facts)],
    summary: facts.summary,
    cwd: facts.cwd,
  });

  return { id, path: eventPath(projectRoot, id), outcome };
};

export const runRecord = async (
  toolCallId: string,
  summary: string | undefined,
  context: ExtensionContext,
): Promise<RecordResult> => {
  if (summary === undefined || summary.trim() === '') {
    throw new Error('record needs summary.');
  }

  return recordCorrection({
    cwd: context.cwd,
    sessionId: context.sessionManager.getSessionId(),
    sessionFile: context.sessionManager.getSessionFile(),
    toolCallId,
    summary,
    createdAt: new Date().toISOString(),
  });
};
