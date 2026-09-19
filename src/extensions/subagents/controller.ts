import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
import {
  claudeArguments,
  claudeChannelSocket,
  claudeEnvironment,
  claudeMcpDocument,
  claudeSettingsDocument,
  claudeToolName,
  claudeUsage,
} from './claude.js';
import { ClaudeChannel } from './claudeHost.js';
import { requireHandover, refuseLiveNativeWriter } from './continuations.js';
import { authorizeHistoryTask, sessionRoot } from './history.js';
import { authenticateParent, channelAuthority, currentProcessIdentity } from './identity.js';
import { resolveInheritedClaudeLoadout, validateSavedLoadout } from './loadout.js';
import { allocateName, nameSuffix } from './names.js';
import { validateNative } from './native.js';
import { WorkerPlacement } from './placement.js';
import type { Visibility } from './placement.js';
import { claudeNativeIdentity, nativeIdentity, seedSession, workerPrompt } from './profiles.js';
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
import { harnessOf, isClaudeLoadout } from './types.js';
import type {
  ChannelTool,
  ClaudeLoadout,
  Loadout,
  Question,
  Report,
  Task,
  TaskEvent,
} from './types.js';

const visibilitySchema = Type.Optional(
  Type.Union([Type.Literal('foreground'), Type.Literal('background')]),
);
const nestedLaunchSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 32_000 }),
    profile: Type.String({ minLength: 1 }),
    timeoutSeconds: Type.Integer({ minimum: 10, maximum: 86_400 }),
    cwd: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    harness: Type.Optional(Type.String()),
    visibility: visibilitySchema,
  },
  { additionalProperties: false },
);
const statusSchema = Type.Object(
  { taskId: Type.String(), questionId: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const replyToolSchema = Type.Object(
  {
    taskId: Type.String(),
    questionId: Type.String(),
    replyId: Type.String({ pattern: '^[a-zA-Z0-9-]{1,128}$' }),
    reply: Type.String({ minLength: 1, maxLength: 32_000 }),
    scopeUnchanged: Type.Boolean(),
  },
  { additionalProperties: false },
);
const cancelSchema = Type.Object({ taskId: Type.String() }, { additionalProperties: false });
const agentSessionSchema = Type.Object({ value: Type.String({ minLength: 1 }) });

export type HerdrClient = (
  arguments_: string[],
  budget: number,
  signal?: AbortSignal,
) => Promise<string>;
export const herdrClient: HerdrClient = (arguments_, budget, signal) =>
  runClient('herdr', arguments_, budget, signal);

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
  if (isClaudeLoadout(task.loadout)) {
    throw new Error('Claude workers launch through their own canonical command.');
  }
  const separator = task.loadout.model.indexOf('/');

  return [
    '--approve',
    '--session',
    task.nativeSessionFile,
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

const nativeUsage = (task: Task) => {
  if (!isClaudeLoadout(task.loadout)) {
    return {
      available: false as const,
      reason: 'Pi reports worker usage in its own session totals.',
    };
  }

  try {
    return { available: true as const, ...claudeUsage(task.nativeSessionFile) };
  } catch (error) {
    return { available: false as const, reason: String(error) };
  }
};

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
    reservationDirectory: task.tree ? admissionDirectory(dirname(directory), task.tree) : undefined,
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
  // A Claude worker reaches its own process after the pane shell runs the command.
  workerObserved?: boolean;
  channel?: ClaudeChannel;
  nested?: WorkerController;
  recordErrors: string[];
  cleanupDetail?: string;
  cleanupFinished?: boolean;
  notifiedQuestions: Set<string>;
}

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
    !readEvent(directory, task.taskId, 'accepted') ||
    (['settled', 'startupFailure', 'cleanup', 'cancelled', 'timeout'] as const).some((kind) =>
      readEvent(directory, task.taskId, kind),
    ) ||
    readReport(directory, task.taskId)
  ) {
    throw new Error('Worker task is inactive.');
  }
};

