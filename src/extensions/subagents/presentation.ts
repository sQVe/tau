import type { WorkerState } from './types.js';

// Model content copies named fields. Never filter, delete, or infer fields from a full record.
export interface StatusQuestion {
  questionId?: string | undefined;
  question?: string | undefined;
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

const modelQuestion = (
  question: StatusQuestion | undefined,
): Record<string, unknown> | undefined => {
  if (!question) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  addField(result, 'questionId', question.questionId);
  addField(result, 'question', question.question);

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
  addField(result, 'submissionReceipt', modelSubmissionReceipt(status.submissionReceipt));
  addField(result, 'nativeOutput', status.nativeOutput);
  if (status.state === 'cleanupUnconfirmed' || status.state === 'notOwned') {
    addField(result, 'recovery', status.recovery);
    addField(result, 'capacityHeld', status.capacityHeld);
    addField(result, 'unconfirmedChildren', modelChildren(status.unconfirmedChildren));
    addField(result, 'descendantEvidence', status.descendantEvidence);
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
