import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec, CommandRuntime } from '../../command.js';
import { findCheckoutRoot } from '../../git.js';
import { createFreshTauDirectory } from '../../tauDirectory.js';
import { readCheckHeader, readPublicationEvidence } from './evidence.js';
import { readReuse } from './reuse.js';
import { readReviewBotStatuses } from './reviewBots.js';
import { readTarget } from './target.js';
import { readVerify, runPath, runPrefix } from './verify.js';

export interface PrToolOptions {
  agentDirectory?: string;
}

type PrContext = Pick<ExtensionToolContext, 'cwd' | 'isProjectTrusted' | 'ui'>;

export const prToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal('prepare'),
    Type.Literal('target'),
    Type.Literal('evidence'),
    Type.Literal('checkHeader'),
    Type.Literal('reuse'),
    Type.Literal('verify'),
    Type.Literal('reviewBots'),
  ]),
  remote: Type.Optional(
    Type.String({ description: 'target, evidence: the Git remote to push the branch to.' }),
  ),
  base: Type.Optional(
    Type.String({
      description:
        'target, evidence: the base branch to use, even when an open pull request names another. verify: the approved base branch.',
    }),
  ),
  directory: Type.Optional(
    Type.String({
      description:
        'reuse: the .tau/workers/review-* directory of a saved review. verify: the .tau/pr/run-* directory from prepare.',
    }),
  ),
  review: Type.Optional(
    Type.String({
      description: 'evidence: the .tau/workers/review-* directory of a saved review.',
    }),
  ),
  mergeBase: Type.Optional(
    Type.String({
      description: 'reuse, checkHeader: the merge base of the branch, such as target returns.',
    }),
  ),
  repository: Type.Optional(
    Type.String({
      description: 'verify, reviewBots: the base repository as <host>/<owner>/<name>.',
    }),
  ),
  pr: Type.Optional(Type.Integer({ description: 'verify, reviewBots: the pull request number.' })),
  title: Type.Optional(Type.String({ description: 'verify: the approved title.' })),
  draft: Type.Optional(Type.Boolean({ description: 'verify: the approved draft status.' })),
});

export type PrInput = Static<typeof prToolParameters>;

const description = `Gather publication facts for a pull request, verify the published pull request, and read which review bots to request.

- prepare: call before saving the first file of a run. Returns {directory}, a fresh Git-ignored .tau/pr/run-XXXXXX path.
- target {remote?, base?}: resolves where the current branch's pull request goes. Returns {host, repository, head: {remote, repository, owner, branch, sha}, base: {remote, branch}, mergeBase, pr, closedPrs}. repository is <host>/<owner>/<name>. head.sha is the local HEAD. pr is the open pull request or null. closedPrs lists merged and closed ones, each with number, url, state, title, body, baseRefName, isDraft, headRefOid. base wins over the open pull request's base, which wins over the default branch. Fails for no unique head remote; pass remote.
- evidence {remote?, base?, review?}: gathers target, reuse, and code_review facts. remote and base work as in target. review is a .tau/workers/review-* directory. Returns {target, branch, subjects, reuse, review, markers, checks, fullCheck, gaps}. subjects lists commit subjects in <mergeBase>..HEAD. markers lists {path, line, marker, text} for added skip or suppression markers. Target errors become gaps.
  - checks holds the newest log per file name in .tau/pr/run-*/checks/*.log, each {path, matches, reasons, excerpt, truncated}. matches is true only when HEAD, Status, and Diff equal the current values. A match is not a pass: read the excerpt. A nonmatching excerpt is null.
  - fullCheck is the saved full_check record for this tree and the merge base: {status, logPath, argv, excerpt, truncated}. status is passed, failed, missing, or malformed; all but passed are gaps.
  - gaps lists what is missing or unreadable. Unavailable objects are null.
- checkHeader {mergeBase}: call before a check other than full_check. Returns {lines}: HEAD: <sha>, Status: <sha256>, Diff: <sha256>. Join them with newlines and a final newline.
- reuse {directory, mergeBase}: compares the saved code review in directory (.tau/workers/review-*) with git diff <mergeBase> HEAD. Returns {status, reasons, recordedBase, paths: {differing, missing, extra}, reports}. status is match when reasons is empty, else mismatch. reports lists the existing reviewer.md, finder.md, and checker.md.
- verify {repository, pr, directory, title, base, draft}: compares the pull request with the approved preview. directory is the prepare directory holding body.md. Returns {url, matches, differences}. Each difference is {field, expected, actual}; fields: title, body, base, draft, head.
- reviewBots {repository, pr}: reads the bots configured in the user tau.json for the repository. Returns {bots} as {login, comment, status}. status is reviewed when the bot reviewed the current head, requested when its comment came after the head commit and its first check suite, else request. Post comment for each bot with status request. An empty list means request no bot.`;

const prepare = async (runtime: CommandRuntime) => {
  const root = await findCheckoutRoot(runtime.cwd, 'pr');

  return { directory: await createFreshTauDirectory(root, runPath, runPrefix) };
};

const reuse = async (runtime: CommandRuntime, parameters: PrInput) => {
  const root = await findCheckoutRoot(runtime.cwd, 'pr');

  const { directory, mergeBase } = parameters;
  const result = await readReuse(root, { directory, mergeBase });

  return { ...result };
};

const verify = async (runtime: CommandRuntime, parameters: PrInput) => {
  const root = await findCheckoutRoot(runtime.cwd, 'pr');

  const result = await readVerify(runtime, root, parameters);

  return { ...result };
};

const reviewBots = async (
  runtime: CommandRuntime,
  options: PrToolOptions,
  parameters: PrInput,
  context: PrContext,
) => {
  const root = await findCheckoutRoot(runtime.cwd, 'pr');

  const location = {
    cwd: root,
    agentDirectory: options.agentDirectory ?? getAgentDir(),
    projectTrusted: context.isProjectTrusted(),
  };

  return { ...(await readReviewBotStatuses(runtime, location, context.ui, parameters)) };
};

const runAction = async (
  exec: Exec,
  options: PrToolOptions,
  parameters: PrInput,
  signal: AbortSignal | undefined,
  context: PrContext,
): Promise<Record<string, unknown>> => {
  const { cwd } = context;
  const runtime = { exec, cwd, signal };

  if (parameters.action === 'prepare') {
    return prepare(runtime);
  }

  if (parameters.action === 'reuse') {
    return reuse(runtime, parameters);
  }

  if (parameters.action === 'verify') {
    return verify(runtime, parameters);
  }

  if (parameters.action === 'reviewBots') {
    return reviewBots(runtime, options, parameters, context);
  }

  if (parameters.action === 'checkHeader') {
    const root = await findCheckoutRoot(cwd, 'pr');

    return readCheckHeader(root, parameters.mergeBase);
  }

  if (parameters.action === 'evidence') {
    const root = await findCheckoutRoot(cwd, 'pr');

    return { ...(await readPublicationEvidence(runtime, root, parameters)) };
  }

  return { ...(await readTarget(runtime, { remote: parameters.remote, base: parameters.base })) };
};

export const createPrTool = (
  exec: Exec,
  options: PrToolOptions = {},
): ToolDefinition<typeof prToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'pr',
    label: 'PR',
    description,
    promptSnippet:
      'Gather PR publication evidence, prepare a pull request run, resolve its target, check review reuse, verify the published pull request, and read which review bots to request.',
    parameters: prToolParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const details = await runAction(exec, options, parameters, signal, context);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
