import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { currentTerminalAddress, get, ls } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { isRecord } from '../../schema.js';
import { readAssignment } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { decideWorkerDelivery, questionKey, reportKey } from './workerDecision.js';
import type { WorkerReadFact } from './workerDecision.js';
import { questionMessageType, reportMessageType } from './workerMessage.js';

type WorkerDeliveryContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;

export interface WorkerDelivery {
  deliver: (context: WorkerDeliveryContext) => Promise<void>;
}

const evidenceText = (report: Assignment['report']): string => {
  const evidence = report?.evidence ?? [];

  return evidence.length === 0
    ? ''
    : `\n\nEvidence:\n${evidence.map((item) => `- ${item}`).join('\n')}`;
};

const reportText = (assignmentId: string, report: Assignment['report']): string =>
  `Worker report ${assignmentId}: ${report?.outcome ?? 'unknown'}\n\n${report?.summary ?? ''}${evidenceText(report)}`;

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

const readFact = async (terminal: HcTerminal): Promise<WorkerReadFact> => {
  const path = terminal.labels?.['tau.assignment'];

  if (path === undefined || path === '') {
    return { kind: 'skip' };
  }

  let assignment: Assignment | undefined;

  try {
    assignment = await readAssignment(path);
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }

  if (assignment === undefined) {
    return { kind: 'error', message: `Missing assignment file: ${path}.` };
  }

  return {
    kind: 'assignment',
    assignmentId: assignment.assignmentId,
    address: terminal.address,
    report: assignment.report,
    questions: assignment.questions,
  };
};

const childFact = async (hc: HcRuntime, child: HcTerminal): Promise<WorkerReadFact> => {
  try {
    return await readFact(await get(hc, child.address));
  } catch (error) {
    return { kind: 'error', message: `Reading ${child.address} failed: ${errorMessage(error)}` };
  }
};

export const createWorkerDelivery = (pi: ExtensionAPI, hc: HcRuntime): WorkerDelivery => {
  let tail: Promise<void> = Promise.resolve();
  const queuedKeys = new Set<string>();

  const run = async (context: WorkerDeliveryContext): Promise<void> => {
    const managerTerminal = currentTerminalAddress();

    if (managerTerminal === undefined) {
      return;
    }

    const list = await ls(hc, { all: true });
    const children = list.terminals.filter((terminal) => terminal.parent === managerTerminal);
    const facts = await Promise.all(children.map((child) => childFact(hc, child)));

    const shownKeys = new Set([...restoreShownKeys(context), ...queuedKeys]);

    const plan = decideWorkerDelivery({ shownKeys: [...shownKeys], facts });

    for (const error of plan.errors) {
      notifyOnce(context.ui, 'worker-report-delivery', error, error, 'error');
    }

    for (const { assignmentId, report } of plan.reports) {
      pi.sendMessage({
        customType: reportMessageType,
        content: reportText(assignmentId, report),
        display: true,
        details: { assignmentId, outcome: report.outcome },
      });

      queuedKeys.add(reportKey(assignmentId));
    }

    for (const { assignmentId, address, question } of plan.questions) {
      pi.sendMessage({
        customType: questionMessageType,
        content: questionText(assignmentId, address, question),
        display: true,
        details: { assignmentId, questionId: question.questionId },
      });

      queuedKeys.add(questionKey(assignmentId, question.questionId));
    }
  };

  return {
    deliver: (context) => {
      const next = tail.then(
        () => run(context),
        () => run(context),
      );

      tail = next.catch(() => undefined);

      return next;
    },
  };
};
