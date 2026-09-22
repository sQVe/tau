import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExecResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { delegateReference } from '../../delegateModel/index.js';
import { commentPolicyHash, formatCommentReview, reviewGit } from './commentReview.js';
import type { CommentReview } from './commentReview.js';
import {
  currentHead,
  listCommitPaths,
  listStagedPaths,
  repositoryPathPrefix,
  stageFiles,
  unstageFiles,
  validateFileRequests,
} from './gitCommands.js';
import type { CommitSuccess, RequestReview, Reviews, ReviewState } from './types.js';
import {
  buildCommitMessage,
  commitFailedError,
  normalizeBody,
  normalizeRepositoryPath,
  sensitivePathDenylist,
} from './validation.js';
import type { CommitInput } from './validation.js';

interface StagedSnapshot {
  reviewedTree: string;
  reviewedIndex: string;
  reviewedHead: string | null;
}

interface GroupExecution {
  parameters: CommitInput['groups'][number];
  temporaryDirectory: string;
  pi: Pick<ExtensionAPI, 'exec'>;
  context: ExtensionContext;
  signal: AbortSignal | undefined;
  reviews: Reviews;
  requestReview: RequestReview;
  committedFiles: Set<string>;
}

interface GroupRun extends GroupExecution {
  messagePath: string;
  subject: string;
  body: string | null;
  requestedFiles: Set<string>;
  snapshot: StagedSnapshot;
  state: ReviewState;
  reviewGroup: string;
  reviewReport: string;
  commentReview: CommentReview | undefined;
}

interface CleanupCheck {
  pi: Pick<ExtensionAPI, 'exec'>;
  cwd: string;
  requestedFiles: Set<string>;
  snapshot: StagedSnapshot;
  groupError: unknown;
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
): Promise<void> => {
  const stagedPaths = await listStagedPaths(execution.pi, execution.context.cwd);
  const unrelatedStagedPaths = stagedPaths.filter((file) => !requestedFiles.has(file));

  if (unrelatedStagedPaths.length > 0) {
    throw new Error(
      `Cannot commit only the requested files while other paths are already staged: ${unrelatedStagedPaths.join(', ')}`,
    );
  }

  await validateFileRequests(execution.context.cwd, execution.parameters.files);
};

const stageAndVerifyRequest = async (run: GroupRun): Promise<boolean> => {
  await stageFiles(run.pi, run.context.cwd, run.parameters.files);

  const stagedAfterRequest = await listStagedPaths(run.pi, run.context.cwd);
  const unrequestedPaths = stagedAfterRequest.filter((file) => !run.requestedFiles.has(file));

  if (unrequestedPaths.length > 0) {
    throw new Error(
      `Staging ${run.parameters.files.join(', ')} produced staged paths that were not requested: ${unrequestedPaths.join(', ')}`,
    );
  }

  if (run.signal?.aborted) {
    return false;
  }

  if (stagedAfterRequest.length === 0) {
    const consumed = [...run.requestedFiles].some((file) => run.committedFiles.has(file));

    throw new Error(
      consumed
        ? 'Requested changes were already committed by an earlier hook. Stopped remaining groups. Inspect the reported commits and remaining working changes before retrying.'
        : 'No staged changes for the requested files. Stopped before comment review and Git hooks.',
    );
  }

  return true;
};

const prepareReviewState = (run: GroupRun): void => {
  run.reviewGroup = JSON.stringify([
    run.context.cwd,
    run.snapshot.reviewedHead,
    [...run.requestedFiles].toSorted(),
  ]);

  const state = run.reviews.get(run.reviewGroup) ?? { disputes: [], returns: 0 };

  run.reviews.delete(run.reviewGroup);
  run.reviews.set(run.reviewGroup, state);
  run.state = state;

  if (run.reviews.size > 32) {
    const oldest = run.reviews.keys().next().value;

    if (oldest !== undefined) {
      run.reviews.delete(oldest);
    }
  }

  if (state.refusedTree === run.snapshot.reviewedTree) {
    throw new Error(
      `Comment review refused for this unchanged tree:\n${state.result ? formatCommentReview(state.result) : ''}\nStop automatic retries and report the blocker. Evidence alone cannot reopen a refused tree.`,
    );
  }
};

