import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { runWithEnvironment } from '../../hc/connect.js';
import { currentTerminalAddress, get, HcError, ls, readCurrentTerminal } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import type { SkillTools } from '../../skillTools.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { WorkerCapacityFullError } from './capacityRefusal.js';
import { launchErrorResult } from './errorResult.js';
import type { ToolResult } from './errorResult.js';
import { briefWithAppUrl } from './launchEnvironment.js';
import type { LaunchParameters } from './launchParameters.js';
import { resolveRoutedLoadout } from './loadout.js';
import { installWorkerPackages } from './packageInstall.js';
import type { WorkerPackageManager } from './packageInstall.js';
import { removeSnapshotDirectory, snapshotDirectoryFor } from './packageSnapshot.js';
import { piPackageManager } from './piPackageManager.js';
import { workerCommand, workerEnvironment } from './workerCommand.js';

export interface LaunchRuntime {
  pi: ExtensionAPI;
  hc: HcRuntime;
  capacity: number;
  skillTools: SkillTools;
  agentDirectory: string;
  processEnvironment: NodeJS.ProcessEnv;
  admission: Admission;
  refuseCapacity?: (() => void) | undefined;
  refuseSkillTools?: (() => string | undefined) | undefined;
  packageManager?: (loadout: Assignment['loadout']) => WorkerPackageManager;
  buildCommand?: (
    sessionFile: string,
    loadout: Assignment['loadout'],
    extensionPackages: readonly { path: string }[],
  ) => string[];
}

export interface LaunchRequest {
  parameters: LaunchParameters;
  startedAt: { wall: number; monotonic: number };
  parentSession: string;
}

export interface LaunchStatus {
  address: string;
  name: string;
  parent: string | undefined;
  state: string;
  labels: Record<string, string>;
}

type Reconciliation =
  | { kind: 'found'; terminal: HcTerminal }
  | { kind: 'missing' }
  | { kind: 'unclear' };

const defaultTimeoutSeconds = { investigation: 1800, editing: 3600 };
const taskLabelLength = 60;
const workerNameSuffixLength = 8;

const millisecondsPerSecond = 1000;

const firstLine = (value: string | undefined): string => (value ?? '').split('\n')[0] ?? '';

const shortTask = (parameters: LaunchParameters): string => {
  const label = parameters.label;

  if (label !== undefined && label !== '') {
    return label;
  }

  return firstLine(parameters.task).slice(0, taskLabelLength);
};

const workerName = (profile: string, assignmentId: string): string =>
  `${profile}-${assignmentId.replaceAll('-', '').slice(0, workerNameSuffixLength)}`;

const assignmentIdFromPath = (path: string | undefined): string | undefined => {
  if (path === undefined || path === '') {
    return undefined;
  }

  return basename(dirname(path));
};

const isFinished = (terminal: HcTerminal): boolean => terminal.state === 'finished';

export class Admission {
  private tail: Promise<void> = Promise.resolve();
  private readonly live = new Set<string>();

  run<Result>(work: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    const current = Promise.withResolvers<undefined>();

    this.tail = previous.then(() => current.promise);

    return previous.then(async () => {
      try {
        return await work();
      } finally {
        current.resolve(undefined);
      }
    });
  }

  add(assignmentId: string): void {
    this.live.add(assignmentId);
  }

  remove(assignmentId: string): void {
    this.live.delete(assignmentId);
  }

  async count(runtime: LaunchRuntime, parentTerminal: string): Promise<number> {
    const list = await ls(runtime.hc, { all: true });
    const children = list.terminals.filter((terminal) => terminal.parent === parentTerminal);
    const terminals = await Promise.all(children.map((child) => get(runtime.hc, child.address)));
    const assignments = new Map<string, HcTerminal>();

    for (const terminal of terminals) {
      const assignmentId = assignmentIdFromPath(terminal.labels?.['tau.assignment']);

      if (assignmentId !== undefined) {
        assignments.set(assignmentId, terminal);

        if (isFinished(terminal)) {
          this.live.delete(assignmentId);
        }
      }
    }

    let pending = 0;

    for (const [assignmentId, terminal] of assignments) {
      if (isFinished(terminal) || this.live.has(assignmentId)) {
        continue;
      }

      pending += 1;
    }

    return this.live.size + pending;
  }
}

