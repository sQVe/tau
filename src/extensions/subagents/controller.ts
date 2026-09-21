import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import {
  admissionDirectory,
  descendantReservations,
  monotonicNow,
  requireActiveAncestry,
  reserveTask,
} from './admission.js';
import { cancelOwnedWorker, matchesWorker, runClient, workerStopped } from './cancellation.js';
import type { OwnedWorker } from './cancellation.js';
import { requireHandover, refuseLiveNativeWriter } from './continuations.js';
import {
  acceptGenericReport,
  genericPrompt,
  genericReportPath,
  prepareGenericReport,
  readGenericReference,
  readGenericSubmission,
  submitGenericText,
} from './generic.js';
import { authorizeHistoryTask } from './history.js';
import { authenticateParent, currentProcessIdentity } from './identity.js';
import { validateSavedLoadout } from './loadout.js';
import { allocateName, nameSuffix } from './names.js';
import { validateNative } from './native.js';
import { WorkerPlacement } from './placement.js';
import type { Visibility } from './placement.js';
import { nativeIdentity, seedSession } from './profiles.js';
import {
  acceptReply,
  claimSuccessor,
  publish,
  readAcknowledgement,
  readEvent,
  readPendingQuestion,
  readQuestion,
  readReply,
  readReport,
  readTask,
  readTasks,
  readSuccessor,
  recordEvent,
  validateTask,
} from './records.js';
import { object, resolveTerminal, result, text } from './terminal.js';
import { harnessOf, isGenericLoadout, isPiLoadout, requireNativeTask } from './types.js';
import type { Loadout, Question, Report, Task, TaskEvent } from './types.js';

const agentSessionSchema = Type.Object({ value: Type.String({ minLength: 1 }) });

export type HerdrClient = (
  argumentsList: string[],
  budget: number,
  signal?: AbortSignal,
) => Promise<string>;
export const herdrClient: HerdrClient = (argumentsList, budget, signal) =>
  runClient('herdr', argumentsList, budget, signal);

const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('Invalid herdr process identity.');
  }

  return Number(value);
};
const processAbsent = (processId: number): boolean => {
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
    // Pi keeps explicit -e entries with --no-extensions. Replay the validated set without rediscovering packages or another Tau checkout.
    '--no-extensions',
    ...task.loadout.integrations.flatMap((path) => ['-e', path]),
    '-e',
    fileURLToPath(new URL('./worker.ts', import.meta.url)),
  ];
};

const taskOutcome = (
  events: (TaskEvent | undefined)[],
  report: Report | undefined,
  incomplete: boolean,
): string => {
  const terminal = events.find((event) => event !== undefined);

  if (terminal) {
    return terminal.kind === 'startupFailure' ? 'failure' : terminal.kind;
  }

  return report?.outcome ?? (incomplete ? 'incomplete' : 'running');
};

// Confirmed cleanup needs no warning. Only an active deadline or uncertain stop is worth stating.
const enforcementNote = (active: boolean, cleanup: TaskEvent | undefined) => {
  if (active) {
    return 'Original parent deadline remains active.';
  }

  if (cleanup?.stopped === true) {
    return undefined;
  }

  return 'No active owner in this parent. Saved evidence only; work may still be running. Check the saved pane manually. No retry or continuing enforcement is promised.';
};

const unconfirmedDescendants = (root: string, task: Task) => {
  try {
    const children = descendantReservations(root, task)
      .filter(
        (child) => readEvent(join(root, child.taskId), child.taskId, 'cleanup')?.stopped !== true,
      )
      .map((child) => ({ taskId: child.taskId, directory: join(root, child.taskId) }));

    return { children, evidence: undefined };
  } catch (error) {
    return {
      children: [],
      evidence: `Descendant reservation evidence unavailable; capacity may still be held. ${String(error)}`,
    };
  }
};

const nativeDescription = (task: Task, directory: string): string =>
  isGenericLoadout(task.loadout)
    ? `Native reference, when observed: ${join(directory, 'nativeReference.json')}.`
    : `Native session: ${task.nativeSessionId} (${task.nativeSessionFile}).`;

const nativeUsage = (task: Task) => ({
  available: false as const,
  reason: isPiLoadout(task.loadout)
    ? 'Pi reports worker usage in its own session totals.'
    : 'Native usage and model verification are unavailable through this generic interface.',
});

export const taskStatus = (directory: string, activeOwner?: string, enforcing = true) => {
  const task = readTask(directory);
  const report = readReport(directory, task.taskId);
  const event = (kind: TaskEvent['kind']) => readEvent(directory, task.taskId, kind);
  const timeout = event('timeout');
  const cancelled = event('cancelled');
  const failure = event('startupFailure');
  const settled = event('settled');
  const cleanup = event('cleanup');
  const descendants = unconfirmedDescendants(dirname(directory), task);
  const active = enforcing && activeOwner === task.ownerId && !cleanup && !timeout && !cancelled;
  const outcome = taskOutcome([timeout, cancelled, failure], report, Boolean(settled) || !active);

  return {
    taskId: task.taskId,
    name: task.name,
    predecessorTaskId: task.predecessorTaskId,
    successorTaskId: readSuccessor(directory)?.successorTaskId,
    outcome,
    ready: Boolean(event('ready')),
    accepted: Boolean(event('accepted')),
    reportAccepted: Boolean(report),
    ownedByThisParent: activeOwner === task.ownerId,
    deadlineActive: active,
    stopped: Boolean(settled?.stopped) || Boolean(cleanup?.stopped),
    deadline: task.deadline,
    capacityHeld: cleanup?.stopped !== true,
    reservationDirectory: admissionDirectory(dirname(directory), task.tree),
    unconfirmedChildren: descendants.children,
    descendantEvidence: descendants.evidence,
    harness: harnessOf(task.loadout),
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    usage: nativeUsage(task),
    directory,
    report,
    pendingQuestion: readPendingQuestion(directory, task.taskId),
    failure: failure?.detail,
    cleanup: cleanup?.detail,
    enforcement: enforcementNote(active, cleanup),
  };
};

