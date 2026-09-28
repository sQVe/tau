import { join } from 'node:path';

import type { ThemeColor } from '@earendil-works/pi-coding-agent';

import type { WorkerActivity } from './activity.js';
import { capReportText } from './reportCap.js';
import type { WorkerState } from './types.js';
import { showsActivity } from './workerState.js';

// The single label table for worker states. Wording credits the worker and never claims a stop
// or an acknowledgement that the saved records do not prove.
export interface StateLabel {
  icon: string;
  color: ThemeColor;
  text: string;
}

// Model content copies named fields. Never filter, delete, or infer fields from a full record.
interface StatusQuestion {
  questionId?: string | undefined;
  question?: string | undefined;
  replySaved?: boolean | undefined;
}

interface QuestionReceiptInput {
  question?: { questionId?: string | undefined } | undefined;
  reply?: unknown;
  acknowledgement?: unknown;
}

export interface StatusInput {
  taskId: string;
  state: WorkerState;
  deadline: number;
  directory?: string | undefined;
  activity?: WorkerActivity | undefined;
  name?: string | undefined;
  outcome?: string | undefined;
  predecessorTaskId?: string | undefined;
  successorTaskId?: string | undefined;
  report?: unknown;
  pendingQuestion?: StatusQuestion | undefined;
  failure?: string | undefined;
  cleanup?: string | undefined;
  questionReceipt?: QuestionReceiptInput | undefined;
  recovery?: unknown;
  placement?: { visibility: string; reason?: string } | undefined;
}

export interface ReplyReceiptInput {
  questionId?: string | undefined;
  replyAccepted: boolean;
  workerAcknowledged?: boolean | undefined;
  delivery: string;
  deliveryError?: string | undefined;
}

export interface EvidenceNoticeInput {
  taskId: string;
  name?: string | undefined;
  evidenceError: string;
  recovery: unknown;
}

export interface WorkerNotice {
  content: Record<string, unknown>;
  details: unknown;
  question: boolean;
}

export interface HandoffSections {
  present: HandoffSection[];
  missing: HandoffSection[];
}

export const stateLabels: Record<WorkerState, StateLabel> = {
  starting: { icon: '○', color: 'muted', text: 'starting' },
  running: { icon: '●', color: 'accent', text: 'running' },
  awaitingReply: { icon: '?', color: 'accent', text: 'asks' },
  reported: { icon: '◐', color: 'warning', text: 'reported' },
  stopping: { icon: '◐', color: 'warning', text: 'stopping' },
  stopped: { icon: '◐', color: 'warning', text: 'stopped' },
  cleanupUnconfirmed: { icon: '!', color: 'error', text: 'cleanup unconfirmed' },
  notOwned: { icon: '◇', color: 'muted', text: 'may still be running' },
};

// Only a saved report outcome tells a stopped worker apart. Only success earns the check mark.
const stoppedOutcomeLabels: Record<string, StateLabel> = {
  success: { icon: '✓', color: 'success', text: 'reported success · stopped' },
  failure: { icon: '✗', color: 'error', text: 'stopped · failure' },
  incomplete: { icon: '◐', color: 'warning', text: 'stopped · incomplete' },
};

const stoppedUnknownLabel: StateLabel = { icon: '◐', color: 'warning', text: 'stopped' };

export const stateLabel = (state: WorkerState, outcome?: string): StateLabel => {
  if (state !== 'stopped') {
    return stateLabels[state];
  }

  if (outcome === undefined || !Object.hasOwn(stoppedOutcomeLabels, outcome)) {
    return stoppedUnknownLabel;
  }

  return stoppedOutcomeLabels[outcome] ?? stoppedUnknownLabel;
};

const addField = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const handoffSectionNames = ['Changes', 'Evidence', 'Decisions', 'Concerns'] as const;

type HandoffSection = (typeof handoffSectionNames)[number];

// A heading starts its line, may carry Markdown marks, and ends at a colon, parenthesis, or line end.
const summaryHasHeading = (summary: string, name: string): boolean =>
  new RegExp(`^[\\s#*>-]*${name}\\**\\s*(?::|\\(|$)`, 'im').test(summary);

