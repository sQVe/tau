import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { WorkerController } from './controller/controller.js';
import { launchErrorResult } from './errorResult.js';
import type { EvidenceDetails, ToolResult } from './errorResult.js';
import { briefWithAppUrl } from './launchEnvironment.js';
import type { LaunchParameters } from './launchParameters.js';
import { resolveRoutedLoadout } from './loadout.js';
import { modelStatus } from './presentation.js';

interface LaunchRuntime {
  pi: Pick<ExtensionAPI, 'getCommands'>;
  getController: (context: ExtensionContext) => WorkerController;
  refuseCapacity: () => void;
}

type LaunchStatus = Awaited<ReturnType<WorkerController['launch']>>;

interface LaunchRequest {
  parameters: LaunchParameters;
  startedAt: { wall: number; monotonic: number };
  parentSession: string;
}

const defaultTimeoutSeconds = { investigation: 1800, editing: 3600 };

export const millisecondsPerSecond = 1000;

export const executeLaunch = async (
  runtime: LaunchRuntime,
  { parameters, startedAt, parentSession }: LaunchRequest,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<ToolResult<LaunchStatus | EvidenceDetails | undefined>> => {
  const controller = runtime.getController(context);

  const { loadout, routing } = await resolveRoutedLoadout(
    parameters,
    context,
    runtime.pi.getCommands(),
    signal,
  );

  const timeout =
    (parameters.timeoutSeconds ?? defaultTimeoutSeconds[loadout.role]) * millisecondsPerSecond;

  signal?.throwIfAborted();

  let status: LaunchStatus;

  try {
    status = await controller.launch(
      {
        task: briefWithAppUrl(parameters.task, parameters.url),
        ...(parameters.acceptance === undefined ? {} : { acceptance: parameters.acceptance }),
        ...(parameters.label === undefined ? {} : { label: parameters.label }),
        loadout,
        ...(routing === undefined ? {} : { routing }),
        timeout,
        startedAt,
        parentSession,
        parentSessionId: context.sessionManager.getSessionId(),
        ...(parameters.visibility ? { visibility: parameters.visibility } : {}),
      },
      signal,
    );
  } catch (error) {
    return launchErrorResult(runtime.refuseCapacity, error);
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(modelStatus(status)) }],
    details: status,
  };
};
