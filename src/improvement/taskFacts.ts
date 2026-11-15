import { basename, dirname } from 'node:path';

import { isRecord } from '../schema.ts';
import { text } from './transcript.ts';
import type { ToolCall } from './transcript.ts';

interface FactPlace {
  entryId: string;
  callId: string;
  timestamp: string;
}

export type TaskFact =
  | (FactPlace & { kind: 'publication'; repository: string; pr: number })
  | (FactPlace & { kind: 'reviewCapture' | 'fixCapture' | 'checkFailure' })
  | (FactPlace & { kind: 'feedbackRound'; pr: number })
  | (FactPlace & { kind: 'launch'; profile: string | undefined; workerId: string | undefined });

type EvidenceKind =
  | 'publication'
  | 'reviewCapture'
  | 'fixCapture'
  | 'feedbackRound'
  | 'checkFailure'
  | 'qaLaunch'
  | 'workerId';

export interface MissingEvidence extends FactPlace {
  tool: string;
  reason: string;
  affects: EvidenceKind[];
}

export interface TaskEvidence {
  facts: TaskFact[];
  missing: MissingEvidence[];
}

export type Count = number | 'unknown';

export interface TaskCounts {
  publications: Count;
  reviewCaptures: Count;
  fixCaptures: Count;
  feedbackRounds: Count;
  checkFailures: Count;
  qaLaunches: Count;
  launches: Count;
}

type CallEvidence = { fact: TaskFact } | { missing: MissingEvidence } | undefined;

const qaProfile = 'qa';

const actions: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set([
    'prepare',
    'target',
    'evidence',
    'checkHeader',
    'reuse',
    'verify',
    'reviewBots',
    'coverage',
  ]),
  pr_feedback: new Set(['read', 'checks', 'post', 'status']),
  code_review: new Set(['prepare', 'capture', 'freshness', 'evidence']),
};

const affectedByTool: Readonly<Record<string, EvidenceKind[]>> = {
  pr: ['publication'],
  pr_feedback: ['feedbackRound'],
  code_review: ['reviewCapture', 'fixCapture'],
};

const placeOf = (call: ToolCall): FactPlace => ({
  entryId: call.entryId,
  callId: call.callId,
  timestamp: call.timestamp,
});

const missing = (call: ToolCall, reason: string, affects: EvidenceKind[]): CallEvidence => ({
  missing: { ...placeOf(call), tool: call.tool, reason, affects },
});

const succeeded = (call: ToolCall) => call.result !== undefined && call.result.error === undefined;

const positiveInteger = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

export const namedPullRequest = (call: ToolCall): number | undefined =>
  positiveInteger(call.arguments?.pr);

export const publicationOf = (call: ToolCall): { repository: string; pr: number } | undefined => {
  const repository = text(call.arguments?.repository);
  const pr = namedPullRequest(call);
  const isVerify = call.tool === 'pr' && call.arguments?.action === 'verify';
  const namesPullRequest = repository !== undefined && pr !== undefined;

  if (!isVerify || !succeeded(call) || !namesPullRequest) {
    return undefined;
  }

  return { repository, pr };
};

// Returns the action of a pr, pr_feedback, or code_review call, or the reason its shape is unknown.
const actionOf = (call: ToolCall): { action: string } | { reason: string } => {
  if (call.arguments === undefined) {
    return { reason: 'The arguments are not an object.' };
  }

  const action = text(call.arguments.action);

  if (action === undefined || actions[call.tool]?.has(action) !== true) {
    return { reason: `The action ${JSON.stringify(call.arguments.action)} is unknown.` };
  }

  return { action };
};

const prEvidence = (call: ToolCall, action: string): CallEvidence => {
  if (action !== 'verify') {
    return undefined;
  }

  const publication = publicationOf(call);

  if (publication === undefined) {
    return missing(call, 'verify has no repository or numeric pr.', ['publication']);
  }

  return { fact: { ...placeOf(call), kind: 'publication', ...publication } };
};

const feedbackEvidence = (call: ToolCall, action: string): CallEvidence => {
  if (action !== 'read') {
    return undefined;
  }

  const pr = namedPullRequest(call);

  if (pr === undefined) {
    return missing(call, 'read has no numeric pr.', ['feedbackRound']);
  }

  return { fact: { ...placeOf(call), kind: 'feedbackRound', pr } };
};

