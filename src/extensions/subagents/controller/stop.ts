import { setTimeout as delay } from 'node:timers/promises';

import { processAbsent } from '../cancellation.js';
import { decidePiStop } from '../piStop.js';
import type { WorkerPlacement } from '../placement.js';
import {
  listTerminals,
  requireObject,
  resolveTerminal,
  result,
  terminalLocation,
} from '../terminal.js';
import type { TerminalLocation } from '../terminal.js';
import { inspectWorker, isHerdrError } from './inspect.js';
import type { Handle } from './types.js';

export interface StopPiWorkerRequest {
  handle: Handle;
  call: (argumentsList: string[]) => Promise<string>;
  remainingBudget: () => number;
  signal: AbortSignal;
  placement: WorkerPlacement;
  // A finished worker gets a moment to exit by itself before its pane is closed.
  graceful: boolean;
}

interface PiStopProgress {
  terminalId: string;
  graceEnds: number;
  closed: boolean;
}

// The pane's own process is the Pi launched with this task's session.
const runsTaskSession = (response: string, paneId: string, session: string): boolean => {
  const information = requireObject(result(response).process_info);

  const processes = Array.isArray(information.foreground_processes)
    ? information.foreground_processes.map(requireObject)
    : [];

  const root = processes.find((process) => process.pid === information.shell_pid);

  return information.pane_id === paneId && Array.isArray(root?.argv) && root.argv.includes(session);
};

// Without saved ownership, the pane's own process must be the Pi started for this task's session.
const checkUnownedPi = async (
  handle: Handle,
  paneId: string,
  call: (argumentsList: string[]) => Promise<string>,
): Promise<void> => {
  const response = await call(['pane', 'process-info', '--pane', paneId]);

  if (!runsTaskSession(response, paneId, handle.task.nativeSessionFile)) {
    throw new Error('Pane runs another process; pane closure refused.');
  }
};

// After a lost launch reply, the worker is the one pane that is new since the launch and runs this
// task's session. A follow-up shares its predecessor's session, so older panes never count.
const findLaunchedTerminal = async (request: StopPiWorkerRequest): Promise<string | undefined> => {
  const { handle, call } = request;
  const before = handle.startup.terminalsBeforeLaunch;

  if (before === undefined) {
    return undefined;
  }

  const terminals = await listTerminals(call);
  const launched = terminals.filter((pane) => !before.includes(pane.terminalId));

  const matches = await Promise.all(
    launched.map(async (pane) => {
      const response = await call(['pane', 'process-info', '--pane', pane.paneId]).catch(
        () => undefined,
      );

      return response !== undefined &&
        runsTaskSession(response, pane.paneId, handle.task.nativeSessionFile)
        ? pane
        : undefined;
    }),
  );

  const [found, ...others] = matches.filter((pane) => pane !== undefined);

  // Several panes on one session leave the launched one unknown.
  if (found === undefined || others.length > 0) {
    return undefined;
  }

  handle.identity.paneId = found.paneId;
  handle.identity.terminalId = found.terminalId;

  return found.terminalId;
};

const emptyPlacementStep = (): Promise<void> => Promise.resolve();
const gracePeriod = 1000;
const pollInterval = 25;

// A cancelled launch can stop after herdr started Pi but before Tau read the pane's terminal.
// `exited` means herdr already removed the launched pane, which it does only after Pi exits.
const launchedTerminal = async (
  request: StopPiWorkerRequest,
): Promise<string | { exited: true } | undefined> => {
  const { handle, call, signal, placement } = request;

  // Placement is serialized, so this empty step runs after an in-flight launch records its pane.
  if (handle.identity.terminalId === undefined && !handle.startup.neverStarted) {
    await placement.close(emptyPlacementStep, signal).catch(() => undefined);
  }

  const paneId = handle.identity.paneId;

  if (handle.identity.terminalId !== undefined || handle.startup.neverStarted) {
    return handle.identity.terminalId;
  }

  if (paneId === undefined) {
    return findLaunchedTerminal(request);
  }

  try {
    const response = await call(['pane', 'get', paneId]);

    return terminalLocation(result(response).pane).terminalId;
  } catch (error) {
    return isHerdrError(error, 'pane_not_found') ? { exited: true } : undefined;
  }
};