interface Handle {
  directory: string;
  task: Task;
  owned?: OwnedWorker;
  paneId?: string;
  terminalId?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  abort: AbortController;
  expires: number;
  removeLaunchAbort?: () => void;
  workerNeverStarted: boolean;
  workerObserved?: boolean;
  shell?: { processId: number; startedAt: string };
  startError?: string;
  nativeState?: string;
  observationIssue?: string;
  recordErrors: string[];
  cleanupDetail?: string;
  cleanupFinished?: boolean;
  notifiedQuestions: Set<string>;
}

const genericStatus = (directory: string, task: Task, handle?: Handle) => {
  if (!isGenericLoadout(task.loadout)) {
    return {};
  }

  return {
    // Keep the generic harness separate from the native kind name in status.
    harness: 'generic' as const,
    nativeKind: task.loadout.kind,
    nativeState: handle?.nativeState ?? 'unknown',
    observationIssue: handle?.observationIssue,
    nativeReference: readGenericReference(directory, task.taskId),
    nativeConfiguration: task.loadout,
    requestedModel: task.loadout.requestedModel,
    observedModel: null,
    modelVerification:
      'Unavailable. Native arguments record a request, not proof of the model used.',
    reportPath: genericReportPath(task),
    assignment: readGenericSubmission(directory, task.taskId, 'assignment'),
    safety:
      'Native controls; Tau does not certify runtime enforcement. Approval dialogs require user action.',
  };
};

const recordNativeIssue = (handle: Handle, filename: string, error: unknown): void => {
  const detail = String(error).slice(0, 4000);
  handle.observationIssue = detail;

  try {
    if (!existsSync(join(handle.directory, filename))) {
      publish(handle.directory, filename, { taskId: handle.task.taskId, detail });
    }
  } catch (recordError) {
    handle.recordErrors.push(String(recordError));
  }
};

// One remainder for every budget question; two clocks disagree within a millisecond.
const remainingWorkBudget = (handle: Handle): number =>
  Math.floor(handle.expires - handle.task.cancellationBudget - performance.now());

const workBudget = (handle: Handle, maximum = 30_000): number => {
  handle.abort.signal.throwIfAborted();
  const remaining = remainingWorkBudget(handle);

  if (remaining <= 0) {
    throw new Error('The original worker startup budget expired.');
  }

  return Math.min(maximum, remaining);
};

const ensureReplyActive = (handle: Handle): void => {
  workBudget(handle);
  const { directory, task } = handle;

  if (
    (!isGenericLoadout(task.loadout) && !readEvent(directory, task.taskId, 'accepted')) ||
    (['settled', 'startupFailure', 'cleanup', 'cancelled', 'timeout'] as const).some((kind) =>
      readEvent(directory, task.taskId, kind),
    ) ||
    readReport(directory, task.taskId)
  ) {
    throw new Error('Worker task is inactive.');
  }
};

