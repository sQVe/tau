import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { runWithEnvironment } from '../../hc/connect.js';
import { currentTerminalAddress, get, HcError, ls, readCurrentTerminal } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { currentRole } from '../../role/role.js';
import type { SkillTools } from '../../skillTools.js';
import { readSkillTools as readCurrentSkillTools } from '../../skillTools.js';
import { acceptanceRefusal } from './acceptanceRefusal.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { WorkerCapacityFullError } from './capacityRefusal.js';
import { launchErrorResult } from './errorResult.js';
import type { ToolResult } from './errorResult.js';
import { briefWithAppUrl } from './launchEnvironment.js';
import type { LaunchParameters } from './launchParameters.js';
import { resolveLoadout } from './loadout.js';
import { installWorkerPackages } from './packageInstall.js';
import type { WorkerPackageManager } from './packageInstall.js';
import {
  missingPackagePath,
  missingPackagePathError,
  removeSnapshotDirectory,
  snapshotDirectoryFor,
} from './packageSnapshot.js';
import { piPackageManager } from './piPackageManager.js';
import { roleLaunchRefusal } from './roleLaunchRefusal.js';
import { skillToolsRefusal } from './skillToolsRefusal.js';
import {
  clearSnapshotMarker,
  markSnapshotUnused,
  readSnapshotUnusedSince,
} from './snapshotMarker.js';
import { workerCommand, workerEnvironment } from './workerCommand.js';
import type { StartingWorker } from './workerFolderDecision.js';
import { sweepWorkerFolders, withFolderSweepLock } from './workerFolderSweep.js';
import { workerName } from './workerName.js';
import { packagesNeedSnapshot } from './workerPackages.js';
import { placementLabels } from './workerPlacement.js';
import {
  createScratchDirectory,
  errorAfterScratchCleanup,
  scratchDirectoryFor,
} from './workerScratch.js';

export interface LaunchRuntime {
  pi: ExtensionAPI;
  hc: HcRuntime;
  capacity: number;
  agentDirectory: string;
  processEnvironment: NodeJS.ProcessEnv;
  admission: Admission;
  refuseCapacity?: (() => void) | undefined;
  readSkillTools?: (() => SkillTools | undefined) | undefined;
  sweepFolders?: ((starting: StartingWorker) => Promise<unknown>) | undefined;
  packageManager?: (loadout: Assignment['loadout']) => WorkerPackageManager;
  buildCommand?: (
    sessionFile: string,
    loadout: Assignment['loadout'],
    extensionPackages: readonly { path: string }[],
    skillTools: SkillTools,
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
  model: string;
  modelReason: string;
  warning?: string;
}

type Reconciliation =
  | { kind: 'found'; terminal: HcTerminal }
  | { kind: 'missing' }
  | { kind: 'unclear' };

export interface WorkerStart {
  assignment: Assignment;
  task: string;
  label: string | undefined;
  extensionPackages: readonly { path: string }[];
  skillTools: SkillTools;
  modelReason: string;
  signal: AbortSignal | undefined;
}

interface StartedFollowUp {
  terminal: HcTerminal;
  warning?: string;
}

const defaultTimeoutSeconds = { investigation: 1800, editing: 3600 };
const taskLabelLength = 60;

const millisecondsPerSecond = 1000;

const firstLine = (value: string | undefined): string => (value ?? '').split('\n')[0] ?? '';

const shortTask = (task: string, label: string | undefined): string => {
  if (label !== undefined && label !== '') {
    return label;
  }

  return firstLine(task).slice(0, taskLabelLength);
};

const assignmentIdFromPath = (path: string | undefined): string | undefined => {
  if (path === undefined || path === '') {
    return undefined;
  }

  return basename(dirname(path));
};

const isFinished = (terminal: HcTerminal): boolean => terminal.state === 'finished';

export class Admission {
  private tail: Promise<void> = Promise.resolve();
  private readonly live = new Map<string, string>();

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

  add(assignmentId: string, sessionFile: string): void {
    this.live.set(assignmentId, sessionFile);
  }

