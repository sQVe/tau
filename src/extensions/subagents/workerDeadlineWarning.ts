import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { Wake } from '../../wake/wake.js';
import { hasSavedReport } from './assignment.js';
import { deadlineWarningDelay } from './deadlineDecision.js';
import type { ReportTarget } from './report.js';

type DeadlineWarningContext = Pick<ExtensionContext, 'isIdle' | 'signal'>;

export interface WorkerDeadlineWarning {
  arm: (context: DeadlineWarningContext, target: ReportTarget) => void;
  clear: () => void;
}

const millisecondsPerSecond = 1000;

const deadlineWarningText = (deadline: number, now: number): string => {
  const seconds = Math.max(0, Math.ceil((deadline - now) / millisecondsPerSecond));

  return `Deadline in ${seconds} s: call subagent_report now with what you have; blockerKind time is accepted.`;
};

export const createWorkerDeadlineWarning = (wake: Wake): WorkerDeadlineWarning => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let used = false;
  let cleared = false;

  const fire = async (context: DeadlineWarningContext, target: ReportTarget): Promise<void> => {
    if (await hasSavedReport(target.assignmentPath)) {
      return;
    }

    if (cleared) {
      return;
    }

    wake(context, {
      customType: 'tau-worker-deadline-warning',
      content: deadlineWarningText(target.assignment.deadline, Date.now()),
      display: true,
    });
  };

  return {
    arm: (context, target) => {
      if (used) {
        return;
      }

      used = true;

      timer = setTimeout(
        () => {
          timer = undefined;

          fire(context, target).catch(() => undefined);
        },
        deadlineWarningDelay(target.assignment.deadline, Date.now()),
      );
    },
    clear: () => {
      used = true;
      cleared = true;

      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
};
