import type { ThemeColor } from '@earendil-works/pi-coding-agent';

import type { WorkerState } from './types.js';

// The single label table for worker states. Wording credits the worker and never claims a stop
// or an acknowledgement that the saved records do not prove.
export interface StateLabel {
  icon: string;
  color: ThemeColor;
  text: string;
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

  return (outcome === undefined ? undefined : stoppedOutcomeLabels[outcome]) ?? stoppedUnknownLabel;
};

// Model content copies named fields. Never filter, delete, or infer fields from a full record.
export interface StatusQuestion {
  questionId?: string | undefined;
  question?: string | undefined;
  replySaved?: boolean | undefined;
}

export interface QuestionReceiptInput {
  question?: { questionId?: string | undefined } | undefined;
  reply?: unknown;
  acknowledgement?: unknown;
}

export interface SubmissionReceiptInput {
  intent?:
    | { taskId?: string | undefined; id?: string | undefined; text?: string | undefined }
    | undefined;
  observation?:
    | {
        taskId?: string | undefined;
        id?: string | undefined;
        state?: string | undefined;
        detail?: string | undefined;
      }
    | undefined;
  retry?: string | undefined;
}

export interface StatusInput {
  taskId: string;
  state: WorkerState;
  deadline: number;
  name?: string | undefined;
  outcome?: string | undefined;
  predecessorTaskId?: string | undefined;
  successorTaskId?: string | undefined;
  report?: unknown;
  pendingQuestion?: StatusQuestion | undefined;
  failure?: string | undefined;
  cleanup?: string | undefined;
  questionReceipt?: QuestionReceiptInput | undefined;
  nativeState?: string | undefined;
  delivery?: string | undefined;
  observationIssue?: string | undefined;
  submissionReceipt?: SubmissionReceiptInput | undefined;
  nativeOutput?: unknown;
  recovery?: unknown;
  capacityHeld?: boolean | undefined;
  unconfirmedChildren?: { taskId: string; directory?: string | undefined }[] | undefined;
  descendantEvidence?: unknown;
}

export interface ReplyReceiptInput {
  questionId?: string | undefined;
  replyAccepted: boolean;
  workerAcknowledged?: boolean | undefined;
  delivery: string;
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

const addField = (target: Record<string, unknown>, key: string, value: unknown): void => {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
};

// Native observation errors are raw herdr text. Bound them before the model reads them, because the
// full text stays in details for the pilot.
const observationIssueLimit = 200;

const boundedReason = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length <= observationIssueLimit) {
    return value;
  }

  return `${value.slice(0, observationIssueLimit)}…`;
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

const modelSubmissionReceipt = (
  receipt: SubmissionReceiptInput | undefined,
): Record<string, unknown> | undefined => {
  if (!receipt) {
    return undefined;
  }

  const result: Record<string, unknown> = { id: receipt.intent?.id };
  addField(result, 'state', receipt.observation?.state);
  addField(result, 'detail', receipt.observation?.detail);

  return result;
};

const modelChildren = (
  children: { taskId: string; directory?: string | undefined }[] | undefined,
): { taskId: string }[] | undefined => children?.map((child) => ({ taskId: child.taskId }));

export const modelStatus = (status: StatusInput): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    taskId: status.taskId,
    state: status.state,
    deadline: status.deadline,
  };
  addField(result, 'name', status.name);
  addField(result, 'outcome', status.outcome);
  addField(result, 'predecessorTaskId', status.predecessorTaskId);
  addField(result, 'successorTaskId', status.successorTaskId);
  addField(result, 'report', status.report);
  addField(result, 'pendingQuestion', modelQuestion(status.pendingQuestion));
  addField(result, 'failure', status.failure);
  addField(result, 'cleanup', status.cleanup);
  addField(result, 'questionReceipt', modelQuestionReceipt(status.questionReceipt));
  addField(result, 'nativeState', status.nativeState);
  addField(result, 'delivery', status.delivery);
  addField(result, 'observationIssue', boundedReason(status.observationIssue));
  addField(result, 'submissionReceipt', modelSubmissionReceipt(status.submissionReceipt));
  addField(result, 'nativeOutput', status.nativeOutput);

  // A stopped parent can still own a child whose cleanup is unconfirmed; that child may be running
  // and holds capacity (ADR 0031), so descendant warnings never depend on the parent's state.
  if (status.unconfirmedChildren?.length) {
    addField(result, 'unconfirmedChildren', modelChildren(status.unconfirmedChildren));
  }

  addField(result, 'descendantEvidence', status.descendantEvidence);

  if (status.state === 'cleanupUnconfirmed' || status.state === 'notOwned') {
    addField(result, 'recovery', status.recovery);
    addField(result, 'capacityHeld', status.capacityHeld);
  }

  return result;
};

export const modelReply = (taskId: string, receipt: ReplyReceiptInput): Record<string, unknown> => {
  const result: Record<string, unknown> = { taskId };
  addField(result, 'questionId', receipt.questionId);
  result.replyAccepted = receipt.replyAccepted;
  addField(result, 'workerAcknowledged', receipt.workerAcknowledged);
  result.delivery = receipt.delivery;

  return result;
};

export const modelEvidenceNotice = (input: EvidenceNoticeInput): Record<string, unknown> => {
  const result: Record<string, unknown> = { taskId: input.taskId };
  addField(result, 'name', input.name);
  result.evidenceError = input.evidenceError;
  result.recovery = input.recovery;

  return result;
};
