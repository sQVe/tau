import { createHash } from 'node:crypto';
import { access, constants, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Static } from 'typebox';
import { Type } from 'typebox';

import { errorMessage, hasErrorCode } from '../errors.js';
import { runGit } from '../gitOutput.js';
import { decideFreshness } from './freshness.js';
import type { CaptureState, Freshness } from './freshness.js';

export interface Gap {
  kind: 'binary' | 'unreadable' | 'excluded' | 'unmatched' | 'submodule';
  path: string;
}

export interface Capture {
  bytes: Buffer;
  hash: string;
  paths: string[];
  gaps: Gap[];
  // A capture with errors is incomplete, so its bytes and hash must not stand for the target.
  errors: string[];
}

interface Part {
  bytes: Buffer;
  paths: string[];
  gaps: Gap[];
  errors: string[];
}

type FileList =
  | { files: string[]; unreadable: string[]; error?: undefined }
  | { files?: undefined; unreadable?: undefined; error: string };

type HeadRead = { head: string; error?: undefined } | { head?: undefined; error: string };

const revisionSchema = Type.String({ minLength: 1 });

const exclude = Type.Optional(
  Type.Array(Type.String({ minLength: 1 }), {
    description: 'Paths to leave out of the capture. Each is reported as a gap.',
  }),
);

export const reviewTargetSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('workingTree'), base: revisionSchema, exclude },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('range'), from: revisionSchema, to: revisionSchema, exclude },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('rootCommit'), commit: revisionSchema, exclude },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('files'),
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      base: Type.Optional(revisionSchema),
      exclude,
    },
    { additionalProperties: false },
  ),
]);

export type ReviewTarget = Static<typeof reviewTargetSchema>;

