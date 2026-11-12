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

const description = `- status: snapshot {prs,recommended,reason,attention}, bottom-to-top. PR: {pr,url,verdict,reasons,head,draft,gaps}; reasons: code, optional count/names/logins. Verdict: action-required|unknown|waiting-checks|waiting-human|clear (no known blocker, not merge approval). recommended: lowest action-required, else unknown, else null; attention: those numbers.
- read: feedback {bodies,directory,feedback,viewer,pr,threads,reviews,comments,stateToken,gaps}. feedback: full JSON path; join body chunks without separator. pr: author,headRefOid,branches,head repository/owner,state,maintainerCanModify,mergeable (may be UNKNOWN). threads: unresolved, not viewer-only; replyTo: first comment ID; fromPerson: any non-bot. Reviews/comments: id,author,isBot,body,url; reviews add state. Null author: deleted person. gaps {kind,list,id,kept,total}: capped feedback. stateToken: others' comment changes.
- checks: pinned head; trunk defaults to baseRefName. {pr,checks,gaps}; check: {name,workflow,bucket:pass|fail|pending|skipping|cancel,state,link}; fail/cancel: log {excerpt,omittedLines,omittedCharacters} or gap. command reads cuts; budgetLimited: shared budget cut. trunkMatches [{url,headSha}]: same-name failures in latest five trunk runs, not verdicts. trunkGaps: unread. gaps {check,command,code,stderr,reason} includes trunkGaps; null check: unread checks. Omitted checks have command.
- post: replies.json in read's directory:
  {"version":1,"threads":[{"id":"<thread id>","reply":"<text or null>","resolve":true}],"comment":{"body":"<text>","answers":["<review or comment id>"]}}
  comment may be null. Person writes require confirmation. Changed token/head writes nothing; retries skip posted writes. {status:posted|declined|unchanged,posted,skipped}; unchanged: already posted.`;

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