  holdsSession(sessionFile: string): boolean {
    return [...this.live.values()].includes(sessionFile);
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

export const capacityRefusal = (used: number, capacity: number): WorkerCapacityFullError =>
  new WorkerCapacityFullError(
    `Worker capacity full (${used}/${capacity}). End your turn and retry after a worker stops.`,
  );

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

const launchStatus = (terminal: HcTerminal, model: string, modelReason: string): LaunchStatus => ({
  address: terminal.address,
  name: terminal.name ?? '',
  parent: terminal.parent ?? undefined,
  state: terminal.state,
  labels: terminal.labels ?? {},
  model,
  modelReason,
});

const buildAssignment = (
  assignmentId: string,
  parameters: LaunchParameters,
  loadout: Assignment['loadout'],
  deadline: number,
  parentSession: string,
  parentTerminal: string,
  packageSnapshot: string | undefined,
  extensionPackages: readonly { source: string; path: string }[],
): Assignment => {
  const sessionId = randomUUID();
  const sessionFile = join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`);

  return {
    version: 3,
    assignmentId,
    task: briefWithAppUrl(parameters.task, parameters.url),
    acceptance: parameters.acceptance ?? [],
    label: parameters.label ?? null,
    profile: loadout.profile,
    loadout,
    routing: null,
    packageSnapshot: packageSnapshot ?? null,
    session: { file: sessionFile, id: sessionId },
    parentSession,
    cwd: loadout.cwd,
    parentTerminal,
    deadline,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: [...extensionPackages],
    questions: [],
    report: null,
  };
};

const startAssignmentWorker = async (
  runtime: LaunchRuntime,
  facts: WorkerStart,
  placement: Record<string, string>,
): Promise<HcTerminal> => {
  const { assignment, extensionPackages, skillTools } = facts;

  const commandBuilder =
    runtime.buildCommand ??
    ((sessionFile, loadout, packages) => workerCommand(sessionFile, loadout, packages, skillTools));

  const argv = commandBuilder(
    assignment.session.file,
    assignment.loadout,
    extensionPackages,
    skillTools,
  );

  const environment = workerEnvironment(
    runtime.processEnvironment,
    runtime.agentDirectory,
    scratchDirectoryFor(runtime.agentDirectory, assignment.assignmentId),
    assignmentDirectory(assignment.assignmentId),
  );

  const labels: Record<string, string> = {
    'tau.assignment': join(assignmentDirectory(assignment.assignmentId), 'assignment.json'),
    'tau.profile': assignment.profile,
    'tau.role': 'worker',
    'tau.model': assignment.loadout.model,
    'tau.deadline': String(assignment.deadline),
    'tau.task': shortTask(facts.task, facts.label),
    ...placement,
  };

  // No await may sit between this check and the request, so a cancellation before the request never
  // starts a worker.
  facts.signal?.throwIfAborted();

  const name = workerName(assignment.profile, assignment.assignmentId);

  return runWithEnvironment(
    { ...runtime.hc, ...(facts.signal === undefined ? {} : { signal: facts.signal }) },
    {
      argv,
      name,
      ...(assignment.parentTerminal === '' ? {} : { parent: assignment.parentTerminal }),
      cwd: assignment.cwd,
      labels,
      noNotify: true,
      env: environment,
    },
  );
};

const startFolderSweep = (
  runtime: LaunchRuntime,
  assignment: Assignment,
  terminal: HcTerminal,
): void => {
  const snapshot = assignment.packageSnapshot;

  const starting: StartingWorker = {
    kind: 'read',
    assignmentId: assignment.assignmentId,
    running: true,
    packageSnapshot: snapshot === null ? null : basename(snapshot),
    terminalAddress: terminal.address,
  };

  const sweep =
    runtime.sweepFolders ??
    ((fact) => sweepWorkerFolders(runtime.hc, runtime.agentDirectory, Date.now, [fact]));

  // A sweep failure never fails a launch. The next scan reports it.
  sweep(starting).catch(() => undefined);
};

const startWithReconciliation = async (
  runtime: LaunchRuntime,
  facts: WorkerStart,
  placement: Record<string, string>,
): Promise<HcTerminal> => {
  try {
    return await startAssignmentWorker(runtime, facts, placement);
  } catch (error) {
    if (!isUnclearLaunch(error)) {
      throw error;
    }

    const name = workerName(facts.assignment.profile, facts.assignment.assignmentId);
    const reconciled = await reconcileUnclearLaunch(runtime, name);

    if (reconciled.kind === 'missing') {
      throw error;
    }

    if (reconciled.kind === 'unclear') {
      throw new UnclearLaunchError(name);
    }

    return reconciled.terminal;
  }
};

// A reused snapshot may carry a marker older than its new user. The follow-up clears it under the
// sweep lock, so no sweep can start an unused window before the worker runs.
const startPackageBackedFollowUp = async (
  runtime: LaunchRuntime,
  facts: WorkerStart,
  placement: Record<string, string>,
): Promise<StartedFollowUp> => {
  const { assignment } = facts;
  const snapshot = assignment.packageSnapshot;

  if (snapshot === null) {
    throw new Error('A package-backed follow-up needs a package snapshot.');
  }

  const snapshotName = basename(snapshot);
  let started: HcTerminal | undefined;

  try {
    const terminal = await withFolderSweepLock(runtime.agentDirectory, facts.signal, async () => {
      const missingPath = missingPackagePath(facts.extensionPackages);

      if (missingPath !== undefined) {
        throw missingPackagePathError(missingPath);
      }

      let priorMarker: number | undefined;

      try {
        priorMarker = await readSnapshotUnusedSince(runtime.agentDirectory, snapshotName);
      } catch (error) {
        throw new Error(
          `Reading the unused marker of snapshot ${snapshotName} failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }

      const clearError = await clearSnapshotMarker(runtime.agentDirectory, snapshotName);

      if (clearError !== undefined) {
        throw new Error(clearError);
      }

      try {
        await createScratchDirectory(runtime.agentDirectory, assignment.assignmentId);
        started = await startWithReconciliation(runtime, facts, placement);
      } catch (error) {
        const mayHaveStarted = isUnclearLaunch(error) || error instanceof UnclearLaunchError;

        if (priorMarker !== undefined && !mayHaveStarted) {
          const restoreError = await markSnapshotUnused(
            runtime.agentDirectory,
            snapshotName,
            priorMarker,
          );

          if (restoreError !== undefined) {
            throw new Error(
              `${errorMessage(error)}; restoring the unused marker failed: ${restoreError}`,
              { cause: error },
            );
          }
        }

        throw error;
      }

      return started;
    });

