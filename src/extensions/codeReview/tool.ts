import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { findCheckoutRoot } from '../../gitOutput.js';
import { readReviewEvidence } from '../../reviewCapture/evidence.js';
import {
  pinFixTarget,
  saveVerifiedSnapshot,
  snapshotFolder,
} from '../../reviewCapture/fixCapture.js';
import { decideFixScope } from '../../reviewCapture/fixScope.js';
import { captureReview, checkFreshness } from '../../reviewCapture/pinnedCapture.js';
import {
  inputFileName,
  readCaptureRecord,
  recheckFileName,
  recordFileName,
  writeCaptureRecord,
} from '../../reviewCapture/record.js';
import { pinTarget, readHead, reviewTargetSchema } from '../../reviewCapture/reviewCapture.js';
import type { Gap, PinnedTarget, ReviewTarget } from '../../reviewCapture/reviewCapture.js';
import {
  checkReviewDirectory,
  existingEntry,
  reviewPrefix,
  workersPath,
} from '../../reviewCapture/reviewDirectory.js';
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

const captureHeading = '## Capture';

const description = `Capture a code review target, check that it is still fresh, and read its review evidence. Call it as the code-review skill directs.
- prepare: creates a fresh ignored directory .tau/workers/review-XXXXXX. Returns {directory}.
- capture {directory, target}: appends the capture and a "## Gaps" section to directory/input.md, whose last heading must be "## Capture", and saves directory/capture.json. Every revision is pinned to its SHA. target is one of:
  - {kind: "workingTree", base}: the diff from base to the working tree, plus each untracked file in full.
  - {kind: "range", from, to}: the diff between two commits only.
  - {kind: "rootCommit", commit}: a commit with no parent, in full.
  - {kind: "files", paths, base?}: the diff of the named paths from base (HEAD by default), plus every file they list in full, unchanged ones included.
  - {kind: "fix", review, findingPaths}: the diff since the earlier capture in the review directory review. That capture must be a workingTree, files, range, or rootCommit capture; a workingTree or files capture saves a snapshot for this, and an older capture has none.
  Each target takes exclude, a list of paths to leave out.
  Returns {hash, head, base, empty, paths, gaps}. base is null for a root commit. empty is true when nothing was captured; then nothing is written. gaps lists {kind, path} with kind binary, unreadable, excluded, unmatched (a named path that lists no file), or submodule (contents not captured). A fix target also returns {fixPaths, scope, outsidePaths}: scope is "fix", or "wholeTarget" when the fix touches paths outside findingPaths, which outsidePaths lists.
- freshness {directory}: captures the saved target again and compares its hash and HEAD with capture.json. Returns {status, reasons}: fresh when both match, stale when either differs, unknown when the recapture fails. reasons says what changed or failed.
- evidence {directory}: runs freshness, then reads the evidence for the saved capture. Returns {target, base, head, hash, freshness, paths, tests, markers, callers, rules, checks, gaps}. tests lists the changed test files and the sibling test file of each changed source file. markers lists added lines that hold .skip(, .only(, .todo(, @ts-ignore, @ts-expect-error, eslint-disable, or oxlint-disable. They show where a test or check may have been weakened and are no verdict. callers lists lines outside the changed module that import a changed source module. rules and checks list {path, status} for each path in the "## Rules" and "## Checks" sections of input.md, with status readable, missing, or unreadable. gaps lists every capture gap, plus freshness, incompleteCapture, evidenceMismatch, truncated, missing, unreadable, binary, unsearched, and incompleteSearch gaps with their reasons. The result holds evidence only, never a verdict.
A bad directory, a bad revision, a missing or malformed capture.json, or a failed capture throws an error that names the cause. Nothing is written then.`;

const lastHeading = (text: string) =>
  text
    .split('\n')
    .findLast((line) => line.startsWith('#'))
    ?.trim();

const readInput = async (directory: string) => {
  const path = join(directory, inputFileName);
  const text = await readFile(path, 'utf8');

  if (lastHeading(text) !== captureHeading) {
    throw new Error(`${path} must end with a "${captureHeading}" heading. Nothing was written.`);
  }

  return text;
};

const rejectSavedCapture = async (directory: string) => {
  const path = join(directory, recordFileName);

  if ((await existingEntry(path)) !== undefined) {
    throw new Error(`${path} already holds a capture. Run prepare for a new review.`);
  }
};

const gapLabels: Record<Gap['kind'], string> = {
  binary: 'binary file, not shown',
  unreadable: 'unreadable file or directory, not shown',
  excluded: 'excluded from the review',
  unmatched: 'named path that lists no file',
  submodule: 'submodule or nested repository, contents not shown',
};

// JSON keeps a path with a newline on one line, and an escaped backtick cannot end the code span.
const quotePath = (path: string) => JSON.stringify(path).replaceAll('`', String.raw`\u0060`);

