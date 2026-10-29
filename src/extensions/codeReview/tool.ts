import { join } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { findCheckoutRoot } from '../../git.js';
import { readReviewEvidence } from '../../reviewCapture/evidence.js';
import {
  captureGeneration,
  checkFreshness,
  checkReviewDirectory,
  pruneEndpointRefs,
  readCaptureRecord,
  recheckFileName,
  reviewPrefix,
  reviewTargetSchema,
  workersPath,
} from '../../reviewCapture/reviewCapture.js';
import type { ReviewTarget } from '../../reviewCapture/reviewCapture.js';
import { createFreshTauDirectory } from '../../tauDirectory.js';

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

const description = `Capture a code review target, check that it is still fresh, and read its review evidence. Call it as the code-review skill directs.
- prepare: creates a fresh ignored directory .tau/workers/review-XXXXXX. Returns {directory}.
- capture {directory, target}: appends the capture and a "## Gaps" section to directory/input.md, whose last heading must be "## Capture". Saves the original patch and input under capture/, writes capture.json last, and refuses a claimed directory. Pins every revision to its SHA. target is one of:
  - {kind: "workingTree", base}: the diff from base to the working tree, plus untracked files in full.
  - {kind: "range", from, to}: the diff between two commits only.
  - {kind: "rootCommit", commit}: a commit with no parent, in full.
  - {kind: "files", paths, base?}: the diff of the named paths from base (HEAD by default), plus each file they list in full, unchanged ones included.
  - {kind: "fix", review, findingPaths}: the diff since the earlier capture in the directory review: a workingTree, files, range, rootCommit, or fix capture. A fix capture needs a complete endpoint; only workingTree and files save a snapshot.
  Each target takes exclude: paths to leave out.
  Returns {hash, head, base, empty, paths, gaps, identity}. base is null for a root commit. empty is true when nothing was captured; then nothing is written. identity is capture.json's Git blob hash. gaps lists {kind, path} with kind binary, unreadable, excluded, unmatched (a named path that lists no file), or submodule (contents not captured). A fix target also returns {fixPaths, scope, outsidePaths}: scope is "wholeTarget" when outsidePaths is not empty, else "fix".
- freshness {directory}: captures the saved target again and compares its hash and HEAD with capture.json. Returns {status, reasons}: fresh when both match, stale when either differs, unknown when the recapture fails. reasons says what changed or failed.
- evidence {directory}: runs freshness, then reads the evidence for the saved capture. Returns {target, base, head, hash, freshness, paths, tests, markers, callers, rules, checks, gaps}. tests lists the changed test files and the sibling test file of each changed source file. markers lists added lines that hold .skip(, .only(, .todo(, @ts-ignore, @ts-expect-error, eslint-disable, or oxlint-disable. They show where a test or check may have been weakened and are no verdict. callers lists lines outside the changed module that import a changed source module. rules and checks list {path, status} for each path in the "## Rules" and "## Checks" sections of input.md, with status readable, missing, or unreadable. gaps lists every capture gap, plus freshness, incompleteCapture, evidenceMismatch, truncated, missing, unreadable, binary, unsearched, and incompleteSearch gaps with their reasons. The result holds evidence only, never a verdict.
A bad directory, revision, or capture.json, or a failed capture, throws an error that names the cause and writes nothing.`;

const capture = async (root: string, directory: string, target: ReviewTarget | undefined) => {
  if (target === undefined) {
    throw new Error('capture needs target.');
  }

  return captureGeneration(root, directory, target);
};

const freshness = async (root: string, directory: string) => {
  const record = await readCaptureRecord(directory);

  return checkFreshness(root, record, join(directory, recheckFileName));
};

const runAction = async (cwd: string, parameters: CodeReviewInput): Promise<object> => {
  const root = await findCheckoutRoot(cwd, 'code_review');

  if (parameters.action === 'prepare') {
    const directory = await createFreshTauDirectory(root, workersPath, reviewPrefix);

    await pruneEndpointRefs(root, Date.now());

    return { directory };
  }

  if (parameters.directory === undefined) {
    throw new Error('capture, freshness, and evidence need the directory that prepare returned.');
  }

  const directory = await checkReviewDirectory(root, parameters.directory);

  if (parameters.action === 'capture') {
    return capture(root, directory, parameters.target);
  }

  if (parameters.action === 'evidence') {
    return readReviewEvidence(root, directory);
  }

  return freshness(root, directory);
};

export const createCodeReviewTool = (): ToolDefinition<
  typeof codeReviewToolParameters,
  Record<string, unknown>
> =>
  defineTool({
    name: 'code_review',
    label: 'Code review',
    description,
    promptSnippet:
      'Prepare a review directory, capture the review target, check freshness, and read review evidence.',
    parameters: codeReviewToolParameters,
    // Two capture calls that ran at once could both append to one input.md.
    executionMode: 'sequential',
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      const details = { ...(await runAction(context.cwd, parameters)) };

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
