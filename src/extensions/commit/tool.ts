import { posix } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { tddGateStatus, unknownGateStatus } from '../tdd/state.js';
import {
  reviewComments,
  formatCommentReview,
  reviewGit,
  commentPolicyHash,
} from './commentReview.js';
import type { CommentReview } from './commentReview.js';
import type { CommitView } from './overlay.js';
import { confirmCommitOverlay } from './overlay.js';
import { snapshotPreparation } from './preparation.js';
import { checkProject, prepareProject, readPreparation } from './projectCheck.js';
import type { Preparation } from './projectCheck.js';
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

const buildCommitMessage = (subject: string, body?: string) => {
  if (body !== undefined) {
    return `${subject}\n\n${body}`;
  }

  return subject;
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

const stagedNumstat = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
): Promise<CommitView['files']> => {
  const result = await pi.exec(
    'git',
    ['--literal-pathspecs', 'diff', '--cached', '--numstat', '--no-renames', '-z', '--', ...files],
    { cwd: workingDirectory },
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

// Worktree fingerprint for a group's files. Approve-all covers the content the user saw, so a
// later group whose files changed since must be shown rather than committed unseen.
const hashFiles = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
) => {
  const hashes: string[] = [];

  for (const file of files) {
    const result = await pi.exec('git', ['--literal-pathspecs', 'hash-object', '--', file], {
      cwd: workingDirectory,
    });
    const hash = result.code === 0 ? result.stdout.trim() : `absent:${file}`;

    hashes.push(hash);
  }

  return hashes.join(' ');
};

interface ReviewSnapshot {
  tree: string;
  head: string | null;
  dispute?: string;
}

type RequestReview = (snapshot: ReviewSnapshot, baseTree: string | null) => Promise<CommentReview>;

const treeOf = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  revision: string | null,
  signal?: AbortSignal,
) => {
  if (revision === null) {
    return null;
  }

  const tree = await reviewGit(pi, workingDirectory, ['rev-parse', `${revision}^{tree}`], signal);

  return tree.trim();
};

// Stage the groups cumulatively so each planned pair matches what that group sees at its turn:
// group N commits before group N+1 stages, so N+1's index tree already contains N's content.
const planGroupReviews = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  groups: CommitInput['groups'],
  signal: AbortSignal | undefined,
): Promise<{ baseTree: string; tree: string }[]> => {
  const plan: { baseTree: string; tree: string }[] = [];
  const head = await currentHead(pi, workingDirectory);
  let baseTree = await treeOf(pi, workingDirectory, head, signal);

  if (baseTree === null) {
    return plan;
  }

  try {
    for (const group of groups) {
      await stageFiles(pi, workingDirectory, group.files);

      const treeOutput = await reviewGit(pi, workingDirectory, ['write-tree'], signal);
      const tree = treeOutput.trim();

      plan.push({ baseTree, tree });
      baseTree = tree;
    }
  } finally {
    for (const group of groups) {
      await unstageFiles(pi, workingDirectory, group.files);
    }
  }

  return plan;
};