    return { terminal };
  } catch (error) {
    if (started === undefined) {
      throw error;
    }

    return {
      terminal: started,
      warning: `The folder sweep lock was not released after the follow-up started: ${errorMessage(error)}`,
    };
  }
};

export const startReservedWorker = async (
  runtime: LaunchRuntime,
  facts: WorkerStart,
  hooks: { onDefiniteFailure?: ((error: unknown) => Promise<unknown>) | undefined } = {},
): Promise<ToolResult<LaunchStatus>> => {
  const { assignment } = facts;
  const assignmentId = assignment.assignmentId;

  runtime.admission.add(assignmentId, assignment.session.file);

  try {
    facts.signal?.throwIfAborted();

    const manager = await readCurrentTerminal(runtime.hc);
    const placement = placementLabels(manager?.labels ?? {});

    const waitsForSweepLock =
      assignment.previousAssignmentId !== null && assignment.packageSnapshot !== null;

    let terminal: HcTerminal;
    let warning: string | undefined;

    if (waitsForSweepLock) {
      const started = await startPackageBackedFollowUp(runtime, facts, placement);

      terminal = started.terminal;
      warning = started.warning;
    } else {
      // A sweep removes a scratch folder 60 s after creation, so no slow read may sit between the
      // creation and the request.
      await createScratchDirectory(runtime.agentDirectory, assignmentId);
      terminal = await startWithReconciliation(runtime, facts, placement);
    }

    runtime.admission.remove(assignmentId);

    if (warning === undefined) {
      startFolderSweep(runtime, assignment, terminal);
    }

    const modelReason = facts.modelReason;
    const status = launchStatus(terminal, assignment.loadout.model, modelReason);
    const details = warning === undefined ? status : { ...status, warning };

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(details) }],
      details,
    };
  } catch (error) {
    if (error instanceof UnclearLaunchError) {
      throw error;
    }

    runtime.admission.remove(assignmentId);

    const failure = await errorAfterScratchCleanup(runtime.agentDirectory, assignmentId, error);
    const onDefiniteFailure = hooks.onDefiniteFailure;

    if (onDefiniteFailure === undefined) {
      throw failure;
    }

    throw await onDefiniteFailure(failure);
  }
};

export const executeLaunch = async (
  runtime: LaunchRuntime,
  request: LaunchRequest,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<ToolResult<LaunchStatus | undefined>> => {
  try {
    const launchingRole = currentRole();
    const currentSkillTools = (runtime.readSkillTools ?? readCurrentSkillTools)();
    const registeredNames = runtime.pi.getAllTools().map((tool) => tool.name);
    const registeredToolNames = new Set(registeredNames);

    const skillToolsRefused = skillToolsRefusal(
      currentSkillTools,
      registeredToolNames,
      launchingRole,
    );

    if (skillToolsRefused !== undefined) {
      throw new Error(skillToolsRefused);
    }

    const loadout = resolveLoadout(request.parameters, context, runtime.pi.getCommands(), {
      launchingRole,
    });

    const roleRefusal = roleLaunchRefusal(launchingRole, loadout);

    if (roleRefusal !== undefined) {
      throw new Error(roleRefusal);
    }

    const refusal = acceptanceRefusal(loadout.role, request.parameters.acceptance);

    if (refusal !== undefined) {
      throw new Error(refusal);
    }

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

      const needsSnapshot = packagesNeedSnapshot(extensionPackages);

      const errorAfterCleanup = async (error: unknown): Promise<unknown> => {
        if (!needsSnapshot) {
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
        const snapshotPath = needsSnapshot ? snapshotDirectory : undefined;

        assignment = buildAssignment(
          assignmentId,
          request.parameters,
          loadout,
          deadline,
          request.parentSession,
          parentTerminal,
          snapshotPath,
          extensionPackages,
        );

        await writeAssignment(assignment);
      } catch (error) {
        throw await errorAfterCleanup(error);
      }

      return startReservedWorker(
        runtime,
        {
          assignment,
          task: request.parameters.task,
          label: request.parameters.label,
          extensionPackages,
          skillTools: currentSkillTools ?? {},
          modelReason: 'Tau runs the profile model; it has no model routes.',
          signal,
        },
        { onDefiniteFailure: errorAfterCleanup },
      );
    });
  } catch (error) {
    if (error instanceof WorkerCapacityFullError) {
      runtime.refuseCapacity?.();
    }

    return launchErrorResult(error);
  }
};
