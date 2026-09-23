import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { matchesWorker, runClient } from './cancellation.js';
import type { OwnedWorker } from './cancellation.js';
import { workBudget } from './controllerBudget.js';
import type { Handle } from './controllerTypes.js';
import { readGenericReference, prepareGenericReport } from './generic.js';
import { seedSession } from './profiles.js';
import { publish, readEvent } from './records.js';
import { object, resolveTerminal, result, text } from './terminal.js';
import { isGenericLoadout, isPiLoadout, requireNativeTask } from './types.js';
import type { GenericLoadout, Task, TaskEvent } from './types.js';

const agentSessionSchema = Type.Object({ value: Type.String({ minLength: 1 }) });
const missingPiIntegrationMessage =
  "herdr reported no Pi agent session. herdr's Pi integration must be loaded in Pi; install it with `herdr integration install pi`.";

export type HerdrClient = (
  argumentsList: string[],
  budget: number,
  signal?: AbortSignal,
) => Promise<string>;

export const herdrClient: HerdrClient = (argumentsList, budget, signal) =>
  runClient('herdr', argumentsList, budget, signal ? { signal } : {});

export const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('Invalid herdr process identity.');
  }

  return Number(value);
};

export const isBareShell = (information: Record<string, unknown>): boolean => {
  const processes = information.foreground_processes;
  const shellPid = integer(information.shell_pid);
  const shellAlone =
    Array.isArray(processes) && processes.length === 1 && object(processes[0]).pid === shellPid;

  return information.foreground_process_group_id === shellPid && shellAlone;
};

export const waitForShell = async (
  handle: Handle,
  paneId: string,
  call: (argumentsList: string[]) => Promise<string>,
): Promise<void> => {
  let previousShell: number | undefined;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Shell startup polling shares the original launch budget.
    const response = await call(['pane', 'process-info', '--pane', paneId]);
    const information = object(result(response).process_info);

    if (information.pane_id !== paneId) {
      throw new Error('Shell pane identity changed before startup.');
    }

    if (isBareShell(information)) {
      const shell = integer(information.shell_pid);

      if (shell === previousShell) {
        return;
      }

      previousShell = shell;
    } else {
      previousShell = undefined;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll serially within the original startup budget.
    await delay(Math.min(100, workBudget(handle)), undefined, { signal: handle.abort.signal });
  }
};

export const processAbsent = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
};

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
    // Load the empty-command guard before the explicitly replayed integrations, including Safety Net.
    '--no-extensions',
    '-e',
    fileURLToPath(new URL('./workerBashGuard.ts', import.meta.url)),
    ...task.loadout.integrations.flatMap((path) => ['-e', path]),
    '-e',
    fileURLToPath(new URL('./worker.ts', import.meta.url)),
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

  throw new Error('Worker exited before readiness. No task dispatch or retry.');
};

const readAgent = async (
  call: (argumentsList: string[]) => Promise<string>,
  paneId: string,
  starting: boolean,
): Promise<Record<string, unknown>> => {
  try {
    // herdr answers with an error document for a pane that has no detected agent yet.
    return object(result(await call(['agent', 'get', paneId])).agent);
  } catch (error) {
    if (starting) {
      throw new Error('Native worker has not been detected by herdr yet.', { cause: error });
    }

    throw error;
  }
};

export interface InspectionBudget {
  remainingBudget: () => number;
  signal: AbortSignal;
}

export const readProcessStart = async (
  handle: Handle,
  processId: number,
  cleanup?: InspectionBudget,
): Promise<string> => {
  const processStart = await runClient(
    'ps',
    ['-p', String(processId), '-o', 'lstart='],
    cleanup ? Math.min(1000, cleanup.remainingBudget()) : workBudget(handle, 1000),
    { signal: cleanup?.signal ?? handle.abort.signal },
  ).catch((error: unknown) => {
    if (processAbsent(processId)) {
      throw new Error('Worker exited before readiness. No task dispatch or retry.', {
        cause: error,
      });
    }

    throw error;
  });

  return processStart.trim();
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

  const shellStart = await readProcessStart(handle, expected.shellPid);

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

export const isHerdrError = (error: unknown, code: string): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  if ('stderr' in error && typeof error.stderr === 'string') {
    try {
      const parsed = object(JSON.parse(error.stderr));

      if (object(parsed.error).code === code) {
        return true;
      }
    } catch {
      // The transport error is not absence evidence unless its structured code is known.
    }
  }

  return 'cause' in error && isHerdrError(error.cause, code);
};

export const verifyRejectedStart = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<boolean> => {
  const shell = handle.shell;

  if (!shell || !handle.terminalId) {
    return false;
  }

  const location = await resolveTerminal(text(handle.terminalId), call);
  handle.paneId = location.paneId;
  const information = object(
    result(await call(['pane', 'process-info', '--pane', location.paneId])).process_info,
  );
  const changedPane =
    information.pane_id !== location.paneId || integer(information.shell_pid) !== shell.processId;

  if (changedPane) {
    return false;
  }

  const changedShell =
    !isBareShell(information) ||
    (await readProcessStart(handle, shell.processId, cleanup)) !== shell.startedAt;

  if (changedShell) {
    return false;
  }

  try {
    if (Object.keys(await readAgent(call, location.paneId, true)).length > 0) {
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

const observedNativeState = (agent: Record<string, unknown>): string =>
  typeof agent.agent_status === 'string' &&
  ['idle', 'done', 'working', 'blocked', 'unknown'].includes(agent.agent_status)
    ? agent.agent_status
    : 'unknown';

const verifyWorkerAgent = async (
  handle: Handle,
  agent: Record<string, unknown>,
  generic: GenericLoadout | undefined,
  identity: { paneId: string; shellPid: number; processId: number },
): Promise<{ kind: string; value: string } | undefined> => {
  if (generic) {
    return checkGenericAgent(handle, agent, { kind: generic.kind, ...identity });
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

  const information = object(
    result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
  );
  const previous = handle.owned ? { ...handle.owned, paneId } : undefined;
  // Ownership is unestablished until a started process reports the expected session to herdr.
  const starting = Boolean(generic) && !previous;
  checkForeground(information, paneId, previous, starting && !handle.workerObserved);

  handle.workerObserved = true;

  const agent = await readAgent(call, paneId, starting);
  const processId = integer(information.foreground_process_group_id);
  const shellPid = integer(information.shell_pid);
  const nativeReference = await verifyWorkerAgent(handle, agent, generic, {
    paneId,
    shellPid,
    processId,
  });
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

export const prepareTaskDirectory = (
  directory: string,
  task: Task,
  continued: boolean,
  reservation: () => string,
): void => {
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
      `Task preparation ${task.taskId} is uncertain at ${directory}. Capacity remains reserved at ${reservation()}. No automatic retry.`,
      { cause: error },
    );
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
