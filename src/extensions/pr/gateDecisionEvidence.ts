import { join } from 'node:path';

import { errorMessage } from '../../errors.js';
import { readDecisionRecords } from '../../questionGate/questionGate.js';
import type { DecisionRecord } from '../../questionGate/questionGate.js';
import { readVersionedRecord } from '../../record.js';
import { findSharedRepositoryRoot, rejectTauSymlinks } from '../../tauDirectory.js';
import type { PublicationGap } from './evidenceDecisions.js';

export interface GateDecisionEvidence {
  path: string;
  time: number;
  head: string | null;
  decisions: {
    question: string;
    choice: string;
    reason: string;
    confidence: number;
  }[];
}

export interface GateDecisionRead {
  gateDecisions: GateDecisionEvidence[] | null;
  gaps: PublicationGap[];
}

const projectRecord = (path: string, record: DecisionRecord): GateDecisionEvidence => ({
  path,
  time: record.time,
  head: record.head,
  decisions: record.decisions.map((decision) => ({
    question: decision.question.question,
    choice: decision.choice,
    reason: decision.reason,
    confidence: decision.confidence,
  })),
});

const compareRecords = (left: GateDecisionEvidence, right: GateDecisionEvidence): number =>
  left.time - right.time || left.path.localeCompare(right.path);

const readFailure = (error: unknown): GateDecisionRead => ({
  gateDecisions: null,
  gaps: [{ kind: 'gateDecision', reason: errorMessage(error) }],
});

export const readGateDecisions = async (
  root: string,
  branch: string | null,
): Promise<GateDecisionRead> => {
  if (branch === null) {
    return {
      gateDecisions: null,
      gaps: [{ kind: 'gateDecision', reason: 'The branch name is unavailable.' }],
    };
  }

  let directory: string;

  try {
    const sharedRoot = await findSharedRepositoryRoot(root);

    await rejectTauSymlinks(sharedRoot, 'questions');
    directory = join(sharedRoot, '.tau', 'questions');
  } catch (error) {
    return readFailure(error);
  }

  let read: Awaited<ReturnType<typeof readDecisionRecords>>;

  try {
    read = await readDecisionRecords(directory, readVersionedRecord);
  } catch (error) {
    return readFailure(error);
  }

  const gaps = read.gaps.map((gap): PublicationGap => ({
    kind: 'gateDecisionRecord',
    path: gap.path,
    reason: gap.reason,
  }));

  const gateDecisions = read.records
    .filter(({ record }) => record.branch === branch)
    .map(({ path, record }) => projectRecord(path, record))
    .toSorted(compareRecords);

  return { gateDecisions, gaps };
};
