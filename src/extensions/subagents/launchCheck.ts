import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { appAnswers } from './appProbe.js';
import {
  appUrlRefusal,
  briefLimitRefusal,
  briefWithAppUrl,
  checksLaunchEnvironment,
  launchEnvironmentRefusal,
} from './launchEnvironment.js';
import type { LaunchParameters } from './launchParameters.js';
import { textLimit } from './types.js';

export const checkLaunchEnvironment = async (
  parameters: LaunchParameters,
  signal: AbortSignal | undefined,
  sessionCwd: string,
): Promise<void> => {
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
    return;
  }

  const worktree = resolve(sessionCwd, parameters.cwd ?? '.');
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
};
