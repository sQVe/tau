import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage, isMissingFile } from '../../errors.js';
import type { GitResult, runGit } from '../../git.js';
import {
  currentHead,
  decodeOutput,
  HeadReadError,
  isCommitAncestor,
  readIndex,
  readIndexEntries,
  listStagedPaths,
  repositoryPathPrefix,
  restoreIndexEntries,
  stageFiles,
  unstageFiles,
  writeTree,
} from './gitCommands.js';
import { reportCommit } from './reporting.js';
import type { CommittedGroup } from './types.js';
import {
  buildCommitMessage,
  commitFailedError,
  normalizeBody,
  normalizeRepositoryPath,
} from './validation.js';
import type { CommitInput } from './validation.js';

interface StagedSnapshot {
  tree: string;
  index: string;
  head: string | null;
}

interface StagedBefore {
  files: Set<string>;
  entries: Map<string, string>;
}

interface GroupExecution {
  parameters: CommitInput['groups'][number];
  subject: string;
  targetHash: string | undefined;
  temporaryDirectory: string;
  runner: typeof runGit;
  context: ExtensionContext;
  signal: AbortSignal | undefined;
  committedFiles: Set<string>;
}

interface GroupRun extends GroupExecution {
  messagePath: string;
  messageText: string;
  requestedFiles: Set<string>;
  prefix: string;
  stagedBefore: StagedBefore;
}

interface StagedCandidate {
  snapshot: StagedSnapshot;
  requestedFiles: Set<string>;
  stagedBefore: StagedBefore;
  message: {
    path: string;
    text: string;
  };
  runner: typeof runGit;
  cwd: string;
  prefix: string;
  files: string[];
}

export type GroupOutcome = { kind: 'cancelled' } | { kind: 'committed'; commit: CommittedGroup };

interface CleanupCheck {
  runner: typeof runGit;
  cwd: string;
  requestedFiles: Set<string>;
  prefix: string;
  stagedBefore: StagedBefore;
  snapshot: StagedSnapshot | null;
  headUnread: boolean;
}

const repositoryPath = (prefix: string, file: string) =>
  normalizeRepositoryPath(`${prefix}${file}`);

const validateStagingArea = async (
  execution: GroupExecution,
  requestedFiles: Set<string>,
): Promise<string[]> => {
  const stagedPaths = await listStagedPaths(execution.runner, execution.context.cwd);
  const unrelatedStagedPaths = stagedPaths.filter((file) => !requestedFiles.has(file));

  if (unrelatedStagedPaths.length > 0) {
    throw new Error(
      `Cannot commit only the requested files while other paths are already staged: ${unrelatedStagedPaths.join(', ')}`,
    );
  }

  return stagedPaths;
};

const readStagedBefore = async (
  execution: GroupExecution,
  prefix: string,
  stagedPaths: string[],
): Promise<StagedBefore> => {
  const files = new Set(stagedPaths);

  const stagedRequests = execution.parameters.files.filter((file) =>
    files.has(repositoryPath(prefix, file)),
  );

  return {
    files,
    entries:
      stagedRequests.length > 0
        ? await readIndexEntries(execution.runner, execution.context.cwd, stagedRequests)
        : new Map<string, string>(),
  };
};

const stagedDeletions = (check: Pick<CleanupCheck, 'prefix' | 'stagedBefore'>, files: string[]) =>
  files.filter((file) => {
    const path = repositoryPath(check.prefix, file);

    return check.stagedBefore.files.has(path) && !check.stagedBefore.entries.has(path);
  });

const isMissingFromWorktree = (cwd: string, file: string) =>
  lstat(join(cwd, file)).then(
    () => false,
    (error: unknown) => {
      if (isMissingFile(error)) {
        return true;
      }

      throw error;
    },
  );

