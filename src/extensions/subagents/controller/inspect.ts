import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { matchesWorker, processAbsent, runClient } from '../cancellation.js';
import type { OwnedWorker } from '../cancellation.js';
import { readGenericReference, prepareGenericReport } from '../generic.js';
import { seedSession } from '../profiles.js';
import { publish, readEvent } from '../records.js';
import { requireObject, resolveTerminal, result, text } from '../terminal.js';
import { isGenericLoadout, isPiLoadout, nativeAgentStates, requireNativeTask } from '../types.js';
import type { GenericLoadout, NativeAgentState, Task, TaskEvent } from '../types.js';
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
  if (!isPiLoadout(task.loadout)) {
    throw new Error('Only Pi workers use Pi launch arguments.');
  }

  const separator = task.loadout.model.indexOf('/');

  return [
    '--approve',
    '--session',
    requireNativeTask(task).nativeSessionFile,
    '--provider',
    task.loadout.model.slice(0, separator),
    '--model',
    task.loadout.model.slice(separator + 1),
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
  starting: boolean,
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

  if (starting) {
    throw new Error('Native worker has not reached its own process yet.');
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

const opaqueNativeReferenceSchema = Type.Object({
  kind: Type.String({ minLength: 1, maxLength: 100 }),
  value: Type.String({ minLength: 1, maxLength: 8000 }),
});

const opaqueAgentReference = (
  agent: Record<string, unknown>,
): { kind: string; value: string } | undefined => {
  if (agent.agent_session === undefined || agent.agent_session === null) {
    return undefined;
  }

  if (!Value.Check(opaqueNativeReferenceSchema, agent.agent_session)) {
    throw new Error('Malformed opaque native reference.');
  }

  return { kind: agent.agent_session.kind, value: agent.agent_session.value };
};

const checkGenericAgent = async (
  handle: Handle,
  agent: Record<string, unknown>,
  expected: { kind: string; paneId: string; shellPid: number; processId: number },
  cleanup?: InspectionBudget,
) => {
  const expectedShell = handle.shell;

  const wrongAgent =
    agent.pane_id !== expected.paneId ||
    agent.agent !== expected.kind ||
    expected.shellPid === expected.processId;

  const wrongShell = expected.shellPid !== expectedShell?.processId;

  if (wrongAgent || wrongShell) {
    throw new Error('Native kind, terminal, or shell identity changed.');
  }

  const shellStart = await readProcessStart(handle, expected.shellPid, cleanup);

  if (shellStart !== expectedShell.startedAt) {
    throw new Error('Native kind, terminal, or shell identity changed.');
  }

  const reference = opaqueAgentReference(agent);

  const savedReference =
    handle.owned?.nativeReference ?? readGenericReference(handle.directory, handle.task.taskId);

  if (savedReference && !isDeepStrictEqual(savedReference, reference)) {
    throw new Error('Opaque native reference changed.');
  }

  return reference;
};

// The placed shell is still the bare foreground process, so no worker runs in the pane.
export const shellUnchanged = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<boolean> => {
  const shell = handle.shell;

  if (!shell || handle.terminalId == null) {
    return false;
  }

  const seen = { changedPane: false, bare: false };

  await settledShell(async () => {
    const location = await resolveTerminal(text(handle.terminalId), call);

    handle.paneId = location.paneId;

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
    if (Object.keys(await readAgent(call, text(handle.paneId), true)).length > 0) {
      return false;
    }
  } catch (error) {
    return isHerdrError(error, 'agent_not_found');
  }

  // Accept a successful empty agent object as absence evidence after checking the shell identity.
  return true;
};

export const agentPromptArguments = (paneId: string, message: string): string[] => [
  'agent',
  'prompt',
  paneId,
  message,
];

const saveGenericOwnership = (handle: Handle, owned: OwnedWorker): void => {
  if (owned.nativeReference && !readGenericReference(handle.directory, handle.task.taskId)) {
    publish(handle.directory, 'nativeReference.json', {
      taskId: handle.task.taskId,
      reference: owned.nativeReference,
    });
  }

  if (!existsSync(join(handle.directory, 'owned.json'))) {
    publish(handle.directory, 'owned.json', owned);
  }
};

const isNativeAgentState = (value: unknown): value is NativeAgentState =>
  nativeAgentStates.some((state) => state === value);

const observedNativeState = (agent: Record<string, unknown>): NativeAgentState =>
  isNativeAgentState(agent.agent_status) ? agent.agent_status : 'unknown';

const verifyWorkerAgent = async (
  handle: Handle,
  agent: Record<string, unknown>,
  identity: { paneId: string; shellPid: number; processId: number },
  cleanup?: InspectionBudget,
): Promise<{ kind: string; value: string } | undefined> => {
  if (isGenericLoadout(handle.task.loadout)) {
    return checkGenericAgent(
      handle,
      agent,
      { kind: handle.task.loadout.kind, ...identity },
      cleanup,
    );
  }

  checkAgentIdentity(
    agent,
    { paneId: identity.paneId, expectedSession: text(handle.task.nativeSessionFile) },
    identity.shellPid === identity.processId,
  );

  return undefined;
};

const buildOwnedWorker = (
  handle: Handle,
  previous: OwnedWorker | undefined,
  generic: GenericLoadout | undefined,
  identity: {
    paneId: string;
    terminalId: string;
    shellPid: number;
    processId: number;
    startedAt: string;
  },
): OwnedWorker =>
  previous ?? {
    kind: generic ? 'generic' : 'pi',
    paneId: identity.paneId,
    terminalId: identity.terminalId,
    shellPid: identity.shellPid,
    processId: identity.processId,
    ...(generic
      ? {
          agentKind: generic.kind,
          shellStartedAt: text(handle.shell?.startedAt),
        }
      : { token: text(handle.task.nativeSessionFile) }),
    startedAt: identity.startedAt,
  };

export const inspectWorker = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<OwnedWorker> => {
  const generic = isGenericLoadout(handle.task.loadout) ? handle.task.loadout : undefined;
  const location = await resolveTerminal(text(handle.terminalId), call);
  const paneId = location.paneId;

  handle.paneId = paneId;

  const information = requireObject(
    result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
  );

  const previous = handle.owned ? { ...handle.owned, paneId } : undefined;
  // Ownership is unestablished until a started process reports the expected session to herdr.
  const starting = Boolean(generic) && !previous;

  checkForeground(information, paneId, previous, starting && handle.workerObserved !== true);

  handle.workerObserved = true;

  const agent = await readAgent(call, paneId, starting);
  const processId = integer(information.foreground_process_group_id);
  const shellPid = integer(information.shell_pid);

  const nativeReference = await verifyWorkerAgent(
    handle,
    agent,
    {
      paneId,
      shellPid,
      processId,
    },
    cleanup,
  );

  const startedAt = await readProcessStart(handle, processId, cleanup);

  const owned = buildOwnedWorker(handle, previous, generic, {
    paneId,
    terminalId: location.terminalId,
    shellPid,
    processId,
    startedAt,
  });

  if (!startedAt || startedAt !== owned.startedAt || !matchesWorker(information, owned)) {
    throw new Error('Worker process start or pane identity changed or is unavailable.');
  }

  const verified = nativeReference ? { ...owned, nativeReference } : owned;

  if (generic) {
    saveGenericOwnership(handle, verified);
    handle.nativeState = observedNativeState(agent);
  }

  return verified;
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
    publish(directory, 'task.json', task);

    // Native harnesses own their conversations; only Pi sessions are seeded with Tau lineage.
    if (isGenericLoadout(task.loadout)) {
      prepareGenericReport(task);
    } else if (!continued) {
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