const snapshotStagedTree = async (run: GroupRun): Promise<boolean> => {
  const treeOutput = await reviewGit(run.pi, run.context.cwd, ['write-tree'], {
    signal: run.signal,
  });

  run.snapshot.reviewedTree = treeOutput.trim();
  run.snapshot.reviewedIndex = await reviewGit(run.pi, run.context.cwd, [
    'ls-files',
    '--stage',
    '--debug',
    '-v',
    '-z',
  ]);
  run.snapshot.reviewedHead = await currentHead(run.pi, run.context.cwd);

  if (run.signal?.aborted) {
    return false;
  }

  await writeFile(run.messagePath, buildCommitMessage(run.subject, run.body), { mode: 0o600 });

  prepareReviewState(run);

  return true;
};

const recordDispute = (run: GroupRun): void => {
  const dispute = run.parameters.commentDispute;

  if (!dispute || run.state.disputes.some(({ evidence }) => evidence === dispute)) {
    return;
  }

  run.state.disputes.push({
    evidence: dispute,
    findings: run.state.result
      ? formatCommentReview(run.state.result)
      : 'No prior findings available.',
  });
};

const buildDisputeReport = (run: GroupRun): string => {
  const disputes = run.state.disputes
    .map(({ evidence, findings }) => `Prior findings:\n${findings}\nDispute evidence:\n${evidence}`)
    .join('\n');

  return `Comment review rechecked after dispute.\n${disputes}\nCurrent review:\n${run.reviewReport || 'No findings.'}`;
};

const requestCommentReview = async (run: GroupRun): Promise<boolean> => {
  const dispute = run.parameters.commentDispute;

  recordDispute(run);

  const reviewKey = JSON.stringify([
    run.snapshot.reviewedTree,
    commentPolicyHash,
    delegateReference(),
    dispute,
  ]);
  let commentReview: CommentReview | undefined;

  try {
    commentReview =
      run.state.key === reviewKey && run.state.result
        ? run.state.result
        : await run.requestReview({
            tree: run.snapshot.reviewedTree,
            head: run.snapshot.reviewedHead,
            ...(dispute ? { dispute } : {}),
          });
  } catch (error) {
    if (run.signal?.aborted) {
      return false;
    }

    throw new Error(
      `Comment review failed: ${error instanceof Error ? error.message : String(error)}\nFix the cause and call commit again.`,
      { cause: error },
    );
  }

  run.state.key = reviewKey;
  run.state.result = commentReview;
  run.reviewReport = formatCommentReview(commentReview);

  if (run.state.disputes.length) {
    run.reviewReport = buildDisputeReport(run);
  }

  run.commentReview = commentReview;

  return true;
};

const enforceReviewGate = (run: GroupRun): void => {
  const reviewBlocked =
    run.commentReview?.findings.some(
      (finding) => finding.kind !== 'missing' && finding.kind !== 'unverified',
    ) ?? false;

  if (!reviewBlocked) {
    return;
  }

  if (run.state.returns >= 2) {
    run.state.refusedTree = run.snapshot.reviewedTree;

    throw new Error(
      `Comment review refused after two automatic returns:\n${run.reviewReport}\nStop automatic retries and report the blocker. Review must pass before committing.`,
    );
  }

  run.state.returns += 1;

  throw new Error(
    `Comment review needs corrections:\n${run.reviewReport}\nFix the findings or supply commentDispute with evidence and call commit again.`,
  );
};

