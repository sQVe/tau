import { posix } from 'node:path';

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
import type { CommitView } from './overlay.js';
import { confirmCommitOverlay } from './overlay.js';
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
    }),
    { minItems: 1 },
  ),
  commentDispute: Type.Optional(
    Type.String({
      maxLength: 4000,
      description: 'Evidence for rechecking a comment finding. This never waives review.',
    }),
  ),
});

export type CommitInput = Static<typeof commitToolParameters>;

// Pi forwards only error.message, so include hook diagnostics from both streams.
export const commitFailedError = (stdout: string, stderr: string) =>
  new Error(
    `git commit failed: ${[stderr.trim(), stdout.trim()].filter(Boolean).join('\n')}`.trim(),
  );

export const validateSubject = (subject: string) => {
  if (!conventionalCommitSubjectPattern.test(subject)) {
    throw new Error(`Invalid subject: ${subject}`);
  }
};

const normalizeRepoPath = (file: string) =>
  posix.normalize(file.replaceAll('\\', '/')).replace(/\/+$/, '');

export const validatePaths = (files: string[]) => {
  for (const rawFile of files) {
    const file = normalizeRepoPath(rawFile);

    if (
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

const buildCommitMessage = (subject: string, body?: string) => {
  if (body !== undefined) {
    return `${subject}\n\n${body}`;
  }

  return subject;
};

const listStagedPaths = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string) => {
  const result = await pi.exec(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRDT', '-z'],
    {
      cwd,
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
    .map((file) => normalizeRepoPath(file));
};

// Literal pathspecs prevent glob expansion from staging unrequested files.
const stageFiles = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string, files: string[]) => {
  const result = await pi.exec('git', ['--literal-pathspecs', 'add', '--', ...files], { cwd });
  if (result.code !== 0) {
    throw new Error(
      `git add failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

const unstageFiles = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string, files: string[]) => {
  const result = await pi.exec('git', ['--literal-pathspecs', 'reset', '--', ...files], { cwd });
  if (result.code !== 0) {
    throw new Error(
      `git reset failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

// Convert cwd-relative requests to repo-relative paths for comparison with staged paths.
const repoPathPrefix = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string) => {
  const result = await pi.exec('git', ['rev-parse', '--show-prefix'], { cwd });
  if (result.code !== 0) {
    throw new Error(
      `git rev-parse --show-prefix failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }

  return result.stdout.trim();
};

// HEAD is unresolved before the first commit.
const currentHead = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string) => {
  const result = await pi.exec('git', ['rev-parse', 'HEAD'], { cwd });
  return result.code === 0 ? result.stdout.trim() : null;
};

const listCommitPaths = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string) => {
  const result = await pi.exec(
    'git',
    ['diff-tree', '--root', '-r', '--no-commit-id', '--name-only', '-z', 'HEAD'],
    { cwd },
  );

  if (result.code !== 0) {
    throw new Error(
      `git diff-tree failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeRepoPath(file));
};

const undoCommit = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  cwd: string,
  previousHead: string | null,
) => {
  const result = await pi.exec(
    'git',
    previousHead === null ? ['update-ref', '-d', 'HEAD'] : ['reset', '--soft', previousHead],
    { cwd },
  );

  if (result.code !== 0) {
    throw new Error(
      `git failed to undo the commit, which stands with unrequested paths in it: ${result.stderr || result.stdout}`.trim(),
    );
  }
};

const stagedNumstat = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  cwd: string,
  files: string[],
): Promise<CommitView['files']> => {
  const result = await pi.exec(
    'git',
    ['diff', '--cached', '--numstat', '--no-renames', '-z', '--', ...files],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(
      `git diff --cached --numstat failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const [added = '0', removed = '0', ...path] = row.split('\t');
      return { path: path.join('\t'), added, removed };
    });
};

type Reviews = Map<
  string,
  {
    attempts: number;
    key?: string;
    result?: CommentReview;
    disputes: { evidence: string; findings: string }[];
  }
>;

const executeGroup = async (
  params: CommitInput['groups'][number] & { commentDispute: string | undefined },
  group: string,
  pi: Pick<ExtensionAPI, 'exec'>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  reviews: Reviews,
  review: typeof reviewComments,
): Promise<CommitSuccess> => {
  let subject = params.subject;
  let body = params.body ?? null;
  const cancelled = (): CommitSuccess => ({
    content: [{ type: 'text', text: 'Commit cancelled' }],
    details: { sha: '', files: params.files, subject, body },
  });
  if (signal?.aborted) {
    return cancelled();
  }

  const prefix = await repoPathPrefix(pi, ctx.cwd);
  const requestedFiles = new Set(params.files.map((file) => normalizeRepoPath(`${prefix}${file}`)));
  const stagedPaths = await listStagedPaths(pi, ctx.cwd);
  const unrelatedStagedPaths = stagedPaths.filter((file) => !requestedFiles.has(file));

  if (unrelatedStagedPaths.length > 0) {
    throw new Error(
      `Cannot commit only the requested files while other paths are already staged: ${unrelatedStagedPaths.join(', ')}`,
    );
  }

  await stageFiles(pi, ctx.cwd, params.files);
  let approved = false;
  let reviewedTree = '';
  let reviewedHead: string | null = null;
  let reviewGroup = '';
  let reviewReport = '';
  let reviewWaived = false;
  let returningForCorrections = false;
  try {
    // Directory arguments can stage unrequested files; convert those paths back to cwd-relative.
    const unrequestedPaths = (await listStagedPaths(pi, ctx.cwd))
      .filter((file) => !requestedFiles.has(file))
      .map((file) => file.slice(prefix.length));

    if (unrequestedPaths.length > 0) {
      await unstageFiles(pi, ctx.cwd, unrequestedPaths);
      throw new Error(
        `Staging ${params.files.join(', ')} produced staged paths that were not requested: ${unrequestedPaths.join(', ')}`,
      );
    }

    reviewedTree = (await reviewGit(pi, ctx.cwd, ['write-tree'], signal)).trim();
    reviewedHead = await currentHead(pi, ctx.cwd);
    reviewGroup = JSON.stringify([ctx.cwd, reviewedHead, [...requestedFiles].toSorted()]);
    const state = reviews.get(reviewGroup) ?? { attempts: 0, disputes: [] };
    reviews.delete(reviewGroup);
    reviews.set(reviewGroup, state);
    if (reviews.size > 32) {
      const oldest = reviews.keys().next().value;
      if (oldest !== undefined) reviews.delete(oldest);
    }
    if (
      params.commentDispute &&
      !state.disputes.some(({ evidence }) => evidence === params.commentDispute)
    ) {
      state.disputes.push({
        evidence: params.commentDispute,
        findings: state.result ? formatCommentReview(state.result) : 'No prior findings available.',
      });
    }
    const key = JSON.stringify([
      reviewedTree,
      commentPolicyHash,
      ctx.model?.provider,
      ctx.model?.id,
      params.commentDispute,
    ]);
    let commentReview: CommentReview | undefined;
    try {
      commentReview =
        state.key === key && state.result
          ? state.result
          : await review(pi, ctx, signal, {
              tree: reviewedTree,
              head: reviewedHead,
              ...(params.commentDispute ? { dispute: params.commentDispute } : {}),
            });
      state.key = key;
      state.result = commentReview;
      if (commentReview.findings.some((finding) => finding.kind !== 'missing')) state.attempts += 1;
      reviewReport = formatCommentReview(commentReview);
    } catch (error) {
      reviewReport = `Comment review failed: ${error instanceof Error ? error.message : String(error)}\nRetry or explicitly waive this failed review.`;
    }
    if (state.disputes.length) {
      reviewReport = `Comment review rechecked after dispute.\n${state.disputes.map(({ evidence, findings }) => `Prior findings:\n${findings}\nDispute evidence:\n${evidence}`).join('\n')}\nCurrent review:\n${reviewReport || 'No findings.'}`;
    }
    if (signal?.aborted) return cancelled();
    const reviewBlocked =
      !commentReview || commentReview.findings.some((finding) => finding.kind !== 'missing');
    if (commentReview && reviewBlocked && state.attempts <= 2) {
      returningForCorrections = true;
      throw new Error(
        `Comment review needs corrections (${state.attempts}/2 automatic returns):\n${reviewReport}\nFix the findings and call commit again. Unresolved findings will require user review after two returns.`,
      );
    }
    const files = await stagedNumstat(pi, ctx.cwd, params.files);
    let notice = '';
    while (true) {
      if (signal?.aborted) {
        return cancelled();
      }
      const choice = await confirmCommitOverlay(
        ctx,
        {
          subject,
          body,
          files,
          group,
          notice,
          review: reviewReport,
          reviewBlocked,
        },
        signal,
      );
      notice = '';
      if (signal?.aborted) {
        return cancelled();
      }
      if (choice === 'approve' && reviewBlocked) {
        throw new Error('Comment review requires an explicit user waiver.');
      }
      if (choice === 'approve' || choice === 'waive') {
        const currentTree = (await reviewGit(pi, ctx.cwd, ['write-tree'], signal)).trim();
        if (currentTree !== reviewedTree || (await currentHead(pi, ctx.cwd)) !== reviewedHead) {
          throw new Error(
            'Staged content or HEAD changed since comment review. Call commit again to review the changes.',
          );
        }
        approved = true;
        reviewWaived = choice === 'waive';
        break;
      }
      if (choice === 'retry') {
        reviews.delete(reviewGroup);
        throw new Error(`User requested fixes or another comment review:\n${reviewReport}`);
      }
      if (choice === 'skip') {
        return {
          content: [{ type: 'text', text: 'Commit skipped by user' }],
          details: { sha: '', files: params.files, subject, body, skipped: true },
        };
      }
      if (choice === 'abort') {
        throw new Error('Commit declined by user');
      }
      if (choice === 'subject') {
        const edited = await ctx.ui.editor('Edit subject', subject);
        if (edited !== undefined) {
          try {
            validateSubject(edited);
            subject = edited;
          } catch (error) {
            notice = error instanceof Error ? error.message : String(error);
          }
        }
      } else {
        body = (await ctx.ui.editor('Edit body', body ?? '')) ?? body;
      }
    }
  } finally {
    if (!approved) {
      if (!returningForCorrections) reviews.delete(reviewGroup);
      await unstageFiles(pi, ctx.cwd, params.files);
    }
  }

  const previousHead = await currentHead(pi, ctx.cwd);
  const commitResult = await pi.exec(
    'git',
    ['commit', '-m', buildCommitMessage(subject, body ?? undefined)],
    {
      cwd: ctx.cwd,
    },
  );
  if (commitResult.code !== 0) {
    throw commitFailedError(commitResult.stdout, commitResult.stderr);
  }

  // Hooks can stage files after approval, so check the committed paths too.
  const smuggledPaths = (await listCommitPaths(pi, ctx.cwd)).filter(
    (file) => !requestedFiles.has(file),
  );

  if (smuggledPaths.length > 0) {
    await undoCommit(pi, ctx.cwd, previousHead);
    await unstageFiles(
      pi,
      ctx.cwd,
      smuggledPaths.map((file) => file.slice(prefix.length)),
    );
    throw new Error(
      `A hook staged paths that were not requested: ${smuggledPaths.join(', ')}. The commit was undone.`,
    );
  }

  const committedTree = (await reviewGit(pi, ctx.cwd, ['rev-parse', 'HEAD^{tree}'])).trim();
  if (committedTree !== reviewedTree) {
    await undoCommit(pi, ctx.cwd, previousHead);
    throw new Error(
      'A hook changed reviewed content. The commit was undone. Call commit again to stage and review the current changes.',
    );
  }

  const revParseResult = await pi.exec('git', ['rev-parse', 'HEAD'], {
    cwd: ctx.cwd,
  });
  if (revParseResult.code !== 0) {
    throw new Error(
      `git rev-parse HEAD failed with exit code ${revParseResult.code}: ${revParseResult.stderr || revParseResult.stdout}`.trim(),
    );
  }

  const sha = revParseResult.stdout.trim();
  reviews.delete(reviewGroup);

  return {
    content: [
      {
        type: 'text',
        text: `${sha} ${subject}${reviewReport ? `\nComment review${reviewWaived ? ' waived by user' : ''}:\n${reviewReport}` : ''}`,
      },
    ],
    details: {
      sha,
      files: params.files,
      subject,
      body,
      commentReview: {
        status: reviewWaived ? 'waived' : 'passed',
        tree: reviewedTree,
        policy: commentPolicyHash,
        report: reviewReport,
      },
    },
  };
};

export const createCommitTool = (
  pi: Pick<ExtensionAPI, 'exec'>,
  review = reviewComments,
): ToolDefinition<typeof commitToolParameters, { groups: CommitSuccess['details'][] }> => {
  const reviews: Reviews = new Map();
  return defineTool({
    name: 'commit',
    label: 'Commit',
    description: 'Stage and commit logical groups sequentially, confirming each group.',
    promptSnippet: 'Create git commits for an ordered groups array in one call.',
    promptGuidelines: [
      'When asked to commit, call this tool without asking for confirmation in chat first. Its overlay is the only approval step; the user approves, edits, skips, or aborts there, even for changes that look temporary or wrong.',
      'Only commit the files explicitly provided.',
      'Use a conventional commit subject.',
      'Do not commit sensitive files such as .env or SSH keys.',
      'Comment review runs before approval. Fix blocking findings or supply commentDispute with evidence; missing-comment suggestions are advisory. After two automatic returns, unresolved findings go to the user. Never claim a waiver on the user’s behalf.',
    ],
    parameters: commitToolParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      for (const group of params.groups) {
        validateSubject(group.subject);
        validatePaths(group.files);
      }
      if (!ctx.hasUI) {
        throw new Error('Cannot commit without user confirmation (non-interactive mode)');
      }
      const groups: CommitSuccess['details'][] = [];
      const content: CommitSuccess['content'] = [];
      for (const [index, group] of params.groups.entries()) {
        const id = `${index + 1}/${params.groups.length}`;
        try {
          const result = await executeGroup(
            { ...group, commentDispute: params.commentDispute },
            id,
            pi,
            ctx,
            signal,
            reviews,
            review,
          );
          if (!result.details.sha && !result.details.skipped && params.groups.length > 1) {
            throw new Error('Commit cancelled');
          }
          groups.push(result.details);
          content.push(
            ...result.content.map((item) => ({
              ...item,
              text: params.groups.length === 1 ? item.text : `Group ${id}: ${item.text}`,
            })),
          );
        } catch (error) {
          if (params.groups.length === 1) throw error;
          const committed = groups.flatMap((result, committedIndex) =>
            result.sha
              ? [
                  `Group ${committedIndex + 1}/${params.groups.length}: ${result.sha} ${result.subject}`,
                ]
              : [],
          );
          throw new Error(
            `Group ${id}: ${error instanceof Error ? error.message : String(error)}\nAlready committed:\n${committed.join('\n') || 'None.'}`,
            { cause: error },
          );
        }
      }
      return { content, details: { groups } };
    },
  });
};
