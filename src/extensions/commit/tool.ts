import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import {
  reviewComments,
  formatCommentReview,
  reviewGit,
  commentPolicyHash,
} from './commentReview.js';
import type { CommentReview } from './commentReview.js';
import { snapshotPreparation } from './preparation.js';
import {
  createCandidateChecks,
  MessageMutationError,
  prepareProject,
  readPreparation,
} from './projectCheck.js';
import type { Preparation } from './projectCheck.js';
import { assertNoPendingRecovery } from './recovery.js';
import type { CommitSuccess } from './types.js';

export const conventionalCommitSubjectPattern =
  /^(feat|fix|chore|refactor|docs|test|style|perf|build|ci|revert)(\([a-z0-9-]+\))?!?: [^\r\n]+$/;

export const sensitivePathDenylist = [
  /(^|\/)\.env$/i,
  /(^|\/)\.env\..+$/i,
  /(^|\/)\.npmrc$/i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_rsa($|\.)/i,
  /(^|\/)id_ed25519($|\.)/i,
  /(^|\/)\.ssh($|\/)/i,
] as const;

export const commitToolParameters = Type.Object({
  groups: Type.Array(
    Type.Object({
      files: Type.Array(Type.String(), { minItems: 1 }),
      subject: Type.String(),
      body: Type.Optional(Type.String()),
      commentDispute: Type.Optional(
        Type.String({
          maxLength: 4000,
          description: 'Evidence for rechecking a comment finding. This never waives review.',
        }),
      ),
    }),
    { minItems: 1 },
  ),
});

export type CommitInput = Static<typeof commitToolParameters>;

// Pi forwards only error.message, so include hook diagnostics from both streams.
export const commitFailedError = (stdout: string, stderr: string) =>
  new Error(
    `git commit failed: ${[stderr.trim(), stdout.trim()].filter(Boolean).join('\n')}`.trim(),
  );

export const validateSubject = (subject: string) => {
  if (subject.includes('\0')) {
    throw new Error('Invalid subject: NUL is not allowed.');
  }

  if (!conventionalCommitSubjectPattern.test(subject)) {
    throw new Error(`Invalid subject: ${subject}`);
  }
};

const normalizeRepositoryPath = (file: string) =>
  posix
    .normalize(process.platform === 'win32' ? file.replaceAll('\\', '/') : file)
    .replace(/\/+$/, '');

export const validatePaths = (files: string[]) => {
  for (const rawFile of files) {
    // Validate the backslash reading on every platform so a Windows-style traversal or sensitive
    // name is rejected everywhere, while staging keeps the literal name on POSIX.
    const file = posix.normalize(rawFile.replaceAll('\\', '/')).replace(/\/+$/, '');

    if (
      rawFile.includes('\0') ||
      file === '' ||
      file === '.' ||
      rawFile.startsWith(':') ||
      posix.isAbsolute(file) ||
      file === '..' ||
      file.startsWith('../')
    ) {
      throw new Error(`Invalid path: ${rawFile}`);
    }

    if (sensitivePathDenylist.some((pattern) => pattern.test(file))) {
      throw new Error(`Invalid path: ${rawFile}`);
    }
  }
};

const normalizeBody = (body: string | null) => {
  if (body?.includes('\0')) {
    throw new Error('Invalid body: NUL is not allowed.');
  }

  const normalized = body?.replaceAll(/\r\n?/g, '\n') ?? null;

  return normalized && !normalized.endsWith('\n') ? `${normalized}\n` : normalized;
};

const buildCommitMessage = (subject: string, body: string | null) =>
  body ? `${subject}\n\n${body}` : `${subject}\n`;

const cleanupTemporary = async (directory: string) => {
  try {
    await rm(directory, { recursive: true, force: true });

    return '';
  } catch (error) {
    return `Temporary cleanup failed at ${directory}: ${String(error)}`;
  }
};

