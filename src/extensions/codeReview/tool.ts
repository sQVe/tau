import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { findCheckoutRoot } from '../../gitOutput.js';
import { readReviewEvidence } from '../../reviewCapture/evidence.js';
import { pinFixTarget, saveVerifiedSnapshot } from '../../reviewCapture/fixCapture.js';
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
- capture {directory, target}: target is one of {kind: "workingTree", base} (the diff from base to the working tree, plus each untracked file in full), {kind: "range", from, to} (the diff between two commits only), {kind: "rootCommit", commit} (a commit with no parent, in full), {kind: "files", paths, base?} (the diff of the named paths from base, HEAD by default, plus every file they list in full, unchanged ones included), or {kind: "fix", review, findingPaths} (the diff since the earlier capture in the review directory review, which must be a workingTree, files, range, or rootCommit capture made by this version; a workingTree or files capture saves a snapshot folder in its directory for this). Each takes exclude, a list of paths to leave out. Pins every revision to its SHA, then appends the capture and a "## Gaps" section to directory/input.md after its last heading, which must be "## Capture". Saves directory/capture.json with the pinned target, base, HEAD, and hash. Returns {hash, head, base, empty, paths, gaps}, and for a fix target also {fixPaths, scope, outsidePaths}: scope is "fix", or "wholeTarget" when the fix touches a path outside findingPaths, which outsidePaths lists. hash is git hash-object --no-filters of the capture. base is the base or from SHA, or null for a root commit. paths lists the captured files. gaps lists {kind, path} with kind binary, unreadable (a file or directory the user cannot read, a link to a directory, or a file in a directory that resolves outside the repository; links to directories and files outside the repository are never read), excluded, unmatched (a named path that lists no file), or submodule (a Git link or untracked nested repository; its contents are not captured, and a changed Git link shows only its commit change). empty is true when the capture holds nothing; then nothing is written.
- freshness {directory}: captures the saved target again into directory/recheck.diff and compares its hash and HEAD with capture.json. Returns {status, reasons}: fresh when both match, stale when either differs, unknown when the recapture fails. reasons says what changed or failed. A failed recapture leaves no recheck.diff.
- evidence {directory}: runs freshness, then reads the review evidence for the saved capture. It writes nothing else. Returns {target, base, head, hash, freshness, paths, tests, markers, callers, rules, checks, gaps}. target, base, head, and hash come from capture.json, and freshness is the freshness result. paths lists the files the saved target captures now. A range reads source at to, a rootCommit at commit, and workingTree and files read the working tree. tests lists {path, lines: [{line, text}]} for each changed test file and the sibling *.test file of each changed source file that exists in the source; a deleted or renamed test path is no gap, since the capture shows it. markers lists {path, line, marker, text} for each added line in the captured diff whose text holds .skip(, .only(, .todo(, @ts-ignore, @ts-expect-error, eslint-disable, or oxlint-disable, with line the new-file line number and marker the first one that matches; Markdown files (.md, .mdx, .markdown) are skipped. They show where a test or check may have been weakened and are no verdict. callers lists {module, path, line, text} for each line outside test files and outside the module that imports a changed source module by a relative path through an import or export-from that starts its statement, a "} from" that starts its line, import(), or require(), outside a trailing comment that starts with // after whitespace. rules and checks list {path, status} for each code span or link path in the "## Rules" and "## Checks" sections of input.md, with status readable, missing, or unreadable. A range or rootCommit checks rule paths inside the repository at its pinned commit; check paths and paths outside the repository are checked on the filesystem. gaps lists every capture gap, plus {kind: "freshness", status, reasons} for a stale or unknown capture, {kind: "incompleteCapture", reasons}, {kind: "evidenceMismatch", recordedHash, evidenceHash} when the capture the evidence was read from does not match capture.json, even after a fresh result, {kind: "truncatedList", list, path?, kept, total} (list is paths, tests, markers, callers, rules, or checks), {kind: "truncatedBody", path, limit, kept, total} for a body cut at its line or character limit, with kept and total in lines, {kind: "truncatedLine", path, line, kept, total} for a caller or marker line text cut at its character limit, with kept and total in characters, {kind: "missing", path, section}, {kind: "unreadable", path}, also for a working tree test path that is a symlink, is not a regular file, or sits in a directory that resolves outside the repository, which is never read, {kind: "binary", path}, and {kind: "unsearched", path, reason} for each module of a failed caller search or malformed git grep output, and for a module whose name holds a newline, and {kind: "incompleteSearch", path, reason} for a caller search that skipped paths; its callers are kept. The result holds evidence only, never a verdict.
Errors: a directory that is not .tau/workers/review-* or goes through a symlink, a revision that starts with - or that Git cannot resolve, a rootCommit with a parent, a fix review directory with no capture record, no snapshot, a version 1 record, or a fix capture, an input.md that does not end with "## Capture", a directory that already holds capture.json, any Git error during capture, and a missing, malformed, or newer capture.json for freshness and evidence, including a saved target revision that is not a full object name, named by its field. Nothing is written in those cases. The capture never changes staged contents, .git/index, or Git objects.`;

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

  const { head, error } = await readHead(root);

  if (head === undefined) {
    throw new Error(`${error} Nothing was written.`);
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

  const snapshot = hasSnapshot(pinned)
    ? await saveVerifiedSnapshot(directory, root, pinned, captured)
    : undefined;

  await appendFile(join(directory, inputFileName), Buffer.concat(appended));

  await writeCaptureRecord(directory, {
    version: 2,
    target: pinned,
    base,
    head,
    hash: captured.hash,
    ...(snapshot === undefined ? {} : { snapshot }),
  });

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