// Presence means the saved summary contains a section heading with that name. The scan reports the
// missing handoff sections; it does not read evidence strings, verify content, or claim freshness.
export const handoffSections = (report: unknown): HandoffSections | undefined => {
  if (!isRecord(report)) {
    return undefined;
  }

  const summary = typeof report.summary === 'string' ? report.summary : '';
  const present = handoffSectionNames.filter((name) => summaryHasHeading(summary, name));
  const presentSet = new Set(present);

  return {
    present,
    missing: handoffSectionNames.filter((name) => !presentSet.has(name)),
  };
};

const modelQuestion = (
  question: StatusQuestion | undefined,
): Record<string, unknown> | undefined => {
  if (!question) {
    return undefined;
  }

  const result: Record<string, unknown> = {};

  addField(result, 'questionId', question.questionId);
  addField(result, 'question', question.question);
  addField(result, 'replySaved', question.replySaved);

  return result;
};

const modelQuestionReceipt = (
  receipt: QuestionReceiptInput | undefined,
): Record<string, unknown> | undefined => {
  if (!receipt) {
    return undefined;
  }

  return {
    questionId: receipt.question?.questionId,
    replyAccepted: Boolean(receipt.reply),
    workerAcknowledged: Boolean(receipt.acknowledgement),
  };
};

const modelActivity = (status: StatusInput): Record<string, unknown> | undefined => {
  const { activity } = status;

  if (!activity || !showsActivity(status.state)) {
    return undefined;
  }

  const result: Record<string, unknown> = { phase: activity.phase };

  addField(result, 'description', activity.description);
  result.updatedAt = activity.updatedAt;
  addField(result, 'usage', activity.usage);

  return result;
};

const cappedReport = (report: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(report) || typeof report.summary !== 'string' || !Array.isArray(report.evidence)) {
    return undefined;
  }

  const evidence = report.evidence.filter((entry): entry is string => typeof entry === 'string');
  const capped = capReportText(report.summary, evidence);

  if (!capped) {
    return undefined;
  }

  return {
    taskId: report.taskId,
    outcome: report.outcome,
    summary: capped.summary,
    evidence: capped.evidence,
  };
};

const addReport = (target: Record<string, unknown>, status: StatusInput): void => {
  const capped = cappedReport(status.report);

  if (!capped) {
    addField(target, 'report', status.report);

    return;
  }

  target.report = capped;
  target.truncated = true;

  addField(
    target,
    'reportFile',
    status.directory === undefined ? undefined : join(status.directory, 'report.json'),
  );
};

export const modelStatus = (status: StatusInput): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    taskId: status.taskId,
    state: status.state,
    deadline: status.deadline,
  };

  addField(result, 'name', status.name);
  addField(result, 'placement', status.placement);
  addField(result, 'outcome', status.outcome);
  addField(result, 'activity', modelActivity(status));
  addField(result, 'predecessorTaskId', status.predecessorTaskId);
  addField(result, 'successorTaskId', status.successorTaskId);
  addReport(result, status);
  addField(result, 'handoffSections', handoffSections(status.report));
  addField(result, 'pendingQuestion', modelQuestion(status.pendingQuestion));
  addField(result, 'failure', status.failure);
  addField(result, 'cleanup', status.cleanup);
  addField(result, 'questionReceipt', modelQuestionReceipt(status.questionReceipt));

  if (status.state === 'cleanupUnconfirmed' || status.state === 'notOwned') {
    addField(result, 'recovery', status.recovery);
  }

  return result;
};

export const modelReply = (taskId: string, receipt: ReplyReceiptInput): Record<string, unknown> => {
  const result: Record<string, unknown> = { taskId };

  addField(result, 'questionId', receipt.questionId);
  result.replyAccepted = receipt.replyAccepted;
  addField(result, 'workerAcknowledged', receipt.workerAcknowledged);
  result.delivery = receipt.delivery;
  addField(result, 'deliveryError', receipt.deliveryError);

  return result;
};

export const modelEvidenceNotice = (input: EvidenceNoticeInput): Record<string, unknown> => {
  const result: Record<string, unknown> = { taskId: input.taskId };

  addField(result, 'name', input.name);
  result.evidenceError = input.evidenceError;
  result.recovery = input.recovery;

  return result;
};
