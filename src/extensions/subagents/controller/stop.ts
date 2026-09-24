import { cancelOwnedWorker, processAbsent, runClient, workerStopped } from '../cancellation.js';
import type { OwnedWorker } from '../cancellation.js';
import type { WorkerPlacement } from '../placement.js';
import { requireObject, resolveTerminal, result, text } from '../terminal.js';
import { shellUnchanged } from './inspect.js';
import type { HerdrClient } from './inspect.js';
import { cleanupDetail } from './record.js';
import { runsForegroundJob, settledShell } from './shellIdentity.js';
import type { Handle } from './types.js';

export interface StopOwnedWorkerRequest {
  handle: Handle;
  owned: OwnedWorker;
  call: (argumentsList: string[]) => Promise<string>;
  remainingBudget: () => number;
  signal: AbortSignal;
  placement: WorkerPlacement;
  client: HerdrClient;
}

interface CheckShellOwnedRequest {
  handle: Handle;
  worker: OwnedWorker;
  call: (argumentsList: string[]) => Promise<string>;
  remainingBudget: number;
  signal: AbortSignal;
}

const checkShellOwned = async (
  request: CheckShellOwnedRequest,
): Promise<{ owned: OwnedWorker; shellOwned: boolean }> => {
  const { handle, worker, call, remainingBudget, signal } = request;
  const location = await resolveTerminal(text(worker.terminalId), call);
  const owned = { ...worker, paneId: location.paneId };

  handle.paneId = location.paneId;
  handle.owned = owned;
  const seen = { changedShell: false, stopped: false };
  const sampleStopped = async () => {
    const information = requireObject(
      result(await call(['pane', 'process-info', '--pane', owned.paneId])).process_info,
    );

    seen.changedShell =
      information.pane_id !== owned.paneId || information.shell_pid !== owned.shellPid;
    seen.stopped = workerStopped(information, owned);

    return seen.changedShell || seen.stopped || runsForegroundJob(information);
  };

  // Once the worker is gone, its shell may still be running prompt hooks.
  await (processAbsent(owned.processId) ? settledShell(sampleStopped, signal) : sampleStopped());

  if (!seen.stopped) {
    return { owned, shellOwned: false };
  }

  if (owned.kind === 'generic') {
    const shellStart = await runClient(
      'ps',
      ['-p', String(owned.shellPid), '-o', 'lstart='],
      remainingBudget,
      { signal },
    );

    return { owned, shellOwned: shellStart.trim() === owned.shellStartedAt };
  }

  return { owned, shellOwned: true };
};

const closeStoppedShell = async (
  request: StopOwnedWorkerRequest,
  worker: OwnedWorker,
  expectedPaneId: string,
  paneConfirmed: { confirmed: boolean },
): Promise<string> => {
  const { handle, call, remainingBudget, signal } = request;
  const { shellOwned } = await checkShellOwned({
    handle,
    worker,
    call,
    remainingBudget: remainingBudget(),
    signal,
  });

  if (!shellOwned) {
    throw new Error('Stopped shell identity changed; pane closure refused.');
  }

  const location = await resolveTerminal(worker.terminalId, call);

  if (location.paneId !== handle.paneId || location.paneId !== expectedPaneId) {
    throw new Error('Worker moved after the stopped-shell check; pane closure refused.');
  }

  await call(['pane', 'close', location.paneId]);
  paneConfirmed.confirmed = true;

  return 'Owned process stopped and pane closed. Detached descendants are not covered.';
};

export const closeUnstartedPane = async (
  request: Omit<StopOwnedWorkerRequest, 'owned' | 'client'>,
): Promise<{ stopped: boolean; detail: string }> => {
  const { handle, call, remainingBudget, signal, placement } = request;
  const paneClosed = { confirmed: false };

  try {
    const location = await resolveTerminal(text(handle.terminalId), call);

    await placement.close(
      location,
      call,
      async () => {
        const absent = await shellUnchanged(handle, call, { remainingBudget, signal });

        if (!absent || handle.paneId !== location.paneId) {
          throw new Error('Worker shell identity changed; pane closure refused.');
        }

        await call(['pane', 'close', location.paneId]);
        paneClosed.confirmed = true;
      },
      signal,
    );

    return {
      stopped: true,
      detail: 'Worker absence confirmed; its unchanged shell pane closed.',
    };
  } catch (error) {
    const detail = paneClosed.confirmed
      ? `Worker pane closed; placement cleanup failed: ${String(error)}`
      : `Pane ${handle.paneId} left open: ${String(error)}`;

    return { stopped: paneClosed.confirmed, detail };
  }
};

export const stopOwnedWorker = async (
  request: StopOwnedWorkerRequest,
): Promise<{ stopped: boolean; detail: string }> => {
  const { handle, call, remainingBudget, signal, placement, client } = request;
  const worker = request.owned;
  let owned = worker;
  let stopped = handle.workerNeverStarted;
  let detail = cleanupDetail(handle, stopped);
  const paneConfirmed = { confirmed: false };

  try {
    const checked = await checkShellOwned({
      handle,
      worker,
      call,
      remainingBudget: remainingBudget(),
      signal,
    });

    owned = checked.owned;
    stopped = checked.shellOwned;
    signal.throwIfAborted();

    if (stopped) {
      detail =
        'The owned process is absent and its shell is foreground; detached or background descendants are not covered.';
    } else {
      const cancellation = await cancelOwnedWorker(
        owned,
        remainingBudget(),
        (argumentsList, remaining, attempt) => client(argumentsList, remaining, attempt),
        signal,
      );

      stopped = cancellation.cleanup === 'confirmed';
      detail = cancellation.detail;
    }

    // closeShell rechecks the stopped shell inside the placement queue. Never close a reused pane.
    if (stopped) {
      const location = await resolveTerminal(worker.terminalId, call);

      await placement.close(
        location,
        call,
        async () => {
          detail = await closeStoppedShell(request, worker, location.paneId, paneConfirmed);
        },
        signal,
      );
    }
  } catch (error) {
    if (!paneConfirmed.confirmed) {
      detail = stopped
        ? `${detail} Pane ${handle.paneId} left open: ${String(error)}`
        : `${String(error)} Check pane ${handle.paneId} manually. Detached descendants are not covered.`;
    }
  }

  return { stopped, detail };
};