const capacityRefusal = (used: number, capacity: number): WorkerCapacityFullError =>
  new WorkerCapacityFullError(
    `Worker capacity full (${used}/${capacity}). End your turn and retry after a worker stops.`,
  );

const foregroundLabels = async (runtime: LaunchRuntime): Promise<Record<string, string>> => {
  const manager = await readCurrentTerminal(runtime.hc);

  if (manager === undefined) {
    return {};
  }

  const labels: Record<string, string> = {};

  for (const key of ['herdr.space', 'herdr.tab']) {
    const value = manager.labels?.[key];

    if (value !== undefined && value !== '') {
      labels[key] = value;
    }
  }

  return labels;
};

class UnclearLaunchError extends Error {
  override name = 'UnclearLaunchError';

  constructor(name: string) {
    super(
      `The launch is unclear: hc did not confirm whether "${name}" started. Check \`hc ls\` for a terminal named "${name}" before launching again.`,
    );
  }
}

const reconcileUnclearLaunch = async (
  runtime: LaunchRuntime,
  name: string,
): Promise<Reconciliation> => {
  try {
    const list = await ls(runtime.hc, { all: true });
    const match = list.terminals.find((terminal) => terminal.name === name);

    if (match === undefined) {
      return { kind: 'missing' };
    }

    return { kind: 'found', terminal: await get(runtime.hc, match.address) };
  } catch {
    return { kind: 'unclear' };
  }
};

// Only a failure before hc sees the request is definite. Any later failure may have started the
// worker, so it is reconciled by name.
const definiteFailureKinds = new Set(['spawn_failed']);

const isUnclearLaunch = (error: unknown): boolean =>
  error instanceof HcError && !definiteFailureKinds.has(error.kind);

const launchStatus = (terminal: HcTerminal): LaunchStatus => ({
  address: terminal.address,
  name: terminal.name ?? '',
  parent: terminal.parent ?? undefined,
  state: terminal.state,
  labels: terminal.labels ?? {},
});