const reviewEvidence = (call: ToolCall, action: string): CallEvidence => {
  if (action !== 'capture') {
    return undefined;
  }

  const target = call.arguments?.target;
  const kind = isRecord(target) ? text(target.kind) : undefined;

  if (kind === undefined) {
    return missing(call, 'capture has no target kind.', ['reviewCapture', 'fixCapture']);
  }

  return { fact: { ...placeOf(call), kind: kind === 'fix' ? 'fixCapture' : 'reviewCapture' } };
};

const actionEvidence = (call: ToolCall): CallEvidence => {
  const shape = actionOf(call);

  if ('reason' in shape) {
    return missing(call, shape.reason, affectedByTool[call.tool] ?? []);
  }

  if (call.tool === 'pr') {
    return prEvidence(call, shape.action);
  }

  return call.tool === 'pr_feedback'
    ? feedbackEvidence(call, shape.action)
    : reviewEvidence(call, shape.action);
};

const checkEvidence = (call: ToolCall): CallEvidence => {
  const passed = call.result?.details?.passed;

  if (passed === false) {
    return { fact: { ...placeOf(call), kind: 'checkFailure' } };
  }

  if (passed === true || !succeeded(call)) {
    return undefined;
  }

  return call.viaCodemode
    ? missing(call, 'A nested call has no result details.', ['checkFailure'])
    : missing(call, 'The result has no passed flag.', ['checkFailure']);
};

const labelsOf = (call: ToolCall) => {
  const labels = call.result?.details?.labels;

  return isRecord(labels) ? labels : {};
};

// An assignment record lives in a folder named after its assignment ID.
const assignmentIdOf = (path: string | undefined) =>
  path === undefined ? undefined : basename(dirname(path));

const workerIdOf = (call: ToolCall): { workerId: string } | { reason: string } => {
  if (call.viaCodemode) {
    return { reason: 'A nested call has no result details.' };
  }

  const workerId =
    text(call.result?.details?.taskId) ?? assignmentIdOf(text(labelsOf(call)['tau.assignment']));

  return workerId === undefined || workerId === ''
    ? { reason: 'The result names no task ID or assignment.' }
    : { workerId };
};

const launchEvidence = (call: ToolCall): CallEvidence[] => {
  if (!succeeded(call)) {
    return [];
  }

  const profile = text(call.arguments?.profile) ?? text(labelsOf(call)['tau.profile']);
  const worker = workerIdOf(call);
  const workerId = 'workerId' in worker ? worker.workerId : undefined;

  const evidence: CallEvidence[] = [
    { fact: { ...placeOf(call), kind: 'launch', profile, workerId } },
  ];

  if (profile === undefined) {
    evidence.push(missing(call, 'The launch names no profile.', ['qaLaunch']));
  }

  if ('reason' in worker) {
    evidence.push(missing(call, worker.reason, ['workerId']));
  }

  return evidence;
};

const callEvidence = (call: ToolCall): CallEvidence[] => {
  if (call.tool === 'subagent') {
    return launchEvidence(call);
  }

  if (call.tool === 'full_check') {
    return [checkEvidence(call)];
  }

  return actions[call.tool] !== undefined && succeeded(call) ? [actionEvidence(call)] : [];
};

export const extractTaskEvidence = (calls: readonly ToolCall[]): TaskEvidence => {
  const evidence: TaskEvidence = { facts: [], missing: [] };

  for (const item of calls.flatMap(callEvidence)) {
    if (item !== undefined && 'fact' in item) {
      evidence.facts.push(item.fact);
    }

    if (item !== undefined && 'missing' in item) {
      evidence.missing.push(item.missing);
    }
  }

  return evidence;
};

const countOf = (
  evidence: TaskEvidence,
  kind: EvidenceKind,
  matches: (fact: TaskFact) => boolean,
): Count =>
  evidence.missing.some((item) => item.affects.includes(kind))
    ? 'unknown'
    : evidence.facts.filter(matches).length;

export const countTaskFacts = (evidence: TaskEvidence): TaskCounts => ({
  publications: countOf(evidence, 'publication', (fact) => fact.kind === 'publication'),
  reviewCaptures: countOf(evidence, 'reviewCapture', (fact) => fact.kind === 'reviewCapture'),
  fixCaptures: countOf(evidence, 'fixCapture', (fact) => fact.kind === 'fixCapture'),
  feedbackRounds: countOf(evidence, 'feedbackRound', (fact) => fact.kind === 'feedbackRound'),
  checkFailures: countOf(evidence, 'checkFailure', (fact) => fact.kind === 'checkFailure'),
  qaLaunches: countOf(
    evidence,
    'qaLaunch',
    (fact) => fact.kind === 'launch' && fact.profile === qaProfile,
  ),
  launches: evidence.facts.filter((fact) => fact.kind === 'launch').length,
});