const restoreRequest = async (
  runner: typeof runGit,
  cwd: string,
  check: Pick<CleanupCheck, 'prefix' | 'stagedBefore'>,
  files: string[],
) => {
  const deletions = stagedDeletions(check, files);

  if (check.stagedBefore.entries.size > 0 || deletions.length > 0) {
    await restoreIndexEntries(runner, cwd, [...check.stagedBefore.entries.values()], deletions);
  }

  const unstaged = files.filter(
    (file) => !check.stagedBefore.files.has(repositoryPath(check.prefix, file)),
  );

  if (unstaged.length > 0) {
    await unstageFiles(runner, cwd, unstaged);
  }
};

const stageAndVerifyRequest = async (run: GroupRun): Promise<boolean> => {
  const deletions = stagedDeletions(run, run.parameters.files);

  // Git cannot add a staged deletion that is still missing, and the index already holds it.
  const missing = await Promise.all(
    deletions.map((file) => isMissingFromWorktree(run.context.cwd, file)),
  );

  const skipped = new Set(deletions.filter((_file, index) => missing[index] === true));
  const filesToAdd = run.parameters.files.filter((file) => !skipped.has(file));

  if (filesToAdd.length > 0) {
    await stageFiles(run.runner, run.context.cwd, filesToAdd);
  }

  const stagedAfterRequest = await listStagedPaths(run.runner, run.context.cwd);
  const unrequestedPaths = stagedAfterRequest.filter((file) => !run.requestedFiles.has(file));

  if (unrequestedPaths.length > 0) {
    throw new Error(
      `Staging ${run.parameters.files.join(', ')} produced staged paths that were not requested: ${unrequestedPaths.join(', ')}`,
    );
  }

  if (run.signal?.aborted === true) {
    return false;
  }

  if (stagedAfterRequest.length === 0) {
    const consumed = [...run.requestedFiles].some((file) => run.committedFiles.has(file));

    throw new Error(
      consumed
        ? 'Requested changes were already committed by an earlier hook. Stopped remaining groups. Inspect the reported commits and remaining working changes before retrying.'
        : 'No staged changes for the requested files. Stopped before Git hooks.',
    );
  }

  return true;
};

const snapshotStagedTree = async (run: GroupRun): Promise<StagedSnapshot> => {
  const tree = await writeTree(run.runner, run.context.cwd, run.signal);
  const index = await readIndex(run.runner, run.context.cwd);
  const head = await currentHead(run.runner, run.context.cwd);

  return { tree, index, head };
};

const prepareCommit = async (run: GroupRun, snapshot: StagedSnapshot): Promise<boolean> => {
  if (run.signal?.aborted === true) {
    return false;
  }

  if (run.targetHash !== undefined) {
    const targetInHistory =
      snapshot.head !== null &&
      (await isCommitAncestor(run.runner, run.context.cwd, run.targetHash, snapshot.head));

    if (!targetInHistory) {
      throw new Error('Fixup target is no longer an ancestor of the snapshot HEAD.');
    }
  }

  await writeFile(run.messagePath, run.messageText, { mode: 0o600 });

  return true;
};

const snapshotChanged = async (
  check: CleanupCheck,
  snapshot: StagedSnapshot,
  currentIndex: string,
): Promise<boolean> => {
  if (currentIndex !== snapshot.index) {
    return true;
  }

  return (await currentHead(check.runner, check.cwd)) !== snapshot.head;
};

const assertCleanupOwnership = async (check: CleanupCheck): Promise<void> => {
  if (check.headUnread) {
    throw new Error('HEAD could not be read. Staging was left untouched.');
  }

  if (check.snapshot === null) {
    // Before the candidate snapshot, unexpected entries may belong to another writer.
    const staged = await listStagedPaths(check.runner, check.cwd);

    if (staged.some((file) => !check.requestedFiles.has(file))) {
      throw new Error('Concurrent staging was left untouched. Inspect the index before retrying.');
    }

    return;
  }

  const currentIndex = await readIndex(check.runner, check.cwd);

  if (await snapshotChanged(check, check.snapshot, currentIndex)) {
    throw new Error('Staged content or HEAD changed. Concurrent staging was left untouched.');
  }
};

const cleanUpGroup = async (check: CleanupCheck, files: string[]): Promise<void> => {
  await assertCleanupOwnership(check);
  await restoreRequest(check.runner, check.cwd, check, files);
};

