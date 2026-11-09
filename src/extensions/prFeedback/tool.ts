import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec, CommandRuntime } from '../../command.js';
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
import { threadsToShow } from './threads.js';

const feedbackPath = 'pr-feedback';

export const prFeedbackToolParameters = Type.Object({
  action: Type.Union([Type.Literal('read'), Type.Literal('checks'), Type.Literal('post')]),
  repository: Type.Optional(
    Type.String({
      description: 'read, checks: <host>/<owner>/<name>, such as github.com/sQVe/tau.',
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

const description = `Read a GitHub pull request's feedback and checks, and post replies, as the pr-feedback skill directs.
- read {repository, pr}: saves the full feedback in <directory>/feedback.json, where each body is an array of chunks to join with no separator. Returns {bodies, directory, feedback, viewer, pr, threads, reviews, comments, stateToken, gaps}.
  - pr: {number, url, author, headRefOid, state, baseRefName, headRefName, headRepository (name, or null), headRepositoryOwner (login), isCrossRepository, maintainerCanModify, mergeable (may stay UNKNOWN)}.
  - threads: unresolved threads only, each {id, path, line, isOutdated, viewerCanReply, viewerCanResolve, replyTo (the first comment's ID), fromPerson (any comment not by a bot), startedByViewer, comments [{id, author, isBot, body, url, createdAt, updatedAt}]}. Threads with only viewer comments are left out.
  - reviews: each {id, author, isBot, state, body, url}. comments: each {id, author, isBot, body, url}. author null is a deleted account and counts as a person.
  - The result is capped; gaps names each cut, {kind: truncatedBody|truncatedList, list, id (bodies only), kept, total}. feedback.json holds the rest.
  - stateToken changes when a person other than the viewer adds, edits, or deletes a comment.
- checks {repository, pr, head, trunk}: head is the SHA the checks must belong to (read's pr.headRefOid). trunk defaults to pr.baseRefName. Returns {pr, checks, gaps}.
  - checks: each {name, workflow, bucket, state, link}. bucket is pass, fail, pending, skipping, or cancel. A fail or cancel check has log {excerpt, omittedLines, omittedCharacters} or a gap. A cut log has a command to read it whole; budgetLimited: true means the shared budget cut it.
  - A failing Actions check has trunkMatches [{url, headSha}]: the latest five trunk runs of its workflow where a job of its name failed. Matches are candidates, not verdicts. trunkGaps lists unread trunk evidence.
  - gaps: every {check, command, code, stderr, reason} for unread evidence, trunkGaps included; never a passing check. When the check list is unreadable, checks is empty and one gap has check null. An omitted-checks gap has a command to read them.
- post {directory, stateToken, head}: directory and stateToken come from read. head is the SHA the PR head must be at: the round's push, or pr.headRefOid when the round pushed nothing. Write <directory>/replies.json first:
  {"version": 1, "threads": [{"id": "<thread id>", "reply": "<text or null>", "resolve": true}], "comment": {"body": "<text>", "answers": ["<review or comment id>"]}}
  comment may be null. Only writes to a person need user confirmation, asked once. If the stateToken or head no longer matches, it posts nothing; read again. A retry with the same directory skips posted writes. Returns {status: posted, declined (the user refused), or unchanged (all were posted), posted, skipped}.`;

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

const runAction = (
  commands: { exec: Exec; execInGroup: GroupExec },
  context: ExtensionContext,
  parameters: PrFeedbackInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  const runtime = { ...commands, cwd: context.cwd, signal };

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
): ToolDefinition<typeof prFeedbackToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'pr_feedback',
    label: 'PR feedback',
    description,
    promptSnippet: "Read a pull request's review feedback and post replies.",
    parameters: prFeedbackToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const details = await runAction({ exec, execInGroup }, context, parameters, signal);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
