import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { Exec, CommandRuntime } from '../../command.js';
import { readConfigLocation } from '../../config/config.js';
import { findCheckoutRoot } from '../../git.js';
import { readReviewBotStatuses } from '../../reviewBots/reviewBots.js';
import { createFreshTauDirectory } from '../../tauDirectory.js';
import { readCheckHeader } from './checkEvidence.js';
import { readChainCoverage } from './coverage.js';
import { readPublicationEvidence } from './evidence.js';
import { readReuse } from './reuse.js';
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
    Type.Literal('coverage'),
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
  chain: Type.Optional(
    Type.Array(Type.Object({ directory: Type.String(), identity: Type.String() }), {
      description: 'coverage, evidence: the saved review links, root first.',
    }),
  ),
  head: Type.Optional(Type.String({ description: 'coverage: the head revision. Default HEAD.' })),
});

export type PrInput = Static<typeof prToolParameters>;

const description = `Gather PR facts, verify the PR, and read which bots to request.

- prepare: call before saving a run's first file. Returns {directory}, a fresh Git-ignored .tau/pr/run-XXXXXX path.
- target {remote?, base?}: resolves the current branch's PR target. Returns {host, repository, head: {remote, repository, owner, branch, sha}, base: {remote, branch}, mergeBase, pr, closedPrs}. repository is <host>/<owner>/<name>. head.sha is local HEAD. pr is the open PR or null. closedPrs lists closed and merged PRs. Each has number, url, state, title, body, author, baseRefName, isDraft, headRefOid. base wins over the open PR's base, then the default branch. Pass remote if the head remote is ambiguous.
- evidence {remote?, base?, review?, chain?}: gathers target, reuse, and code_review facts; remote and base work as above. review is a .tau/workers/review-* directory. chain adds coverage. Returns {target, ownership, branch, subjects, reuse, review, markers, checks, fullCheck, gaps}. ownership is {status: "own" | "other" | "unclear", reasons}: PR author versus viewer, otherwise commit emails versus your Git email. Failed reads return unclear. subjects lists commit subjects in <mergeBase>..HEAD. markers lists added skip or suppression lines and deleted test files. Target errors become gaps.
  - checks holds the newest log per name in .tau/pr/run-*/checks/*.log: {path, matches, reasons, excerpt, truncated}. matches is true only when HEAD, Status, and Diff equal the current values. A match is not a pass; read excerpt (null for nonmatches).
  - fullCheck is the newest full_check record for this tree: {status, logPath, argv, excerpt, truncated}. status is passed, failed, missing, or malformed; all but passed are gaps. missing also means no configured command, or a record of another command.
  - gaps lists missing or unreadable evidence. Unavailable objects are null.
- checkHeader {mergeBase}: call before a check other than full_check. Returns {lines}: HEAD: <sha>, Status: <sha256>, Diff: <sha256>. Join them with newlines, ending with one.
- coverage {chain, mergeBase, head?}: reads whether chain covers mergeBase..head (default HEAD), without writes. chain is [{directory, identity}], root first; identity is capture.json's Git blob hash. Returns {status, link, reasons, links}: match, mismatch, unsupported, or unknown; link is the 1-based deciding link.
- reuse {directory, mergeBase}: compares the saved code review in directory (.tau/workers/review-*) with git diff <mergeBase> HEAD. Returns {status, reasons, recordedBase, paths: {differing, missing, extra}, reports}. status is match when reasons is empty, else mismatch. reports lists existing reviewer.md, finder.md, checker.md.
- verify {repository, pr, directory, title, base, draft}: compares the PR with the approved preview. directory holds body.md from prepare. Returns {url, matches, differences: [{field, expected, actual}]}; fields: title, body, base, draft, head.
- reviewBots {repository, pr}: reads this repository's bots from user tau.json. Returns {bots} as {login, comment, status}. status is reviewed when the bot reviewed the current head, requested when its comment came after the head commit and its first check suite, else request. Post comment for each bot with status request. Empty means request no bot.`;

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
  const location = readConfigLocation(root, options, context);

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

  if (parameters.action === 'coverage') {
    const root = await findCheckoutRoot(cwd, 'pr');

    return { ...(await readChainCoverage(root, parameters)) };
  }

  if (parameters.action === 'checkHeader') {
    const root = await findCheckoutRoot(cwd, 'pr');

    return readCheckHeader(root, parameters.mergeBase);
  }

  if (parameters.action === 'evidence') {
    const root = await findCheckoutRoot(cwd, 'pr');
    const config = { location: readConfigLocation(root, options, context), ui: context.ui };

    return { ...(await readPublicationEvidence(runtime, root, parameters, config)) };
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
