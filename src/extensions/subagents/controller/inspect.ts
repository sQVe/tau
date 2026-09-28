import { mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { parseModelReference } from '../../../delegateModel/index.js';
import { matchesWorker, processAbsent, runClient } from '../cancellation.js';
import type { OwnedWorker } from '../cancellation.js';
import { seedSession } from '../profiles.js';
import { publishRecord, readEvent } from '../records.js';
import { requireObject, resolveTerminal, result, text } from '../terminal.js';
import type { Task, TaskEvent } from '../types.js';
import { workBudget } from './budget.js';
import {
  integer,
  isBareShell,
  readProcessStart,
  runsForegroundJob,
  settledShell,
  WorkerExitedError,
} from './shellIdentity.js';
import type { InspectionBudget } from './shellIdentity.js';
import type { Handle } from './types.js';

export type HerdrClient = (
  argumentsList: string[],
  budget: number,
  signal?: AbortSignal,
) => Promise<string>;

const agentSessionSchema = Type.Object({ value: Type.String({ minLength: 1 }) });

const missingPiIntegrationMessage =
  "herdr reported no Pi agent session. herdr's Pi integration must be loaded in Pi; install it with `herdr integration install pi`.";

export const herdrClient: HerdrClient = (argumentsList, budget, signal) =>
  runClient('herdr', argumentsList, budget, signal ? { signal } : {});

export const workerArguments = (task: Task): string[] => {
  const model = parseModelReference(task.loadout.model);

  if (!model) {
    throw new Error('Pi workers need a provider/id model.');
  }

  return [
    '--approve',
    '--session',
    task.nativeSessionFile,
    '--provider',
    model.provider,
    '--model',
    model.id,
    '--thinking',
    task.loadout.thinking,
    // Pi loads these command-line extensions before the saved configuration's, so the guard is active before CC Safety Net.
    '-e',
    fileURLToPath(new URL('../workerBashGuard.ts', import.meta.url)),
    '-e',
    fileURLToPath(new URL('../workerExtension.ts', import.meta.url)),
  ];
};

const checkForeground = (
  information: Record<string, unknown>,
  paneId: string,
  previous: OwnedWorker | undefined,
): void => {
  const paneMoved = information.pane_id !== paneId;
  const foregroundIsJob = information.foreground_process_group_id !== information.shell_pid;
  const shellReplaced = previous !== undefined && information.shell_pid !== previous.shellPid;
  const previousProcessAlive = previous !== undefined && !processAbsent(previous.processId);
  const paneMovedOrJobRunning = paneMoved || foregroundIsJob;
  const previousWorkerRemains = shellReplaced || previousProcessAlive;

  if (paneMovedOrJobRunning || previousWorkerRemains) {
    return;
  }

  throw new WorkerExitedError();
};

export const isHerdrError = (error: unknown, code: string): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  if ('stderr' in error && typeof error.stderr === 'string') {
    try {
      const parsed = requireObject(JSON.parse(error.stderr));

      if (requireObject(parsed.error).code === code) {
        return true;
      }
    } catch {
      // The transport error is not absence evidence unless its structured code is known.
    }
  }

  return 'cause' in error && isHerdrError(error.cause, code);
};

const readAgent = async (
  call: (argumentsList: string[]) => Promise<string>,
  paneId: string,
  starting: boolean,
): Promise<Record<string, unknown>> => {
  try {
    // herdr answers with an error document for a pane that has no detected agent yet.
    return requireObject(result(await call(['agent', 'get', paneId])).agent);
  } catch (error) {
    if (starting && isHerdrError(error, 'agent_not_found')) {
      throw new Error('Native worker has not been detected by herdr yet.', { cause: error });
    }

    throw error;
  }
};

class PendingPiSessionError extends Error {
  override name = 'PendingPiSessionError';
}

const missingAgentSession = (session: unknown): boolean =>
  session === null || session === undefined;

const checkAgentIdentity = (
  agent: Record<string, unknown>,
  expected: { paneId: string; expectedSession: string },
  unchangedShell: boolean,
): void => {
  // herdr detects a Pi pane before its integration reports which session that agent opened.
  const session = agent.agent_session;

  if (!Value.Check(agentSessionSchema, session)) {
    const isPiPane = agent.agent === 'pi' || agent.agent === undefined;
    const sessionPending = missingAgentSession(session);
    const samePiPane = agent.agent === 'pi' && agent.pane_id === expected.paneId;

    if (sessionPending && samePiPane && !unchangedShell) {
      throw new PendingPiSessionError(missingPiIntegrationMessage);
    }

    throw new Error(
      isPiPane ? missingPiIntegrationMessage : 'Started worker identity could not be established.',
    );
  }

  const samePane = agent.pane_id === expected.paneId;
  const sameSession = agent.agent === 'pi' && session.value === expected.expectedSession;

  if (!samePane || !sameSession || unchangedShell) {
    throw new Error('Started worker identity could not be established.');
  }
};

// The placed shell is still the bare foreground process, so no worker runs in the pane.
export const shellUnchanged = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<boolean> => {
  const shell = handle.identity.shell;

  if (!shell || handle.identity.terminalId == null) {
    return false;
  }

  const seen = { changedPane: false, bare: false };

  await settledShell(async () => {
    const location = await resolveTerminal(text(handle.identity.terminalId), call);

    handle.identity.paneId = location.paneId;

    const information = requireObject(
      result(await call(['pane', 'process-info', '--pane', location.paneId])).process_info,
    );

    seen.changedPane =
      information.pane_id !== location.paneId || integer(information.shell_pid) !== shell.processId;

    seen.bare = isBareShell(information);

    return seen.changedPane || seen.bare || runsForegroundJob(information);
  }, cleanup?.signal ?? handle.abort.signal);

  if (seen.changedPane || !seen.bare) {
    return false;
  }

  return (await readProcessStart(handle, shell.processId, cleanup)) === shell.startedAt;
};