const listStagedPaths = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const result = await pi.exec(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
    {
      cwd: workingDirectory,
    },
  );

  if (result.code !== 0) {
    throw new Error(
      `git diff --cached --name-only failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeRepositoryPath(file));
};

// Literal pathspecs prevent glob expansion from staging unrequested files.
const stageFiles = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
) => {
  const result = await pi.exec('git', ['--literal-pathspecs', 'add', '--', ...files], {
    cwd: workingDirectory,
  });

  if (result.code !== 0) {
    throw new Error(
      `git add failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

const unstageFiles = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
) => {
  const result = await pi.exec('git', ['--literal-pathspecs', 'reset', '--', ...files], {
    cwd: workingDirectory,
  });

  if (result.code !== 0) {
    throw new Error(
      `git reset failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

// Staged paths are repository-relative; requested paths are relative to the working directory.
const repositoryPathPrefix = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const result = await pi.exec('git', ['rev-parse', '--show-prefix'], { cwd: workingDirectory });

  if (result.code !== 0) {
    throw new Error(
      `git rev-parse --show-prefix failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }

  return result.stdout.replace(/\n$/, '');
};

// HEAD is unresolved before the first commit.
const currentHead = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const result = await pi.exec('git', ['rev-parse', 'HEAD'], { cwd: workingDirectory });

  return result.code === 0 ? result.stdout.trim() : null;
};

const listCommitPaths = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const result = await pi.exec(
    'git',
    ['diff-tree', '--root', '-r', '--no-commit-id', '--name-only', '-z', 'HEAD'],
    { cwd: workingDirectory },
  );

  if (result.code !== 0) {
    throw new Error(
      `git diff-tree failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeRepositoryPath(file));
};

const undoCommit = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  previousHead: string | null,
) => {
  const result = await pi.exec(
    'git',
    previousHead === null ? ['update-ref', '-d', 'HEAD'] : ['reset', '--soft', previousHead],
    { cwd: workingDirectory },
  );

  if (result.code !== 0) {
    throw new Error(
      `git failed to undo the commit, which stands with unrequested paths in it: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

type Reviews = Map<
  string,
  {
    key?: string;
    result?: CommentReview;
    disputes: { evidence: string; findings: string }[];
  }
>;

interface ReviewSnapshot {
  tree: string;
  head: string | null;
  dispute?: string;
}

type RequestReview = (snapshot: ReviewSnapshot) => Promise<CommentReview>;

/* oxlint-disable eslint/max-depth -- Preparation and cleanup branches stay inside their ownership scope. */
// oxlint-disable-next-line eslint/complexity -- This transaction keeps preparation, review and rollback in one ownership scope.
const executeGroup = async (
  parameters: CommitInput['groups'][number],
  temporaryDirectory: string,
  preparation: Preparation,
  ownership: Awaited<ReturnType<typeof snapshotPreparation>> | undefined,
  otherGroups: Set<string>,
  pi: Pick<ExtensionAPI, 'exec'>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
  reviews: Reviews,
  requestReview: RequestReview,
): Promise<CommitSuccess> => {
  let resultFiles = parameters.files;
  let repositoryRelative = false;
  const pathDetails = () => ({
    files: resultFiles,
    ...(repositoryRelative ? { pathBase: 'repository' as const } : {}),
  });
  const cancelled = (): CommitSuccess => ({
    content: [{ type: 'text', text: 'Commit cancelled' }],
    details: { sha: '', ...pathDetails(), subject, body },
  });

  const subject = parameters.subject;
  const body = normalizeBody(parameters.body ?? null);

  if (signal?.aborted) {
    return cancelled();
  }

  const prefix = await repositoryPathPrefix(pi, context.cwd);

  const requestedFiles = new Set(
    parameters.files.map((file) => normalizeRepositoryPath(`${prefix}${file}`)),
  );
  if (ownership) {
    resultFiles = [...requestedFiles];
    repositoryRelative = true;
  }

  const stagedPaths = await listStagedPaths(pi, context.cwd);

  const unrelatedStagedPaths = stagedPaths.filter((file) => !requestedFiles.has(file));

  if (unrelatedStagedPaths.length > 0) {
    throw new Error(
      `Cannot commit only the requested files while other paths are already staged: ${unrelatedStagedPaths.join(', ')}`,
    );
  }

  let projectPreparation = preparation.notice;
  let readyToCommit = false;
  let reviewedTree = '';
  let reviewedIndex = '';
  let reviewedHead: string | null = null;
  let reviewGroup = '';
  let reviewReport = '';
  let projectCheck = '';
  let returningForCorrections = false;
  let candidate: Awaited<ReturnType<typeof createCandidateChecks>>;
  let messageCheck = '';
  let groupError: unknown;
  const assertCleanupOwnership = async () => {
    const currentIndex = await reviewGit(pi, context.cwd, [
      'ls-files',
      '--stage',
      '--debug',
      '-v',
      '-z',
    ]);

    if (
      reviewedTree &&
      (currentIndex !== reviewedIndex || (await currentHead(pi, context.cwd)) !== reviewedHead)
    ) {
      throw new Error(
        `${groupError instanceof Error ? `${groupError.message}\n` : ''}Staged content or HEAD changed. Concurrent staging was left untouched.`,
      );
    }
  };

  try {
    const staging = ownership?.isolated ?? pi;

    if (ownership) {
      await ownership.stage(requestedFiles);
      try {
        projectPreparation = await prepareProject(staging, preparation, signal);
      } catch (error) {
        await ownership.preserve().catch((recoveryError: unknown) => {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nPrivate-index recovery failed: ${String(recoveryError)}. Do not prune Git objects. Inspect the retained candidate-index before retrying.`,
            { cause: error },
          );
        });

        if (signal?.aborted) {
          return cancelled();
        }

        throw error;
      }

      await ownership.restage(requestedFiles);

      const preparedCandidate = await ownership.validate(requestedFiles, otherGroups);
      validatePaths(preparedCandidate.added);

      if (preparedCandidate.added.length) {
        const assignmentRequired = `Preparation added paths (repository-relative): ${JSON.stringify(preparedCandidate.added)}. Assign each clean generated path explicitly to a group and retry.`;

        throw new Error(assignmentRequired);
      }

      await ownership.publish();
    } else {
      await stageFiles(staging, context.cwd, parameters.files);
    }

    // Directory arguments can stage unrequested files.
    // Reset needs paths relative to the working directory.
    const stagedAfterRequest = await listStagedPaths(pi, context.cwd);
    const unrequestedPaths = stagedAfterRequest
      .filter((file) => !requestedFiles.has(file))
      .map((file) => (ownership ? file : file.slice(prefix.length)));

    if (unrequestedPaths.length > 0) {
      if (ownership) {
        throw new Error(
          `Index ownership conflict after publication: ${JSON.stringify(unrequestedPaths)}. Concurrent staging was left untouched.`,
        );
      }

      await unstageFiles(pi, context.cwd, unrequestedPaths);

      throw new Error(
        `Staging ${parameters.files.join(', ')} produced staged paths that were not requested: ${unrequestedPaths.join(', ')}`,
      );
    }

    const treeOutput = await reviewGit(pi, context.cwd, ['write-tree'], signal);
    reviewedTree = treeOutput.trim();
    reviewedIndex = await reviewGit(pi, context.cwd, [
      'ls-files',
      '--stage',
      '--debug',
      '-v',
      '-z',
    ]);
    reviewedHead = await currentHead(pi, context.cwd);

    if (signal?.aborted) {
      return cancelled();
    }

    try {
      candidate = await createCandidateChecks(
        pi,
        context.cwd,
        reviewedTree,
        temporaryDirectory,
        signal,
      );
      const message = buildCommitMessage(subject, body);
      const initial = await candidate.checkInitial(message);
      projectCheck = initial.projectNotice;
      messageCheck = initial.messageResult.notice;

      if (!initial.messageResult.passed) {
        throw new Error(messageCheck);
      }
    } catch (error) {
      if (signal?.aborted) {
        return cancelled();
      }

      throw error;
    }

    reviewGroup = JSON.stringify([context.cwd, reviewedHead, [...requestedFiles].toSorted()]);

    const state = reviews.get(reviewGroup) ?? { disputes: [] };

    reviews.delete(reviewGroup);
    reviews.set(reviewGroup, state);

    if (reviews.size > 32) {
      const oldest = reviews.keys().next().value;

      if (oldest !== undefined) {
        reviews.delete(oldest);
      }
    }

    if (
      parameters.commentDispute &&
      !state.disputes.some(({ evidence }) => evidence === parameters.commentDispute)
    ) {
      state.disputes.push({
        evidence: parameters.commentDispute,
        findings: state.result ? formatCommentReview(state.result) : 'No prior findings available.',
      });
    }

    const reviewKey = JSON.stringify([
      reviewedTree,
      commentPolicyHash,
      context.model?.provider,
      context.model?.id,
      parameters.commentDispute,
    ]);
    let commentReview: CommentReview | undefined;

    try {
      commentReview =
        state.key === reviewKey && state.result
          ? state.result
          : await requestReview({
              tree: reviewedTree,
              head: reviewedHead,
              ...(parameters.commentDispute ? { dispute: parameters.commentDispute } : {}),
            });
      state.key = reviewKey;
      state.result = commentReview;

      reviewReport = formatCommentReview(commentReview);
    } catch (error) {
      if (signal?.aborted) {
        return cancelled();
      }

      throw new Error(
        `Comment review failed: ${error instanceof Error ? error.message : String(error)}\nFix the cause and call commit again.`,
        { cause: error },
      );
    }

    if (state.disputes.length) {
      const disputes = state.disputes
        .map(
          ({ evidence, findings }) =>
            `Prior findings:\n${findings}\nDispute evidence:\n${evidence}`,
        )
        .join('\n');

      reviewReport = `Comment review rechecked after dispute.\n${disputes}\nCurrent review:\n${reviewReport || 'No findings.'}`;
    }

    if (signal?.aborted) {
      return cancelled();
    }

    const reviewBlocked = commentReview.findings.some((finding) => finding.kind !== 'missing');

    if (reviewBlocked) {
      returningForCorrections = true;

      throw new Error(
        `Comment review needs corrections:\n${reviewReport}\nFix the findings or supply commentDispute with evidence and call commit again.`,
      );
    }

    const currentIndex = await reviewGit(pi, context.cwd, [
      'ls-files',
      '--stage',
      '--debug',
      '-v',
      '-z',
    ]);

    if (currentIndex !== reviewedIndex) {
      throw new Error(
        'Staged content changed since comment review. Call commit again to review the changes.',
      );
    }

    const currentTreeOutput = await reviewGit(pi, context.cwd, ['write-tree'], signal);
    const currentTree = currentTreeOutput.trim();
    const changedSinceReview =
      currentTree !== reviewedTree || (await currentHead(pi, context.cwd)) !== reviewedHead;

    if (changedSinceReview) {
      throw new Error(
        'Staged content or HEAD changed since comment review. Call commit again to review the changes.',
      );
    }

    await candidate.verifyMessage(
      buildCommitMessage(subject, body),
      'Message file changed after validation. Retry commit.',
    );

    readyToCommit = true;
  } catch (error) {
    groupError = error;
    throw error;
  } finally {
    if (!readyToCommit) {
      if (!returningForCorrections) {
        reviews.delete(reviewGroup);
      }

      const gitDirectoryOutput = await reviewGit(pi, context.cwd, [
        'rev-parse',
        '--absolute-git-dir',
      ]);
      const gitDirectory = gitDirectoryOutput.trimEnd();
      await assertNoPendingRecovery(gitDirectory).catch((error: unknown) => {
        throw new Error(
          `${groupError instanceof Error ? `${groupError.message}\n` : ''}${String(error)}`,
          { cause: groupError ?? error },
        );
      });

      if (!ownership) {
        await assertCleanupOwnership();
        await unstageFiles(pi, context.cwd, parameters.files);
      }
    }
  }

  const message = buildCommitMessage(subject, body);
  const previousHead = await currentHead(pi, context.cwd);
  const gitDirectoryOutput = await reviewGit(pi, context.cwd, ['rev-parse', '--absolute-git-dir']);
  const gitDirectory = gitDirectoryOutput.trimEnd();
  await assertNoPendingRecovery(gitDirectory);
  const commitResult = await pi.exec(
    'git',
    [
      ...(candidate.hooks === 'skip' ? ['-c', `core.hooksPath=${candidate.hooksPath}`] : []),
      'commit',
      '--cleanup=verbatim',
      '-F',
      candidate.messagePath,
    ],
    {
      cwd: context.cwd,
    },
  );

  if (commitResult.code !== 0 || commitResult.killed) {
    if (!ownership) {
      await unstageFiles(pi, context.cwd, parameters.files);
    }

    throw commitFailedError(commitResult.stdout, commitResult.stderr);
  }

  // Hooks can stage files after review, so check the committed paths too.
  const committedPaths = await listCommitPaths(pi, context.cwd);

  const smuggledPaths = committedPaths.filter((file) => !requestedFiles.has(file));

  if (smuggledPaths.length > 0) {
    await undoCommit(pi, context.cwd, previousHead);
    await unstageFiles(
      pi,
      ownership ? preparation.repositoryRoot : context.cwd,
      smuggledPaths.map((file) => (ownership ? file : file.slice(prefix.length))),
    );

    throw new Error(
      `A hook staged paths that were not requested: ${smuggledPaths.join(', ')}. The commit was undone.`,
    );
  }

  const committedTreeOutput = await reviewGit(pi, context.cwd, ['rev-parse', 'HEAD^{tree}']);
  const committedTree = committedTreeOutput.trim();

  if (committedTree !== reviewedTree) {
    await undoCommit(pi, context.cwd, previousHead);

    throw new Error(
      'A hook changed reviewed content. The commit was undone. Call commit again to stage and review the current changes.',
    );
  }

  const commitObject = await reviewGit(pi, context.cwd, ['cat-file', '-p', 'HEAD']);
  const storedMessage = commitObject.slice(commitObject.indexOf('\n\n') + 2);

  if (storedMessage !== message) {
    await undoCommit(pi, context.cwd, previousHead);

    throw new Error(
      'A hook changed the checked message. The commit was undone. Retry with the final message; hooks must not rewrite it.',
    );
  }

  const revParseResult = await pi.exec('git', ['rev-parse', 'HEAD'], {
    cwd: context.cwd,
  });

  if (revParseResult.code !== 0) {
    throw new Error(
      `git rev-parse HEAD failed with exit code ${revParseResult.code}: ${revParseResult.stderr || revParseResult.stdout}`.trim(),
    );
  }

  const commitHash = revParseResult.stdout.trim();

  reviews.delete(reviewGroup);

  return {
    content: [
      {
        type: 'text',
        text: `${commitHash} ${subject}\n${projectPreparation}\n${projectCheck}\n${messageCheck}\nGit hooks: ${candidate.hooks} (staged policy).${reviewReport ? `\nComment review:\n${reviewReport}` : ''}`,
      },
    ],
    details: {
      sha: commitHash,
      ...pathDetails(),
      subject,
      body,
      projectCheck,
      messageCheck,
      hooks: candidate.hooks,
      commentReview: {
        status: 'passed',
        tree: reviewedTree,
        policy: commentPolicyHash,
        report: reviewReport,
      },
    },
  };
};

/* oxlint-enable eslint/max-depth */

export const createCommitTool = (
  pi: Pick<ExtensionAPI, 'exec'>,
  review = reviewComments,
): ToolDefinition<typeof commitToolParameters, { groups: CommitSuccess['details'][] }> => {
  const reviews: Reviews = new Map();

  return defineTool({
    name: 'commit',
    label: 'Commit',
    description:
      'Stage, prepare, check, review, and commit each group sequentially without human approval. Preparation-added paths require explicit assignment in a new call. Failed checks and blocking comment reviews return errors.',
    promptSnippet: 'Create git commits for an ordered groups array in one call.',
    promptGuidelines: [
      'When asked to commit, call commit without asking for confirmation. The commit tool runs without human approval; checks and comment review still apply.',
      'The commit tool commits only files explicitly assigned to the requested groups.',
      'The commit tool runs configured preparation once after staging each executed group, then restages requested files. Staged-only preparation output stops the group and is retained under a recovery ref. Inspect it and change preparation to leave output in working files before retrying. Fix reported errors before retrying. Report unavailable checks as unavailable, not passed.',
      'Checks run in the existing checkout with installed dependencies. Tau saves verified recovery before hiding working edits and restores before review. Reviews run serially. Requested paths remain reserved for their group.',
      "Preparation-added paths stop the commit without UI. Inspect them, assign them explicitly in the next commit call, and retry. Never absorb prior dirty or untracked user edits, other groups' paths, or rejected sensitive paths to clear an error.",
      'Prepared commit results use repository-relative files with pathBase: repository, including paths outside the invoking directory. For a retry, convert paths within the invoking directory to relative paths. Retry from the repository root when added paths are outside that directory.',
      'Preparation recovery requires a local POSIX checkout, a regular supported index, and at most 100 MiB of tracked and nonignored untracked working data. Unsupported states fail before preparation. Ignored files, external symlink targets, and background writers are outside recovery coverage; this is not a sandbox.',
      'On preparation failure, cancellation, or ownership conflict, read the reported recovery instructions. Working edits remain; never restore a saved index or working files over concurrent user edits. Post-commit tree, path, and message guards remain enabled.',
      'Working root tau.json selects prepare. The actual staged candidate selects check, checkMessage, and hooks. hooks defaults to run; only explicit staged hooks: skip disables hooks for the final Git commit. Never bypass hooks ad hoc through --no-verify, core.hooksPath, environment variables, or config changes to evade a failure.',
      'checkMessage is optional argv without an implicit shell. Tau appends an absolute temporary full-message file path. Initial project and message checks share a staged working window. Missing checks are unavailable, not passed. Failed checks cannot be waived; checker mutations stop the group.',
      'Pending recovery blocks commits and staging cleanup. Stop writers and inspect the reported archives; never overwrite concurrent staging or HEAD. Partial hiding or restoration needs manual inspection. Successful recovery archives remain because displaced files may receive late writes. Checkers must keep children in their POSIX process group; detached writers and ignored dependencies are outside recovery coverage.',
      'Messages reject NUL. Body CRLF and CR become LF; other whitespace is preserved. Nonempty bodies end in LF. Tau commits the requested normalized message through git commit --cleanup=verbatim -F. Hook message rewrites undo the commit and require retry with the final message.',
      'Use a conventional commit subject.',
      'Do not commit sensitive files such as .env or SSH keys.',
      'Comment review runs before committing. Fix blocking findings or supply commentDispute with evidence. Missing-comment suggestions are advisory. Blocking findings and review failures return tool errors on every call; there are no review waivers.',
    ],
    parameters: commitToolParameters,
    // oxlint-disable-next-line eslint/complexity -- Group execution owns partial success reporting and recovery cleanup across failures.
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const assigned = new Set<string>();

      for (const group of parameters.groups) {
        validateSubject(group.subject);
        normalizeBody(group.body ?? null);
        validatePaths(group.files);

        for (const file of new Set(group.files.map(normalizeRepositoryPath))) {
          if (assigned.has(file)) {
            throw new Error(
              `Path assigned to multiple groups: ${JSON.stringify(file)}. Assign it to one group and retry.`,
            );
          }

          assigned.add(file);
        }
      }

      const groups: CommitSuccess['details'][] = [];
      const content: CommitSuccess['content'] = [];

      const finish = (items: CommitSuccess['content']) => ({ content: items, details: { groups } });

      if (signal?.aborted) {
        return finish([{ type: 'text', text: 'Commit cancelled' }]);
      }

      const gitDirectoryOutput = await reviewGit(
        pi,
        context.cwd,
        ['rev-parse', '--absolute-git-dir'],
        signal,
      );
      const gitDirectory = gitDirectoryOutput.trimEnd();
      await assertNoPendingRecovery(gitDirectory);

      const preparation = await readPreparation(pi, context.cwd);

      // Review runs only after restoration, never speculatively across a later check window.
      const requestReview: RequestReview = (snapshot) => review(pi, context, signal, snapshot);

      /* oxlint-disable eslint/no-await-in-loop -- Groups share staging and recovery ownership, so each must finish before the next. */
      for (const [index, group] of parameters.groups.entries()) {
        const groupLabel = `${index + 1}/${parameters.groups.length}`;

        let ownership: Awaited<ReturnType<typeof snapshotPreparation>> | undefined;
        let completed = false;
        let temporaryDirectory = '';
        let temporaryCleanup = '';

        try {
          await assertNoPendingRecovery(gitDirectory);
          const prefix = preparation.command ? await repositoryPathPrefix(pi, context.cwd) : '';

          if (preparation.command) {
            ownership = await snapshotPreparation(
              pi,
              preparation.repositoryRoot,
              group.files.map((file) => normalizeRepositoryPath(`${prefix}${file}`)),
            );
          }
          const otherGroups = new Set([
            ...(preparation.command ? groups.flatMap((result) => result.files) : []),
            ...parameters.groups
              .filter((_, groupIndex) => groupIndex !== index)
              .flatMap((other) =>
                other.files.map((file) => normalizeRepositoryPath(`${prefix}${file}`)),
              ),
          ]);
          temporaryDirectory = await mkdtemp(join(tmpdir(), 'tau-commit-check-'));

          const result = await executeGroup(
            group,
            temporaryDirectory,
            preparation,
            ownership,
            otherGroups,
            pi,
            context,
            signal,
            reviews,
            requestReview,
          );

          completed = Boolean(result.details.sha);
          temporaryCleanup = await cleanupTemporary(temporaryDirectory);
          temporaryDirectory = '';

          if (temporaryCleanup) {
            result.content.push({ type: 'text', text: temporaryCleanup });
          }

          if (ownership) {
            if (completed) {
              // oxlint-disable-next-line eslint/max-depth -- Report cleanup failure without rolling back an already completed commit.
              try {
                await ownership.discard();
              } catch (error) {
                result.content.push({
                  type: 'text',
                  text: `Commit succeeded; recovery cleanup failed: ${String(error)}\n${ownership.notice}`,
                });
              }
            } else {
              await ownership.cleanup();
              result.content.push({ type: 'text', text: ownership.notice });
            }
          }

          if (!result.details.sha && parameters.groups.length > 1) {
            throw new Error('Commit cancelled');
          }

          groups.push(result.details);
          content.push(
            // oxlint-disable-next-line oxc/no-map-spread -- Prefix copies without mutating the group's original result.
            ...result.content.map((item) => ({
              ...item,
              text:
                parameters.groups.length === 1 ? item.text : `Group ${groupLabel}: ${item.text}`,
            })),
          );
        } catch (error) {
          const recovered = await assertNoPendingRecovery(gitDirectory).then(
            () => true,
            () => false,
          );
          let cleanupDiagnostic = temporaryCleanup;

          if (!recovered) {
            cleanupDiagnostic = `Pending recovery: temporary check data retained at ${temporaryDirectory}. No staging cleanup was attempted.`;
          } else if (error instanceof MessageMutationError) {
            cleanupDiagnostic = `Checker message output retained at ${temporaryDirectory}.`;
          } else if (temporaryDirectory) {
            cleanupDiagnostic = await cleanupTemporary(temporaryDirectory);
          }

          if (ownership && !completed && recovered) {
            try {
              await ownership.cleanup();
            } catch (cleanupError) {
              cleanupDiagnostic += `\nIndex cleanup failed: ${String(cleanupError)}`;
            }
          }

          const failure =
            ownership || cleanupDiagnostic
              ? new Error(
                  `${error instanceof Error ? error.message : String(error)}${cleanupDiagnostic ? `\n${cleanupDiagnostic}` : ''}${ownership ? `\n${ownership.notice}` : ''}`,
                  { cause: error },
                )
              : error;

          if (parameters.groups.length === 1) {
            throw failure;
          }

          const committed = groups.flatMap((result, committedIndex) =>
            result.sha
              ? [
                  `Group ${committedIndex + 1}/${parameters.groups.length}: ${result.sha} ${result.subject}`,
                ]
              : [],
          );

          throw new Error(
            `Group ${groupLabel}: ${failure instanceof Error ? failure.message : String(failure)}\nAlready committed:\n${committed.join('\n') || 'None.'}`,
            { cause: error },
          );
        }
      }
      /* oxlint-enable eslint/no-await-in-loop */

      return finish(content);
    },
  });
};