const executeGroup = async (
  parameters: CommitInput['groups'][number],
  groupLabel: string | undefined,
  preparation: Preparation,
  ownership: Awaited<ReturnType<typeof snapshotPreparation>> | undefined,
  otherGroups: Set<string>,
  pi: Pick<ExtensionAPI, 'exec'>,
  context: ExtensionContext,
  signal: AbortSignal | undefined,
  reviews: Reviews,
  requestReview: RequestReview,
  batch: {
    autoApprove: () => Promise<boolean>;
    onApproveAll: () => Promise<void>;
    prefetchNext: () => void;
  },
): Promise<CommitSuccess> => {
  const cancelled = (): CommitSuccess => ({
    content: [{ type: 'text', text: 'Commit cancelled' }],
    details: { sha: '', files: parameters.files, subject, body },
  });

  let subject = parameters.subject;
  let body = parameters.body ?? null;

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

  let projectPreparation = preparation.notice;
  let approved = false;
  let reviewedTree = '';
  let reviewedHead: string | null = null;
  let reviewGroup = '';
  let reviewReport = '';
  let projectCheck = '';
  let reviewWaived = false;
  let returningForCorrections = false;

  try {
    const staging = ownership?.isolated ?? pi;

    if (ownership) {
      await ownership.stage(requestedFiles);
      try {
        projectPreparation = await prepareProject(staging, preparation, signal);
      } catch (error) {
        if (signal?.aborted) {
          return cancelled();
        }

        throw error;
      }

      await ownership.stage(requestedFiles);
      await ownership.validate(requestedFiles, otherGroups);
      await ownership.publish();
    } else {
      await stageFiles(staging, context.cwd, parameters.files);
    }

    // Directory arguments can stage unrequested files.
    // Reset needs paths relative to the working directory.
    const stagedAfterRequest = await listStagedPaths(pi, context.cwd);
    const unrequestedPaths = stagedAfterRequest
      .filter((file) => !requestedFiles.has(file))
      .map((file) => file.slice(prefix.length));

    if (unrequestedPaths.length > 0) {
      await unstageFiles(pi, context.cwd, unrequestedPaths);

      throw new Error(
        `Staging ${parameters.files.join(', ')} produced staged paths that were not requested: ${unrequestedPaths.join(', ')}`,
      );
    }

    const treeOutput = await reviewGit(pi, context.cwd, ['write-tree'], signal);
    reviewedTree = treeOutput.trim();
    reviewedHead = await currentHead(pi, context.cwd);

    if (signal?.aborted) {
      return cancelled();
    }

    try {
      projectCheck = await checkProject(pi, context.cwd, reviewedTree, signal);
    } catch (error) {
      if (signal?.aborted) {
        return cancelled();
      }

      throw error;
    }

    const reviewedBaseTree = await treeOf(pi, context.cwd, reviewedHead, signal);

    reviewGroup = JSON.stringify([context.cwd, reviewedHead, [...requestedFiles].toSorted()]);

    const state = reviews.get(reviewGroup) ?? { attempts: 0, disputes: [] };

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
          : await requestReview(
              {
                tree: reviewedTree,
                head: reviewedHead,
                ...(parameters.commentDispute ? { dispute: parameters.commentDispute } : {}),
              },
              reviewedBaseTree,
            );
      state.key = reviewKey;
      state.result = commentReview;

      if (commentReview.findings.some((finding) => finding.kind !== 'missing')) {
        state.attempts += 1;
      }

      reviewReport = formatCommentReview(commentReview);
    } catch (error) {
      reviewReport = `Comment review failed: ${error instanceof Error ? error.message : String(error)}\nRetry or explicitly waive this failed review.`;
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

    const reviewBlocked =
      !commentReview || commentReview.findings.some((finding) => finding.kind !== 'missing');

    if (commentReview && reviewBlocked && state.attempts <= 2) {
      returningForCorrections = true;

      throw new Error(
        `Comment review needs corrections (${state.attempts}/2 automatic returns):\n${reviewReport}\nFix the findings and call commit again. Unresolved findings will require user review after two returns.`,
      );
    }

    const files = await stagedNumstat(pi, context.cwd, parameters.files);
    let notice = `${projectPreparation}\n${projectCheck}`;

    while (true) {
      if (signal?.aborted) {
        return cancelled();
      }

      batch.prefetchNext();

      const automaticallyApproved = await batch.autoApprove();
      const choice = automaticallyApproved
        ? 'approve'
        : await confirmCommitOverlay(
            context,
            {
              subject,
              body,
              files,
              ...(groupLabel ? { group: groupLabel } : {}),
              notice,
              review: reviewReport,
              reviewBlocked,
            },
            signal,
          );
      notice = `${projectPreparation}\n${projectCheck}`;

      if (signal?.aborted) {
        return cancelled();
      }

      if ((choice === 'approve' || choice === 'approveAll') && reviewBlocked) {
        throw new Error(`Comment review requires an explicit user waiver.\n${reviewReport}`);
      }

      if (choice === 'approve' || choice === 'approveAll' || choice === 'waive') {
        const currentTreeOutput = await reviewGit(pi, context.cwd, ['write-tree'], signal);
        const currentTree = currentTreeOutput.trim();
        const changedSinceReview =
          currentTree !== reviewedTree || (await currentHead(pi, context.cwd)) !== reviewedHead;

        if (changedSinceReview) {
          throw new Error(
            'Staged content or HEAD changed since comment review. Call commit again to review the changes.',
          );
        }

        if (choice === 'approveAll') {
          await batch.onApproveAll();
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
          details: { sha: '', files: parameters.files, subject, body, skipped: true },
        };
      }

      if (choice === 'abort') {
        throw new Error('Commit declined by user');
      }

      if (choice === 'subject') {
        const edited = await context.ui.editor('Edit subject', subject);

        if (edited !== undefined) {
          try {
            validateSubject(edited);
            subject = edited;
          } catch (error) {
            notice = error instanceof Error ? error.message : String(error);
          }
        }
      } else {
        body = (await context.ui.editor('Edit body', body ?? '')) ?? body;
      }
    }
  } finally {
    if (!approved) {
      if (!returningForCorrections) {
        reviews.delete(reviewGroup);
      }

      if (!ownership) {
        await unstageFiles(pi, context.cwd, parameters.files);
      }
    }
  }

  const previousHead = await currentHead(pi, context.cwd);
  const commitResult = await pi.exec(
    'git',
    ['commit', '-m', buildCommitMessage(subject, body ?? undefined)],
    {
      cwd: context.cwd,
    },
  );

  if (commitResult.code !== 0) {
    if (!ownership) {
      await unstageFiles(pi, context.cwd, parameters.files);
    }

    throw commitFailedError(commitResult.stdout, commitResult.stderr);
  }

  // Hooks can stage files after approval, so check the committed paths too.
  const committedPaths = await listCommitPaths(pi, context.cwd);

  const smuggledPaths = committedPaths.filter((file) => !requestedFiles.has(file));

  if (smuggledPaths.length > 0) {
    await undoCommit(pi, context.cwd, previousHead);
    await unstageFiles(
      pi,
      context.cwd,
      smuggledPaths.map((file) => file.slice(prefix.length)),
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
        text: `${commitHash} ${subject}\n${projectPreparation}\n${projectCheck}${reviewReport ? `\nComment review${reviewWaived ? ' waived by user' : ''}:\n${reviewReport}` : ''}`,
      },
    ],
    details: {
      sha: commitHash,
      files: parameters.files,
      subject,
      body,
      projectCheck,
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
  autoApproveCommits = () => false,
): ToolDefinition<typeof commitToolParameters, { groups: CommitSuccess['details'][] }> => {
  const reviews: Reviews = new Map();

  return defineTool({
    name: 'commit',
    label: 'Commit',
    description:
      'Stage, prepare, check, review, and commit each group sequentially. Preparation-added paths require explicit assignment and a retry. Confirm each group unless started with --auto-approve-commits.',
    promptSnippet: 'Create git commits for an ordered groups array in one call.',
    promptGuidelines: [
      'When asked to commit, call commit without asking for confirmation in chat first. The commit overlay is the only approval step unless Pi was started with --auto-approve-commits. That flag skips confirmation, not checks or comment review.',
      'Only commit the files explicitly provided.',
      'The commit tool runs configured preparation once after staging each executed group, then restages requested files and checks the candidate. Fix reported errors before retrying. Report unavailable checks as unavailable, not passed.',
      'Configured preparation disables speculative review planning and approve-all reuse for later groups. It never expands requested files. Assign clean generated paths explicitly to a group and retry; do not absorb ownership conflicts.',
      'Preparation recovery requires a local POSIX checkout, a regular supported index, and at most 100 MiB of tracked and nonignored untracked working data. Unsupported states fail before preparation. Ignored files, external symlink targets, and background writers are outside recovery coverage; this is not a sandbox.',
      'On preparation failure, cancellation, rejection, or ownership conflict, read the reported recovery instructions. Working edits remain; never restore a saved index or working files over concurrent user edits. Git hooks and post-commit guards remain enabled. checkMessage and hooks settings remain reserved and rejected.',
      'Use a conventional commit subject.',
      'Do not commit sensitive files such as .env or SSH keys.',
      "Comment review runs before commit approval. Fix blocking findings or supply commentDispute with evidence. Missing-comment suggestions are advisory. After two automatic returns, unresolved findings need a user waiver. With --auto-approve-commits, commit returns an error instead of asking for a waiver. Stop and report the blocker. Never claim a waiver on the user's behalf.",
    ],
    parameters: commitToolParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const assigned = new Set<string>();

      for (const group of parameters.groups) {
        validateSubject(group.subject);
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

      const preapproved = autoApproveCommits();

      if (!context.hasUI && !preapproved) {
        throw new Error('Cannot commit without user confirmation (non-interactive mode)');
      }

      const approval = { all: false, seen: new Map<number, string>() };
      const groups: CommitSuccess['details'][] = [];
      const content: CommitSuccess['content'] = [];

      // Commit is exempt from the guard, so it must report unreadable evidence rather than stay quiet.
      const finish = async (items: CommitSuccess['content']) => {
        const gateOff = await tddGateStatus(context.cwd).catch(() =>
          unknownGateStatus(context.cwd),
        );

        const reported: CommitSuccess['content'] =
          gateOff === undefined ? items : [{ type: 'text', text: gateOff }, ...items];

        return { content: reported, details: { groups } };
      };

      if (signal?.aborted) {
        return finish([{ type: 'text', text: 'Commit cancelled' }]);
      }

      const preparation = await readPreparation(pi, context.cwd);

      // Hide model latency by reviewing the next group while the user reads the overlay.
      // Approve-all starts reviews for every remaining group.
      const plan =
        !preparation.command &&
        parameters.groups.length > 1 &&
        (await listStagedPaths(pi, context.cwd)).length === 0
          ? await planGroupReviews(pi, context.cwd, parameters.groups, signal)
          : [];
      const started = new Map<number, Promise<CommentReview>>();

      const startReview = (index: number) => {
        const step = plan[index];
        const group = parameters.groups[index];

        if (!step || !group || started.has(index)) {
          return;
        }

        const pending = review(pi, context, signal, {
          tree: step.tree,
          head: step.baseTree,
          ...(group.commentDispute ? { dispute: group.commentDispute } : {}),
        });

        // A review started ahead of time may reject before its group awaits it.
        pending.catch(() => {});
        started.set(index, pending);
      };

      const requestReview =
        (index: number): RequestReview =>
        (snapshot, baseTree) => {
          const step = plan[index];
          const planned =
            step?.tree === snapshot.tree &&
            step?.baseTree === baseTree &&
            parameters.groups[index]?.commentDispute === snapshot.dispute;

          if (planned) {
            startReview(index);

            const pending = started.get(index);

            if (pending) {
              return pending;
            }
          }

          return review(pi, context, signal, snapshot);
        };

      startReview(0);

      for (const [index, group] of parameters.groups.entries()) {
        const groupLabel = `${index + 1}/${parameters.groups.length}`;

        let ownership: Awaited<ReturnType<typeof snapshotPreparation>> | undefined;
        let completed = false;

        try {
          const prefix = preparation.command ? await repositoryPathPrefix(pi, context.cwd) : '';

          if (preparation.command) {
            ownership = await snapshotPreparation(
              pi,
              preparation.repositoryRoot,
              group.files.map((file) => normalizeRepositoryPath(`${prefix}${file}`)),
            );
          }
          const otherGroups = new Set(
            parameters.groups
              .filter((_, groupIndex) => groupIndex !== index)
              .flatMap((other) =>
                other.files.map((file) => normalizeRepositoryPath(`${prefix}${file}`)),
              ),
          );
          const result = await executeGroup(
            group,
            parameters.groups.length > 1 ? groupLabel : undefined,
            preparation,
            ownership,
            otherGroups,
            pi,
            context,
            signal,
            reviews,
            requestReview(index),
            {
              autoApprove: async () => {
                if (preapproved) {
                  return true;
                }

                const seen = approval.seen.get(index);

                return (
                  !preparation.command &&
                  approval.all &&
                  seen !== undefined &&
                  seen === (await hashFiles(pi, context.cwd, group.files))
                );
              },
              onApproveAll: async () => {
                approval.all = true;

                for (
                  let remainingIndex = index + 1;
                  remainingIndex < parameters.groups.length;
                  remainingIndex += 1
                ) {
                  const remaining = parameters.groups[remainingIndex];

                  if (!remaining) {
                    continue;
                  }

                  const fingerprint = await hashFiles(pi, context.cwd, remaining.files);

                  approval.seen.set(remainingIndex, fingerprint);
                  startReview(remainingIndex);
                }
              },
              prefetchNext: () => {
                startReview(index + 1);
              },
            },
          );

          completed = Boolean(result.details.sha);

          if (ownership) {
            if (completed) {
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

          if (!result.details.sha && !result.details.skipped && parameters.groups.length > 1) {
            throw new Error('Commit cancelled');
          }

          groups.push(result.details);
          content.push(
            ...result.content.map((item) => ({
              ...item,
              text:
                parameters.groups.length === 1 ? item.text : `Group ${groupLabel}: ${item.text}`,
            })),
          );
        } catch (error) {
          let cleanupDiagnostic = '';

          if (ownership && !completed) {
            try {
              await ownership.cleanup();
            } catch (cleanupError) {
              cleanupDiagnostic = `\nIndex cleanup failed: ${String(cleanupError)}`;
            }
          }

          const failure = ownership
            ? new Error(
                `${error instanceof Error ? error.message : String(error)}${cleanupDiagnostic}\n${ownership.notice}`,
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

      return finish(content);
    },
  });
};