const unlocatedLaunch = (handle: Handle): { stopped: boolean; detail: string } =>
  handle.startup.neverStarted
    ? { stopped: true, detail: 'No worker was started.' }
    : {
        stopped: false,
        detail: `Worker launch is uncertain: herdr confirmed no pane. Check herdr for a Pi pane on ${handle.task.nativeSessionFile}.`,
      };

// Checks the worker inside the placement queue, then closes its pane.
const closePiPane = async (
  request: StopPiWorkerRequest,
  location: TerminalLocation,
): Promise<void> => {
  const { handle, call, remainingBudget, signal, placement } = request;

  handle.identity.paneId = location.paneId;

  await placement.close(async () => {
    await (handle.identity.owned
      ? inspectWorker(handle, call, { remainingBudget, signal })
      : checkUnownedPi(handle, location.paneId, call));

    // Catch a move during the checks.
    const current = await resolveTerminal(location.terminalId, call);

    if (current.paneId !== location.paneId) {
      throw new Error('Worker moved during identity checks; pane closure refused.');
    }

    await call(['pane', 'close', location.paneId]);
  }, signal);
};

// One poll of the worker pane. Returns the result once the stop is settled.
const pollPiStop = async (
  request: StopPiWorkerRequest,
  progress: PiStopProgress,
): Promise<{ stopped: boolean; detail: string } | undefined> => {
  const owned = request.handle.identity.owned;
  const exited = () => owned !== undefined && processAbsent(owned.processId);
  const terminals = await listTerminals(request.call);
  const location = terminals.find((pane) => pane.terminalId === progress.terminalId);

  const step = decidePiStop({
    paneFound: location !== undefined,
    owned: owned !== undefined,
    exited: exited(),
    closed: progress.closed,
    graceElapsed: performance.now() >= progress.graceEnds,
  });

  if (step === 'stopped') {
    const how = progress.closed
      ? 'Worker identity checked and pane closed.'
      : 'Worker exited and its pane closed.';

    return { stopped: true, detail: `${how} Detached descendants are not covered.` };
  }

  if (step === 'processRemains') {
    throw new Error('The worker pane is gone, but its process ID is still in use.');
  }

  if (step === 'close' && location) {
    progress.closed = await closePiPane(request, location).then(
      () => true,
      (error: unknown) => {
        // Pi may exit during the checks; herdr then removes the pane by itself.
        if (exited()) {
          return false;
        }

        throw error;
      },
    );
  }

  return undefined;
};

// A Pi worker is its pane's own process. Herdr removes the pane when Pi exits, and `pane close`
// stops Pi.
export const stopPiWorker = async (
  request: StopPiWorkerRequest,
): Promise<{ stopped: boolean; detail: string }> => {
  const { handle, remainingBudget, signal } = request;
  const terminalId = await launchedTerminal(request);

  if (terminalId === undefined) {
    return unlocatedLaunch(handle);
  }

  if (typeof terminalId !== 'string') {
    return {
      stopped: true,
      detail: 'Worker exited and its pane closed. Detached descendants are not covered.',
    };
  }

  const graceEnds = performance.now() + (request.graceful ? gracePeriod : 0);
  const progress = { terminalId, graceEnds, closed: false };

  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each poll shares the cleanup budget.
      const stop = await pollPiStop(request, progress);

      if (stop) {
        return stop;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- Poll within the cleanup budget.
      await delay(Math.min(pollInterval, remainingBudget()), undefined, { signal });
    }
  } catch (error) {
    return {
      stopped: false,
      detail: `Pane ${handle.identity.paneId ?? 'unknown'} needs manual cleanup: ${String(error)} Detached descendants are not covered.`,
    };
  }
};
