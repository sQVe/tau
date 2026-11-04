import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../config/config.js';
import { errorMessage } from '../../errors.js';
import { currentTerminalAddress, get, kill, send } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { readAssignment } from './assignment.js';
import { decideDeadline, retryDelay, reuseArmedTimer } from './deadlineDecision.js';
import type {
  DeadlineAssignment,
  DeadlineChildFact,
  DeadlineKill,
  DeadlineTimer,
} from './deadlineDecision.js';
import type { ChildAssignment, WorkerChildRead, WorkerDelivery } from './workerDelivery.js';

export type DeadlineWatchdogContext = Pick<
  ExtensionContext,
  'sessionManager' | 'ui' | 'isIdle' | 'signal'
>;

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
    parentSession: assignment.assignment.parentSession,
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

  const retries = new Map<string, ReturnType<typeof setTimeout>>();

  const clearRetry = (address: string): void => {
    const timer = retries.get(address);

    if (timer === undefined) {
      return;
    }

    clearTimeout(timer);
    retries.delete(address);
  };

  const scheduleRetry = (
    context: DeadlineWatchdogContext,
    target: DeadlineTimer | DeadlineKill,
    attempt: number,
    run: () => Promise<void>,
  ): void => {
    if (isStopped()) {
      return;
    }

    const delay = retryDelay(attempt);

    if (delay === undefined) {
      return;
    }

    clearRetry(target.address);

    const timer = setTimeout(() => {
      retries.delete(target.address);

      run().catch((error: unknown) => {
        if (isStopped()) {
          return;
        }

        notifyOnce(
          context.ui,
          'worker-deadline',
          `kill:${target.address}`,
          `Deadline kill for ${target.address} failed: ${errorMessage(error)}`,
          'error',
        );
      });
    }, delay);

    retries.set(target.address, timer);
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

  const showEndedNotice = (
    context: DeadlineWatchdogContext,
    target: DeadlineKill | DeadlineTimer,
  ): void => {
    if (target.assignmentId === undefined || target.parentSession === undefined) {
      return;
    }

    delivery.showEnded(context, target.assignmentId, target.parentSession);
  };

  const killAtDeadline = async (
    context: DeadlineWatchdogContext,
    target: DeadlineTimer | DeadlineKill,
    attempt = 0,
  ): Promise<void> => {
    if (isStopped()) {
      return;
    }

    clearRetry(target.address);

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

      scheduleRetry(context, target, attempt, () => killAtDeadline(context, target, attempt + 1));

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

      scheduleRetry(context, target, attempt, () => killAtDeadline(context, target, attempt + 1));

      return;
    }

    if (isStopped()) {
      return;
    }

    showEndedNotice(context, target);
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

    const inconclusive = new Set(
      children
        .filter((child) => child.assignment.kind === 'unread')
        .map((child) => child.terminal.address),
    );

    for (const timer of plan.armed) {
      const current = armed.get(timer.address);

      if (reuseArmedTimer(current, timer)) {
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

    const killing = new Set(plan.kills.map((target) => target.address));

    for (const address of retries.keys()) {
      if (!killing.has(address) && !inconclusive.has(address)) {
        clearRetry(address);
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

      for (const address of retries.keys()) {
        clearRetry(address);
      }
    },
  };
};