const checkForeground = (
  information: Record<string, unknown>,
  paneId: string,
  previous: OwnedWorker | undefined,
  starting: boolean,
): void => {
  if (
    information.pane_id !== paneId ||
    information.foreground_process_group_id !== information.shell_pid ||
    (previous &&
      (information.shell_pid !== previous.shellPid || !processAbsent(previous.processId)))
  ) {
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

const prepareTaskDirectory = (
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

const readProcessStart = async (handle: Handle, processId: number): Promise<string> => {
  const processStart = await runClient(
    'ps',
    ['-p', String(processId), '-o', 'lstart='],
    workBudget(handle, 1000),
    handle.abort.signal,
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

const checkAgentIdentity = (
  agent: Record<string, unknown>,
  expected: { paneId: string; expectedSession: string },
  unchangedShell: boolean,
): void => {
  // herdr reports a detected agent before its integration reports which session that agent opened.
  const identified =
    agent.agent === 'pi' &&
    Value.Check(agentSessionSchema, agent.agent_session) &&
    agent.agent_session.value === expected.expectedSession;

  if (agent.pane_id !== expected.paneId || !identified || unchangedShell) {
    throw new Error('Started worker identity could not be established.');
  }
};

const checkGenericAgent = async (
  handle: Handle,
  agent: Record<string, unknown>,
  expected: { kind: string; paneId: string; shellPid: number; processId: number },
) => {
  if (
    agent.pane_id !== expected.paneId ||
    agent.agent !== expected.kind ||
    expected.shellPid === expected.processId ||
    expected.shellPid !== handle.shell?.processId ||
    (await readProcessStart(handle, expected.shellPid)) !== handle.shell.startedAt
  ) {
    throw new Error('Native kind, terminal, or shell identity changed.');
  }

  let reference: { kind: string; value: string } | undefined;

  if (agent.agent_session !== undefined && agent.agent_session !== null) {
    if (
      !Value.Check(
        Type.Object({
          kind: Type.String({ minLength: 1, maxLength: 100 }),
          value: Type.String({ minLength: 1, maxLength: 8000 }),
        }),
        agent.agent_session,
      )
    ) {
      throw new Error('Malformed opaque native reference.');
    }

    reference = { kind: agent.agent_session.kind, value: agent.agent_session.value };
  }

  const savedReference =
    handle.owned?.nativeReference ?? readGenericReference(handle.directory, handle.task.taskId);

  if (savedReference && !isDeepStrictEqual(savedReference, reference)) {
    throw new Error('Opaque native reference changed.');
  }

  return reference;
};

const isAgentNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  if ('stderr' in error && typeof error.stderr === 'string') {
    try {
      const parsed = object(JSON.parse(error.stderr));

      if (object(parsed.error).code === 'agent_not_found') {
        return true;
      }
    } catch {
      // The transport error is not absence evidence unless its structured code is known.
    }
  }

  return 'cause' in error && isAgentNotFoundError(error.cause);
};

// A rejected start plus an unchanged shell and a known agent_not_found response is definite rejection evidence.
const verifyRejectedStart = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
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

  if (
    information.pane_id !== location.paneId ||
    integer(information.shell_pid) !== shell.processId ||
    integer(information.foreground_process_group_id) !== shell.processId ||
    (await readProcessStart(handle, shell.processId)) !== shell.startedAt
  ) {
    return false;
  }

  try {
    if (Object.keys(await readAgent(call, location.paneId, true)).length > 0) {
      return false;
    }
  } catch (error) {
    return isAgentNotFoundError(error);
  }

  return false;
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

const inspectWorker = async (
  handle: Handle,
  call: (argumentsList: string[]) => Promise<string>,
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
  const expectedSession = handle.task.nativeSessionFile;
  let nativeReference: { kind: string; value: string } | undefined;

  if (generic) {
    nativeReference = await checkGenericAgent(handle, agent, {
      kind: generic.kind,
      paneId,
      shellPid,
      processId,
    });
  } else {
    checkAgentIdentity(
      agent,
      { paneId, expectedSession: text(expectedSession) },
      shellPid === processId,
    );
  }

  const startedAt = await readProcessStart(handle, processId);
  const owned: OwnedWorker = previous ?? {
    kind: generic ? 'generic' : 'pi',
    paneId,
    terminalId: location.terminalId,
    shellPid,
    processId,
    ...(generic
      ? {
          agentKind: generic.kind,
          shellStartedAt: text(handle.shell?.startedAt),
        }
      : { token: text(expectedSession) }),
    startedAt,
  };

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

const waitForWorkerReadiness = async (
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

const launchTiming = (timeout: number, startedAt?: { wall: number; monotonic: number }) => {
  const createdAt = startedAt?.wall ?? Date.now();
  const expires = (startedAt?.monotonic ?? performance.now()) + timeout;
  const cancellationBudget = Math.min(5000, Math.floor(timeout / 4));

  if (!Number.isFinite(expires) || performance.now() >= expires - cancellationBudget) {
    throw new Error('The original task work budget expired during loadout resolution.');
  }

  return {
    createdAt,
    deadline: createdAt + timeout,
    expires,
    cancellationBudget,
  };
};

const boundedTiming = (timing: ReturnType<typeof launchTiming>, parent?: Task) => {
  const elapsedNow = performance.now();
  const monotonic = monotonicNow();

  if (!parent?.tree) {
    return { ...timing, monotonicDeadline: monotonic + timing.expires - elapsedNow };
  }

  const parentWorkEnd = parent.tree.monotonicDeadline - parent.cancellationBudget;
  const expires = Math.min(timing.expires, elapsedNow + parentWorkEnd - monotonic);
  const monotonicDeadline = Math.min(parentWorkEnd, monotonic + expires - elapsedNow);
  const cancellationBudget = Math.min(
    timing.cancellationBudget,
    Math.floor((expires - elapsedNow) / 4),
  );

  if (cancellationBudget < 1 || elapsedNow >= expires - cancellationBudget) {
    throw new Error('Original parent deadline has no child work budget remaining.');
  }

  // Keep display timestamps on the parent's original clock mapping; later wall-clock jumps do not change the budget.
  const parentClockOffset = parent.deadline - parent.tree.monotonicDeadline;
  const requestedStart = timing.expires - (timing.deadline - timing.createdAt);

  return {
    createdAt: Math.floor(parentClockOffset + monotonic + requestedStart - elapsedNow),
    deadline: Math.floor(parentClockOffset + monotonicDeadline),
    expires,
    cancellationBudget,
    monotonicDeadline,
  };
};

interface LaunchInput {
  task: string;
  loadout: Loadout;
  timeout: number;
  parentSession: string;
  parentSessionId: string;
  parentPane?: string;
  visibility?: Visibility;
  startedAt?: { wall: number; monotonic: number };
}

interface FollowUpPreparation {
  directory: string;
  task: Task;
  origin: Task;
  native: ReturnType<typeof validateNative>;
}

const nativeReference = (loadout: Loadout, directory: string, source?: FollowUpPreparation) => {
  if (source) {
    return {
      predecessorTaskId: source.task.taskId,
      nativeSessionId: source.task.nativeSessionId,
      nativeSessionFile: source.task.nativeSessionFile,
    };
  }

  return isGenericLoadout(loadout) ? {} : nativeIdentity(directory);
};

const requireUnclaimed = (root: string, source: { directory: string; task: Task }): void => {
  const claim = readSuccessor(source.directory);
  const pending = readTasks(root).find(({ task }) => task.predecessorTaskId === source.task.taskId);
  const successor = claim?.successorTaskId ?? pending?.task.taskId;

  if (successor) {
    throw new Error(
      `Task ${source.task.taskId} already has successor attempt ${successor}. No retry or age-based reclaim.`,
    );
  }

  requireHandover(source.directory, source.task);
};

const checkHandoff = (root: string, source: FollowUpPreparation, successor: Task): void => {
  authorizeHistoryTask(
    root,
    { file: successor.parentSession, id: successor.parentSessionId },
    source.task.taskId,
  );

  if (
    !isDeepStrictEqual(readTask(source.directory), source.task) ||
    readSuccessor(source.directory)?.successorTaskId !== successor.taskId
  ) {
    throw new Error(`Successor ${successor.taskId} no longer owns its predecessor claim.`);
  }

  requireHandover(source.directory, source.task);

  if (!isDeepStrictEqual(validateNative(source.task, source.origin), source.native)) {
    throw new Error('Native file changed during follow-up validation. Claim retained; no retry.');
  }
};

const checkNativeWriterListing = (response: string, task: Task): void => {
  const live = result(response);

  if (live.type !== 'agent_list') {
    throw new Error('Malformed live native writer listing.');
  }

  refuseLiveNativeWriter(live.agents, task);
};

const treeCapacity = (): number =>
  // oxlint-disable-next-line node/no-process-env -- Only the first admission in a root session uses this; later launches read the saved policy.
  Number(process.env.TAU_SUBAGENT_CAP ?? 4);

// Absence evidence proves no live process remains; it does not prove the start never ran.
const cleanupDetail = (handle: Handle, stopped: boolean): string => {
  const pane = handle.paneId ?? 'none';

  if (handle.startError !== undefined && handle.workerNeverStarted) {
    return `Native startup was rejected by herdr absence evidence; a worker may have started briefly and exited. Pane ${pane} is left as placed.`;
  }

  return stopped
    ? `No worker process was ever started for this task. Pane ${pane} is left as placed.`
    : `Cleanup unconfirmed. Check pane ${handle.paneId ?? 'unknown'} manually. No automatic retry.`;
};

export class WorkerController {
  readonly ownerId = randomUUID();
  private readonly handles = new Map<string, Handle>();
  private readonly admitted = new Map<string, Task>();
  private readonly lifetime = new AbortController();
  private readonly placement = new WorkerPlacement();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly client: HerdrClient = herdrClient,
    private readonly notify: (message: string, question?: Question) => void = () => undefined,
  ) {}

  async parentAuthority(parentSession: string, parentSessionId: string, signal?: AbortSignal) {
    const identity = await currentProcessIdentity(signal);
    // oxlint-disable-next-line node/no-process-env -- The locator is checked against session and parent-owned process evidence.
    const locator = process.env.TAU_WORKER_RECORD;

    return authenticateParent(
      this.root,
      { file: parentSession, id: parentSessionId },
      identity,
      locator,
    );
  }

  children() {
    const active = [...this.handles.values()].filter((handle) => !handle.cleanupFinished);
    const reservations = new Map(this.admitted);
    const uncertain: string[] = [];

    for (const task of this.admitted.values()) {
      try {
        for (const descendant of descendantReservations(this.root, task)) {
          reservations.set(descendant.taskId, descendant);
        }
      } catch (error) {
        uncertain.push(
          `Child ${task.taskId}: descendant evidence unavailable. Inspect ${join(this.root, task.taskId)} manually. ${String(error)}`,
        );
      }
    }

    for (const task of reservations.values()) {
      if (active.some((handle) => handle.task.taskId === task.taskId)) {
        continue;
      }

      const directory = join(this.root, task.taskId);

      try {
        if (readEvent(directory, task.taskId, 'cleanup')?.stopped === true) {
          continue;
        }
      } catch {
        // Missing or corrupt cleanup evidence cannot free a reservation or imply stopped work.
      }

      uncertain.push(
        `Child ${task.taskId}: cleanup unconfirmed; reservation retained. Inspect ${directory} manually.`,
      );
    }

    return { active: active.length, uncertain };
  }

  launch(input: LaunchInput, signal: AbortSignal = new AbortController().signal) {
    return this.launchTask(input, signal);
  }

  async followUp(
    input: Omit<LaunchInput, 'loadout' | 'startedAt'> & {
      sourceTaskId: string;
      settingsUnchanged: boolean;
    },
    context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>,
    signal: AbortSignal = new AbortController().signal,
  ) {
    const startedAt = { wall: Date.now(), monotonic: performance.now() };
    const timing = launchTiming(input.timeout, startedAt);
    const validationSignal = AbortSignal.any([
      signal,
      this.lifetime.signal,
      AbortSignal.timeout(
        Math.max(1, Math.floor(timing.expires - timing.cancellationBudget - performance.now())),
      ),
    ]);
    validationSignal.throwIfAborted();

    if (this.closed || !input.settingsUnchanged) {
      throw new Error('Follow-up requires an active parent and explicit unchanged saved settings.');
    }

    const source = authorizeHistoryTask(
      this.root,
      { file: input.parentSession, id: input.parentSessionId },
      input.sourceTaskId,
    );

    if (!isPiLoadout(source.task.loadout)) {
      throw new Error('Non-Pi native continuation is unsupported. Start a fresh task.');
    }

    requireUnclaimed(this.root, source);
    const native = validateNative(source.task, source.origin);
    const loadout = await validateSavedLoadout(source.task.loadout, context, validationSignal);
    validationSignal.throwIfAborted();
    requireUnclaimed(this.root, source);

    // Validation expiry must not masquerade as caller cancellation during launch/readiness.
    return this.launchTask({ ...input, loadout, startedAt }, signal, { ...source, native });
  }

  private placeWorker(
    input: LaunchInput,
    handle: Handle,
    call: (argumentsList: string[]) => Promise<string>,
  ) {
    return this.placement.place(
      {
        ...(input.parentPane ? { parentPane: input.parentPane } : {}),
        visibility: input.visibility ?? 'foreground',
        onCreated: (created) => {
          handle.paneId = created.paneId;
          handle.terminalId = created.terminalId;
          publish(handle.directory, 'pane.json', created);
        },
        cwd: handle.task.loadout.cwd,
        environment: isPiLoadout(handle.task.loadout)
          ? [
              `TAU_WORKER_RECORD=${handle.directory}`,
              `TAU_PARENT_PROCESS=${process.pid}`,
              `PI_CODING_AGENT_DIR=${handle.task.loadout.agentDirectory}`,
            ]
          : [],
      },
      call,
      handle.abort.signal,
    );
  }

  private async startWorker(
    handle: Handle,
    paneId: string,
    name: string,
    call: (argumentsList: string[]) => Promise<string>,
  ): Promise<void> {
    const { task } = handle;
    const generic = isGenericLoadout(task.loadout) ? task.loadout : undefined;

    if (generic) {
      const information = object(
        result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
      );
      const shellPid = integer(information.shell_pid);

      if (information.pane_id !== paneId || information.foreground_process_group_id !== shellPid) {
        throw new Error('Native start requires an unchanged foreground shell.');
      }

      handle.shell = { processId: shellPid, startedAt: await readProcessStart(handle, shellPid) };

      if (!handle.shell.startedAt) {
        throw new Error('Shell start identity is unavailable.');
      }

      publish(handle.directory, 'shell.json', handle.shell);
      publish(handle.directory, 'nativeStart-intent.json', {
        taskId: task.taskId,
        kind: generic.kind,
        arguments: generic.arguments,
        terminalId: handle.terminalId,
      });
    }

    // A failing start call can still leave a process behind.
    handle.workerNeverStarted = false;
    await call([
      'agent',
      'start',
      name,
      '--kind',
      generic?.kind ?? 'pi',
      '--pane',
      paneId,
      '--timeout',
      String(workBudget(handle)),
      '--',
      ...(generic?.arguments ?? workerArguments(task)),
    ]).catch((error: unknown) => {
      if (!generic) {
        throw error;
      }

      handle.startError = String(error).slice(0, 4000);
      publish(handle.directory, 'nativeStart-error.json', { detail: handle.startError });
      this.notify(
        `Worker ${task.taskId}: native startup is blocked or uncertain. No start retry. ${handle.startError}`,
      );
    });
  }

  private checkFollowUpSource(
    loadout: Loadout,
    agents: unknown,
    source?: FollowUpPreparation,
  ): void {
    if (!source) {
      return;
    }

    requireUnclaimed(this.root, source);
    refuseLiveNativeWriter(agents, source.task);

    if (!isDeepStrictEqual(loadout, source.task.loadout)) {
      throw new Error('Follow-up cannot change saved worker settings.');
    }
  }

  private async dispatch(
    handle: Handle,
    call: (argumentsList: string[]) => Promise<string>,
  ): Promise<void> {
    const { directory, task } = handle;

    if (isPiLoadout(task.loadout)) {
      publish(directory, 'dispatch.json', { taskId: task.taskId });

      return;
    }

    if (
      readGenericSubmission(directory, task.taskId, 'assignment') ||
      !['idle', 'done'].includes(handle.nativeState ?? 'unknown')
    ) {
      return;
    }

    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (
      location.paneId !== worker.paneId ||
      !['idle', 'done'].includes(handle.nativeState ?? 'unknown')
    ) {
      throw new Error('Native worker moved or is not ready for the assignment.');
    }

    workBudget(handle);
    const prompt = genericPrompt(task);
    const submission = await submitGenericText(directory, task, 'assignment', prompt, () =>
      call(agentPromptArguments(location.paneId, prompt)),
    );
    const observation = submission?.observation;

    if (
      !handle.stopping &&
      !this.closed &&
      (observation?.state === 'not-delivered' || observation?.state === 'uncertain')
    ) {
      this.notify(
        `Worker ${task.taskId}: assignment ${observation.state}. ${observation.detail} Inspect the native pane; no automatic retry. The original deadline remains active.`,
      );
    }
  }

  // oxlint-disable-next-line eslint/complexity -- Launch validates authority, reserves capacity, starts the worker, and classifies startup evidence.
  private async launchTask(
    input: LaunchInput,
    launchSignal: AbortSignal,
    source?: FollowUpPreparation,
  ): Promise<ReturnType<typeof taskStatus>> {
    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }

    launchSignal.throwIfAborted();
    const taskId = randomUUID();
    const directory = join(this.root, taskId);
    const timing = launchTiming(input.timeout, input.startedAt);
    const authority = await this.parentAuthority(
      input.parentSession,
      input.parentSessionId,
      launchSignal,
    );
    const { createdAt, deadline, expires, cancellationBudget, monotonicDeadline } = boundedTiming(
      timing,
      authority.parent,
    );

    if (authority.parent && isGenericLoadout(input.loadout)) {
      throw new Error(
        'Generic workers require root-parent approval and have no Tau nesting channel.',
      );
    }

    const task = validateTask({
      version: isGenericLoadout(input.loadout) ? 2 : 1,
      name: `${input.loadout.role === 'editing' ? 'worker' : 'investigator'}-00`,
      taskId,
      task: input.task,
      parentSession: input.parentSession,
      parentSessionId: input.parentSessionId,
      ownerId: this.ownerId,
      ...nativeReference(input.loadout, directory, source),
      createdAt,
      deadline,
      cancellationBudget,
      tree: { ...authority.tree, monotonicDeadline },
      loadout: input.loadout,
    });
    const remaining = Math.floor(expires - cancellationBudget - performance.now());
    const listingSignal = AbortSignal.any([
      launchSignal,
      this.lifetime.signal,
      AbortSignal.timeout(Math.max(1, remaining)),
    ]);
    const listing = result(
      await this.client(['agent', 'list'], Math.min(30_000, remaining), listingSignal),
    );
    listingSignal.throwIfAborted();

    if (listing.type !== 'agent_list' || performance.now() >= expires - cancellationBudget) {
      throw new Error('Invalid live agent listing or original startup budget expired.');
    }

    this.checkFollowUpSource(input.loadout, listing.agents, source);
    // Synchronous allocation and publication after listing coordinate launches in this process's event loop,
    // not launches in independent processes.
    const name = allocateName(
      this.root,
      input.parentSessionId,
      input.loadout.role,
      listing.agents,
      nameSuffix,
    );
    task.name = name;
    validateTask(task);

    // The reservation precedes task publication, native opening, and successor claims.
    const capacity = treeCapacity();
    reserveTask(this.root, task, capacity);
    this.admitted.set(task.taskId, task);
    prepareTaskDirectory(directory, task, Boolean(source), () =>
      admissionDirectory(this.root, authority.tree),
    );

    const handle: Handle = {
      directory,
      task,
      abort: new AbortController(),
      expires,
      workerNeverStarted: true,
      recordErrors: [],
      notifiedQuestions: new Set(),
    };
    this.handles.set(taskId, handle);

    const abortLaunch = () => {
      void this.stop(handle, 'cancelled');
    };
    launchSignal.addEventListener('abort', abortLaunch, { once: true });
    handle.removeLaunchAbort = () => {
      launchSignal.removeEventListener('abort', abortLaunch);
    };
    handle.timer = setTimeout(
      () => {
        void this.stop(handle, 'timeout');
      },
      Math.max(1, expires - task.cancellationBudget - performance.now()),
    );

    try {
      launchSignal.throwIfAborted();
      workBudget(handle);

      if (source) {
        claimSuccessor(source.directory, task);
        checkHandoff(this.root, source, task);
      }

      const call = (argumentsList: string[]) =>
        this.client(argumentsList, workBudget(handle), handle.abort.signal);
      const location = await this.placeWorker(input, handle, call);

      if (source) {
        checkNativeWriterListing(await call(['agent', 'list']), task);
        checkHandoff(this.root, source, task);
      }

      await this.startWorker(handle, location.paneId, name, call);

      if (isPiLoadout(task.loadout)) {
        handle.owned = await inspectWorker(handle, call);
        publish(directory, 'owned.json', handle.owned);
        const ready = await waitForWorkerReadiness(handle, call);
        const current = await inspectWorker(handle, call);

        if (ready.processId !== current.processId) {
          throw new Error('Native session and worker readiness identities did not match.');
        }

        handle.abort.signal.throwIfAborted();
        await this.dispatch(handle, call);
        this.poll(handle);
      } else {
        if (handle.startError !== undefined && (await verifyRejectedStart(handle, call))) {
          handle.workerNeverStarted = true;
          throw new Error(
            `Native startup was rejected by herdr absence evidence. No retry. ${handle.startError}`,
          );
        }

        await this.pollGeneric(handle);
      }

      handle.removeLaunchAbort();
    } catch (error) {
      const reason = remainingWorkBudget(handle) <= 0 ? 'timeout' : 'failure';
      const detail =
        handle.startError !== undefined && handle.workerNeverStarted
          ? `Native startup was rejected by herdr absence evidence; no retry. ${String(error)}`
          : `Startup delivery is uncertain; no retry. ${String(error)}`;
      await this.stop(handle, reason, detail);
    }

    return this.status(taskId, input.parentSessionId);
  }

  private poll(handle: Handle): void {
    if (this.closed || handle.stopping) {
      return;
    }

    if (handle.timer) {
      clearTimeout(handle.timer);
    }

    handle.timer = setTimeout(
      () => {
        if (isGenericLoadout(handle.task.loadout)) {
          void this.pollGeneric(handle);

          return;
        }

        try {
          if (remainingWorkBudget(handle) <= 0) {
            void this.stop(handle, 'timeout');

            return;
          }

          if (
            readEvent(handle.directory, handle.task.taskId, 'settled') ||
            readEvent(handle.directory, handle.task.taskId, 'startupFailure') ||
            (handle.owned !== undefined && processAbsent(handle.owned.processId))
          ) {
            void this.stop(handle, 'completion');

            return;
          }

          if (handle.task.tree.parentTaskId) {
            try {
              requireActiveAncestry(
                this.root,
                readTask(join(this.root, handle.task.tree.parentTaskId)),
              );
            } catch {
              void this.stop(handle, 'cancelled');

              return;
            }
          }

          const question = readPendingQuestion(handle.directory, handle.task.taskId);

          if (question && !handle.notifiedQuestions.has(question.questionId)) {
            handle.notifiedQuestions.add(question.questionId);
            this.notify(
              `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}) asks: ${question.question}\nReply with subagent_reply using questionId ${question.questionId}. The original deadline still applies.`,
              question,
            );
          }

          this.poll(handle);
        } catch (error) {
          void this.stop(
            handle,
            'failure',
            `Worker evidence unavailable: ${String(error)}. No retry.`,
          );
        }
      },
      Math.max(
        1,
        Math.min(
          isGenericLoadout(handle.task.loadout) ? 1500 : 250,
          handle.expires - handle.task.cancellationBudget - performance.now(),
        ),
      ),
    );
  }

  private async pollGeneric(handle: Handle): Promise<void> {
    if (this.closed || handle.stopping) {
      return;
    }

    try {
      if (remainingWorkBudget(handle) <= 0) {
        await this.stop(handle, 'timeout');

        return;
      }

      try {
        if (acceptGenericReport(handle.directory, handle.task)) {
          await this.stop(handle, 'completion');

          return;
        }
      } catch (error) {
        recordNativeIssue(handle, 'nativeFailure.json', error);
        await this.stop(handle, 'completion');

        return;
      }

      if (handle.owned && processAbsent(handle.owned.processId)) {
        await this.stop(handle, 'completion');

        return;
      }

      const call = (argumentsList: string[]) =>
        this.client(argumentsList, workBudget(handle), handle.abort.signal);
      const previousState = handle.nativeState;
      handle.owned = await inspectWorker(handle, call);
      delete handle.observationIssue;

      if (
        handle.nativeState !== previousState &&
        ['blocked', 'unknown'].includes(handle.nativeState ?? 'unknown')
      ) {
        this.notify(
          `Worker ${handle.task.taskId}: ${handle.nativeState}. Inspect the native dialog; no approval is automatic. The original deadline remains active.`,
        );
      }

      await this.dispatch(handle, call);
      this.poll(handle);
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Awaited calls can stop the handle or controller before this catch runs.
      if (handle.stopping || this.closed) {
        return;
      }

      const previousIssue = handle.observationIssue;
      recordNativeIssue(handle, 'nativeObservation-error.json', error);
      handle.nativeState = 'unknown';

      if (previousIssue !== handle.observationIssue) {
        this.notify(
          `Worker ${handle.task.taskId}: native observation or delivery is uncertain. ${handle.observationIssue} Inspect saved submission intent; no automatic retry. The original deadline remains active.`,
        );
      }

      this.poll(handle);
    }
  }

  private stop(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
    failureDetail = 'Worker lifecycle failed; saved evidence may be incomplete. No retry.',
  ): Promise<void> {
    if (handle.stopping) {
      return handle.stopping;
    }

    if (handle.timer) {
      clearTimeout(handle.timer);
    }

    handle.removeLaunchAbort?.();
    handle.abort.abort();

    // A report published between polls must be saved before cleanup can close its pane.
    if (isGenericLoadout(handle.task.loadout)) {
      try {
        acceptGenericReport(handle.directory, handle.task);
      } catch (error) {
        recordNativeIssue(handle, 'nativeFailure.json', error);
      }
    }

    try {
      recordEvent(
        handle.directory,
        handle.task.taskId,
        'stopping',
        'Parent started bounded cleanup; no further delegation is authorized.',
      );
    } catch (error) {
      handle.recordErrors.push(String(error));
    }

    const cleaned = this.cleanup(handle, reason, failureDetail);

    handle.stopping = Promise.allSettled([cleaned])
      .then(() => {
        // Keep sharing intact until cleanup finishes, including its queued topology change.
        // Unconfirmed cleanup must still stop contributing placement candidates.
        if (handle.terminalId) {
          this.placement.release(handle.terminalId);
        }

        // Report the cleanup failure only once the whole subtree has settled.
        return cleaned;
      })
      .catch((error: unknown) => {
        handle.cleanupFinished = true;
        handle.recordErrors.push(String(error));

        if (this.closed) {
          return;
        }

        this.notify(
          `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}): cleanup unconfirmed. ${String(error)}. Check pane ${handle.paneId ?? 'unknown'} manually. Records: ${handle.directory}. ${nativeDescription(handle.task, handle.directory)}`,
        );
      });

    return handle.stopping;
  }

  private async cleanup(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
    failureDetail: string,
  ): Promise<void> {
    const { directory, task } = handle;
    let owned = handle.owned;
    // Receipt failures must never prevent the bounded stop attempt or hide later recording errors.
    const record = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        handle.recordErrors.push(String(error));
      }
    };

    const budget = Math.max(
      1,
      Math.floor(Math.min(task.cancellationBudget, handle.expires - performance.now())),
    );
    const expires = Math.min(handle.expires, performance.now() + budget);
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(budget)]);
    const remainingBudget = () => {
      signal.throwIfAborted();
      const remaining = Math.floor(expires - performance.now());

      if (remaining <= 0) {
        throw new Error('Original cleanup budget expired.');
      }

      return remaining;
    };
    const call = (argumentsList: string[]) => this.client(argumentsList, remainingBudget(), signal);
    let stopped = handle.workerNeverStarted;
    const paneClosure = { confirmed: false };
    let detail = cleanupDetail(handle, stopped);

    if (owned) {
      const worker = owned;
      const shellIsOwned = async () => {
        const location = await resolveTerminal(text(worker.terminalId), call);
        owned = { ...worker, paneId: location.paneId };
        handle.paneId = location.paneId;
        handle.owned = owned;
        const information = object(
          result(await call(['pane', 'process-info', '--pane', owned.paneId])).process_info,
        );

        if (!workerStopped(information, owned)) {
          return false;
        }

        if (owned.kind === 'generic') {
          const shellStart = await runClient(
            'ps',
            ['-p', String(owned.shellPid), '-o', 'lstart='],
            remainingBudget(),
            signal,
          );

          return shellStart.trim() === owned.shellStartedAt;
        }

        return true;
      };
      const closeShell = async (expectedPaneId: string) => {
        if (!(await shellIsOwned())) {
          throw new Error('Stopped shell identity changed; pane closure refused.');
        }

        const location = await resolveTerminal(worker.terminalId, call);

        if (location.paneId !== handle.paneId || location.paneId !== expectedPaneId) {
          throw new Error('Worker moved after the stopped-shell check; pane closure refused.');
        }

        await call(['pane', 'close', location.paneId]);
        paneClosure.confirmed = true;
        detail = 'Owned process stopped and pane closed. Detached descendants are not covered.';
      };

      try {
        stopped = await shellIsOwned();
        signal.throwIfAborted();

        if (!stopped) {
          const cancellation = await cancelOwnedWorker(
            owned,
            remainingBudget(),
            (argumentsList, remaining, attempt) => this.client(argumentsList, remaining, attempt),
            signal,
          );
          stopped = cancellation.cleanup === 'confirmed';
          detail = cancellation.detail;
        }

        // closeShell rechecks the stopped shell inside the placement queue. Never close a reused pane.
        if (stopped) {
          const location = await resolveTerminal(worker.terminalId, call);
          await this.placement.close(location, call, () => closeShell(location.paneId), signal);
        }
      } catch (error) {
        if (!paneClosure.confirmed) {
          detail = `${String(error)} Check pane ${owned.paneId} manually. Detached descendants are not covered.`;
        }
      }
    }

    handle.cleanupDetail = reason === 'failure' ? `${detail} ${failureDetail}` : detail;
    record(() => {
      if (reason === 'timeout' || reason === 'cancelled') {
        recordEvent(
          directory,
          task.taskId,
          reason,
          `Parent requested ${reason}. ${detail}`,
          stopped,
        );
      } else if (reason === 'failure' && !readEvent(directory, task.taskId, 'startupFailure')) {
        recordEvent(directory, task.taskId, 'startupFailure', failureDetail);
      }
    });
    record(() => {
      recordEvent(directory, task.taskId, 'cleanup', detail, stopped);
    });
    let outcome: string = reason;
    record(() => {
      outcome = taskStatus(directory, this.ownerId, false).outcome;
    });
    handle.cleanupFinished = true;

    if (!this.closed) {
      record(() => {
        recordEvent(directory, task.taskId, 'notified', 'Parent notification attempted once.');
      });
      const errors = handle.recordErrors.length
        ? ` Evidence errors: ${handle.recordErrors.join('; ')}. Check pane ${handle.paneId ?? 'unknown'} manually.`
        : '';
      this.notify(
        `Worker ${task.name ?? 'unnamed'} (${task.taskId}): ${outcome}. ${handle.cleanupDetail}${errors} Records: ${directory}. ${nativeDescription(task, directory)}`,
      );
    }
  }

  status(taskId: string, parentSessionId: string) {
    let handle: Handle | undefined;
    let task: Task | undefined;
    let directory = join(this.root, taskId);

    try {
      directory = this.directory(taskId, parentSessionId);
      handle = this.handles.get(taskId);
      task = handle ? handle.task : readTask(directory);

      if (handle?.recordErrors.length) {
        throw new Error(handle.recordErrors.join('; '));
      }

      return {
        ...taskStatus(
          directory,
          this.closed || !handle ? undefined : this.ownerId,
          !handle?.stopping,
        ),
        ...genericStatus(directory, task, handle),
      };
    } catch (error) {
      // The handle is assigned only after the parent-session check; rejected callers cannot stop work.
      if (handle && !this.closed) {
        void this.stop(
          handle,
          'failure',
          `Worker evidence unavailable: ${String(error)}. No retry.`,
        );
      }

      const native = task
        ? nativeDescription(task, directory)
        : 'Native session unavailable; inspect the saved directory.';

      throw new Error(
        `Worker ${taskId}: saved evidence is unavailable: ${String(error)}. ${handle?.cleanupDetail ?? 'Cleanup unconfirmed.'} Check pane ${handle?.paneId ?? 'unknown'} manually. Records: ${directory}. ${native}`,
        { cause: error },
      );
    }
  }

  submissionReceipt(taskId: string, parentSessionId: string, id: string) {
    const directory = this.directory(taskId, parentSessionId);

    if (!isGenericLoadout(readTask(directory).loadout)) {
      throw new Error('Pi workers use structured question receipts.');
    }

    return readGenericSubmission(directory, taskId, id);
  }

  async nativeOutput(taskId: string, parentSessionId: string) {
    this.directory(taskId, parentSessionId);
    const handle = this.handles.get(taskId);

    if (!handle || !isGenericLoadout(handle.task.loadout) || this.closed || handle.stopping) {
      throw new Error('Native output requires an active owned generic worker.');
    }

    const call = (argumentsList: string[]) =>
      this.client(argumentsList, workBudget(handle), handle.abort.signal);
    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (location.paneId !== worker.paneId) {
      throw new Error('Worker moved during the native output check.');
    }

    const output = await call(['agent', 'read', worker.paneId]);

    return {
      text: output.slice(0, 8000),
      truncated: output.length > 8000,
      format: 'Herdr response; native text is untrusted, not task acceptance or Tau authorization.',
    };
  }

  questionReceipt(taskId: string, parentSessionId: string, questionId: string) {
    const directory = this.directory(taskId, parentSessionId);
    const question = readQuestion(directory, taskId, questionId);

    if (!question) {
      throw new Error('Unknown worker question.');
    }

    return {
      question,
      reply: readReply(directory, taskId, questionId),
      acknowledgement: readAcknowledgement(directory, taskId, questionId),
    };
  }

  private async replyGeneric(
    handle: Handle,
    answer: { questionId?: string; replyId: string; reply: string },
  ) {
    if (
      answer.questionId !== undefined ||
      answer.replyId === 'assignment' ||
      !answer.reply.trim() ||
      answer.reply.length > 32_000
    ) {
      throw new Error(
        'Generic replies use a unique replyId and plain text, without a structured questionId.',
      );
    }

    const { directory, task } = handle;
    const call = (argumentsList: string[]) =>
      this.client(argumentsList, workBudget(handle), handle.abort.signal);
    handle.nativeState = 'unknown';
    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);
    ensureReplyActive(handle);

    if (
      location.paneId !== worker.paneId ||
      !['idle', 'working', 'done'].includes(handle.nativeState)
    ) {
      throw new Error(
        'Native worker moved, is blocked, or has unknown state. No text or approval sent.',
      );
    }

    if (
      readGenericSubmission(directory, task.taskId, 'assignment')?.observation?.state !==
      'submitted'
    ) {
      throw new Error(
        'Assignment delivery is not confirmed. Replies cannot bypass native startup approvals or uncertain delivery.',
      );
    }

    return submitGenericText(directory, task, answer.replyId, answer.reply, () => {
      ensureReplyActive(handle);

      return call(agentPromptArguments(location.paneId, answer.reply));
    });
  }

  async reply(
    taskId: string,
    parentSessionId: string,
    answer: { questionId?: string; replyId: string; reply: string; scopeUnchanged: unknown },
  ) {
    const directory = this.directory(taskId, parentSessionId);
    const handle = this.handles.get(taskId);

    if (!handle || this.closed || handle.stopping) {
      throw new Error('No active owned worker for this reply.');
    }

    if (answer.scopeUnchanged !== true) {
      throw new Error('Replies cannot increase scope or change saved worker settings.');
    }

    ensureReplyActive(handle);

    if (isGenericLoadout(handle.task.loadout)) {
      return this.replyGeneric(handle, answer);
    }

    if (!answer.questionId) {
      throw new Error('Pi replies require a structured questionId.');
    }

    const value = {
      version: 1,
      taskId,
      questionId: answer.questionId,
      replyId: answer.replyId,
      reply: answer.reply,
    };

    const saved = readReply(directory, taskId, answer.questionId);

    if (saved) {
      acceptReply(directory, taskId, value);

      return {
        replyAccepted: true,
        workerAcknowledged: Boolean(readAcknowledgement(directory, taskId, answer.questionId)),
        delivery: 'Not retried. Prior delivery may be uncertain.',
      };
    }

    if (readPendingQuestion(directory, taskId)?.questionId !== answer.questionId) {
      throw new Error('Reply does not match the pending question.');
    }

    const call = (argumentsList: string[]) =>
      this.client(argumentsList, workBudget(handle), handle.abort.signal);
    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (location.paneId !== worker.paneId) {
      throw new Error('Worker moved during identity checks; no input sent.');
    }

    ensureReplyActive(handle);

    // Another caller may have accepted this reply during the identity check. Never send it twice.
    if (readReply(directory, taskId, answer.questionId)) {
      acceptReply(directory, taskId, value);

      return {
        replyAccepted: true,
        workerAcknowledged: Boolean(readAcknowledgement(directory, taskId, answer.questionId)),
        delivery: 'Not retried. Prior delivery may be uncertain.',
      };
    }

    acceptReply(directory, taskId, value);
    const reference = {
      version: 1,
      taskId,
      questionId: answer.questionId,
      replyId: answer.replyId,
    };
    const delivery = `TAU_REPLY ${JSON.stringify(reference)}`;

    try {
      await call(['agent', 'prompt', text(handle.paneId), delivery]);
    } catch (error) {
      throw new Error(
        'Reply accepted durably, but delivery is uncertain. Do not retry delivery; inspect acknowledgement.',
        { cause: error },
      );
    }

    return {
      replyAccepted: true,
      workerAcknowledged: Boolean(readAcknowledgement(directory, taskId, answer.questionId)),
      delivery:
        'Herdr accepted text. This does not prove worker acknowledgement or applied effects.',
    };
  }

  async cancel(taskId: string, parentSessionId: string) {
    this.directory(taskId, parentSessionId);
    const handle = this.handles.get(taskId);

    if (!handle || this.closed) {
      throw new Error(
        'No active owned handle. Use saved pane and native references for manual cleanup.',
      );
    }

    await this.stop(handle, 'cancelled');

    return this.status(taskId, parentSessionId);
  }

  private directory(taskId: string, parentSessionId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) {
      throw new Error('Invalid task identity.');
    }

    const directory = join(this.root, taskId);
    const task = this.handles.get(taskId)?.task ?? readTask(directory);

    if (task.parentSessionId !== parentSessionId) {
      throw new Error('Task belongs to another parent session.');
    }

    return directory;
  }

  // Cleanup for every worker this controller still owns, so a stopping ancestor does not strand its tree.
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.handles.values()].map((handle) => this.stop(handle, 'cancelled')),
    );
    this.close();
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.lifetime.abort();

    for (const handle of this.handles.values()) {
      clearTimeout(handle.timer);
      handle.removeLaunchAbort?.();
      handle.abort.abort();

      if (handle.stopping) {
        continue;
      }

      // A waiting worker cannot receive a reply from a later controller, so it must stop waiting.
      try {
        recordEvent(
          handle.directory,
          handle.task.taskId,
          'parentClosed',
          'Parent controller closed. Replies are no longer possible.',
        );
      } catch (error) {
        handle.recordErrors.push(String(error));
      }
    }
  }
}
