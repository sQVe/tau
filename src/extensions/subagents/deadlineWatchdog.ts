import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { currentTerminalAddress, get, kill, send } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { readAssignment } from './assignment.js';
import { decideDeadline } from './deadlineDecision.js';
import type {
  DeadlineAssignment,
  DeadlineChildFact,
  DeadlineKill,
  DeadlineTimer,
} from './deadlineDecision.js';
import type { ChildAssignment, WorkerChildRead, WorkerDelivery } from './workerDelivery.js';

export type DeadlineWatchdogContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;

export interface DeadlineWatchdog {
  apply: (
    context: DeadlineWatchdogContext,
    managerTerminal: string,
    children: readonly WorkerChildRead[],
  ) => Promise<void>;
  clear: () => void;
}

interface ArmedTimers {
  warn: ReturnType<typeof setTimeout>;
  killTimer: ReturnType<typeof setTimeout>;
  warnAt: number;
  killAt: number;
}

const millisecondsPerSecond = 1000;

const deadlineAssignment = (assignment: ChildAssignment): DeadlineAssignment => {
  if (assignment.kind === 'none') {
    return { kind: 'none' };
  }

  if (assignment.kind === 'unread') {
    return { kind: 'unread', message: assignment.message };
  }

  if (assignment.kind === 'missing') {
    return { kind: 'missing', path: assignment.path };
  }

  if (assignment.kind === 'malformed') {
    return { kind: 'malformed', path: assignment.path, message: assignment.message };
  }

  return {
    kind: 'saved',
    path: assignment.path,
    assignmentId: assignment.assignment.assignmentId,
    deadline: assignment.assignment.deadline,
    reported: assignment.assignment.report !== null,
  };
};

const savedReport = async (path: string): Promise<boolean> => {
  try {
    const assignment = await readAssignment(path);

    return assignment?.report != null;
  } catch {
    return false;
  }
};

const childFact = (child: WorkerChildRead): DeadlineChildFact => ({
  address: child.terminal.address,
  parent: child.terminal.parent ?? undefined,
  state: child.terminal.state,
  labels: child.terminal.labels,
  assignment: deadlineAssignment(child.assignment),
});

const warningText = (timer: DeadlineTimer): string => {
  const seconds = Math.max(0, Math.ceil((timer.killAt - Date.now()) / millisecondsPerSecond));

  return `Deadline in ${seconds} s: call subagent_report now with what you have; blockerKind time is accepted.`;
};

const isLiveTarget = (
  terminal: HcTerminal,
  managerTerminal: string,
  target: DeadlineTimer | DeadlineKill,
): boolean =>
  terminal.parent === managerTerminal &&
  terminal.labels?.['tau.assignment'] === target.assignmentPath &&
  terminal.state === 'live';

