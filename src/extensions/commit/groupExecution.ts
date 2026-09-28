import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExecResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors/index.js';
import {
  currentHead,
  listCommitPaths,
  readIndex,
  readIndexEntries,
  listStagedPaths,
  repositoryPathPrefix,
  restoreIndexEntries,
  runGit,
  stageFiles,
  unstageFiles,
  validateFileRequests,
  writeTree,
} from './gitCommands.js';
import type { CommitSuccess } from './types.js';
import {
  buildCommitMessage,
  commitFailedError,
  normalizeBody,
  normalizeRepositoryPath,
  isSensitivePath,
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
  temporaryDirectory: string;
  pi: Pick<ExtensionAPI, 'exec'>;
  context: ExtensionContext;
  signal: AbortSignal | undefined;
  committedFiles: Set<string>;
}

interface GroupRun extends GroupExecution {
  messagePath: string;
  subject: string;
  body: string | null;
  requestedFiles: Set<string>;
  prefix: string;
  stagedBefore: StagedBefore;
  snapshot: StagedSnapshot | null;
}

export interface GroupOutcome {
  kind: 'cancelled' | 'committed';
  result: CommitSuccess;
}

interface CleanupCheck {
  pi: Pick<ExtensionAPI, 'exec'>;
  cwd: string;
  requestedFiles: Set<string>;
  prefix: string;
  stagedBefore: StagedBefore;
  snapshot: StagedSnapshot | null;
}

const buildCancelledResult = (
  files: string[],
  subject: string,
  body: string | null,
): CommitSuccess => ({
  content: [{ type: 'text', text: 'Commit cancelled' }],
  details: { sha: '', files, subject, body },
});

const validateStagingArea = async (
  execution: GroupExecution,
  requestedFiles: Set<string>,
): Promise<string[]> => {
  const stagedPaths = await listStagedPaths(execution.pi, execution.context.cwd);
  const unrelatedStagedPaths = stagedPaths.filter((file) => !requestedFiles.has(file));

  if (unrelatedStagedPaths.length > 0) {
    throw new Error(
      `Cannot commit only the requested files while other paths are already staged: ${unrelatedStagedPaths.join(', ')}`,
    );
  }

  await validateFileRequests(execution.context.cwd, execution.parameters.files);

  return stagedPaths;
};

const repositoryPath = (prefix: string, file: string) =>
  normalizeRepositoryPath(`${prefix}${file}`);

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
    entries: stagedRequests.length
      ? await readIndexEntries(execution.pi, execution.context.cwd, stagedRequests)
      : new Map<string, string>(),
  };
};

// Git cannot add a staged deletion, and the index already holds it.
const isStagedDeletion = (run: GroupRun, file: string) => {
  const path = repositoryPath(run.prefix, file);

  return run.stagedBefore.files.has(path) && !run.stagedBefore.entries.has(path);
};

const restoreRequest = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  cwd: string,
  check: Pick<CleanupCheck, 'prefix' | 'stagedBefore'>,
  files: string[],
) => {
  if (check.stagedBefore.entries.size > 0) {
    await restoreIndexEntries(pi, cwd, [...check.stagedBefore.entries.values()]);
  }

  const unstaged = files.filter(
    (file) => !check.stagedBefore.files.has(repositoryPath(check.prefix, file)),
  );

  if (unstaged.length > 0) {
    await unstageFiles(pi, cwd, unstaged);
  }
};

