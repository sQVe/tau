import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  new Error(`git commit failed:\n${stdout}${stderr}`);

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
    ['diff', '--cached', '--no-relative', '--name-only', '--diff-filter=ACMRDT', '-z'],
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

const validateFileRequests = async (workingDirectory: string, files: string[]) => {
  await Promise.all(
    files.map(async (file) => {
      const status = await lstat(join(workingDirectory, file)).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });

      if (status?.isDirectory()) {
        throw new Error(
          `Directory requests are not supported: ${file}. Name each file explicitly.`,
        );
      }
    }),
  );
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

const listCommitPaths = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  commitHash: string,
) => {
  const result = await pi.exec(
    'git',
    [
      'diff-tree',
      '--root',
      '--diff-merges=first-parent',
      '--no-relative',
      '-r',
      '--no-commit-id',
      '--no-renames',
      '--name-only',
      '-z',
      commitHash,
    ],
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

type Reviews = Map<
  string,
  {
    key?: string;
    result?: CommentReview;
    returns: number;
    refusedTree?: string;
    disputes: { evidence: string; findings: string }[];
  }
>;

interface ReviewSnapshot {
  tree: string;
  head: string | null;
  dispute?: string;
}

type RequestReview = (snapshot: ReviewSnapshot) => Promise<CommentReview>;

// oxlint-disable-next-line eslint/complexity -- Review, commit guards, and failure cleanup share the staged candidate.
const executeGroup = async (
  parameters: CommitInput['groups'][number],
  temporaryDirectory: string,
  pi: Pick<ExtensionAPI, 'exec'>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
  reviews: Reviews,
  requestReview: RequestReview,
  committedFiles: Set<string>,
): Promise<CommitSuccess> => {
  const messagePath = join(temporaryDirectory, 'message');
  const cancelled = (): CommitSuccess => ({
    content: [{ type: 'text', text: 'Commit cancelled' }],
    details: { sha: '', files: parameters.files, subject, body },
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

  const stagedPaths = await listStagedPaths(pi, context.cwd);

  const unrelatedStagedPaths = stagedPaths.filter((file) => !requestedFiles.has(file));

  if (unrelatedStagedPaths.length > 0) {
    throw new Error(
      `Cannot commit only the requested files while other paths are already staged: ${unrelatedStagedPaths.join(', ')}`,
    );
  }

  await validateFileRequests(context.cwd, parameters.files);

  let readyToCommit = false;
  let reviewedTree = '';
  let reviewedIndex = '';
  let reviewedHead: string | null = null;
  let reviewGroup = '';
  let reviewReport = '';
  let groupError: unknown;
  const assertCleanupOwnership = async () => {
    // Before the candidate snapshot, unexpected entries may belong to another writer.
    const staged = await listStagedPaths(pi, context.cwd);

    if (!reviewedTree && staged.some((file) => !requestedFiles.has(file))) {
      throw new Error(
        `${groupError instanceof Error ? `${groupError.message}\n` : ''}Concurrent staging was left untouched. Inspect the index before retrying.`,
      );
    }

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
    await stageFiles(pi, context.cwd, parameters.files);

    const stagedAfterRequest = await listStagedPaths(pi, context.cwd);
    const unrequestedPaths = stagedAfterRequest.filter((file) => !requestedFiles.has(file));

    if (unrequestedPaths.length > 0) {
      throw new Error(
        `Staging ${parameters.files.join(', ')} produced staged paths that were not requested: ${unrequestedPaths.join(', ')}`,
      );
    }

    if (signal?.aborted) {
      return cancelled();
    }

    if (stagedAfterRequest.length === 0) {
      const consumed = [...requestedFiles].some((file) => committedFiles.has(file));

      throw new Error(
        consumed
          ? 'Requested changes were already committed by an earlier hook. Stopped remaining groups. Inspect the reported commits and remaining working changes before retrying.'
          : 'No staged changes for the requested files. Stopped before comment review and Git hooks.',
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

    await writeFile(messagePath, buildCommitMessage(subject, body), { mode: 0o600 });

    reviewGroup = JSON.stringify([context.cwd, reviewedHead, [...requestedFiles].toSorted()]);

    const state = reviews.get(reviewGroup) ?? { disputes: [], returns: 0 };

    reviews.delete(reviewGroup);
    reviews.set(reviewGroup, state);

    if (reviews.size > 32) {
      const oldest = reviews.keys().next().value;

      if (oldest !== undefined) {
        reviews.delete(oldest);
      }
    }

    if (state.refusedTree === reviewedTree) {
      throw new Error(
        `Comment review refused for this unchanged tree:\n${state.result ? formatCommentReview(state.result) : ''}\nStop automatic retries and report the blocker. Evidence alone cannot reopen a refused tree.`,
      );
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
      if (state.returns >= 2) {
        state.refusedTree = reviewedTree;

        throw new Error(
          `Comment review refused after two automatic returns:\n${reviewReport}\nStop automatic retries and report the blocker. Findings cannot be waived.`,
        );
      }

      state.returns += 1;

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

    const messageStatus = await lstat(messagePath).catch(() => null);
    const messageContent = messageStatus?.isFile() ? await readFile(messagePath) : null;

    if (!messageContent?.equals(Buffer.from(buildCommitMessage(subject, body)))) {
      throw new Error('Message file changed before commit. Retry commit.');
    }

    readyToCommit = true;
  } catch (error) {
    groupError = error;
    throw error;
  } finally {
    if (!readyToCommit) {
      await assertCleanupOwnership();
      await unstageFiles(pi, context.cwd, parameters.files);
    }
  }

  const commitResult = await pi.exec('git', ['commit', '--cleanup=verbatim', '-F', messagePath], {
    cwd: context.cwd,
  });

  if (commitResult.code !== 0 || commitResult.killed) {
    const failure = commitFailedError(commitResult.stdout, commitResult.stderr);

    try {
      if ((await currentHead(pi, context.cwd)) !== reviewedHead) {
        throw new Error(
          'HEAD changed during git commit. Staging was left untouched. Inspect the repository before retrying.',
        );
      }

      // Requested-path staging during hooks is hook-owned; same-path concurrent writers are unsupported.
      await unstageFiles(pi, context.cwd, parameters.files);
    } catch (error) {
      throw new Error(`${failure.message}\n${String(error)}`, { cause: error });
    }

    throw failure;
  }

  reviews.delete(reviewGroup);

  let commitHash = '';

  // A reporting failure must not hide a successful commit or undo hooks' work.
  try {
    const commitHashOutput = await reviewGit(pi, context.cwd, ['rev-parse', 'HEAD']);
    const capturedHead = commitHashOutput.trim();
    const commitObject = await reviewGit(pi, context.cwd, ['cat-file', '-p', capturedHead]);
    const messageOffset = commitObject.indexOf('\n\n');
    const firstParent = commitObject.slice(0, messageOffset).match(/^parent (.+)$/m)?.[1] ?? null;

    // First-parent matching detects an intervening commit, not rewrites sharing the same parent.
    if (firstParent !== reviewedHead) {
      throw new Error(
        "HEAD changed before commit reporting. The captured HEAD could not be verified as this group's commit. HEAD and staging were left untouched.",
      );
    }

    commitHash = capturedHead;

    const committedPaths = await listCommitPaths(pi, context.cwd, commitHash);
    const storedMessage = commitObject.slice(messageOffset + 2);
    const firstNewline = storedMessage.indexOf('\n');
    const storedSubject =
      firstNewline === -1 ? storedMessage : storedMessage.slice(0, firstNewline);
    const storedBody =
      firstNewline === -1 ? '' : storedMessage.slice(firstNewline + 1).replace(/^\n/, '');

    const changedPathsOutput = await reviewGit(pi, context.cwd, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-relative',
      '--name-only',
      '-z',
      reviewedTree,
      `${commitHash}^{tree}`,
      '--',
    ]);
    const hookChanges = {
      files: changedPathsOutput.split('\0').filter(Boolean),
      message: storedMessage !== buildCommitMessage(subject, body),
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

    return {
      content: [
        {
          type: 'text',
          text: `${commitHash} ${storedSubject}\nGit hooks: run.${hookReport ? `\n${hookReport}` : ''}${reviewReport ? `\nComment review:\n${reviewReport}` : ''}`,
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
          tree: reviewedTree,
          policy: commentPolicyHash,
          report: reviewReport,
        },
      },
    };
  } catch (error) {
    throw new Error(
      `Git commit succeeded${commitHash ? `: ${commitHash}` : ''}. The commit was not undone.\nReporting failed: ${String(error)}\nDo not retry this group. Inspect Git history first.\n${commitResult.stdout}${commitResult.stderr}`,
      { cause: error },
    );
  }
};

export const createCommitTool = (
  pi: Pick<ExtensionAPI, 'exec'>,
  review = reviewComments,
): ToolDefinition<typeof commitToolParameters, { groups: CommitSuccess['details'][] }> => {
  const reviews: Reviews = new Map();

  return defineTool({
    name: 'commit',
    label: 'Commit',
    description:
      'Stage, review, and commit each group sequentially with Git hooks. Hook failures and blocking comment reviews return errors.',
    promptSnippet: 'Create git commits for an ordered groups array in one call.',
    promptGuidelines: [
      'When asked to commit, call commit without asking for confirmation. Git hooks and comment review still apply.',
      'The commit tool stages only files explicitly assigned to the requested groups. Installed Git hooks may add paths; successful results report actual committed files relative to the repository root.',
      'The tool stages whole requested files on the real index. Working edits remain visible to Git hooks. Groups run serially.',
      "Never absorb unrelated edits, another group's paths, or rejected sensitive paths to clear an error. Never overwrite concurrent staging or HEAD.",
      "Git commits run with the repository's installed hooks. Never bypass hooks through --no-verify, core.hooksPath, environment variables, or config changes to evade a failure.",
      'Hook failures unstage requested files and return raw output. Successful hook content and message rewrites and added paths stay committed and are reported. If a hook fully consumed a later group with no new staged changes, the batch stops. If reporting fails after commit success, inspect Git history before retrying.',
      'Messages reject NUL. Body CRLF and CR become LF; other whitespace is preserved. Nonempty bodies end in LF. Tau supplies the normalized message through git commit --cleanup=verbatim -F and reports the actual stored message.',
      'Use a conventional commit subject.',
      'Do not commit sensitive files such as .env or SSH keys.',
      'Comment review checks the staged tree before committing. Fix blocking findings or supply commentDispute with evidence. Missing-comment suggestions are advisory. After two automatic returns for a group, remaining findings cause a refusal: stop automatic retries and report the blocker. Evidence alone cannot reopen a refused tree; corrected trees can still pass review. Findings cannot be waived.',
    ],
    parameters: commitToolParameters,
    // oxlint-disable-next-line eslint/complexity -- Group failures retain earlier commit results and temporary cleanup diagnostics.
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

      const requestReview: RequestReview = (snapshot) => review(pi, context, signal, snapshot);

      /* oxlint-disable eslint/no-await-in-loop -- Each group must finish before the next stages its files. */
      for (const [index, group] of parameters.groups.entries()) {
        const groupLabel = `${index + 1}/${parameters.groups.length}`;

        let temporaryDirectory = '';
        let temporaryCleanup = '';

        try {
          temporaryDirectory = await mkdtemp(join(tmpdir(), 'tau-commit-message-'));

          const result = await executeGroup(
            group,
            temporaryDirectory,
            pi,
            context,
            signal,
            reviews,
            requestReview,
            new Set(groups.flatMap((committedGroup) => committedGroup.files)),
          );

          temporaryCleanup = await cleanupTemporary(temporaryDirectory);
          temporaryDirectory = '';

          if (temporaryCleanup) {
            result.content.push({ type: 'text', text: temporaryCleanup });
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
          const cleanupDiagnostic = temporaryDirectory
            ? await cleanupTemporary(temporaryDirectory)
            : temporaryCleanup;
          const failure = cleanupDiagnostic
            ? new Error(
                `${error instanceof Error ? error.message : String(error)}\n${cleanupDiagnostic}`,
                { cause: error },
              )
            : error;

          if (parameters.groups.length === 1) {
            throw failure;
          }

          const committed = content.map((item) => item.text);

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
