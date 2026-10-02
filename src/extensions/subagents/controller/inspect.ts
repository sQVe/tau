import { once } from 'node:events';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { parseModelReference } from '../../../models/models.js';
import { matchesWorker, runClient } from '../cancellation.js';
import type { OwnedWorker } from '../cancellation.js';
import { seedSession, workerTools } from '../profiles.js';
import { publishRecord, readEvent } from '../records.js';
import { listTerminals, requireObject, result } from '../terminal.js';
import type { TerminalLocation } from '../terminal.js';
import type { Task, TaskEvent } from '../types.js';
import { workBudget } from './budget.js';
import { integer, readProcessStart, WorkerExitedError } from './shellIdentity.js';
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

// Nothing reached herdr, so the request started nothing.
export class RequestNotSentError extends Error {
  override name = 'RequestNotSentError';
}

// herdr 0.9.1 offers layout.apply only on its socket. `layout apply <params>` stands for it, so
// every client and fake keeps one argv interface.
export const socketRequest = async (
  socketPath: string,
  argumentsList: string[],
  budget: number,
  signal?: AbortSignal,
): Promise<string> => {
  if (!socketPath) {
    throw new RequestNotSentError('HERDR_SOCKET_PATH is not set.');
  }

  const expired = AbortSignal.timeout(budget);
  const stop = AbortSignal.any([expired, ...(signal ? [signal] : [])]);
  const params: unknown = JSON.parse(argumentsList[2] ?? '');
  const socket = createConnection(socketPath);

  const failed = once(socket, 'error').then(([error]: unknown[]) => {
    throw error;
  });

  try {
    await Promise.race([once(socket, 'connect', { signal: stop }), failed]).catch(
      (error: unknown) => {
        throw new RequestNotSentError('herdr did not receive the request.', { cause: error });
      },
    );

    socket.write(`${JSON.stringify({ id: 'tau', method: 'layout.apply', params })}\n`);

    const received: unknown[] = await Promise.race([
      once(createInterface({ input: socket }), 'line', { signal: stop }),
      failed,
      once(socket, 'close').then(() => {
        throw new Error('herdr closed its socket without a response.');
      }),
    ]);

    const line = String(received[0]);
    const failure: unknown = requireObject(JSON.parse(line)).error;

    if (failure !== undefined) {
      // Match the CLI, whose structured error is on stderr.
      throw Object.assign(new Error(JSON.stringify(failure)), { stderr: line });
    }

    return line;
  } catch (error) {
    throw expired.aborted && !(error instanceof RequestNotSentError)
      ? new Error('Client attempt budget expired; delivery and cleanup are unconfirmed.', {
          cause: error,
        })
      : error;
  } finally {
    socket.destroy();
  }
};

export const herdrClient: HerdrClient = (argumentsList, budget, signal) =>
  argumentsList[0] === 'layout'
    ? // oxlint-disable-next-line node/no-process-env -- herdr gives each pane its socket path.
      socketRequest(process.env.HERDR_SOCKET_PATH ?? '', argumentsList, budget, signal)
    : runClient('herdr', argumentsList, budget, signal ? { signal } : {});

// extensionPackages are the profile packages the parent installed for this start.
export const workerArguments = (task: Task, extensionPackages: readonly string[]): string[] => {
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
    // Only the profile's tools are registered, so no extension can activate another one later.
    '--tools',
    workerTools(task.loadout).join(','),
    '--no-skills',
    ...task.loadout.skills.flatMap((path) => ['--skill', path]),
    // Pi loads these command-line extensions before the saved configuration's, so the guard is active before CC Safety Net.
    '-e',
    fileURLToPath(new URL('../workerBashGuard.ts', import.meta.url)),
    '-e',
    fileURLToPath(new URL('../workerExtension.ts', import.meta.url)),
    ...extensionPackages.flatMap((source) => ['-e', source]),
  ];
};

// The user's `pi` can be a shell function. Herdr runs the executable from PATH directly.
const piExecutable = (): string => {
  // oxlint-disable-next-line node/no-process-env -- Find pi as the user's shell would.
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, 'pi');

    try {
      if (isAbsolute(directory)) {
        accessSync(candidate, constants.X_OK);

        return candidate;
      }
    } catch {
      // Try the next PATH entry.
    }
  }

  throw new Error('No pi executable found on PATH.');
};

