import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { currentTerminalAddress, ls } from '../../hc/hc.js';
import { readSkillTools as readCurrentSkillTools } from '../../skillTools.js';
import { acceptanceRefusal } from './acceptanceRefusal.js';
import { assignmentPath, readAssignment, writeFollowUpAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { WorkerCapacityFullError } from './capacityRefusal.js';
import { launchErrorResult } from './errorResult.js';
import type { ToolResult } from './errorResult.js';
import type { FollowUpParameters } from './followUpParameters.js';
import { capacityRefusal, startReservedWorker } from './launch.js';
import type { LaunchRuntime, LaunchStatus } from './launch.js';
import { decideSessionUse } from './sessionUse.js';
import type { SessionUse, SessionUseTerminal } from './sessionUse.js';
import { skillToolsRefusal } from './skillToolsRefusal.js';
import { readWorkerChild } from './workerDelivery.js';
import type { WorkerChildRead } from './workerDelivery.js';

export interface FollowUpRequest {
  parameters: FollowUpParameters;
  startedAt: { wall: number; monotonic: number };
  parentSession: string;
}

const defaultTimeoutSeconds = { investigation: 1800, editing: 3600 };

const millisecondsPerSecond = 1000;

const sessionUseTerminal = (child: WorkerChildRead): SessionUseTerminal => {
  const { assignment } = child;
  const assignmentLabel = child.terminal.labels?.['tau.assignment'];

  if (assignment.kind === 'saved') {
    return {
      state: child.terminal.state,
      assignmentLabel,
      assignment: { kind: 'saved', sessionFile: assignment.assignment.session.file },
    };
  }

  return { state: child.terminal.state, assignmentLabel, assignment: { kind: assignment.kind } };
};

const sessionUse = async (runtime: LaunchRuntime, source: Assignment): Promise<SessionUse> => {
  const list = await ls(runtime.hc, { all: true });

  const running = list.terminals.filter((terminal) => terminal.state !== 'finished');

  const children = await Promise.all(
    running.map((terminal) => readWorkerChild(runtime.hc, terminal)),
  );

  return decideSessionUse({
    sourceSessionFile: source.session.file,
    terminals: children.map(sessionUseTerminal),
  });
};

const missingPackagePath = (
  packages: readonly { source: string; path: string }[],
): string | undefined => {
  for (const extension of packages) {
    if (!existsSync(extension.path)) {
      return extension.path;
    }
  }

  return undefined;
};

const followUpAssignment = (
  source: Assignment,
  parameters: FollowUpParameters,
  extensionPackages: { source: string; path: string }[],
  parentSession: string,
  parentTerminal: string,
  deadline: number,
): Assignment => ({
  version: 3,
  assignmentId: randomUUID(),
  task: parameters.task,
  acceptance: parameters.acceptance ?? [],
  label: parameters.label ?? null,
  profile: source.profile,
  loadout: source.loadout,
  routing: source.routing,
  packageSnapshot: source.packageSnapshot,
  session: source.session,
  parentSession,
  cwd: source.cwd,
  parentTerminal,
  deadline,
  createdAt: Date.now(),
  previousAssignmentId: source.assignmentId,
  extensionPackages,
  questions: [],
  report: null,
});

const followUpSource = async (
  parameters: FollowUpParameters,
  parentSession: string,
): Promise<{ source: Assignment; extensionPackages: { source: string; path: string }[] }> => {
  const sourcePath = assignmentPath(parameters.sourceAssignmentId);
  const source = await readAssignment(sourcePath);

  if (source === undefined) {
    throw new Error(`Missing source assignment ${sourcePath}; no follow-up can start.`);
  }

  if (source.parentSession !== parentSession) {
    throw new Error(`Assignment ${source.assignmentId} belongs to another manager session.`);
  }

  const acceptanceProblem = acceptanceRefusal(source.loadout.role, parameters.acceptance);

  if (acceptanceProblem !== undefined) {
    throw new Error(acceptanceProblem);
  }

  if (!existsSync(source.session.file)) {
    throw new Error(
      `Missing worker session file ${source.session.file}; no follow-up can resume it.`,
    );
  }

  if (source.extensionPackages === null && source.loadout.packages.length > 0) {
    throw new Error(
      `Assignment ${source.assignmentId} lists profile packages but no extension package snapshot.`,
    );
  }

  const extensionPackages = source.extensionPackages ?? [];
  const missingPath = missingPackagePath(extensionPackages);

  if (missingPath !== undefined) {
    throw new Error(`Missing worker package path ${missingPath}; no follow-up can load it.`);
  }

  return { source, extensionPackages };
};

const followUpTimeout = (source: Assignment, parameters: FollowUpParameters): number =>
  (parameters.timeoutSeconds ?? defaultTimeoutSeconds[source.loadout.role]) * millisecondsPerSecond;

export const executeFollowUp = async (
  runtime: LaunchRuntime,
  request: FollowUpRequest,
  signal: AbortSignal | undefined,
  _context: ExtensionContext,
): Promise<ToolResult<LaunchStatus | undefined>> => {
  try {
    const parameters = request.parameters;
    const { source, extensionPackages } = await followUpSource(parameters, request.parentSession);
    const parentTerminal = currentTerminalAddress();

    if (parentTerminal === undefined) {
      throw new Error('Worker follow-up requires HC_TERMINAL_ID. Start Tau inside an hc terminal.');
    }

    const deadline = request.startedAt.wall + followUpTimeout(source, parameters);
    const skillTools = (runtime.readSkillTools ?? readCurrentSkillTools)();
    const registeredToolNames = new Set(runtime.pi.getAllTools().map((tool) => tool.name));
    const skillToolsRefused = skillToolsRefusal(skillTools, registeredToolNames);

    if (skillToolsRefused !== undefined) {
      throw new Error(skillToolsRefused);
    }

    return await runtime.admission.run(async () => {
      signal?.throwIfAborted();

      if (runtime.admission.holdsSession(source.session.file)) {
        throw new Error(
          `The worker session ${source.session.file} belongs to a launch whose start is still unclear; check \`hc ls\` first.`,
        );
      }

      const use = await sessionUse(runtime, source);

      if (use === 'inUse') {
        throw new Error(`The worker session ${source.session.file} is still in use.`);
      }

      if (use === 'unknown') {
        throw new Error(
          `Tau cannot tell whether the worker session ${source.session.file} is in use; no follow-up can start.`,
        );
      }

      const used = await runtime.admission.count(runtime, parentTerminal);

      if (used >= runtime.capacity) {
        throw capacityRefusal(used, runtime.capacity);
      }

      const assignment = followUpAssignment(
        source,
        parameters,
        extensionPackages,
        request.parentSession,
        parentTerminal,
        deadline,
      );

      await writeFollowUpAssignment(assignment);

      return startReservedWorker(runtime, {
        assignment,
        task: parameters.task,
        label: parameters.label,
        visibility: parameters.visibility,
        extensionPackages,
        skillTools: skillTools ?? {},
        signal,
      });
    });
  } catch (error) {
    if (error instanceof WorkerCapacityFullError) {
      runtime.refuseCapacity?.();
    }

    return launchErrorResult(error);
  }
};