const verifyUnchanged = async (run: GroupRun): Promise<void> => {
  const currentIndex = await reviewGit(run.pi, run.context.cwd, [
    'ls-files',
    '--stage',
    '--debug',
    '-v',
    '-z',
  ]);

  if (currentIndex !== run.snapshot.reviewedIndex) {
    throw new Error(
      'Staged content changed since comment review. Call commit again to review the changes.',
    );
  }

  const currentTreeOutput = await reviewGit(run.pi, run.context.cwd, ['write-tree'], {
    signal: run.signal,
  });
  const currentTree = currentTreeOutput.trim();
  const changedSinceReview =
    currentTree !== run.snapshot.reviewedTree ||
    (await currentHead(run.pi, run.context.cwd)) !== run.snapshot.reviewedHead;

  if (changedSinceReview) {
    throw new Error(
      'Staged content or HEAD changed since comment review. Call commit again to review the changes.',
    );
  }

  const messageStatus = await lstat(run.messagePath).catch(() => null);
  const messageContent = messageStatus?.isFile() ? await readFile(run.messagePath) : null;

  if (!messageContent?.equals(Buffer.from(buildCommitMessage(run.subject, run.body)))) {
    throw new Error('Message file changed before commit. Retry commit.');
  }
};

const snapshotChanged = async (check: CleanupCheck, currentIndex: string): Promise<boolean> => {
  if (currentIndex !== check.snapshot.reviewedIndex) {
    return true;
  }

  return (await currentHead(check.pi, check.cwd)) !== check.snapshot.reviewedHead;
};

const assertCleanupOwnership = async (check: CleanupCheck): Promise<void> => {
  const message = check.groupError instanceof Error ? `${check.groupError.message}\n` : '';

  // Before the candidate snapshot, unexpected entries may belong to another writer.
  const staged = await listStagedPaths(check.pi, check.cwd);

  if (!check.snapshot.reviewedTree && staged.some((file) => !check.requestedFiles.has(file))) {
    throw new Error(
      `${message}Concurrent staging was left untouched. Inspect the index before retrying.`,
    );
  }

  const currentIndex = await reviewGit(check.pi, check.cwd, [
    'ls-files',
    '--stage',
    '--debug',
    '-v',
    '-z',
  ]);

  if (check.snapshot.reviewedTree && (await snapshotChanged(check, currentIndex))) {
    throw new Error(
      `${message}Staged content or HEAD changed. Concurrent staging was left untouched.`,
    );
  }
};

const runGroupPipeline = async (run: GroupRun): Promise<boolean> => {
  if (!(await stageAndVerifyRequest(run))) {
    return false;
  }

  if (!(await snapshotStagedTree(run))) {
    return false;
  }

  if (!(await requestCommentReview(run))) {
    return false;
  }

  if (run.signal?.aborted) {
    return false;
  }

  enforceReviewGate(run);

  await verifyUnchanged(run);

  return true;
};

