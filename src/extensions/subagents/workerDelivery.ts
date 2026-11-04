import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { get, ls } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { isRecord } from '../../schema.js';
import { createWake } from '../../wake/wake.js';
import { readAssignment } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { deadlineEndLabel } from './deadlineDecision.js';
import {
  deadlineKey,
  decideWorkerDelivery,
  endedKey,
  isCurrentSession,
  questionKey,
  reportKey,
} from './workerDecision.js';
import type { WorkerReadFact } from './workerDecision.js';
import {
  deadlineMessageType,
  endedMessageType,
  questionMessageType,
  reportMessageType,
} from './workerMessage.js';

type WorkerDeliveryContext = Pick<ExtensionContext, 'sessionManager' | 'ui' | 'isIdle' | 'signal'>;

export interface WorkerDelivery {
  deliver: (context: WorkerDeliveryContext, children: readonly WorkerChildRead[]) => void;
  showEnded: (context: WorkerDeliveryContext, assignmentId: string, parentSession: string) => void;
  markDeadlinePending: (assignmentId: string) => void;
  clearDeadlinePending: (assignmentId: string) => void;
}

export type ChildAssignment =
  | { kind: 'none' }
  | { kind: 'unread'; message: string }
  | { kind: 'missing'; path: string }
  | { kind: 'malformed'; path: string; message: string }
  | { kind: 'saved'; path: string; assignment: Assignment };

export interface WorkerChildRead {
  terminal: HcTerminal;
  assignment: ChildAssignment;
}

const evidenceText = (report: Assignment['report']): string => {
  const evidence = report?.evidence ?? [];

  return evidence.length === 0
    ? ''
    : `\n\nEvidence:\n${evidence.map((item) => `- ${item}`).join('\n')}`;
};

const reportText = (assignmentId: string, report: Assignment['report']): string =>
  `Worker report ${assignmentId}: ${report?.outcome ?? 'unknown'}\n\n${report?.summary ?? ''}${evidenceText(report)}`;

const endedText = (assignmentId: string, address: string): string =>
  `Worker ${assignmentId} at ${address} ended without a report. Read its screen with hc read ${address}.`;

const deadlineText = (assignmentId: string): string =>
  `Worker ${assignmentId} was ended at its deadline.`;

const questionText = (assignmentId: string, address: string, question: SavedQuestion): string =>
  `Worker question ${assignmentId} from ${address}:\n\n${question.text}\n\nAnswer with \`hc send ${address} "<answer>"\`. Never use --force. If hc refuses the send, report that to the user and do not force it.`;

const shownKeyFromEntry = (entry: {
  type: string;
  customType?: string;
  details?: unknown;
}): string | undefined => {
  if (entry.type !== 'custom_message' || !isRecord(entry.details)) {
    return undefined;
  }

  const assignmentId = entry.details['assignmentId'];
  const questionId = entry.details['questionId'];

  if (typeof assignmentId !== 'string') {
    return undefined;
  }

  if (entry.customType === reportMessageType) {
    return reportKey(assignmentId);
  }

  if (entry.customType === questionMessageType && typeof questionId === 'string') {
    return questionKey(assignmentId, questionId);
  }

  if (entry.customType === deadlineMessageType) {
    return deadlineKey(assignmentId);
  }

  if (entry.customType === endedMessageType) {
    return endedKey(assignmentId);
  }

  return undefined;
};

const restoreShownKeys = (context: WorkerDeliveryContext): Set<string> => {
  const shown = new Set<string>();

  for (const entry of context.sessionManager.getEntries()) {
    const key = shownKeyFromEntry(entry);

    if (key !== undefined) {
      shown.add(key);
    }
  }

  return shown;
};

export const readWorkerChild = async (
  hc: HcRuntime,
  child: HcTerminal,
): Promise<WorkerChildRead> => {
  let terminal: HcTerminal;

  try {
    terminal = await get(hc, child.address);
  } catch (error) {
    return {
      terminal: child,
      assignment: {
        kind: 'unread',
        message: `Reading ${child.address} failed: ${errorMessage(error)}`,
      },
    };
  }

  const path = terminal.labels?.['tau.assignment'];

  if (path === undefined || path === '') {
    return { terminal, assignment: { kind: 'none' } };
  }

  try {
    const assignment = await readAssignment(path);

    return assignment === undefined
      ? { terminal, assignment: { kind: 'missing', path } }
      : { terminal, assignment: { kind: 'saved', path, assignment } };
  } catch (error) {
    return { terminal, assignment: { kind: 'malformed', path, message: errorMessage(error) } };
  }
};

