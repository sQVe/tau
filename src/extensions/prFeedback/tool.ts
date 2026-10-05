import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../exec.js';
import { readGitOutput } from '../../gitOutput.js';
import { checkTauDirectory, createFreshTauDirectory } from '../../tauDirectory.js';
import { readChecks } from './checks.js';
import { parseRepository } from './github.js';
import type { Runtime } from './github.js';
import { postReplies } from './post.js';
import { readFeedback } from './read.js';
import { writePullRequestRecord } from './replies.js';

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
    Type.String({ description: 'post: the SHA the pull request head must be at.' }),
  ),
});

export type PrFeedbackInput = Static<typeof prFeedbackToolParameters>;

const description = `Read a pull request's review feedback and checks on GitHub and post replies to it. Call it as the pr-feedback skill directs.
- read {repository, pr}: repository is <host>/<owner>/<name>, such as github.com/sQVe/tau. Reads the viewer, the pull request, its review threads, reviews, and conversation comments with gh, and creates a fresh ignored directory .tau/pr-feedback/<pr>-XXXXXX for this round. Returns {directory, viewer, pr {number, url, author, headRefOid}, threads, reviews, comments, stateToken}.
  - threads: unresolved threads only, each {id, path, line, isOutdated, viewerCanReply, viewerCanResolve, replyTo (the first comment's ID, to reply to), fromPerson (any comment not by a bot), startedByViewer, comments [{id, author, isBot, body, url, createdAt, updatedAt}]}.
  - reviews: review summaries with a body, each {id, author, isBot, state, body, url}.
  - comments: conversation comments, each {id, author, isBot, body, url}.
  - isBot is true only when GitHub marks the author as a bot. author is null for a deleted account, which counts as a person.
  - stateToken changes when a person other than the viewer adds, edits, or deletes a comment, in any thread, review, or conversation comment. Bot comments, the viewer's comments, and resolving a thread do not change it.
  - Errors: a repository or pr of another shape, a failing gh call, gh output that is not JSON or misses a field, a pull request that is not OPEN, or a thread too long to read in full. Nothing is created in those cases.
- checks {repository, pr}: repository is <host>/<owner>/<name>, as for read. Reads the pull request's checks with gh, and the failed-step log of each failing or cancelled GitHub Actions job. Writes nothing. Returns {pr, checks, gaps}.
  - checks: each {name, workflow, bucket, state, link}. bucket is pass, fail, pending, skipping, or cancel. A check with bucket fail or cancel also has either log {excerpt, omittedLines} or gap. excerpt holds the end of the log, at most 200 lines and 20000 characters; omittedLines counts the lines left out.
  - gaps: one {check, command, code, stderr, reason} for each piece of evidence the tool could not read: a failing check whose link is not a GitHub Actions job of the repository (command is null), a gh run view that failed, or an empty log. gh pr checks exits 1 while a check fails and 8 while one is pending; with valid JSON it still returns the checks. The exit code alone never makes a gap. When gh pr checks prints no JSON, JSON of another shape (such as an unknown bucket), or an empty list, or when it is stopped, checks is empty and one gap has check null. A gap means unread evidence, never a passing check.
  - Errors: a repository or pr of another shape. A failing gh call returns a gap instead.
- post {directory, stateToken, head}: directory and stateToken come from read. head is the SHA the pull request head must be at: the round's push, or pr.headRefOid when the round pushed nothing. Write <directory>/replies.json first:
  {"version": 1, "threads": [{"id": "<thread id>", "reply": "<text or null>", "resolve": true}], "comment": {"body": "<text>", "answers": ["<review or comment id>"]}}
  comment may be null. Leave the other files in the directory alone. Reads the feedback again, then posts in file order: per thread the reply, then the resolve, and the PR comment last. A write goes to a person when its thread has fromPerson, or, for the PR comment, when it answers a review or comment from a person or answers nothing. When any write goes to a person, asks the user to confirm once; writes to bots only post without asking. Records each write in <directory>/posted.json as it succeeds, and a retry with the same directory skips recorded writes. When gh fails during a write, GitHub may still have it, so posted.json records it as uncertain. A retry reads GitHub first: an uncertain reply or PR comment counts as posted when you have a comment with the same text in that thread or on the pull request that was not there before the write; posted.json saves the IDs of the comments that were there as earlierCommentIds, and an uncertain resolve counts as posted when the thread is resolved. Any other uncertain write posts again. Returns {status: posted|declined|unchanged, posted, skipped}, each write with kind, thread, url, text, state, commentId, and earlierCommentIds. unchanged means every write was already posted.
  - Errors: a directory read did not return; a missing, malformed, or newer replies.json; a thread that is unknown, resolved, or listed twice; an entry with no reply and no resolve; a reply where viewerCanReply is false or a resolve where viewerCanResolve is false; an answers ID that is no review or comment; a stateToken that no longer matches, because a person added, edited, or deleted a comment (read again); planned writes that changed while the user answered the confirm, including writes another session posted (read again); a head that differs from the pull request head; or a write to a person with no UI. Nothing is posted in those cases. A failed write throws with posted, uncertain, and notPosted. When the error says the outcome is uncertain, retry with the same directory to reconcile it. When posted.json cannot record a posted write, the error names that write; add it to posted.json before a retry. A write where gh succeeded but printed output the tool cannot read counts as posted, with commentId null.`;

