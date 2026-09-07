import { posix } from 'node:path';

import type { ExtensionAPI, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { defineTool } from '@mariozechner/pi-coding-agent';
import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

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
  files: Type.Array(Type.String(), { minItems: 1 }),
  subject: Type.String(),
  body: Type.Optional(Type.String()),
  commentDispute: Type.Optional(
    Type.String({
      maxLength: 4000,
      description: 'Evidence for rechecking a comment finding. This never waives review.',
    }),
  ),
  group: Type.Optional(
    Type.String({
      description:
        'Optional marker rendered after "commit" in the overlay title (e.g. "2/5") so the caller can wait on it.',
    }),
  ),
});

export type CommitInput = Static<typeof commitToolParameters>;

// Pi forwards only error.message to the model, so hook output has to travel inside it. A hook can
// split its diagnostics across both streams, so neither one is dropped when the other has content.
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

// --literal-pathspecs stops git from reading an argument as a glob and staging files nobody named.
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

// git reports staged paths from the repository root, so requested paths need the same base before
// the two can be compared. Empty when cwd is already the root.
const repoPathPrefix = async (pi: Pick<ExtensionAPI, 'exec'>, cwd: string) => {
  const result = await pi.exec('git', ['rev-parse', '--show-prefix'], { cwd });
  if (result.code !== 0) {
    throw new Error(
      `git rev-parse --show-prefix failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim(),
    );
  }

  return result.stdout.trim();
};

// Null before the first commit, when HEAD names a branch that does not exist yet.
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

export const createCommitTool = (
  pi: Pick<ExtensionAPI, 'exec'>,
  review = reviewComments,
): ToolDefinition<typeof commitToolParameters, CommitSuccess['details']> => {
  const reviews = new Map<string, { attempts: number; key?: string; result?: CommentReview }>();
  return defineTool({
    name: 'commit',
    label: 'Commit',
    description: 'Stage specific files and create a git commit with a validated subject.',
    promptSnippet: 'Create a git commit for specific files using a conventional commit subject.',
    promptGuidelines: [
      'When asked to commit, call this tool without asking for confirmation in chat first. Its overlay is the only approval step; the user approves, edits, skips, or aborts there, even for changes that look temporary or wrong.',
      'Only commit the files explicitly provided.',
      'Use a conventional commit subject.',
      'Do not commit sensitive files such as .env or SSH keys.',
      'Comment review runs before approval. Fix blocking findings or supply commentDispute with evidence; missing-comment suggestions are advisory. After two automatic returns, unresolved findings go to the user. Never claim a waiver on the user’s behalf.',
    ],
    parameters: commitToolParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<CommitSuccess> {
      validateSubject(params.subject);
      validatePaths(params.files);

      if (!ctx.hasUI) {
        throw new Error('Cannot commit without user confirmation (non-interactive mode)');
      }

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
      const requestedFiles = new Set(
        params.files.map((file) => normalizeRepoPath(`${prefix}${file}`)),
      );
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
      try {
        // A directory argument stages everything beneath it, so verify what landed rather than
        // trusting that each argument named one file. Anything extra came from this call's add, so
        // it sits under cwd and the prefix strips back off.
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
        const state = reviews.get(reviewGroup) ?? { attempts: 0 };
        reviews.set(reviewGroup, state);
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
          if (commentReview.findings.some((finding) => finding.kind !== 'missing'))
            state.attempts += 1;
          reviewReport = formatCommentReview(commentReview);
        } catch (error) {
          reviewReport = `Comment review failed: ${error instanceof Error ? error.message : String(error)}\nRetry or explicitly waive this failed review.`;
        }
        if (signal?.aborted) return cancelled();
        const reviewBlocked =
          !commentReview || commentReview.findings.some((finding) => finding.kind !== 'missing');
        if (commentReview && reviewBlocked && state.attempts <= 2) {
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
              ...(params.group !== undefined ? { group: params.group } : {}),
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

      // A pre-commit hook runs after the staged set is approved and can stage more, so the commit
      // is the last place the promise can be checked. Undo it rather than leave it standing.
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
          'A hook changed reviewed content. The commit was undone; changes remain staged. Call commit again to review them.',
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
    },
  });
};