// A SHA-1 or SHA-256 object name. Git can never read one as an option.
export const objectNameSchema = Type.String({ pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$' });

const excludeSchema = Type.Optional(Type.Array(Type.String({ minLength: 1 })));

// A target after pinTarget, keyed by kind, so a reader can name the field of a bad saved target.
export const pinnedTargetSchemas = {
  workingTree: Type.Object(
    { kind: Type.Literal('workingTree'), base: objectNameSchema, exclude: excludeSchema },
    { additionalProperties: false },
  ),
  range: Type.Object(
    {
      kind: Type.Literal('range'),
      from: objectNameSchema,
      to: objectNameSchema,
      exclude: excludeSchema,
    },
    { additionalProperties: false },
  ),
  rootCommit: Type.Object(
    { kind: Type.Literal('rootCommit'), commit: objectNameSchema, exclude: excludeSchema },
    { additionalProperties: false },
  ),
  files: Type.Object(
    {
      kind: Type.Literal('files'),
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      base: objectNameSchema,
      exclude: excludeSchema,
    },
    { additionalProperties: false },
  ),
};

export const pinnedTargetSchema = Type.Union([
  pinnedTargetSchemas.workingTree,
  pinnedTargetSchemas.range,
  pinnedTargetSchemas.rootCommit,
  pinnedTargetSchemas.files,
]);

export type PinnedTarget = Static<typeof pinnedTargetSchema>;

const emptyPart: Part = { bytes: Buffer.alloc(0), paths: [], gaps: [], errors: [] };

const describeCommand = (commandArguments: string[]) => `git ${commandArguments.join(' ')}`;

const failure = (commandArguments: string[], detail: string): Part => ({
  ...emptyPart,
  errors: [`${describeCommand(commandArguments)} failed: ${detail}`],
});

// Runs a Git command that must exit 0 and print nothing to stderr, as a capture command must.
const runCaptureCommand = async (root: string, commandArguments: string[]) => {
  try {
    const result = await runGit(root, commandArguments);

    if (result.exitCode !== 0) {
      return { error: `exit ${result.exitCode}: ${result.stderr.trim()}` };
    }

    if (result.stderr.trim() !== '') {
      return { error: result.stderr.trim() };
    }

    return { stdout: result.stdout };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

const resolveCommit = async (root: string, revision: string) => {
  if (revision.startsWith('-')) {
    throw new Error(`A revision must not start with a dash: ${revision}`);
  }

  const commandArguments = ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`];
  const { stdout } = await runCaptureCommand(root, commandArguments);
  const sha = stdout?.toString('utf8').trim();

  if (sha === undefined || sha === '') {
    throw new Error(`Git cannot resolve ${revision} to a commit.`);
  }

  return sha;
};

const rejectParent = async (root: string, commit: string) => {
  const commandArguments = ['rev-list', '--parents', '--max-count=1', '--end-of-options', commit];
  const { stdout, error } = await runCaptureCommand(root, commandArguments);

  if (stdout === undefined) {
    throw new Error(`${describeCommand(commandArguments)} failed: ${error}`);
  }

  const parents = stdout.toString('utf8').trim().split(' ').slice(1);

  if (parents.length > 0) {
    throw new Error(`${commit} has a parent. Capture it as a range from ${parents[0]}.`);
  }
};

// Replaces each revision in the target with its commit SHA, so a later capture reads the same
// commits even after a branch moves.
export const pinTarget = async (root: string, target: ReviewTarget): Promise<PinnedTarget> => {
  if (target.kind === 'workingTree') {
    return { ...target, base: await resolveCommit(root, target.base) };
  }

  if (target.kind === 'range') {
    const from = await resolveCommit(root, target.from);

    return { ...target, from, to: await resolveCommit(root, target.to) };
  }

  if (target.kind === 'rootCommit') {
    const commit = await resolveCommit(root, target.commit);

    await rejectParent(root, commit);

    return { ...target, commit };
  }

  if (target.paths.length === 0) {
    throw new Error('A files target needs at least one path.');
  }

  return { ...target, base: await resolveCommit(root, target.base ?? 'HEAD') };
};

const exclusions = (target: ReviewTarget) =>
  (target.exclude ?? []).map((path) => `:(exclude)${path}`);

// `skipped` names unreadable files to leave out, matched literally.
const pathspec = (target: ReviewTarget, skipped: string[] = []) => {
  const named = target.kind === 'files' ? target.paths : [];
  const skippedSpec = skipped.map((path) => `:(exclude,literal)${path}`);
  const spec = [...named, ...exclusions(target), ...skippedSpec];

  return spec.length === 0 ? [] : ['--', ...spec];
};

// The diff command for the target. `extra` adds options such as --numstat after the subcommand.
// diff.autoRefreshIndex=false stops git diff from rewriting cached file metadata in .git/index,
// and --no-textconv stops a cachetextconv driver from writing objects and notes refs.
const diffArguments = (target: PinnedTarget, extra: string[], skipped: string[] = []) => {
  const options = ['--no-ext-diff', '--no-textconv', '--no-color', ...extra];
  const spec = pathspec(target, skipped);

  if (target.kind === 'range') {
    return ['diff', ...options, '--end-of-options', target.from, target.to, ...spec];
  }

  if (target.kind === 'rootCommit') {
    return ['show', ...options, '--format=', '--end-of-options', target.commit, ...spec];
  }

  const diff = ['-c', 'diff.autoRefreshIndex=false', 'diff', ...options];

  return [...diff, '--end-of-options', target.base, ...spec];
};

const numstatLine = /^(-|\d+)\t(-|\d+)\t(.*)$/s;

// The counts field, then the old and new paths.
const renameFieldCount = 3;

// Reads `git diff --numstat -z`. A rename prints an empty path followed by the old and new paths.
const parseNumstat = (output: string) => {
  const fields = output.replace(/^\n+/, '').split('\0');
  const entries: { path: string; binary: boolean }[] = [];
  let index = 0;

  while (index < fields.length) {
    const field = fields[index] ?? '';

    if (field === '') {
      index += 1;

      continue;
    }

    const match = numstatLine.exec(field);

    if (match === null) {
      throw new Error(`Git printed a numstat line it should not: ${JSON.stringify(field)}`);
    }

    const binary = match[1] === '-';
    const path = match[3] ?? '';
    const renamed = path === '';
    const paths = renamed ? fields.slice(index + 1, index + renameFieldCount) : [path];

    entries.push(...paths.map((entryPath) => ({ path: entryPath, binary })));
    index += renamed ? renameFieldCount : 1;
  }

  return entries;
};

const gitLinkMode = '160000';

// Reads `git diff --raw -z`: `:<old mode> <new mode> <old> <new> <status>`, then one path, or two
// for a rename or copy. Returns the paths whose mode is a Git link on either side.
const parseGitLinks = (output: string) => {
  const fields = output.split('\0');
  const links: string[] = [];
  let index = 0;

  while (index < fields.length) {
    const header = fields[index] ?? '';

    if (!header.startsWith(':')) {
      index += 1;

      continue;
    }

    const [oldMode, newMode] = header.slice(1).split(' ');
    const status = header.split(' ').at(-1) ?? '';
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(index + 1, index + 1 + pathCount);

    if (oldMode === gitLinkMode || newMode === gitLinkMode) {
      links.push(...paths);
    }

    index += 1 + pathCount;
  }

  return links;
};

const captureDiffOnce = async (
  root: string,
  target: PinnedTarget,
  skipped: string[],
): Promise<Part> => {
  const diffCommand = diffArguments(target, [], skipped);
  const diff = await runCaptureCommand(root, diffCommand);

  if (diff.stdout === undefined) {
    return failure(diffCommand, diff.error);
  }

  const numstatCommand = diffArguments(target, ['--numstat', '-z'], skipped);
  const numstat = await runCaptureCommand(root, numstatCommand);

  if (numstat.stdout === undefined) {
    return failure(numstatCommand, numstat.error);
  }

  const rawCommand = diffArguments(target, ['--raw', '-z'], skipped);
  const raw = await runCaptureCommand(root, rawCommand);

  if (raw.stdout === undefined) {
    return failure(rawCommand, raw.error);
  }

  try {
    const entries = parseNumstat(numstat.stdout.toString('utf8'));
    const binaries = entries.filter((entry) => entry.binary);
    const gitLinks = parseGitLinks(raw.stdout.toString('utf8'));

    return {
      bytes: diff.stdout,
      paths: entries.map((entry) => entry.path),
      gaps: [
        ...binaries.map((entry) => ({ kind: 'binary' as const, path: entry.path })),
        ...gitLinks.map((path) => ({ kind: 'submodule' as const, path })),
      ],
      errors: [],
    };
  } catch (error) {
    return failure(numstatCommand, errorMessage(error));
  }
};

const isReadable = (path: string) =>
  access(path, constants.R_OK).then(
    () => true,
    () => false,
  );

// A deleted file is missing, not unreadable, so only a refused read counts.
const isRefused = (path: string) =>
  access(path, constants.R_OK).then(
    () => false,
    (error: unknown) => hasErrorCode(error, 'EACCES'),
  );

// Changed working tree files the user cannot read. A range or root commit reads no working tree.
const unreadableChangedPaths = async (root: string, target: PinnedTarget) => {
  if (target.kind === 'range' || target.kind === 'rootCommit') {
    return [];
  }

  const listed = await runCaptureCommand(root, diffArguments(target, ['--name-only', '-z']));

  const paths = (listed.stdout?.toString('utf8') ?? '').split('\0').filter((path) => path !== '');

  const refused = await Promise.all(paths.map((path) => isRefused(join(root, path))));

  return paths.filter((_, index) => refused[index] === true);
};

// Git fails the whole diff on one unreadable file, so a failed diff runs again without the files
// the user cannot read, and reports them as gaps. Any other failure stays a failure.
const captureDiff = async (root: string, target: PinnedTarget): Promise<Part> => {
  const first = await captureDiffOnce(root, target, []);

  if (first.errors.length === 0) {
    return first;
  }

  const unreadable = await unreadableChangedPaths(root, target);

  if (unreadable.length === 0) {
    return first;
  }

  const retried = await captureDiffOnce(root, target, unreadable);
  const gaps = unreadable.map((path) => ({ kind: 'unreadable' as const, path }));

  return { ...retried, gaps: [...retried.gaps, ...gaps] };
};

const isBinaryDiff = (output: Buffer) =>
  output
    .toString('utf8')
    .split('\n')
    .some((line) => line.startsWith('Binary files '));

// Shows a file in full as an added file. Exit 1 is normal: it means the file differs from empty.
const captureWholeFile = async (root: string, path: string): Promise<Part> => {
  const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-index'];
  const command = ['diff', ...options, '--', '/dev/null', path];

  try {
    const result = await runGit(root, command);
    const succeeded = result.exitCode <= 1 && result.stderr.trim() === '';

    if (succeeded) {
      const gaps = isBinaryDiff(result.stdout) ? [{ kind: 'binary' as const, path }] : [];

      return { bytes: result.stdout, paths: [path], gaps, errors: [] };
    }

    if (!(await isReadable(join(root, path)))) {
      return { ...emptyPart, gaps: [{ kind: 'unreadable', path }] };
    }

    return failure(command, `exit ${result.exitCode}: ${result.stderr.trim()}`);
  } catch (error) {
    return failure(command, errorMessage(error));
  }
};

const unopenedDirectory = /^warning: could not open directory '(.+)\/': Permission denied$/;

const runListFiles = async (root: string, commandArguments: string[]) => {
  try {
    return await runGit(root, commandArguments);
  } catch (error) {
    return { exitCode: -1, stdout: Buffer.alloc(0), stderr: errorMessage(error) };
  }
};

// Directories that `ls-files` warned it could not open and that the user cannot read. Undefined
// when stderr holds anything else, so that message stays an error.
const confirmedUnopenedDirectories = async (root: string, stderr: string) => {
  const lines = stderr.trim().split('\n');
  const directories = lines.map((line) => unopenedDirectory.exec(line)?.[1]);

  if (directories.some((directory) => directory === undefined)) {
    return undefined;
  }

  const confirmed = directories.filter((directory) => directory !== undefined);
  const refused = await Promise.all(confirmed.map((directory) => isRefused(join(root, directory))));

  return refused.every(Boolean) ? confirmed : undefined;
};

const splitFileList = (stdout: Buffer) =>
  stdout
    .toString('utf8')
    .split('\0')
    .filter((file) => file !== '');

// Git skips a directory it cannot open and warns on stderr. A warning for a directory the user
// cannot read becomes an unreadable entry, since its untracked contents are missing.
const listFiles = async (root: string, options: string[], spec: string[]): Promise<FileList> => {
  const commandArguments = ['ls-files', '-z', ...options, '--exclude-standard', ...spec];
  const result = await runListFiles(root, commandArguments);
  const clean = result.exitCode === 0 && result.stderr.trim() === '';

  if (clean) {
    return { files: splitFileList(result.stdout), unreadable: [] };
  }

  const failed = `${describeCommand(commandArguments)} failed`;

  if (result.exitCode !== 0) {
    return { error: `${failed}: exit ${result.exitCode}: ${result.stderr.trim()}` };
  }

  const unreadable = await confirmedUnopenedDirectories(root, result.stderr);

  if (unreadable === undefined) {
    return { error: `${failed}: ${result.stderr.trim()}` };
  }

  // Git still lists tracked files below a directory it cannot list, and the whole-file capture
  // checks each one, so every listed file is kept.
  return { files: splitFileList(result.stdout), unreadable };
};

// Untracked files for a working tree; every file a named pathspec lists for a files target, so
// unchanged named files appear in full.
const wholeFileList = (target: PinnedTarget, root: string): Promise<FileList> => {
  if (target.kind === 'workingTree') {
    return listFiles(root, ['-o'], pathspec(target));
  }

  if (target.kind === 'files') {
    return listFiles(root, ['-c', '-o'], pathspec(target));
  }

  return Promise.resolve({ files: [], unreadable: [] });
};

const unmatchedPaths = async (root: string, target: PinnedTarget): Promise<Part> => {
  if (target.kind !== 'files') {
    return emptyPart;
  }

  const listed = await Promise.all(
    target.paths.map((path) => listFiles(root, ['-c', '-o'], ['--', path])),
  );

  const errors = listed.flatMap((result) => (result.error === undefined ? [] : [result.error]));
  const unmatched = target.paths.filter((_, index) => listed[index]?.files?.length === 0);
  const gaps = unmatched.map((path) => ({ kind: 'unmatched' as const, path }));

  return { ...emptyPart, gaps, errors };
};

// Cached Git links, such as submodules, in a files target. `ls-files -s -z` prints
// `<mode> <object> <stage>\t<path>` for each entry.
const cachedGitLinks = async (root: string, target: PinnedTarget) => {
  if (target.kind !== 'files') {
    return { links: new Set<string>() };
  }

  const commandArguments = ['ls-files', '-z', '-s', ...pathspec(target)];
  const listed = await runCaptureCommand(root, commandArguments);

  if (listed.stdout === undefined) {
    return { error: `${describeCommand(commandArguments)} failed: ${listed.error}` };
  }

  const entries = listed.stdout.toString('utf8').split('\0');
  const links = entries.filter((entry) => entry.startsWith(`${gitLinkMode} `));

  return { links: new Set(links.map((entry) => entry.slice(entry.indexOf('\t') + 1))) };
};

// `ls-files -o` lists an untracked nested repository as its directory with a trailing slash.
const isNestedRepository = (file: string) => file.endsWith('/');

// A Git link has no file contents to show in full; its commit change stays in the diff.
const submoduleGap = (file: string): Part => {
  const path = isNestedRepository(file) ? file.slice(0, -1) : file;

  return { ...emptyPart, gaps: [{ kind: 'submodule', path }] };
};

const captureWholeFiles = async (root: string, target: PinnedTarget): Promise<Part[]> => {
  const listed = await wholeFileList(target, root);
  const gitLinks = await cachedGitLinks(root, target);

  if (listed.error !== undefined) {
    return [{ ...emptyPart, errors: [listed.error] }];
  }

  if (gitLinks.error !== undefined) {
    return [{ ...emptyPart, errors: [gitLinks.error] }];
  }

  const unreadable = listed.unreadable.map((path) => ({ kind: 'unreadable' as const, path }));
  const parts: Part[] = [{ ...emptyPart, gaps: unreadable }];

  // One Git process at a time keeps a large untracked tree from starting thousands at once.
  for (const file of listed.files) {
    if (gitLinks.links.has(file) || isNestedRepository(file)) {
      parts.push(submoduleGap(file));

      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- the files run one at a time on purpose.
    parts.push(await captureWholeFile(root, file));
  }

  return parts;
};

const hashBytes = async (root: string, bytes: Buffer) => {
  const commandArguments = ['rev-parse', '--show-object-format'];
  const { stdout, error } = await runCaptureCommand(root, commandArguments);
  const format = stdout?.toString('utf8').trim();

  if (format !== 'sha1' && format !== 'sha256') {
    return { error: `${describeCommand(commandArguments)} failed: ${error ?? format}` };
  }

  const header = Buffer.from(`blob ${bytes.length}\0`);

  return { hash: createHash(format).update(header).update(bytes).digest('hex') };
};

const excludedGaps = (target: ReviewTarget): Gap[] =>
  (target.exclude ?? []).map((path) => ({ kind: 'excluded', path }));

// A named file can show in the diff and in full, so one gap can come from both.
const uniqueGaps = (gaps: Gap[]) => [
  ...new Map(gaps.map((gap) => [`${gap.kind}\0${gap.path}`, gap])).values(),
];

// Captures the target as Git prints it. Changes no staged contents, .git/index, or Git objects.
// The hash equals `git hash-object --no-filters` of the bytes, so .gitattributes cannot change it.
export const captureTarget = async (root: string, target: PinnedTarget): Promise<Capture> => {
  const parts = [
    await captureDiff(root, target),
    ...(await captureWholeFiles(root, target)),
    await unmatchedPaths(root, target),
  ];

  const bytes = Buffer.concat(parts.map((part) => part.bytes));
  const hashed = await hashBytes(root, bytes);
  const paths = [...new Set(parts.flatMap((part) => part.paths))].toSorted();
  const gaps = uniqueGaps([...parts.flatMap((part) => part.gaps), ...excludedGaps(target)]);
  const errors = parts.flatMap((part) => part.errors);

  if (hashed.error !== undefined) {
    errors.push(hashed.error);
  }

  return { bytes, hash: hashed.hash ?? '', paths, gaps, errors };
};

export const readHead = async (root: string): Promise<HeadRead> => {
  const commandArguments = ['rev-parse', '--verify', 'HEAD'];
  const { stdout, error } = await runCaptureCommand(root, commandArguments);
  const head = stdout?.toString('utf8').trim();

  if (head === undefined || head === '') {
    return { error: `${describeCommand(commandArguments)} failed: ${error ?? 'no output'}` };
  }

  return { head };
};

// Captures the recorded target again into recheckFile and compares it, and HEAD, with the record.
// A failed recapture removes recheckFile, so no stale file stands for the current target.
export const checkFreshness = async (
  root: string,
  recorded: CaptureState & { target: PinnedTarget },
  recheckFile: string,
): Promise<Freshness> => {
  const capture = await captureTarget(root, recorded.target);
  const current = await readHead(root);

  if (current.head === undefined) {
    await rm(recheckFile, { force: true });

    const captureErrors = [...capture.errors, current.error];

    return decideFreshness({ recorded, current: undefined, captureErrors });
  }

  if (capture.errors.length > 0) {
    await rm(recheckFile, { force: true });

    return decideFreshness({ recorded, current: undefined, captureErrors: capture.errors });
  }

  await writeFile(recheckFile, capture.bytes);

  const currentState = { hash: capture.hash, head: current.head };

  return decideFreshness({ recorded, current: currentState, captureErrors: [] });
};