export const readWorkerChildren = async (
  hc: HcRuntime,
  managerTerminal: string,
): Promise<WorkerChildRead[]> => {
  const list = await ls(hc, { all: true });
  const children = list.terminals.filter((terminal) => terminal.parent === managerTerminal);

  return Promise.all(children.map((child) => readWorkerChild(hc, child)));
};

const isEndedAtDeadline = (labels: HcTerminal['labels']): boolean =>
  labels?.[deadlineEndLabel.key] === deadlineEndLabel.value;

const deliveryFact = (
  child: WorkerChildRead,
  sessionFile: string | undefined,
  isDeadlinePending: (assignmentId: string) => boolean,
): WorkerReadFact => {
  const { assignment } = child;

  if (assignment.kind === 'none') {
    return { kind: 'skip' };
  }

  if (assignment.kind === 'unread') {
    return { kind: 'error', message: assignment.message };
  }

  if (assignment.kind === 'missing') {
    return { kind: 'error', message: `Missing assignment file: ${assignment.path}.` };
  }

  if (assignment.kind === 'malformed') {
    return { kind: 'error', message: assignment.message };
  }

  if (!isCurrentSession(assignment.assignment.parentSession, sessionFile)) {
    return { kind: 'skip' };
  }

  return {
    kind: 'assignment',
    assignmentId: assignment.assignment.assignmentId,
    address: child.terminal.address,
    state: child.terminal.state,
    report: assignment.assignment.report,
    questions: assignment.assignment.questions,
    endedAtDeadline:
      isEndedAtDeadline(child.terminal.labels) ||
      isDeadlinePending(assignment.assignment.assignmentId),
  };
};

export const createWorkerDelivery = (pi: ExtensionAPI): WorkerDelivery => {
  const queuedKeys = new Set<string>();
  const deadlinePending = new Set<string>();
  const wake = createWake(pi);

  const showDeadline = (context: WorkerDeliveryContext, assignmentId: string): void => {
    queuedKeys.add(deadlineKey(assignmentId));

    wake(context, {
      customType: deadlineMessageType,
      content: deadlineText(assignmentId),
      display: true,
      details: { assignmentId },
    });
  };

  const deliver = (context: WorkerDeliveryContext, children: readonly WorkerChildRead[]): void => {
    const sessionFile = context.sessionManager.getSessionFile();

    const facts = children.map((child) =>
      deliveryFact(child, sessionFile, (assignmentId) => deadlinePending.has(assignmentId)),
    );

    const shownKeys = new Set([...restoreShownKeys(context), ...queuedKeys]);

    const plan = decideWorkerDelivery({ shownKeys: [...shownKeys], facts });

    for (const error of plan.errors) {
      notifyOnce(context.ui, 'worker-report-delivery', error, error, 'error');
    }

    for (const { assignmentId, report } of plan.reports) {
      wake(context, {
        customType: reportMessageType,
        content: reportText(assignmentId, report),
        display: true,
        details: { assignmentId, outcome: report.outcome },
      });

      queuedKeys.add(reportKey(assignmentId));
    }

    for (const { assignmentId, address, question } of plan.questions) {
      wake(context, {
        customType: questionMessageType,
        content: questionText(assignmentId, address, question),
        display: true,
        details: { assignmentId, questionId: question.questionId },
      });

      queuedKeys.add(questionKey(assignmentId, question.questionId));
    }

    for (const { assignmentId, address } of plan.ended) {
      wake(context, {
        customType: endedMessageType,
        content: endedText(assignmentId, address),
        display: true,
        details: { assignmentId },
      });

      queuedKeys.add(endedKey(assignmentId));
    }

    for (const { assignmentId } of plan.deadlines) {
      showDeadline(context, assignmentId);
    }
  };

  const showEnded = (
    context: WorkerDeliveryContext,
    assignmentId: string,
    parentSession: string,
  ): void => {
    if (!isCurrentSession(parentSession, context.sessionManager.getSessionFile())) {
      return;
    }

    const key = deadlineKey(assignmentId);
    const ended = endedKey(assignmentId);
    const shown = restoreShownKeys(context);

    if (shown.has(ended) || queuedKeys.has(ended)) {
      return;
    }

    if (shown.has(key) || queuedKeys.has(key)) {
      return;
    }

    showDeadline(context, assignmentId);
  };

  const markDeadlinePending = (assignmentId: string): void => {
    deadlinePending.add(assignmentId);
  };

  const clearDeadlinePending = (assignmentId: string): void => {
    deadlinePending.delete(assignmentId);
  };

  return { deliver, showEnded, markDeadlinePending, clearDeadlinePending };
};
