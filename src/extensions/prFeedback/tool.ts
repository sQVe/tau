import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec, CommandRuntime } from '../../command.js';
import { readConfigLocation } from '../../config/config.js';
import { findCheckoutRoot } from '../../git.js';
import { parseRepository } from '../../github/github.js';
import type { GroupExec } from '../../process/process.js';
import { checkTauDirectory, createFreshTauDirectory, requireTauChild } from '../../tauDirectory.js';
import { readChecks } from './checks.js';
import { boundFeedback, chunkFeedbackBodies } from './feedbackBounds.js';
import { postReplies } from './post.js';
import type { PostRuntime } from './post.js';
import { readFeedback } from './read.js';
import { writePullRequestRecord } from './replies.js';
import { readStatuses } from './status.js';
import { threadsToShow } from './threads.js';

const feedbackPath = 'pr-feedback';

export const prFeedbackToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal('read'),
    Type.Literal('checks'),
    Type.Literal('post'),
    Type.Literal('status'),
  ]),
  prs: Type.Optional(
    Type.Array(
      Type.Object({ pr: Type.Integer({ minimum: 1 }), head: Type.String({ minLength: 1 }) }),
      {
        minItems: 1,
        description: 'status: PRs ordered bottom to top, with their expected head SHAs.',
      },
    ),
  ),
  repository: Type.Optional(
    Type.String({
      description: 'read, checks, status: <host>/<owner>/<name>.',
    }),
  ),
  pr: Type.Optional(
    Type.Integer({ minimum: 1, description: 'read, checks: the pull request number.' }),
  ),
  directory: Type.Optional(Type.String({ description: 'post: the directory that read returned.' })),
  stateToken: Type.Optional(Type.String({ description: 'post: the stateToken from read.' })),
  head: Type.Optional(
    Type.String({
      description: 'post, checks: the SHA the pull request head must be at.',
    }),
  ),
  trunk: Type.Optional(Type.String({ description: 'checks: the trunk branch.' })),
});

export type PrFeedbackInput = Static<typeof prFeedbackToolParameters>;

const description = `Read GitHub PR status, feedback, and checks, or post replies.
- status {repository, prs: [{pr, head}]}: one snapshot, bottom to top; no files or GitHub writes. Returns {prs, recommended, reason, attention}. Each PR: {pr, url, verdict, reasons, head, draft, gaps}. Reasons have code and optional count, names, or logins. Verdicts: action-required, unknown, waiting-checks, waiting-human, clear. clear means no known blocker, not a merge guarantee. recommended is the lowest action-required PR, else lowest unknown, else null. attention lists those PR numbers bottom to top. The user picks.
- read {repository, pr}: returns {bodies, directory, feedback, viewer, pr, threads, reviews, comments, stateToken, gaps}. Full feedback is in feedback.json; join each body's chunks without a separator.
  - pr includes author, headRefOid, branches, head repository/owner, state, maintainerCanModify, and mergeable (may stay UNKNOWN).
  - threads are unresolved, excluding viewer-only conversations. replyTo is the first comment ID; fromPerson means any non-bot comment. Reviews and comments have id, author, isBot, body, url; reviews add state. author null means a deleted person.
  - gaps reports capped bodies/lists with kind, list, id, kept, total. Read feedback.json for the rest. stateToken tracks other people's added, edited, or deleted comments.
- checks {repository, pr, head, trunk?}: pins checks to head (read's pr.headRefOid); trunk defaults to pr.baseRefName. Returns {pr, checks, gaps}.
  - Each check: {name, workflow, bucket, state, link}. bucket: pass, fail, pending, skipping, cancel. fail/cancel has log {excerpt, omittedLines, omittedCharacters} or a gap. Cut logs have a command; budgetLimited means the shared budget cut them.
  - trunkMatches [{url, headSha}] lists failed same-name jobs among the latest five trunk workflow runs: candidates, not verdicts. trunkGaps are unread evidence.
  - gaps {check, command, code, stderr, reason} includes trunkGaps, never passes. check null means unread checks. Omitted checks have a read command.
- post {directory, stateToken, head}: use read's directory/token and the round's pushed head, or read's head if unchanged. First write replies.json:
  {"version":1,"threads":[{"id":"<thread id>","reply":"<text or null>","resolve":true}],"comment":{"body":"<text>","answers":["<review or comment id>"]}}
  comment may be null. Person writes ask once for confirmation. Changed token/head posts nothing: read again. Retrying the directory skips posted writes. Returns {status: posted|declined|unchanged, posted, skipped}; declined means refused, unchanged means already posted.`;