export const verifyRejectedStart = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<boolean> => {
  if (!(await shellUnchanged(handle, call, cleanup))) {
    return false;
  }

  try {
    if (Object.keys(await readAgent(call, text(handle.identity.paneId), true)).length > 0) {
      return false;
    }
  } catch (error) {
    return isHerdrError(error, 'agent_not_found');
  }

  // Accept a successful empty agent object as absence evidence after checking the shell identity.
  return true;
};

const buildOwnedWorker = (
  handle: Handle,
  previous: OwnedWorker | undefined,
  identity: {
    paneId: string;
    terminalId: string;
    shellPid: number;
    processId: number;
    startedAt: string;
  },
): OwnedWorker =>
  previous ?? {
    kind: 'pi',
    paneId: identity.paneId,
    terminalId: identity.terminalId,
    shellPid: identity.shellPid,
    processId: identity.processId,
    token: handle.task.nativeSessionFile,
    startedAt: identity.startedAt,
  };

// Verifies the worker without saving records. The handle receives the pane as soon as it resolves,
// so a later failed check still leaves it behind.
export const inspectWorker = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<OwnedWorker> => {
  const location = await resolveTerminal(text(handle.identity.terminalId), call);
  const paneId = location.paneId;

  handle.identity.paneId = paneId;

  const information = requireObject(
    result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
  );

  const previous = handle.identity.owned ? { ...handle.identity.owned, paneId } : undefined;

  checkForeground(information, paneId, previous);

  const agent = await readAgent(call, paneId, false);
  const processId = integer(information.foreground_process_group_id);
  const shellPid = integer(information.shell_pid);

  checkAgentIdentity(
    agent,
    { paneId, expectedSession: handle.task.nativeSessionFile },
    shellPid === processId,
  );

  const startedAt = await readProcessStart(handle, processId, cleanup);

  const owned = buildOwnedWorker(handle, previous, {
    paneId,
    terminalId: location.terminalId,
    shellPid,
    processId,
    startedAt,
  });

  if (!startedAt || startedAt !== owned.startedAt || !matchesWorker(information, owned)) {
    throw new Error('Worker process start or pane identity changed or is unavailable.');
  }

  return owned;
};

export const waitForPiIdentity = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<OwnedWorker> => {
  for (;;) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Only a missing Pi integration session is transient here.
      return await inspectWorker(handle, call, cleanup);
    } catch (error) {
      if (!(error instanceof PendingPiSessionError)) {
        throw error;
      }

      try {
        const remaining = cleanup ? cleanup.remainingBudget() : workBudget(handle);

        // oxlint-disable-next-line eslint/no-await-in-loop -- Session discovery uses the existing work or cleanup deadline.
        await delay(Math.min(250, remaining), undefined, {
          signal: cleanup?.signal ?? handle.abort.signal,
        });
      } catch {
        throw error;
      }
    }
  }
};

export const prepareTaskDirectory = (directory: string, task: Task, continued: boolean): void => {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    publishRecord(directory, 'task.json', task);

    // A follow-up continues the saved session, which already holds its lineage.
    if (!continued) {
      seedSession(task);
    }
  } catch (error) {
    throw new Error(
      `Task preparation ${task.taskId} is uncertain at ${directory}. No automatic retry.`,
      { cause: error },
    );
  }
};

export const waitForWorkerExit = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  signal: AbortSignal,
): Promise<never> => {
  const budget = { signal, remainingBudget: () => workBudget(handle) };
  let bareSamples = 0;
  let workerObserved = false;

  for (;;) {
    // ponytail: require a worker record or foreground sample; exits missed between polls fall back to herdr's timeout.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Exit polling shares the startup deadline and ends when agent start settles.
    await delay(Math.min(250, workBudget(handle)), undefined, { signal });
    const failure = readEvent(handle.directory, handle.task.taskId, 'startupFailure');
    const ended = failure ?? readEvent(handle.directory, handle.task.taskId, 'settled');

    // oxlint-disable-next-line eslint/no-await-in-loop -- Records precede shutdown; only the unchanged bare shell proves exit.
    const bare = await shellUnchanged(handle, call, budget);

    workerObserved ||= ended !== undefined || !bare;
    bareSamples = workerObserved && bare ? bareSamples + 1 : 0;

    if (bareSamples === 2) {
      throw failure ? new Error(failure.detail) : new WorkerExitedError();
    }
  }
};

export const waitForWorkerReadiness = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
): Promise<TaskEvent> => {
  for (;;) {
    handle.abort.signal.throwIfAborted();
    const failure = readEvent(handle.directory, handle.task.taskId, 'startupFailure');

    if (failure) {
      throw new Error(failure.detail);
    }

    const ready = readEvent(handle.directory, handle.task.taskId, 'ready');

    if (ready) {
      return ready;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Detect death and changed identity before readiness within the same startup budget.
    await inspectWorker(handle, call);

    // oxlint-disable-next-line eslint/no-await-in-loop -- Readiness remains inside the original deadline and cancellation signal.
    await delay(Math.min(250, workBudget(handle)), undefined, { signal: handle.abort.signal });
  }
};
