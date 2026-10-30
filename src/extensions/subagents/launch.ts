import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { launchTiming, remainingLaunchBudget } from './controller/budget.js';
import type { WorkerController } from './controller/controller.js';
import { launchErrorResult } from './errorResult.js';
import type { EvidenceDetails, ToolResult } from './errorResult.js';
import { checkLaunchEnvironment } from './launchCheck.js';
import { briefWithAppUrl } from './launchEnvironment.js';
import type { LaunchParameters } from './launchParameters.js';
import { resolveRoutedLoadout } from './loadout.js';
import { modelStatus } from './presentation.js';
import { resolveProfile } from './profiles.js';

interface LaunchRuntime {
  pi: Pick<ExtensionAPI, 'getCommands' | 'exec'>;
  getController: (context: ExtensionContext) => Promise<WorkerController>;
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

// Resume belongs to existing saved workers. Cancelling a new launch stops only its wait.
const waitForController = (
  pending: Promise<WorkerController>,
  signal: AbortSignal,
): Promise<WorkerController> => {
  const stopped = Promise.withResolvers<never>();

  const cancel = () => {
    stopped.reject(signal.reason);
  };

  if (signal.aborted) {
    cancel();
  } else {
    signal.addEventListener('abort', cancel, { once: true });
  }

  return Promise.race([pending, stopped.promise]).finally(() => {
    signal.removeEventListener('abort', cancel);
  });
};

const initialTimeout = (parameters: LaunchParameters, context: ExtensionContext): number => {
  if (parameters.timeoutSeconds !== undefined) {
    return parameters.timeoutSeconds * millisecondsPerSecond;
  }

  const profile = resolveProfile(
    context.cwd,
    getAgentDir(),
    context.isProjectTrusted(),
    parameters.profile,
  );

  if (profile === undefined) {
    throw new Error(`Worker profile not found: ${parameters.profile}`);
  }

  return defaultTimeoutSeconds[profile.role] * millisecondsPerSecond;
};

const prepareLaunch = async (
  runtime: LaunchRuntime,
  request: LaunchRequest,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
) => {
  signal?.throwIfAborted();

  const timeout = initialTimeout(request.parameters, context);
  const timing = launchTiming(timeout, request.startedAt);
  const deadline = new AbortController();

  const timer = setTimeout(() => {
    deadline.abort(new Error('The original task work budget expired during launch preparation.'));
  }, remainingLaunchBudget(timing));

  const preparationSignal =
    signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);

  try {
    const parameters = await checkLaunchEnvironment(
      request.parameters,
      preparationSignal,
      context,
      (command, argumentsList, options) => runtime.pi.exec(command, argumentsList, options),
    );

    preparationSignal.throwIfAborted();

    const controller = await waitForController(runtime.getController(context), preparationSignal);

    preparationSignal.throwIfAborted();

    const { loadout, routing } = await resolveRoutedLoadout(
      parameters,
      context,
      runtime.pi.getCommands(),
      preparationSignal,
    );

    preparationSignal.throwIfAborted();
    launchTiming(timeout, request.startedAt);

    return { parameters, controller, loadout, routing, timeout };
  } catch (error) {
    preparationSignal.throwIfAborted();

    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const executeInitialLaunch = async (
  runtime: LaunchRuntime,
  request: LaunchRequest,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<ToolResult<LaunchStatus | EvidenceDetails | undefined>> => {
  const { parameters, controller, loadout, routing, timeout } = await prepareLaunch(
    runtime,
    request,
    signal,
    context,
  );

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
        startedAt: request.startedAt,
        parentSession: request.parentSession,
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