const parsePullRequestNumber = (action: string, pr: number | undefined) => {
  if (pr === undefined) {
    throw new Error(`${action} needs pr.`);
  }

  if (!Number.isSafeInteger(pr) || pr < 1) {
    throw new Error(`pr must be a pull request number, not ${pr}.`);
  }

  return pr;
};

// Refuses any directory but .tau/pr-feedback/<name>, so post reads and writes only a round's files.
const feedbackDirectory = async (root: string, directory: string | undefined) => {
  if (directory === undefined) {
    throw new Error('post needs the directory that read returned.');
  }

  const name = requireTauChild(root, feedbackPath, '', directory, 'The feedback directory');

  await checkTauDirectory(root, `${feedbackPath}/${name}`);

  return join(root, '.tau', feedbackPath, name);
};

const post = async (
  runtime: PostRuntime,
  context: ExtensionContext,
  parameters: PrFeedbackInput,
) => {
  const root = await findCheckoutRoot(runtime.cwd, 'pr_feedback');

  if (parameters.stateToken === undefined) {
    throw new Error('post needs the stateToken that read returned.');
  }

  if (parameters.head === undefined) {
    throw new Error('post needs head.');
  }

  return postReplies(runtime, context, () => feedbackDirectory(root, parameters.directory), {
    stateToken: parameters.stateToken,
    head: parameters.head,
  });
};

const read = async (runtime: CommandRuntime, parameters: PrFeedbackInput) => {
  if (parameters.repository === undefined) {
    throw new Error('read needs repository.');
  }

  const repository = parseRepository(parameters.repository);
  const pr = parsePullRequestNumber('read', parameters.pr);
  const root = await findCheckoutRoot(runtime.cwd, 'pr_feedback');
  const full = await readFeedback(runtime, repository, pr);
  const feedback = { ...full, threads: threadsToShow(full.threads) };
  const directory = await createFreshTauDirectory(root, feedbackPath, `${pr}-`);

  await writePullRequestRecord(directory, { repository, pr });

  const path = join(directory, 'feedback.json');

  const saved = { directory, ...chunkFeedbackBodies(feedback) };

  await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' });

  return { ...boundFeedback(feedback, { directory, feedback: path }) };
};

const checks = async (runtime: CommandRuntime, parameters: PrFeedbackInput) => {
  if (parameters.repository === undefined) {
    throw new Error('checks needs repository.');
  }

  const repository = parseRepository(parameters.repository);
  const pr = parsePullRequestNumber('checks', parameters.pr);

  if (parameters.head === undefined) {
    throw new Error('checks needs head.');
  }

  const pull = { pr, head: parameters.head, trunk: parameters.trunk };

  return { ...(await readChecks(runtime, repository, pull)) };
};

const status = async (
  runtime: CommandRuntime,
  parameters: PrFeedbackInput,
  context: ExtensionContext,
  options: { agentDirectory?: string },
) => {
  if (parameters.repository === undefined) {
    throw new Error('status needs repository.');
  }

  const repository = parseRepository(parameters.repository);

  if (parameters.prs === undefined || parameters.prs.length === 0) {
    throw new Error('status needs prs ordered bottom to top.');
  }

  for (const request of parameters.prs) {
    parsePullRequestNumber('status', request.pr);

    if (request.head.trim() === '') {
      throw new Error('status needs a nonempty head for each PR.');
    }
  }

  const root = await findCheckoutRoot(runtime.cwd, 'pr_feedback');
  const location = readConfigLocation(root, options, context);

  return readStatuses({ ...runtime, location, ui: context.ui }, repository, parameters.prs);
};

const runAction = (
  commands: { exec: Exec; execInGroup: GroupExec; agentDirectory?: string },
  context: ExtensionContext,
  parameters: PrFeedbackInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  const runtime = { ...commands, cwd: context.cwd, signal };

  if (parameters.action === 'status') {
    return status(runtime, parameters, context, commands);
  }

  if (parameters.action === 'read') {
    return read(runtime, parameters);
  }

  return parameters.action === 'checks'
    ? checks(runtime, parameters)
    : post(runtime, context, parameters);
};

export const createPrFeedbackTool = (
  exec: Exec,
  execInGroup: GroupExec,
  options: { agentDirectory?: string } = {},
): ToolDefinition<typeof prFeedbackToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'pr_feedback',
    label: 'PR feedback',
    description,
    promptSnippet: "Read a pull request's review feedback and post replies.",
    parameters: prFeedbackToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const details = await runAction(
        { exec, execInGroup, ...options },
        context,
        parameters,
        signal,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
