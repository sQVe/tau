import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { Exec } from '../../command.js';
import { readMergedPullRequest } from '../../github/mergedPullRequest.js';
import { sessionDirectoryFor } from '../../improvement/sessionDirectory.js';
import type { Coverage } from '../../improvement/taskMapping.js';
import { readTaskTranscripts } from '../../improvement/taskTranscripts.js';
import { findSharedRepositoryRoot } from '../../tauDirectory.js';
import type { TaskRequest } from './recordRequest.js';

export interface TaskResult {
  pullRequest: string;
  manager: string[];
  workers: string[];
  coverage: Coverage;
  projectRoot: string | null;
}

const projectRootFor = async (worktree: string): Promise<string | null> => {
  try {
    return await findSharedRepositoryRoot(worktree);
  } catch {
    return null;
  }
};

export const runTask = async (
  exec: Exec,
  agentDirectory: string,
  request: TaskRequest,
  context: ExtensionContext,
): Promise<TaskResult> => {
  const runtime = { exec, cwd: context.cwd, signal: context.signal };
  const pullRequest = await readMergedPullRequest(runtime, request.pullRequest);

  if (pullRequest === undefined) {
    throw new Error(`Could not read merged pull request ${request.pullRequest}.`);
  }

  const read = await readTaskTranscripts({
    agentDirectory,
    sessionDirectory: sessionDirectoryFor(request.worktree, agentDirectory),
    cwd: request.worktree,
    pullRequest,
  });

  if (read.status === 'failed') {
    throw new Error(read.reason);
  }

  return {
    pullRequest: request.pullRequest,
    manager: read.manager,
    workers: read.workers,
    coverage: read.coverage,
    projectRoot: await projectRootFor(request.worktree),
  };
};
