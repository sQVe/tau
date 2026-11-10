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

const description = `Capture review targets and read freshness and evidence. Follow the code-review skill.
- prepare: creates a fresh ignored directory .tau/workers/review-XXXXXX. Returns {directory}.
- capture {directory, target}: appends the capture and a "## Gaps" section to directory/input.md, whose last heading must be "## Capture". Saves the original patch and input under capture/, writes capture.json last, and refuses a claimed directory. Pins every revision to its SHA. target is one of:
  - {kind: "workingTree", base}: the diff from base to the working tree, plus untracked files in full.
  - {kind: "range", from, to}: the diff between commits.
  - {kind: "rootCommit", commit}: a root commit in full.
  - {kind: "files", paths, base?}: the named paths' diff from base (default HEAD), plus each listed file in full, even unchanged.
  - {kind: "fix", review, findingPaths}: the diff since the earlier capture in review, of any target kind. A fix capture needs a complete endpoint; only workingTree and files save a snapshot.
  Each target takes exclude: paths to leave out.
  Returns {hash, head, base, empty, paths, gaps, identity, ownership}. ownership is {status: "own" | "other" | "unclear", reasons}: PR author versus viewer, otherwise commit emails versus your Git email. Failed reads return unclear. base is null for a root commit. empty means nothing was captured or written. identity is capture.json's Git blob hash. gaps lists {kind, path} with kind binary, unreadable, excluded, unmatched (a named path that lists no file), or submodule (contents not captured). A fix target also returns {fixPaths, scope, outsidePaths}: scope is "wholeTarget" when outsidePaths is not empty, else "fix".
- freshness {directory}: captures the saved target again and compares its hash and HEAD with capture.json. Returns {status, reasons}: fresh when both match, stale when either differs, unknown when the recapture fails.
- evidence {directory}: reads the freshness and evidence of the saved capture, and writes nothing. Returns {target, base, head, hash, freshness, paths, tests, markers, callers, rules, checks, gaps}. tests lists changed tests and each changed source file's sibling test. markers lists added lines that hold .skip(, .only(, .todo(, @ts-ignore, @ts-expect-error, eslint-disable, or oxlint-disable, and each deleted test file as {path, marker: "deleted test"}. They flag checks that may be weaker. callers lists lines outside the changed module that import a changed source module. rules and checks list {path, status} for each path in the "## Rules" and "## Checks" sections of input.md, with status readable, missing, or unreadable. gaps lists every capture gap, plus freshness, incompleteCapture, evidenceMismatch, truncated, missing, unreadable, binary, unsearched, and incompleteSearch gaps with their reasons. Evidence only, never a verdict.
A bad directory, revision, or capture.json, or a failed capture, throws an error that names the cause and writes nothing.`;

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