export const createDeadlineWatchdog = (
  hc: HcRuntime,
  delivery: WorkerDelivery,
): DeadlineWatchdog => {
  const armed = new Map<string, ArmedTimers>();
  let stopped = false;

  // Read through a function so TypeScript does not narrow the flag across awaits.
  const isStopped = (): boolean => stopped;

  const clearAddress = (address: string): void => {
    const entry = armed.get(address);

    if (entry === undefined) {
      return;
    }

    clearTimeout(entry.warn);
    clearTimeout(entry.killTimer);
    armed.delete(address);
  };

  const reportKillProblem = (
    context: DeadlineWatchdogContext,
    key: string,
    message: string,
    error: unknown,
  ): void => {
    if (isStopped()) {
      return;
    }

    notifyOnce(
      context.ui,
      'worker-deadline-kill',
      key,
      `${message} ${errorMessage(error)}`,
      'error',
    );
  };

  const warn = async (context: DeadlineWatchdogContext, timer: DeadlineTimer): Promise<void> => {
    if (isStopped()) {
      return;
    }

    try {
      await send(hc, timer.address, { text: warningText(timer) });
    } catch (error) {
      if (isStopped()) {
        return;
      }

      notifyOnce(
        context.ui,
        'worker-deadline-warning',
        timer.address,
        `Warning ${timer.address} failed: ${errorMessage(error)}`,
        'error',
      );
    }
  };

  const killAtDeadline = async (
    context: DeadlineWatchdogContext,
    target: DeadlineTimer | DeadlineKill,
  ): Promise<void> => {
    if (isStopped()) {
      return;
    }

    const managerTerminal = currentTerminalAddress();

    if (managerTerminal === undefined) {
      return;
    }

    let terminal: HcTerminal;

    try {
      terminal = await get(hc, target.address);
    } catch (error) {
      reportKillProblem(
        context,
        `get:${target.address}`,
        `Reading ${target.address} failed:`,
        error,
      );

      return;
    }

    if (isStopped() || !isLiveTarget(terminal, managerTerminal, target)) {
      return;
    }

    if (await savedReport(target.assignmentPath)) {
      return;
    }

    if (isStopped()) {
      return;
    }

    try {
      await kill(hc, target.address);
    } catch (error) {
      reportKillProblem(
        context,
        `kill:${target.address}`,
        `Ending ${target.address} failed:`,
        error,
      );

      return;
    }

    if (isStopped()) {
      return;
    }

    if (target.assignmentId !== undefined) {
      delivery.showEnded(context, target.assignmentId);
    }
  };

  const arm = (context: DeadlineWatchdogContext, timer: DeadlineTimer): void => {
    if (isStopped()) {
      return;
    }

    const warnTimer = setTimeout(
      () => {
        warn(context, timer).catch((error: unknown) => {
          if (isStopped()) {
            return;
          }

          notifyOnce(
            context.ui,
            'worker-deadline',
            `warn:${timer.address}`,
            `Deadline warning for ${timer.address} failed: ${errorMessage(error)}`,
            'error',
          );
        });
      },
      Math.max(0, timer.warnAt - Date.now()),
    );

    const killTimer = setTimeout(
      () => {
        killAtDeadline(context, timer).catch((error: unknown) => {
          if (isStopped()) {
            return;
          }

          notifyOnce(
            context.ui,
            'worker-deadline',
            `kill:${timer.address}`,
            `Deadline kill for ${timer.address} failed: ${errorMessage(error)}`,
            'error',
          );
        });
      },
      Math.max(0, timer.killAt - Date.now()),
    );

    armed.set(timer.address, {
      warn: warnTimer,
      killTimer,
      warnAt: timer.warnAt,
      killAt: timer.killAt,
    });
  };

  const apply = async (
    context: DeadlineWatchdogContext,
    managerTerminal: string,
    children: readonly WorkerChildRead[],
  ): Promise<void> => {
    if (isStopped()) {
      return;
    }

    const plan = decideDeadline({
      managerTerminal,
      now: Date.now(),
      children: children.map(childFact),
    });

    for (const error of plan.errors) {
      notifyOnce(context.ui, 'worker-deadline', error.key, error.message, 'error');
    }

    const wanted = new Set(plan.armed.map((timer) => timer.address));

    // A failed read is inconclusive, so its known deadline timers stay armed.
    const inconclusive = new Set(
      children
        .filter((child) => child.assignment.kind === 'unread')
        .map((child) => child.terminal.address),
    );

    for (const timer of plan.armed) {
      const current = armed.get(timer.address);

      if (
        current !== undefined &&
        current.warnAt === timer.warnAt &&
        current.killAt === timer.killAt
      ) {
        continue;
      }

      clearAddress(timer.address);
      arm(context, timer);
    }

    for (const address of armed.keys()) {
      if (!wanted.has(address) && !inconclusive.has(address)) {
        clearAddress(address);
      }
    }

    await Promise.all(plan.kills.map((target) => killAtDeadline(context, target)));
  };

  return {
    apply,
    clear: () => {
      stopped = true;

      for (const address of armed.keys()) {
        clearAddress(address);
      }
    },
  };
};
