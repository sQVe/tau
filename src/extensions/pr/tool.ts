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
  remote: Type.Optional(Type.String({ description: 'target/evidence: push remote.' })),
  base: Type.Optional(
    Type.String({
      description: 'target/evidence: override base. verify: approved base.',
    }),
  ),
  directory: Type.Optional(
    Type.String({
      description: "reuse: review directory. verify: prepare's directory.",
    }),
  ),
  review: Type.Optional(
    Type.String({
      description: "evidence: candidate chain's last directory.",
    }),
  ),
  mergeBase: Type.Optional(
    Type.String({
      description: "reuse/checkHeader: target's mergeBase.",
    }),
  ),
  repository: Type.Optional(
    Type.String({
      description: 'verify/reviewBots: <host>/<owner>/<name>.',
    }),
  ),
  pr: Type.Optional(Type.Integer({ description: 'verify/reviewBots: PR number.' })),
  title: Type.Optional(Type.String({ description: 'verify: approved title.' })),
  draft: Type.Optional(Type.Boolean({ description: 'verify: approved draft status.' })),
  chain: Type.Optional(
    Type.Array(Type.Object({ directory: Type.String(), identity: Type.String() }), {
      description: 'coverage: review links.',
    }),
  ),
  head: Type.Optional(Type.String({ description: 'coverage: revision; default HEAD.' })),
});

export type PrInput = Static<typeof prToolParameters>;

const description = `- prepare: start a run; returns {directory}.
- target {remote?,base?}: resolve {host,repository,head:{remote,repository,owner,branch,sha},base:{remote,branch},mergeBase,pr,closedPrs}. sha: local HEAD; pr: open or null; closedPrs: closed/merged {number,url,state,title,body,author,baseRefName,isDraft,headRefOid}. Base: explicit, PR, then default.
- evidence {remote?,base?,review?}: {target,ownership,branch,subjects,chain,coverage,reuse,review,markers,checks,fullCheck,gaps}. chain: root-first or null; ambiguousChain: directory-list candidates. reuse/review use root, else input review. ownership {status:own|other|unclear,reasons}: PR author/viewer or commit/Git emails; failed reads: unclear. review.reusable: matching bytes, fresh complete capture, reports; reusableReasons: refusal. subjects: since mergeBase; markers: skips/suppressions/deleted tests. Null objects/gaps: unavailable evidence.
  checks: newest per name {path,matches,reasons,excerpt,truncated}; matches: HEAD/Status/Diff, not pass; unmatched excerpt: null. fullCheck: newest for tree {status,logPath,argv,excerpt,truncated}; passed|failed|missing|malformed; missing includes absent/different command.
- checkHeader {mergeBase}: before non-full_check checks; {lines}: join with newlines, including final newline.
- coverage {chain,mergeBase,head?}: mergeBase..head coverage. chain: [{directory,identity}], root-first; identity: capture.json Git blob hash. {status,link,reasons,links}: match|mismatch|unsupported|unknown; link: 1-based. Match closes no finding.
- reuse: review versus mergeBase..HEAD; {status:match|mismatch,reasons,recordedBase,paths:{differing,missing,extra},reports}.
- verify: published PR versus approval; directory holds body.md. {url,matches,differences:[{field,expected,actual}]} for title/body/base/draft/head.
- reviewBots: configured {bots:[{login,comment,status}]}; reviewed: current head; requested: comment after head and first check suite; request: needs comment. Empty: no bots.`;

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
