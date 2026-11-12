import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { CommandRuntime, Exec } from '../../command.js';
import { findCheckoutRoot } from '../../git.js';
import { readReviewEvidence } from '../../reviewCapture/evidence.js';
import {
  captureReviewDirectory,
  checkReviewFreshness,
  prepareReviewDirectory,
  reviewTargetSchema,
} from '../../reviewCapture/reviewCapture.js';
import type { ReviewTarget } from '../../reviewCapture/reviewCapture.js';

export const codeReviewToolParameters = Type.Object({
  action: Type.Union([
    Type.Literal('prepare'),
    Type.Literal('capture'),
    Type.Literal('freshness'),
    Type.Literal('evidence'),
  ]),
  directory: Type.Optional(
    Type.String({
      description: 'capture, freshness, and evidence: the directory that prepare returned.',
    }),
  ),
  target: Type.Optional(reviewTargetSchema),
});

export type CodeReviewInput = Static<typeof codeReviewToolParameters>;

const description = `- prepare: start capture; {directory}.
- capture: input.md must end in "## Capture". target kinds:
  workingTree: base diff plus untracked; range: from..to; rootCommit: full commit; files: paths' diff (base default HEAD) plus full files; fix: diff since review's complete snapshot (workingTree/files).
  {hash,head,base,empty,paths,gaps,identity,ownership}. base: null for roots; empty: nothing captured/written; identity: capture.json Git blob hash. ownership {status:own|other|unclear,reasons}: PR author/viewer or commit/Git emails; failed reads: unclear. gaps {kind,path}: binary|unreadable|excluded|unmatched (no file)|submodule (no contents). Fix adds {fixPaths,scope,outsidePaths}; scope: wholeTarget if outsidePaths nonempty, else fix.
- freshness: saved target {status,reasons}: fresh if hash/HEAD match, stale if different, unknown if recapture fails.
- evidence: {target,base,head,hash,freshness,paths,tests,markers,callers,rules,checks,gaps}, not a verdict. tests: changed/sibling; markers: added skips/suppressions/deleted tests; callers: outside importers. rules/checks {path,status}: input.md paths, readable|missing|unreadable. gaps: capture gaps, incomplete/mismatched/stale/truncated/unread evidence with reasons.`;

const capture = async (
  runtime: CommandRuntime,
  directory: string,
  target: ReviewTarget | undefined,
) => {
  if (target === undefined) {
    throw new Error('capture needs target.');
  }

  return captureReviewDirectory(runtime.cwd, directory, target, runtime);
};

const runAction = async (runtime: CommandRuntime, parameters: CodeReviewInput): Promise<object> => {
  const root = await findCheckoutRoot(runtime.cwd, 'code_review');

  if (parameters.action === 'prepare') {
    return { directory: await prepareReviewDirectory(root, Date.now()) };
  }

  if (parameters.directory === undefined) {
    throw new Error('capture, freshness, and evidence need the directory that prepare returned.');
  }

  if (parameters.action === 'capture') {
    return capture({ ...runtime, cwd: root }, parameters.directory, parameters.target);
  }

  if (parameters.action === 'evidence') {
    return readReviewEvidence(root, parameters.directory);
  }

  return checkReviewFreshness(root, parameters.directory);
};

export const createCodeReviewTool = (
  exec: Exec,
): ToolDefinition<typeof codeReviewToolParameters, Record<string, unknown>> =>
  defineTool({
    name: 'code_review',
    label: 'Code review',
    description,
    promptSnippet:
      'Prepare a review directory, capture the review target, check freshness, and read review evidence.',
    parameters: codeReviewToolParameters,
    // Two capture calls that ran at once could both append to one input.md.
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const runtime = { exec, cwd: context.cwd, signal };
      const details = { ...(await runAction(runtime, parameters)) };

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