const findRoot = async (cwd: string) => {
  const output = await readGitOutput(cwd, ['rev-parse', '--show-toplevel']);
  const root = output?.trim();

  if (root === undefined || root === '') {
    throw new Error(`The pr_feedback tool needs a Git checkout, and ${cwd} is not in one.`);
  }

  return root;
};

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

  const absolute = resolve(root, directory);
  const name = relative(join(root, '.tau', feedbackPath), absolute);
  const outside = name === '' || name.startsWith('..') || isAbsolute(name);
  const nested = name.includes('/') || name.includes('\\');

  if (outside || nested) {
    throw new Error(`The directory must be .tau/${feedbackPath}/<name>, not ${directory}.`);
  }

  await checkTauDirectory(root, `${feedbackPath}/${name}`);

  return absolute;
};

const post = async (runtime: Runtime, context: ExtensionContext, parameters: PrFeedbackInput) => {
  const root = await findRoot(runtime.cwd);
  const directory = await feedbackDirectory(root, parameters.directory);

  if (parameters.stateToken === undefined) {
    throw new Error('post needs the stateToken that read returned.');
  }

  if (parameters.head === undefined) {
    throw new Error('post needs head.');
  }

  return postReplies(runtime, context, directory, {
    stateToken: parameters.stateToken,
    head: parameters.head,
  });
};

const read = async (runtime: Runtime, parameters: PrFeedbackInput) => {
  if (parameters.repository === undefined) {
    throw new Error('read needs repository.');
  }

  const repository = parseRepository(parameters.repository);
  const pr = parsePullRequestNumber('read', parameters.pr);
  const root = await findRoot(runtime.cwd);
  const feedback = await readFeedback(runtime, repository, pr);
  const directory = await createFreshTauDirectory(root, feedbackPath, `${pr}-`);

  await writePullRequestRecord(directory, { repository, pr });

  return { directory, ...feedback };
};

const checks = async (runtime: Runtime, parameters: PrFeedbackInput) => {
  if (parameters.repository === undefined) {
    throw new Error('checks needs repository.');
  }

  const repository = parseRepository(parameters.repository);
  const pr = parsePullRequestNumber('checks', parameters.pr);

  return { ...(await readChecks(runtime, repository, pr)) };
};

const runAction = (
  exec: Exec,
  context: ExtensionContext,
  parameters: PrFeedbackInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => {
  const runtime = { exec, cwd: context.cwd, signal };

  if (parameters.action === 'read') {
    return read(runtime, parameters);
  }

  return parameters.action === 'checks'
    ? checks(runtime, parameters)
    : post(runtime, context, parameters);
};

export const createPrFeedbackTool = (
  exec: Exec,
): ToolDefinition<typeof prFeedbackToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'pr_feedback',
    label: 'PR feedback',
    description,
    promptSnippet: "Read a pull request's review feedback and post replies.",
    parameters: prFeedbackToolParameters,
    defaultActive: false,
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const details = await runAction(exec, context, parameters, signal);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