// A cleanup failure must not hide why the group failed.
const withGroupError = (groupError: unknown, cleanupError: unknown): unknown => {
  if (groupError === undefined) {
    return cleanupError;
  }

  return new Error(`${errorMessage(groupError)}\n${errorMessage(cleanupError)}`, {
    cause: groupError,
  });
};

const stageGroup = async (run: GroupRun): Promise<StagedCandidate | null> => {
  let groupError: unknown;
  let candidate: StagedCandidate | null = null;
  let snapshot: StagedSnapshot | null = null;

  try {
    if (!(await stageAndVerifyRequest(run))) {
      return null;
    }

    snapshot = await snapshotStagedTree(run);

    if (!(await prepareCommit(run, snapshot))) {
      return null;
    }

    candidate = {
      snapshot,
      requestedFiles: run.requestedFiles,
      stagedBefore: run.stagedBefore,
      message: { path: run.messagePath, text: run.messageText },
      runner: run.runner,
      cwd: run.context.cwd,
      prefix: run.prefix,
      files: run.parameters.files,
    };

    return candidate;
  } catch (error) {
    groupError = error;
    throw error;
  } finally {
    if (candidate === null) {
      const check: CleanupCheck = {
        runner: run.runner,
        cwd: run.context.cwd,
        requestedFiles: run.requestedFiles,
        prefix: run.prefix,
        stagedBefore: run.stagedBefore,
        snapshot,
        headUnread: groupError instanceof HeadReadError,
      };

      await cleanUpGroup(check, run.parameters.files).catch((cleanupError: unknown) => {
        throw withGroupError(groupError, cleanupError);
      });
    }
  }
};

const commitStaged = async (candidate: StagedCandidate): Promise<GitResult> => {
  const commitResult = await candidate.runner(
    candidate.cwd,
    ['commit', '--cleanup=verbatim', '-F', candidate.message.path],
    {
      timeoutMilliseconds: null,
    },
  );

  if (commitResult.exitCode !== 0) {
    const failure = commitFailedError(decodeOutput(commitResult), commitResult.stderr);

    try {
      if ((await currentHead(candidate.runner, candidate.cwd)) !== candidate.snapshot.head) {
        throw new Error(
          'HEAD changed during git commit. Staging was left untouched. Inspect the repository before retrying.',
        );
      }

      // Requested-path staging during hooks is hook-owned; same-path concurrent writers are unsupported.
      await restoreRequest(candidate.runner, candidate.cwd, candidate, candidate.files);
    } catch (error) {
      throw new Error(`${failure.message}\n${String(error)}`, { cause: error });
    }

    throw failure;
  }

  return commitResult;
};

export const executeGroup = async (execution: GroupExecution): Promise<GroupOutcome> => {
  if (execution.signal?.aborted === true) {
    return { kind: 'cancelled' };
  }

  const subject = execution.subject;
  const body = normalizeBody(execution.parameters.body ?? null);
  const messagePath = join(execution.temporaryDirectory, 'message');
  const messageText = buildCommitMessage(subject, body);

  const prefix = await repositoryPathPrefix(execution.runner, execution.context.cwd);

  const requestedFiles = new Set(
    execution.parameters.files.map((file) => repositoryPath(prefix, file)),
  );

  const stagedBefore = await readStagedBefore(
    execution,
    prefix,
    await validateStagingArea(execution, requestedFiles),
  );

  const run: GroupRun = {
    ...execution,
    messagePath,
    messageText,
    requestedFiles,
    prefix,
    stagedBefore,
  };

  const candidate = await stageGroup(run);

  if (candidate === null) {
    return { kind: 'cancelled' };
  }

  const commitResult = await commitStaged(candidate);

  const commit = await reportCommit({
    runner: candidate.runner,
    cwd: candidate.cwd,
    snapshot: { tree: candidate.snapshot.tree, head: candidate.snapshot.head },
    expectedMessage: candidate.message.text,
    commitResult,
  });

  return { kind: 'committed', commit };
};