const commitStaged = async (run: GroupRun): Promise<ExecResult> => {
  const commitResult = await run.pi.exec(
    'git',
    ['commit', '--cleanup=verbatim', '-F', run.messagePath],
    { cwd: run.context.cwd },
  );

  if (commitResult.code !== 0 || commitResult.killed) {
    const failure = commitFailedError(commitResult.stdout, commitResult.stderr);

    try {
      if ((await currentHead(run.pi, run.context.cwd)) !== run.snapshot.reviewedHead) {
        throw new Error(
          'HEAD changed during git commit. Staging was left untouched. Inspect the repository before retrying.',
        );
      }

      // Requested-path staging during hooks is hook-owned; same-path concurrent writers are unsupported.
      await unstageFiles(run.pi, run.context.cwd, run.parameters.files);
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
  const sensitivePaths = committedPaths.filter((file) =>
    sensitivePathDenylist.some((pattern) => pattern.test(file.replaceAll('\\', '/'))),
  );
  const hookReport = [
    ...(sensitivePaths.length
      ? [`Warning: committed sensitive paths: ${sensitivePaths.join(', ')}`]
      : []),
    ...(hookChanges.files.length ? [`Hook changed paths: ${hookChanges.files.join(', ')}`] : []),
    ...(hookChanges.message ? [`Hook changed the commit message:\n${storedMessage}`] : []),
  ].join('\n');

  return { hookChanges, hookReport };
};

const buildCommitReport = async (
  run: GroupRun,
  commitHash: string,
  commitObject: string,
  messageOffset: number,
): Promise<CommitSuccess> => {
  const committedPaths = await listCommitPaths(run.pi, run.context.cwd, commitHash);
  const storedMessage = commitObject.slice(messageOffset + 2);
  const firstNewline = storedMessage.indexOf('\n');
  const storedSubject = firstNewline === -1 ? storedMessage : storedMessage.slice(0, firstNewline);
  const storedBody =
    firstNewline === -1 ? '' : storedMessage.slice(firstNewline + 1).replace(/^\n/, '');

  const changedPathsOutput = await reviewGit(run.pi, run.context.cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-relative',
    '--name-only',
    '-z',
    run.snapshot.reviewedTree,
    `${commitHash}^{tree}`,
    '--',
  ]);
  const { hookChanges, hookReport } = buildHookReport(
    run,
    committedPaths,
    changedPathsOutput,
    storedMessage,
  );

  return {
    content: [
      {
        type: 'text',
        text: `${commitHash} ${storedSubject}\nGit hooks: run.${hookReport ? `\n${hookReport}` : ''}${run.reviewReport ? `\nComment review:\n${run.reviewReport}` : ''}`,
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
      commentReview: {
        status: 'passed',
        tree: run.snapshot.reviewedTree,
        policy: commentPolicyHash,
        report: run.reviewReport,
      },
    },
  };
};

const reportCommit = async (run: GroupRun, commitResult: ExecResult): Promise<CommitSuccess> => {
  run.reviews.delete(run.reviewGroup);

  let commitHash = '';

  // A reporting failure must not hide a successful commit or undo hooks' work.
  try {
    const commitHashOutput = await reviewGit(run.pi, run.context.cwd, ['rev-parse', 'HEAD']);
    const capturedHead = commitHashOutput.trim();
    const commitObject = await reviewGit(run.pi, run.context.cwd, ['cat-file', '-p', capturedHead]);
    const messageOffset = commitObject.indexOf('\n\n');
    const firstParent = commitObject.slice(0, messageOffset).match(/^parent (.+)$/m)?.[1] ?? null;

    // First-parent matching detects an intervening commit, not rewrites sharing the same parent.
    if (firstParent !== run.snapshot.reviewedHead) {
      throw new Error(
        "HEAD changed before commit reporting. The captured HEAD could not be verified as this group's commit. HEAD and staging were left untouched.",
      );
    }

    commitHash = capturedHead;

    return await buildCommitReport(run, commitHash, commitObject, messageOffset);
  } catch (error) {
    throw new Error(
      `Git commit succeeded${commitHash ? `: ${commitHash}` : ''}. The commit was not undone.\nReporting failed: ${String(error)}\nDo not retry this group. Inspect Git history first.\n${commitResult.stdout}${commitResult.stderr}`,
      { cause: error },
    );
  }
};

export const executeGroup = async (execution: GroupExecution): Promise<CommitSuccess> => {
  const subject = execution.parameters.subject;
  const body = normalizeBody(execution.parameters.body ?? null);
  const messagePath = join(execution.temporaryDirectory, 'message');
  const cancelled = buildCancelledResult(execution.parameters.files, subject, body);

  if (execution.signal?.aborted) {
    return cancelled;
  }

  const prefix = await repositoryPathPrefix(execution.pi, execution.context.cwd);
  const requestedFiles = new Set(
    execution.parameters.files.map((file) => normalizeRepositoryPath(`${prefix}${file}`)),
  );
  const run: GroupRun = {
    ...execution,
    messagePath,
    subject,
    body,
    requestedFiles,
    snapshot: { reviewedTree: '', reviewedIndex: '', reviewedHead: null },
    state: { disputes: [], returns: 0 },
    reviewGroup: '',
    reviewReport: '',
    commentReview: undefined,
  };
  let groupError: unknown;
  let readyToCommit = false;

  await validateStagingArea(execution, requestedFiles);

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
      await assertCleanupOwnership({
        pi: execution.pi,
        cwd: execution.context.cwd,
        requestedFiles,
        snapshot: run.snapshot,
        groupError,
      });
      await unstageFiles(execution.pi, execution.context.cwd, execution.parameters.files);
    }
  }

  const commitResult = await commitStaged(run);

  return reportCommit(run, commitResult);
};
