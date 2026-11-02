import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { currentTerminalAddress, get, ls } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { isRecord } from '../../schema.js';
import { readAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { decideReportDelivery } from './reportDecision.js';
import type { ReportReadFact } from './reportDecision.js';
import { reportMessageType } from './reportMessage.js';

type ReportDeliveryContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;

export interface ReportDelivery {
  deliver: (context: ReportDeliveryContext) => Promise<void>;
}

const evidenceText = (report: Assignment['report']): string => {
  const evidence = report?.evidence ?? [];

  return evidence.length === 0
    ? ''
    : `\n\nEvidence:\n${evidence.map((item) => `- ${item}`).join('\n')}`;
};

const reportText = (assignmentId: string, report: Assignment['report']): string =>
  `Worker report ${assignmentId}: ${report?.outcome ?? 'unknown'}\n\n${report?.summary ?? ''}${evidenceText(report)}`;

const shownIdFromEntry = (entry: {
  type: string;
  customType?: string;
  details?: unknown;
}): string | undefined => {
  if (entry.type !== 'custom_message' || entry.customType !== reportMessageType) {
    return undefined;
  }

  const details = entry.details;

  return isRecord(details) && typeof details['assignmentId'] === 'string'
    ? details['assignmentId']
    : undefined;
};

const restoreShownIds = (context: ReportDeliveryContext): Set<string> => {
  const shown = new Set<string>();

  for (const entry of context.sessionManager.getEntries()) {
    const assignmentId = shownIdFromEntry(entry);

    if (assignmentId !== undefined) {
      shown.add(assignmentId);
    }
  }

  return shown;
};

const readFact = async (terminal: HcTerminal): Promise<ReportReadFact> => {
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

  if (assignment.report === null) {
    return { kind: 'no-report' };
  }

  return { kind: 'report', assignmentId: assignment.assignmentId, report: assignment.report };
};

const childFact = async (hc: HcRuntime, child: HcTerminal): Promise<ReportReadFact> => {
  try {
    return await readFact(await get(hc, child.address));
  } catch (error) {
    return { kind: 'error', message: `Reading ${child.address} failed: ${errorMessage(error)}` };
  }
};

export const createReportDelivery = (pi: ExtensionAPI, hc: HcRuntime): ReportDelivery => {
  let tail: Promise<void> = Promise.resolve();
  const queuedIds = new Set<string>();

  const run = async (context: ReportDeliveryContext): Promise<void> => {
    const managerTerminal = currentTerminalAddress();

    if (managerTerminal === undefined) {
      return;
    }

    const list = await ls(hc, { all: true });
    const children = list.terminals.filter((terminal) => terminal.parent === managerTerminal);
    const facts = await Promise.all(children.map((child) => childFact(hc, child)));

    const shownIds = new Set([...restoreShownIds(context), ...queuedIds]);

    const plan = decideReportDelivery({ shownIds: [...shownIds], facts });

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

      queuedIds.add(assignmentId);
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