// A Claude worker is typed into the pane shell, so its process and agent identity appear a moment later.
class PendingStartError extends Error {
  override name = 'PendingStartError';
}

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
    throw new PendingStartError('Claude has not reached its own process yet.');
  }

  throw new Error('Worker exited before readiness. No task dispatch or retry.');
};

const readAgent = async (
  call: (arguments_: string[]) => Promise<string>,
  paneId: string,
  starting: boolean,
): Promise<Record<string, unknown>> => {
  try {
    // herdr answers with an error document for a pane that has no detected agent yet.
    return object(result(await call(['agent', 'get', paneId])).agent);
  } catch (error) {
    if (starting) {
      throw new PendingStartError('Claude has not reported its session to herdr yet.');
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

    // Claude opens and owns its own transcript; only Pi sessions are seeded with Tau lineage.
    if (!continued && !isClaudeLoadout(task.loadout)) {
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
  expected: { paneId: string; expectedSession: string; claude: boolean; starting: boolean },
  unchangedShell: boolean,
): void => {
  // herdr reports a detected agent before its integration reports which session that agent opened.
  const identified =
    agent.agent === (expected.claude ? 'claude' : 'pi') &&
    Value.Check(agentSessionSchema, agent.agent_session) &&
    agent.agent_session.value === expected.expectedSession;

  if (expected.starting && !identified) {
    throw new PendingStartError('Claude has not reported this task session to herdr yet.');
  }
  if (agent.pane_id !== expected.paneId || !identified || unchangedShell) {
    throw new Error('Started worker identity could not be established.');
  }
};

const inspectWorker = async (
  handle: Handle,
  call: (arguments_: string[]) => Promise<string>,
): Promise<OwnedWorker> => {
  const claude = isClaudeLoadout(handle.task.loadout);
  const location = await resolveTerminal(text(handle.terminalId), call);
  const paneId = location.paneId;

  handle.paneId = paneId;

  const information = object(
    result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
  );
  const previous = handle.owned ? { ...handle.owned, paneId } : undefined;
  // Ownership is unestablished until a started process reports the expected session to herdr.
  const starting = claude && !previous;
  checkForeground(information, paneId, previous, starting && !handle.workerObserved);

  handle.workerObserved = true;

  const agent = await readAgent(call, paneId, starting);
  const processId = integer(information.foreground_process_group_id);
  const shellPid = integer(information.shell_pid);
  const expectedSession = claude ? handle.task.nativeSessionId : handle.task.nativeSessionFile;
  checkAgentIdentity(agent, { paneId, expectedSession, claude, starting }, shellPid === processId);

  const startedAt = await readProcessStart(handle, processId);
  const owned: OwnedWorker = previous ?? {
    kind: claude ? 'claude' : 'pi',
    paneId,
    terminalId: location.terminalId,
    shellPid,
    processId,
    token: expectedSession,
    startedAt,
  };
  if (!startedAt || startedAt !== owned.startedAt || !matchesWorker(information, owned)) {
    throw new Error('Worker process start or pane identity changed or is unavailable.');
  }

  return owned;
};

const awaitStartedWorker = async (
  handle: Handle,
  call: (arguments_: string[]) => Promise<string>,
): Promise<OwnedWorker> => {
  for (;;) {
    handle.abort.signal.throwIfAborted();

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each attempt checks live identity within the same startup budget.
      return await inspectWorker(handle, call);
    } catch (error) {
      if (!(error instanceof PendingStartError)) {
        throw error;
      }
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Startup polling remains bounded by the deadline and cancellation signal.
    await delay(Math.min(250, workBudget(handle)), undefined, { signal: handle.abort.signal });
  }
};

const waitForWorkerReadiness = async (
  handle: Handle,
  call: (arguments_: string[]) => Promise<string>,
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

  return isClaudeLoadout(loadout)
    ? claudeNativeIdentity(loadout.agentDirectory, loadout.cwd)
    : nativeIdentity(directory);
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

export class WorkerController {
  readonly ownerId = randomUUID();
  // Nested Claude delegation resolves profiles and trust against the parent session's current project.
  project?: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'> | undefined;
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
    call: (arguments_: string[]) => Promise<string>,
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
        environment: [
          `TAU_WORKER_RECORD=${handle.directory}`,
          `TAU_PARENT_PROCESS=${process.pid}`,
          ...(isClaudeLoadout(handle.task.loadout)
            ? claudeEnvironment(handle.task.loadout)
            : [`PI_CODING_AGENT_DIR=${handle.task.loadout.agentDirectory}`]),
        ],
      },
      call,
      handle.abort.signal,
    );
  }

  // The channel caller must validate the parent task before supplying delegated authority.
  delegate(
    input: LaunchInput,
    authority: { tree: NonNullable<Task['tree']>; parent: Task },
    signal: AbortSignal = new AbortController().signal,
  ) {
    return this.launchTask(input, signal, undefined, authority);
  }

  private nestedController(handle: Handle): WorkerController {
    handle.nested ??= new WorkerController(this.root, this.client, (message) => {
      void this.deliverNotice(handle, message);
    });
    handle.nested.project = this.project;

    return handle.nested;
  }

  private async deliverNotice(handle: Handle, message: string): Promise<void> {
    const channel = handle.channel;
    const paneId = handle.paneId;
    if (this.closed || handle.stopping || !channel || !paneId) {
      return;
    }

    try {
      await this.client(
        ['agent', 'prompt', paneId, channel.notice(message)],
        Math.max(1, Math.min(30_000, remainingWorkBudget(handle))),
        handle.abort.signal,
      );
    } catch (error) {
      this.notify(
        `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}) could not receive a child notice: ${String(error)} Notice: ${message}`,
      );
    }
  }

  private delegationTools(handle: Handle): ChannelTool[] {
    const owner = () => handle.task.nativeSessionId;

    return [
      {
        name: 'subagent',
        description:
          'Delegate a bounded nested task inside your assigned scope. It inherits your exact model, permissions, harness, cwd, and safety integration, and shares one root capacity cap. A full or busy tree refuses promptly without a queue; never retry in a loop.',
        parameters: nestedLaunchSchema,
        execute: async (input) => {
          if (!Value.Check(nestedLaunchSchema, input)) {
            throw new Error('Invalid nested worker request.');
          }

          const project = this.project;
          const inherited = handle.task.loadout;
          if (!isClaudeLoadout(inherited) || !project) {
            throw new Error('Nested delegation needs an active Claude parent task.');
          }

          const authority = channelAuthority(
            this.root,
            readTask(handle.directory),
            claudeToolName('subagent'),
          );
          const loadout = await resolveInheritedClaudeLoadout(
            handle.task,
            inherited,
            { ...input, permissions: inherited.permissions },
            project,
          );

          return this.nestedController(handle).delegate(
            {
              task: input.task,
              loadout,
              timeout: input.timeoutSeconds * 1000,
              parentSession: handle.task.nativeSessionFile,
              parentSessionId: handle.task.nativeSessionId,
              ...(handle.paneId ? { parentPane: handle.paneId } : {}),
              ...(input.visibility ? { visibility: input.visibility } : {}),
            },
            authority,
          );
        },
      },
      {
        name: 'subagent_status',
        description:
          'Recover validated results, pending questions, and native references for a task you delegated. Reconnect never resubmits work or resets deadlines.',
        parameters: statusSchema,
        execute: (input) => {
          if (!Value.Check(statusSchema, input)) {
            throw new Error('Invalid status request.');
          }

          const nested = this.nestedController(handle);
          const receipt = input.questionId
            ? nested.questionReceipt(input.taskId, owner(), input.questionId)
            : undefined;

          return Promise.resolve({
            ...nested.status(input.taskId, owner()),
            questionReceipt: receipt,
          });
        },
      },
      {
        name: 'subagent_reply',
        description:
          'Answer one pending clarification from a task you delegated. Scope increases are refused, and delivery is never retried.',
        parameters: replyToolSchema,
        execute: (input) => {
          if (!Value.Check(replyToolSchema, input)) {
            throw new Error('Invalid reply request.');
          }

          return this.nestedController(handle).reply(input.taskId, owner(), input);
        },
      },
      {
        name: 'subagent_cancel',
        description:
          'Attempt bounded identity-checked cancellation of a task you delegated. Failed cleanup may require manual action.',
        parameters: cancelSchema,
        execute: (input) => {
          if (!Value.Check(cancelSchema, input)) {
            throw new Error('Invalid cancellation request.');
          }

          return this.nestedController(handle).cancel(input.taskId, owner());
        },
      },
    ];
  }

  private async startWorker(
    handle: Handle,
    paneId: string,
    name: string,
    call: (arguments_: string[]) => Promise<string>,
  ): Promise<void> {
    const { directory, task } = handle;
    const claude = isClaudeLoadout(task.loadout) ? task.loadout : undefined;
    if (claude) {
      await this.openClaudeChannel(handle, claude);
    }

    // A failing start call can still leave a process behind.
    handle.workerNeverStarted = false;
    if (claude) {
      await call(['pane', 'run', paneId, ...claudeArguments(task, claude, directory)]);

      return;
    }

    await call([
      'agent',
      'start',
      name,
      '--kind',
      'pi',
      '--pane',
      paneId,
      '--timeout',
      String(workBudget(handle)),
      '--',
      ...workerArguments(task),
    ]);
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

  // Pi reads its dispatch record itself; Claude starts from a prompt its hook matches to that record.
  private async dispatch(
    handle: Handle,
    call: (arguments_: string[]) => Promise<string>,
  ): Promise<void> {
    const { directory, task } = handle;
    if (!isClaudeLoadout(task.loadout)) {
      publish(directory, 'dispatch.json', { taskId: task.taskId });

      return;
    }

    const prompt = workerPrompt(task);
    publish(directory, 'dispatch.json', { taskId: task.taskId, prompt });
    await call(['agent', 'prompt', text(handle.paneId), prompt]);
  }

  private async openClaudeChannel(handle: Handle, loadout: ClaudeLoadout): Promise<void> {
    const socketPath = claudeChannelSocket(handle.directory);
    const channel = new ClaudeChannel({
      directory: handle.directory,
      task: handle.task,
      socketPath,
      children: () => this.nestedController(handle).children(),
      delegation: () => this.delegationTools(handle),
    });
    handle.channel = channel;
    await channel.listen();

    publish(handle.directory, 'claudeSettings.json', claudeSettingsDocument(loadout, socketPath));
    publish(handle.directory, 'claudeMcp.json', claudeMcpDocument(loadout, socketPath));
  }

  private async launchTask(
    input: LaunchInput,
    launchSignal: AbortSignal,
    source?: FollowUpPreparation,
    delegated?: Awaited<ReturnType<WorkerController['parentAuthority']>>,
  ): Promise<ReturnType<typeof taskStatus>> {
    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }
    launchSignal.throwIfAborted();
    const taskId = randomUUID();
    const directory = join(this.root, taskId);
    const timing = launchTiming(input.timeout, input.startedAt);
    // Channel callers supply checked authority instead of Pi session evidence.
    const authority =
      delegated ??
      (await this.parentAuthority(input.parentSession, input.parentSessionId, launchSignal));
    const { createdAt, deadline, expires, cancellationBudget, monotonicDeadline } = boundedTiming(
      timing,
      authority.parent,
    );
    const task = validateTask({
      version: 1,
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
    // ponytail: Each live legacy task rebuilds ancestry; share a registry if large upgraded histories make admission slow.
    reserveTask(this.root, task, capacity, (legacy) =>
      sessionRoot(this.root, { file: legacy.parentSession, id: legacy.parentSessionId }),
    );
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
      const call = (arguments_: string[]) =>
        this.client(arguments_, workBudget(handle), handle.abort.signal);
      const location = await this.placeWorker(input, handle, call);
      if (source) {
        checkNativeWriterListing(await call(['agent', 'list']), task);
        checkHandoff(this.root, source, task);
      }

      await this.startWorker(handle, location.paneId, name, call);
      handle.owned = await awaitStartedWorker(handle, call);
      publish(directory, 'owned.json', handle.owned);

      const ready = await waitForWorkerReadiness(handle, call);
      const current = await inspectWorker(handle, call);
      if (ready.processId !== current.processId) {
        throw new Error('Native session and worker readiness identities did not match.');
      }

      handle.abort.signal.throwIfAborted();
      await this.dispatch(handle, call);
      this.poll(handle);
      handle.removeLaunchAbort();
    } catch (error) {
      const reason = remainingWorkBudget(handle) <= 0 ? 'timeout' : 'failure';
      await this.stop(handle, reason, `Startup delivery is uncertain; no retry. ${String(error)}`);
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
          const channelFailure = handle.channel?.failure();
          if (channelFailure) {
            void this.stop(handle, 'failure', `${channelFailure} No retry.`);
            return;
          }
          if (handle.task.tree?.parentTaskId) {
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
        Math.min(250, handle.expires - handle.task.cancellationBudget - performance.now()),
      ),
    );
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
    // Nested workers keep running and holding capacity unless this stop reaches them first.
    const nested = handle.nested?.stopAll() ?? Promise.resolve();
    const cleaned = this.cleanup(handle, reason, failureDetail);

    handle.stopping = Promise.allSettled([nested, cleaned])
      .then(() => {
        handle.channel?.close();
        handle.nested?.close();
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
          `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}): cleanup unconfirmed. ${String(error)}. Check pane ${handle.paneId ?? 'unknown'} manually. Records: ${handle.directory}. Native session: ${handle.task.nativeSessionId} (${handle.task.nativeSessionFile}).`,
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
    const call = (arguments_: string[]) => this.client(arguments_, remainingBudget(), signal);
    let stopped = handle.workerNeverStarted;
    const paneClosure = { confirmed: false };
    let detail = stopped
      ? `No worker process was ever started for this task. Pane ${handle.paneId ?? 'none'} is left as placed.`
      : `Cleanup unconfirmed. Check pane ${handle.paneId ?? 'unknown'} manually. No automatic retry.`;

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

        return workerStopped(information, owned);
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
            (arguments_, remaining, attempt) => this.client(arguments_, remaining, attempt),
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
        `Worker ${task.name ?? 'unnamed'} (${task.taskId}): ${outcome}. ${handle.cleanupDetail}${errors} Records: ${directory}. Native session: ${task.nativeSessionId} (${task.nativeSessionFile}).`,
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

      return taskStatus(
        directory,
        this.closed || !handle ? undefined : this.ownerId,
        !handle?.stopping,
      );
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
        ? `Native session: ${task.nativeSessionId} (${task.nativeSessionFile}).`
        : 'Native session unavailable; inspect the saved directory.';

      throw new Error(
        `Worker ${taskId}: saved evidence is unavailable: ${String(error)}. ${handle?.cleanupDetail ?? 'Cleanup unconfirmed.'} Check pane ${handle?.paneId ?? 'unknown'} manually. Records: ${directory}. ${native}`,
        { cause: error },
      );
    }
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

  async reply(
    taskId: string,
    parentSessionId: string,
    answer: { questionId: string; replyId: string; reply: string; scopeUnchanged: unknown },
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
    const call = (arguments_: string[]) =>
      this.client(arguments_, workBudget(handle), handle.abort.signal);
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
    // Claude cannot transform its own input, so it receives the accepted reply text with its reference.
    const delivery = isClaudeLoadout(handle.task.loadout)
      ? `TAU_REPLY ${answer.questionId} ${answer.replyId}\n${answer.reply}`
      : `TAU_REPLY ${JSON.stringify(reference)}`;
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
      handle.channel?.close();
      handle.nested?.close();
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