export const workerCommand = (task: Task, extensionPackages: readonly string[]): string[] => [
  piExecutable(),
  ...workerArguments(task, extensionPackages),
];

// A typed command inherited the user's shell setup, such as PATH. Pass the parent's environment,
// which came from that shell. Herdr sets the pane's own HERDR_* identity after it.
export const workerEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    // oxlint-disable-next-line node/no-process-env -- The worker inherits the parent's environment.
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== 'PWD' && entry[0] !== 'OLDPWD',
    ),
  );

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

// herdr answers with an error document for a pane that has no detected agent yet.
const readAgent = async (
  call: (argumentsList: string[]) => Promise<string>,
  paneId: string,
): Promise<Record<string, unknown>> =>
  requireObject(result(await call(['agent', 'get', paneId])).agent);

class PendingPiSessionError extends Error {
  override name = 'PendingPiSessionError';
}

const missingAgentSession = (session: unknown): boolean =>
  session === null || session === undefined;

const checkAgentIdentity = (
  agent: Record<string, unknown>,
  expected: { paneId: string; expectedSession: string },
): void => {
  const session = agent.agent_session;
  const samePiPane = agent.agent === 'pi' && agent.pane_id === expected.paneId;

  if (!Value.Check(agentSessionSchema, session)) {
    // herdr detects a Pi pane before its integration reports which session that agent opened.
    if (missingAgentSession(session) && samePiPane) {
      throw new PendingPiSessionError(missingPiIntegrationMessage);
    }

    throw new Error(
      agent.agent === 'pi' || agent.agent === undefined
        ? missingPiIntegrationMessage
        : 'Started worker identity could not be established.',
    );
  }

  if (!samePiPane || session.value !== expected.expectedSession) {
    throw new Error('Started worker identity could not be established.');
  }
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
    version: 2,
    kind: 'pi',
    paneId: identity.paneId,
    terminalId: identity.terminalId,
    shellPid: identity.shellPid,
    processId: identity.processId,
    token: handle.task.nativeSessionFile,
    startedAt: identity.startedAt,
  };

// Herdr removes a Pi pane when Pi exits, so a missing terminal means the worker exited.
const locateWorker = async (
  terminalId: string | undefined,
  call: (argumentsList: string[]) => Promise<string>,
): Promise<TerminalLocation> => {
  const terminals = await listTerminals(call);
  const location = terminals.find((pane) => pane.terminalId === terminalId);

  if (!location) {
    throw new WorkerExitedError();
  }

  return location;
};

const checkWorker = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<OwnedWorker> => {
  const location = await locateWorker(handle.identity.terminalId, call);
  const paneId = location.paneId;

  handle.identity.paneId = paneId;

  const information = requireObject(
    result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
  );

  const previous = handle.identity.owned ? { ...handle.identity.owned, paneId } : undefined;

  const agent = await readAgent(call, paneId).catch((error: unknown) => {
    // herdr detects a Pi pane shortly after Pi starts.
    throw !previous && isHerdrError(error, 'agent_not_found')
      ? new PendingPiSessionError(missingPiIntegrationMessage, { cause: error })
      : error;
  });

  // A Pi worker is its pane's own process.
  const processId = integer(information.shell_pid);

  checkAgentIdentity(agent, { paneId, expectedSession: handle.task.nativeSessionFile });

  const startedAt = await readProcessStart(handle, processId, cleanup);

  const owned = buildOwnedWorker(handle, previous, {
    paneId,
    terminalId: location.terminalId,
    shellPid: processId,
    processId,
    startedAt,
  });

  if (!startedAt || startedAt !== owned.startedAt || !matchesWorker(information, owned)) {
    throw new Error('Worker process start or pane identity changed or is unavailable.');
  }

  return owned;
};

// Verifies the worker without saving records. The handle receives the pane as soon as it resolves,
// so a later failed check still leaves it behind.
export const inspectWorker = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
  cleanup?: InspectionBudget,
): Promise<OwnedWorker> => {
  try {
    return await checkWorker(handle, call, cleanup);
  } catch (error) {
    if (error instanceof WorkerExitedError) {
      throw error;
    }

    const terminals = await listTerminals(call).catch(() => undefined);

    // Herdr removes a Pi pane when Pi exits, which can happen during the checks.
    if (terminals?.every((pane) => pane.terminalId !== handle.identity.terminalId) === true) {
      throw new WorkerExitedError({ cause: error });
    }

    throw error;
  }
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
