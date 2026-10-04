import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec } from '../../exec.js';
import { readGitOutput } from '../../gitOutput.js';
import { createFreshTauDirectory } from '../../tauDirectory.js';
import { parseRepository } from './github.js';
import type { Runtime } from './github.js';
import { readFeedback } from './read.js';

export const prFeedbackToolParameters = Type.Object({
  action: Type.Union([Type.Literal('read')]),
  repository: Type.Optional(
    Type.String({ description: 'read: <host>/<owner>/<name>, such as github.com/sQVe/tau.' }),
  ),
  pr: Type.Optional(Type.Integer({ minimum: 1, description: 'read: the pull request number.' })),
});

export type PrFeedbackInput = Static<typeof prFeedbackToolParameters>;

const description = `Read a pull request's review feedback on GitHub. Call it as the pr-feedback skill directs.
- read {repository, pr}: repository is <host>/<owner>/<name>, such as github.com/sQVe/tau. Reads the viewer, the pull request, its review threads, reviews, and conversation comments with gh, and creates a fresh ignored directory .tau/pr-feedback/<pr>-XXXXXX for this round. Returns {directory, viewer, pr {number, url, author, headRefOid}, threads, reviews, comments, stateToken}.
  - threads: unresolved threads only, each {id, path, line, isOutdated, viewerCanReply, viewerCanResolve, replyTo (the first comment's ID, to reply to), fromPerson (any comment not by a bot), startedByViewer, comments [{id, author, isBot, body, url, createdAt, updatedAt}]}.
  - reviews: review summaries with a body, each {id, author, isBot, state, body, url}.
  - comments: conversation comments, each {id, author, isBot, body, url}.
  - isBot is true only when GitHub marks the author as a bot. author is null for a deleted account, which counts as a person.
  - stateToken changes when a person other than the viewer adds, edits, or deletes a comment, in any thread, review, or conversation comment. Bot comments, the viewer's comments, and resolving a thread do not change it.
Errors: a repository or pr of another shape, a failing gh call, gh output that is not JSON or misses a field, a pull request that is not OPEN, or a thread too long to read in full. Nothing is created in those cases.`;

const findRoot = async (cwd: string) => {
  const output = await readGitOutput(cwd, ['rev-parse', '--show-toplevel']);
  const root = output?.trim();

  if (root === undefined || root === '') {
    throw new Error(`The pr_feedback tool needs a Git checkout, and ${cwd} is not in one.`);
  }

  return root;
};

const parsePullRequestNumber = (pr: number | undefined) => {
  if (pr === undefined) {
    throw new Error('read needs pr.');
  }

  if (!Number.isSafeInteger(pr) || pr < 1) {
    throw new Error(`pr must be a pull request number, not ${pr}.`);
  }

  return pr;
};

const read = async (runtime: Runtime, parameters: PrFeedbackInput) => {
  if (parameters.repository === undefined) {
    throw new Error('read needs repository.');
  }

  const repository = parseRepository(parameters.repository);
  const pr = parsePullRequestNumber(parameters.pr);
  const root = await findRoot(runtime.cwd);
  const feedback = await readFeedback(runtime, repository, pr);
  const directory = await createFreshTauDirectory(root, 'pr-feedback', `${pr}-`);

  return { directory, ...feedback };
};

const runAction = (
  exec: Exec,
  context: ExtensionContext,
  parameters: PrFeedbackInput,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> => read({ exec, cwd: context.cwd, signal }, parameters);

export const createPrFeedbackTool = (
  exec: Exec,
): ToolDefinition<typeof prFeedbackToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'pr_feedback',
    label: 'PR feedback',
    description,
    promptSnippet: "Read a pull request's review feedback.",
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