const gapsSection = (gaps: Gap[]) => {
  const lines = gaps.map((gap) => `- \`${quotePath(gap.path)}\`: ${gapLabels[gap.kind]}`);
  const body = lines.length === 0 ? 'None.' : lines.join('\n');

  return `\n## Gaps\n\n${body}\n`;
};

const newline = Buffer.from('\n');

const withFinalNewline = (bytes: Buffer) =>
  bytes.subarray(-1).equals(newline) ? bytes : Buffer.concat([bytes, newline]);

const baseOf = (target: PinnedTarget) => {
  if (target.kind === 'range') {
    return target.from;
  }

  if (target.kind === 'rootCommit') {
    return null;
  }

  return target.base;
};

const pin = (root: string, target: ReviewTarget) =>
  target.kind === 'fix' ? pinFixTarget(root, target) : pinTarget(root, target);

const hasSnapshot = (
  target: PinnedTarget,
): target is Extract<PinnedTarget, { kind: 'workingTree' | 'files' }> =>
  target.kind === 'workingTree' || target.kind === 'files';

const fixSummary = (target: PinnedTarget, paths: string[]) => {
  if (target.kind !== 'fix') {
    return {};
  }

  const { scope, outsidePaths } = decideFixScope({
    fixPaths: paths,
    findingPaths: target.findingPaths,
  });

  return { fixPaths: paths, scope, outsidePaths };
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Removes the snapshot folder only when this capture saved it. Each cleanup runs even when the other
// fails. Returns one line per failed cleanup, so the caller can report them next to the capture error.
const rollback = async (
  inputPath: string,
  originalInput: Buffer,
  snapshotParent: string | undefined,
): Promise<string[]> => {
  const removeSnapshot =
    snapshotParent === undefined
      ? Promise.resolve()
      : rm(join(snapshotParent, snapshotFolder), { recursive: true, force: true });

  const [snapshotResult, inputResult] = await Promise.allSettled([
    removeSnapshot,
    writeFile(inputPath, originalInput),
  ]);

  const failed: string[] = [];

  if (inputResult.status === 'rejected') {
    failed.push(`restoring input.md: ${messageOf(inputResult.reason)}`);
  }

  if (snapshotResult.status === 'rejected') {
    failed.push(`removing the snapshot: ${messageOf(snapshotResult.reason)}`);
  }

  return failed;
};

const rollbackError = (error: unknown, failedCleanups: string[]) =>
  new Error(
    `${messageOf(error)}\nThe rollback also failed (${failedCleanups.join('; ')}). The review directory may be half-written. Prepare a new review.`,
    { cause: error },
  );

const capture = async (root: string, directory: string, target: ReviewTarget | undefined) => {
  if (target === undefined) {
    throw new Error('capture needs target.');
  }

  await rejectSavedCapture(directory);

  const input = await readInput(directory);
  const pinned = await pin(root, target);
  const captured = await captureReview(root, pinned);

  if (captured.errors.length > 0) {
    throw new Error(`The capture failed. Nothing was written.\n- ${captured.errors.join('\n- ')}`);
  }

  const { head, error: headError } = await readHead(root);

  if (head === undefined) {
    throw new Error(`${headError} Nothing was written.`);
  }

  const base = baseOf(pinned);

  const summary = {
    hash: captured.hash,
    head,
    base,
    paths: captured.paths,
    gaps: captured.gaps,
    ...fixSummary(pinned, captured.changed ?? captured.paths),
  };

  if (captured.bytes.length === 0) {
    return { ...summary, empty: true };
  }

  const separator = input.endsWith('\n') ? '\n' : '\n\n';

  const appended = [
    Buffer.from(separator),
    withFinalNewline(captured.bytes),
    Buffer.from(gapsSection(captured.gaps)),
  ];

  const inputPath = join(directory, inputFileName);
  const originalInput = await readFile(inputPath);

  const snapshot = hasSnapshot(pinned)
    ? await saveVerifiedSnapshot(directory, root, pinned, captured)
    : undefined;

  try {
    await appendFile(inputPath, Buffer.concat(appended));

    await writeCaptureRecord(directory, {
      version: 2,
      target: pinned,
      base,
      head,
      hash: captured.hash,
      ...(snapshot === undefined ? {} : { snapshot }),
    });
  } catch (error) {
    const snapshotParent = snapshot === undefined ? undefined : directory;

    const failedCleanups = await rollback(inputPath, originalInput, snapshotParent);

    if (failedCleanups.length > 0) {
      throw rollbackError(error, failedCleanups);
    }

    throw error;
  }

  return { ...summary, empty: false };
};

const freshness = async (root: string, directory: string) => {
  const record = await readCaptureRecord(directory);

  return checkFreshness(root, record, join(directory, recheckFileName));
};

const runAction = async (cwd: string, parameters: CodeReviewInput): Promise<object> => {
  const root = await findCheckoutRoot(cwd, 'code_review');

  if (parameters.action === 'prepare') {
    return { directory: await createFreshTauDirectory(root, workersPath, reviewPrefix) };
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
