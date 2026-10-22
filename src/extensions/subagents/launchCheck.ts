import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { appAnswers } from './appProbe.js';
import {
  appUrlRefusal,
  briefLimitRefusal,
  briefWithAppUrl,
  checksLaunchEnvironment,
  launchEnvironmentRefusal,
} from './launchEnvironment.js';
import type { LaunchParameters } from './launchParameters.js';
import { applyQaSettings } from './qaLaunch.js';
import { textLimit } from './types.js';

// Resolves the launch with the QA settings applied, and refuses it when the environment fails.
export const checkLaunchEnvironment = async (
  requested: LaunchParameters,
  signal: AbortSignal | undefined,
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'ui'>,
  exec: Exec,
): Promise<LaunchParameters> => {
  const parameters = await applyQaSettings(requested, signal, context, exec);
  const urlRefusal = appUrlRefusal(parameters.profile, parameters.url);

  if (urlRefusal !== undefined) {
    throw new Error(urlRefusal);
  }

  const limitRefusal = briefLimitRefusal(
    briefWithAppUrl(parameters.task, parameters.url),
    textLimit,
  );

  if (limitRefusal !== undefined) {
    throw new Error(limitRefusal);
  }

  if (!checksLaunchEnvironment(parameters.profile)) {
    return parameters;
  }

  const worktree = resolve(context.cwd, parameters.cwd ?? '.');
  const worktreeExists = existsSync(worktree);

  const url =
    parameters.url === undefined || !worktreeExists
      ? undefined
      : { address: parameters.url, answers: await appAnswers(parameters.url, signal) };

  const refusal = launchEnvironmentRefusal({
    profile: parameters.profile,
    worktree,
    worktreeExists,
    url,
  });

  if (refusal !== undefined) {
    throw new Error(refusal);
  }

  return parameters;
};