const stageAndVerifyRequest = async (run: GroupRun): Promise<boolean> => {
  const filesToAdd = run.parameters.files.filter((file) => !isStagedDeletion(run, file));

  if (filesToAdd.length > 0) {
    await stageFiles(run.pi, run.context.cwd, filesToAdd);
  }

  const stagedAfterRequest = await listStagedPaths(run.pi, run.context.cwd);
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

// Every step after snapshotStagedTree reads the staged snapshot; reaching one without it is a bug.
const requireSnapshot = (run: GroupRun): StagedSnapshot => {
  if (run.snapshot === null) {
    throw new Error('The staged snapshot was read before it was taken.');
  }

  return run.snapshot;
};

const snapshotStagedTree = async (run: GroupRun): Promise<boolean> => {
  const tree = await writeTree(run.pi, run.context.cwd, run.signal);
  const index = await readIndex(run.pi, run.context.cwd);
  const head = await currentHead(run.pi, run.context.cwd);

  run.snapshot = { tree, index, head };

  if (run.signal?.aborted === true) {
    return false;
  }

  await writeFile(run.messagePath, buildCommitMessage(run.subject, run.body), { mode: 0o600 });

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

  return (await currentHead(check.pi, check.cwd)) !== snapshot.head;
};

const assertCleanupOwnership = async (check: CleanupCheck): Promise<void> => {
  if (check.snapshot === null) {
    // Before the candidate snapshot, unexpected entries may belong to another writer.
    const staged = await listStagedPaths(check.pi, check.cwd);

    if (staged.some((file) => !check.requestedFiles.has(file))) {
      throw new Error('Concurrent staging was left untouched. Inspect the index before retrying.');
    }

    return;
  }

  const currentIndex = await readIndex(check.pi, check.cwd);

  if (await snapshotChanged(check, check.snapshot, currentIndex)) {
    throw new Error('Staged content or HEAD changed. Concurrent staging was left untouched.');
  }
};

const cleanUpGroup = async (check: CleanupCheck, files: string[]): Promise<void> => {
  await assertCleanupOwnership(check);
  await restoreRequest(check.pi, check.cwd, check, files);
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

const runGroupPipeline = async (run: GroupRun): Promise<boolean> => {
  if (!(await stageAndVerifyRequest(run))) {
    return false;
  }

  return snapshotStagedTree(run);
};

const commitStaged = async (run: GroupRun): Promise<ExecResult> => {
  const snapshot = requireSnapshot(run);

  const commitResult = await run.pi.exec(
    'git',
    ['commit', '--cleanup=verbatim', '-F', run.messagePath],
    { cwd: run.context.cwd },
  );

  if (commitResult.code !== 0 || commitResult.killed) {
    const failure = commitFailedError(commitResult.stdout, commitResult.stderr);

    try {
      if ((await currentHead(run.pi, run.context.cwd)) !== snapshot.head) {
        throw new Error(
          'HEAD changed during git commit. Staging was left untouched. Inspect the repository before retrying.',
        );
      }

      // Requested-path staging during hooks is hook-owned; same-path concurrent writers are unsupported.
      await restoreRequest(run.pi, run.context.cwd, run, run.parameters.files);
    } catch (error) {
      throw new Error(`${failure.message}\n${String(error)}`, { cause: error });
    }

    throw failure;
  }

  return commitResult;
};

const buildHookReport = (
  run: GroupRun,
  committedPaths: string[],
  changedPathsOutput: string,
  storedMessage: string,
) => {
  const hookChanges = {
    files: changedPathsOutput.split('\0').filter(Boolean),
    message: storedMessage !== buildCommitMessage(run.subject, run.body),
  };

  const sensitivePaths = committedPaths.filter((file) => isSensitivePath(file));
  const reportLines: string[] = [];

  if (sensitivePaths.length) {
    reportLines.push(`Warning: committed sensitive paths: ${sensitivePaths.join(', ')}`);
  }

  if (hookChanges.files.length) {
    reportLines.push(`Hook changed paths: ${hookChanges.files.join(', ')}`);
  }

  if (hookChanges.message) {
    reportLines.push(`Hook changed the commit message:\n${storedMessage}`);
  }

  const hookReport = reportLines.join('\n');

  return { hookChanges, hookReport };
};

const buildCommitReport = async (
  run: GroupRun,
  commitHash: string,
  commitObject: string,
  messageOffset: number,
): Promise<CommitSuccess> => {
  const snapshot = requireSnapshot(run);

  const committedPaths = await listCommitPaths(run.pi, run.context.cwd, commitHash);
  const storedMessage = commitObject.slice(messageOffset + 2);
  const firstNewline = storedMessage.indexOf('\n');
  const storedSubject = firstNewline === -1 ? storedMessage : storedMessage.slice(0, firstNewline);

  const storedBody =
    firstNewline === -1 ? '' : storedMessage.slice(firstNewline + 1).replace(/^\n/, '');

  const changedPathsOutput = await runGit(run.pi, run.context.cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-relative',
    '--name-only',
    '-z',
    snapshot.tree,
    `${commitHash}^{tree}`,
    '--',
  ]);

  const { hookChanges, hookReport } = buildHookReport(
    run,
    committedPaths,
    changedPathsOutput,
    storedMessage,
  );

  const reportLines = [`${commitHash} ${storedSubject}`, 'Git hooks: run.'];

  if (hookReport) {
    reportLines.push(hookReport);
  }

  return {
    content: [
      {
        type: 'text',
        text: reportLines.join('\n'),
      },
    ],
    details: {
      sha: commitHash,
      files: committedPaths,
      subject: storedSubject,
      body: storedBody || null,
      message: storedMessage,
      hooks: 'run',
      hookChanges,
    },
  };
};

const reportCommit = async (run: GroupRun, commitResult: ExecResult): Promise<CommitSuccess> => {
  const snapshot = requireSnapshot(run);
  let commitHash = '';

  // A reporting failure must not hide a successful commit or undo hooks' work.
  try {
    const commitHashOutput = await runGit(run.pi, run.context.cwd, ['rev-parse', 'HEAD']);
    const capturedHead = commitHashOutput.trim();
    const commitObject = await runGit(run.pi, run.context.cwd, ['cat-file', '-p', capturedHead]);
    const messageOffset = commitObject.indexOf('\n\n');
    const firstParent = commitObject.slice(0, messageOffset).match(/^parent (.+)$/m)?.[1] ?? null;

    // First-parent matching detects an intervening commit, not rewrites sharing the same parent.
    if (firstParent !== snapshot.head) {
      throw new Error(
        "HEAD changed before commit reporting. The captured HEAD could not be verified as this group's commit. HEAD and staging were left untouched.",
      );
    }

    commitHash = capturedHead;

    return await buildCommitReport(run, commitHash, commitObject, messageOffset);
  } catch (error) {
    const commitSuffix = commitHash ? `: ${commitHash}` : '';

    throw new Error(
      `Git commit succeeded${commitSuffix}. The commit was not undone.\nReporting failed: ${String(error)}\nDo not retry this group. Inspect Git history first.\n${commitResult.stdout}${commitResult.stderr}`,
      { cause: error },
    );
  }
};

export const executeGroup = async (execution: GroupExecution): Promise<GroupOutcome> => {
  const subject = execution.parameters.subject;
  const body = normalizeBody(execution.parameters.body ?? null);
  const messagePath = join(execution.temporaryDirectory, 'message');

  const cancelled = {
    kind: 'cancelled',
    result: buildCancelledResult(execution.parameters.files, subject, body),
  } as const;

  if (execution.signal?.aborted === true) {
    return cancelled;
  }

  const prefix = await repositoryPathPrefix(execution.pi, execution.context.cwd);

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
    subject,
    body,
    requestedFiles,
    prefix,
    stagedBefore,
    snapshot: null,
  };

  let groupError: unknown;
  let readyToCommit = false;

  try {
    if (!(await runGroupPipeline(run))) {
      return cancelled;
    }

    readyToCommit = true;
  } catch (error) {
    groupError = error;
    throw error;
  } finally {
    if (!readyToCommit) {
      const check = {
        pi: execution.pi,
        cwd: execution.context.cwd,
        requestedFiles,
        prefix,
        stagedBefore,
        snapshot: run.snapshot,
      };

      await cleanUpGroup(check, execution.parameters.files).catch((cleanupError: unknown) => {
        throw withGroupError(groupError, cleanupError);
      });
    }
  }

  const commitResult = await commitStaged(run);

  return { kind: 'committed', result: await reportCommit(run, commitResult) };
};