const buildAssignment = (
  assignmentId: string,
  parameters: LaunchParameters,
  resolved: Awaited<ReturnType<typeof resolveRoutedLoadout>>,
  deadline: number,
  parentSession: string,
  parentTerminal: string,
  packageSnapshot: string | undefined,
): Assignment => {
  const sessionId = randomUUID();
  const sessionFile = join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`);

  return {
    version: 1,
    assignmentId,
    task: briefWithAppUrl(parameters.task, parameters.url),
    acceptance: parameters.acceptance ?? [],
    label: parameters.label ?? null,
    profile: resolved.loadout.profile,
    loadout: resolved.loadout,
    routing: resolved.routing ?? null,
    packageSnapshot: packageSnapshot ?? null,
    session: { file: sessionFile, id: sessionId },
    parentSession,
    cwd: resolved.loadout.cwd,
    parentTerminal,
    deadline,
    createdAt: Date.now(),
    report: null,
  };
};

const startWorker = async (
  runtime: LaunchRuntime,
  request: LaunchRequest,
  resolved: Awaited<ReturnType<typeof resolveRoutedLoadout>>,
  assignment: Assignment,
  extensionPackages: readonly { path: string }[],
  signal: AbortSignal | undefined,
): Promise<HcTerminal> => {
  const commandBuilder =
    runtime.buildCommand ??
    ((sessionFile, loadout, packages) =>
      workerCommand(sessionFile, loadout, packages, runtime.skillTools));

  const argv = commandBuilder(assignment.session.file, assignment.loadout, extensionPackages);

  const environment = workerEnvironment(runtime.processEnvironment, runtime.agentDirectory);

  const visibility =
    request.parameters.visibility ??
    (resolved.loadout.role === 'editing' ? 'foreground' : 'background');

  const labels: Record<string, string> = {
    'tau.assignment': join(assignmentDirectory(assignment.assignmentId), 'assignment.json'),
    'tau.profile': assignment.profile,
    'tau.model': assignment.loadout.model,
    'tau.deadline': String(assignment.deadline),
    'tau.task': shortTask(request.parameters),
  };

  if (visibility === 'foreground') {
    Object.assign(labels, await foregroundLabels(runtime));
  }

  // No await may sit between this check and the request, so a cancellation during the label read
  // never starts a worker.
  signal?.throwIfAborted();

  const name = workerName(assignment.profile, assignment.assignmentId);

  return runWithEnvironment(
    { ...runtime.hc, ...(signal === undefined ? {} : { signal }) },
    {
      argv,
      name,
      ...(assignment.parentTerminal === '' ? {} : { parent: assignment.parentTerminal }),
      cwd: assignment.cwd,
      labels,
      env: environment,
    },
  );
};

export const executeLaunch = async (
  runtime: LaunchRuntime,
  request: LaunchRequest,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<ToolResult<LaunchStatus | undefined>> => {
  try {
    const skillToolsRefusal = runtime.refuseSkillTools?.();

    if (skillToolsRefusal !== undefined) {
      throw new Error(skillToolsRefusal);
    }

    const { loadout, routing } = await resolveRoutedLoadout(
      request.parameters,
      context,
      runtime.pi.getCommands(),
      signal,
    );

    const timeout =
      (request.parameters.timeoutSeconds ?? defaultTimeoutSeconds[loadout.role]) *
      millisecondsPerSecond;

    const deadline = request.startedAt.wall + timeout;
    const parentTerminal = currentTerminalAddress();

    if (parentTerminal === undefined) {
      throw new Error('Worker launch requires HC_TERMINAL_ID. Start Tau inside an hc terminal.');
    }

    const assignmentId = randomUUID();
    const packageManager = runtime.packageManager ?? piPackageManager;

    return await runtime.admission.run(async () => {
      signal?.throwIfAborted();

      const used = await runtime.admission.count(runtime, parentTerminal);

      if (used >= runtime.capacity) {
        throw capacityRefusal(used, runtime.capacity);
      }

      const snapshotDirectory = snapshotDirectoryFor(runtime.agentDirectory, assignmentId);

      const extensionPackages = await installWorkerPackages(
        loadout,
        packageManager,
        signal ?? new AbortController().signal,
        snapshotDirectory,
      );

      const errorAfterCleanup = async (error: unknown): Promise<unknown> => {
        if (extensionPackages.length === 0) {
          return error;
        }

        const cleanupError = await removeSnapshotDirectory({
          agentDirectory: runtime.agentDirectory,
          directory: snapshotDirectory,
          snapshotName: assignmentId,
        });

        if (cleanupError === undefined) {
          return error;
        }

        return new Error(
          `${errorMessage(error)} Also failed to remove the launch package snapshot: ${cleanupError}`,
          { cause: error },
        );
      };

      let assignment: Assignment;

      try {
        assignment = buildAssignment(
          assignmentId,
          request.parameters,
          { loadout, routing },
          deadline,
          request.parentSession,
          parentTerminal,
          extensionPackages.length === 0 ? undefined : snapshotDirectory,
        );

        await writeAssignment(assignment);
      } catch (error) {
        throw await errorAfterCleanup(error);
      }

      runtime.admission.add(assignmentId);

      try {
        signal?.throwIfAborted();

        const terminal = await startWorker(
          runtime,
          request,
          { loadout, routing },
          assignment,
          extensionPackages,
          signal,
        );

        runtime.admission.remove(assignmentId);

        const status = launchStatus(terminal);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status) }],
          details: status,
        };
      } catch (error) {
        if (!isUnclearLaunch(error)) {
          runtime.admission.remove(assignmentId);
          throw await errorAfterCleanup(error);
        }

        const name = workerName(assignment.profile, assignmentId);
        const reconciled = await reconcileUnclearLaunch(runtime, name);

        if (reconciled.kind === 'found') {
          runtime.admission.remove(assignmentId);

          const status = launchStatus(reconciled.terminal);

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(status) }],
            details: status,
          };
        }

        if (reconciled.kind === 'missing') {
          runtime.admission.remove(assignmentId);
          throw await errorAfterCleanup(error);
        }

        throw new UnclearLaunchError(name);
      }
    });
  } catch (error) {
    if (error instanceof WorkerCapacityFullError) {
      runtime.refuseCapacity?.();
    }

    return launchErrorResult(error);
  }
};
