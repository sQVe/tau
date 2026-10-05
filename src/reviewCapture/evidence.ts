import { access, constants, lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.js';
import { runGit } from '../gitOutput.js';
import {
  boundList,
  callerText,
  defaultEvidenceLimits,
  freshnessGaps,
  importPattern,
  importsModule,
  isCaller,
  isSourcePath,
  namedPaths,
  numberedBody,
  parseGrepOutput,
  sourceRevision,
  testPaths,
} from './evidenceDecisions.js';
import type {
  EvidenceGap,
  EvidenceLimits,
  NamedSection,
  NumberedLine,
} from './evidenceDecisions.js';
import type { Freshness } from './freshness.js';
import { inputFileName, readCaptureRecord, recheckFileName } from './record.js';
import { captureTarget, checkFreshness } from './reviewCapture.js';
import type { PinnedTarget } from './reviewCapture.js';

interface FileBody {
  path: string;
  lines: NumberedLine[];
}

interface CallerLine {
  module: string;
  path: string;
  line: number;
  text: string;
}

interface NamedPath {
  path: string;
  status: 'readable' | 'missing' | 'unreadable';
}

// The evidence for one saved capture. It holds facts and gaps only, never a review judgment.
export interface ReviewEvidence {
  target: PinnedTarget;
  base: string | null;
  head: string;
  hash: string;
  freshness: Freshness;
  paths: string[];
  tests: FileBody[];
  callers: CallerLine[];
  rules: NamedPath[];
  checks: NamedPath[];
  gaps: EvidenceGap[];
}

interface Collected<T> {
  items: T[];
  gaps: EvidenceGap[];
}

interface NamedPaths {
  rules: Collected<NamedPath>;
  checks: Collected<NamedPath>;
  gaps: EvidenceGap[];
}

type FileRead =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'unreadable' | 'binary' };

const isBinary = (bytes: Buffer) => bytes.includes(0);

const textRead = (bytes: Buffer): FileRead =>
  isBinary(bytes) ? { kind: 'binary' } : { kind: 'text', text: bytes.toString('utf8') };

// A link can point outside the checkout, and a FIFO would block the read, so only a regular file
// is read, and the read refuses a link put in its place after the check.
const readWorkingFile = async (root: string, path: string): Promise<FileRead> => {
  const file = join(root, path);

  try {
    const entry = await lstat(file);

    if (!entry.isFile()) {
      return { kind: 'unreadable' };
    }

    return textRead(await readFile(file, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }));
  } catch (error) {
    return isMissingFile(error) ? { kind: 'absent' } : { kind: 'unreadable' };
  }
};

const existsInCommit = async (root: string, revision: string, path: string) => {
  const result = await runGit(root, ['cat-file', '-e', `${revision}:${path}`]);

  return result.exitCode === 0;
};

const readCommitFile = async (root: string, revision: string, path: string): Promise<FileRead> => {
  const object = `${revision}:${path}`;

  if (!(await existsInCommit(root, revision, path))) {
    return { kind: 'absent' };
  }

  const blob = await runGit(root, ['cat-file', 'blob', object]);

  return blob.exitCode === 0 ? textRead(blob.stdout) : { kind: 'unreadable' };
};

// A commit target reads the commit it pinned; only a working tree target reads the checkout.
const readSourceFile = (root: string, revision: string | undefined, path: string) =>
  revision === undefined ? readWorkingFile(root, path) : readCommitFile(root, revision, path);

const readTestBody = async (
  root: string,
  revision: string | undefined,
  { path, changed }: { path: string; changed: boolean },
  limits: EvidenceLimits,
): Promise<Collected<FileBody>> => {
  const read = await readSourceFile(root, revision, path);

  if (read.kind === 'text') {
    const bodyLimits = { lines: limits.bodyLines, characters: limits.bodyCharacters };
    const { lines, gaps } = numberedBody(path, read.text, bodyLimits);

    return { items: [{ path, lines }], gaps };
  }

  // A sibling test that does not exist is not evidence the capture lacks.
  if (read.kind === 'absent') {
    return { items: [], gaps: changed ? [{ kind: 'absent', path }] : [] };
  }

  return { items: [], gaps: [{ kind: read.kind, path }] };
};

const readTests = async (
  root: string,
  revision: string | undefined,
  paths: readonly string[],
  limits: EvidenceLimits,
): Promise<Collected<FileBody>> => {
  const { changed, siblings } = testPaths(paths);

  const candidates = [
    ...changed.map((path) => ({ path, changed: true })),
    ...siblings.map((path) => ({ path, changed: false })),
  ];

  const results: Collected<FileBody>[] = [];

  for (const candidate of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- one Git process at a time.
    results.push(await readTestBody(root, revision, candidate, limits));
  }

  const found = boundList(
    results.flatMap((result) => result.items),
    limits.testFiles,
    { list: 'tests' },
  );

  return { items: found.items, gaps: [...results.flatMap((result) => result.gaps), ...found.gaps] };
};

const scriptPathspecs = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'];

// -a searches a script that holds a NUL byte as text; Git would otherwise skip it as binary.
const grepModule = async (root: string, revision: string | undefined, module: string) => {
  const options = ['grep', '--no-color', '-n', '-z', '-a', '-E', '-e', importPattern(module)];
  const scope = revision === undefined ? ['--untracked'] : [revision];
  const result = await runGit(root, [...options, ...scope, '--', ...scriptPathspecs]);

  // git grep exits 1 when nothing matches.
  if (result.exitCode > 1) {
    return { error: result.stderr.trim() || `git grep exited ${result.exitCode}` };
  }

  // git grep exits 0 or 1 after it skips a path it cannot read, and says so on stderr.
  return { ...parseGrepOutput(result.stdout.toString('utf8'), revision), warning: result.stderr };
};

const searchGaps = (module: string, warning: string): EvidenceGap[] =>
  warning.trim() === '' ? [] : [{ kind: 'incompleteSearch', path: module, reason: warning.trim() }];

const findModuleCallers = async (
  root: string,
  revision: string | undefined,
  module: string,
  limits: EvidenceLimits,
): Promise<Collected<CallerLine>> => {
  const found = await grepModule(root, revision, module).catch((error: unknown) => ({
    error: errorMessage(error),
    warning: '',
  }));

  if (found.error !== undefined) {
    return { items: [], gaps: [{ kind: 'unsearched', path: module, reason: found.error }] };
  }

  const callers = found.matches
    .filter((match) => isCaller(match.path, module))
    .filter((match) => importsModule(match.path, match.text, module));

  const bounded = boundList(callers, limits.callersPerModule, { list: 'callers', path: module });

  const cut = bounded.items.map((match) => ({
    match,
    ...callerText(match, limits.callerLineCharacters),
  }));

  return {
    items: cut.map(({ match: { path, line }, text }) => ({ module, path, line, text })),
    gaps: [
      ...searchGaps(module, found.warning),
      ...cut.flatMap((caller) => caller.gaps),
      ...bounded.gaps,
    ],
  };
};

const findCallers = async (
  root: string,
  revision: string | undefined,
  paths: readonly string[],
  limits: EvidenceLimits,
): Promise<Collected<CallerLine>> => {
  const results: Collected<CallerLine>[] = [];

  for (const module of paths.filter((path) => isSourcePath(path))) {
    // oxlint-disable-next-line no-await-in-loop -- one Git process at a time.
    results.push(await findModuleCallers(root, revision, module, limits));
  }

  const found = boundList(
    results.flatMap((result) => result.items),
    limits.callers,
    { list: 'callers' },
  );

  return { items: found.items, gaps: [...results.flatMap((result) => result.gaps), ...found.gaps] };
};

const repositoryPath = (root: string, path: string) => {
  const fromRoot = relative(root, resolve(root, path));
  const outside = fromRoot.startsWith('..') || isAbsolute(fromRoot);

  return outside || fromRoot === '' ? undefined : fromRoot;
};

const filesystemStatus = async (root: string, path: string): Promise<NamedPath['status']> => {
  try {
    await access(resolve(root, path), constants.R_OK);

    return 'readable';
  } catch (error) {
    return isMissingFile(error) ? 'missing' : 'unreadable';
  }
};

// A commit target's rules are the files at its pinned commit. Check results and paths outside the
// repository are saved artifacts, so they are read from the filesystem.
const namedPathStatus = async (
  root: string,
  revision: string | undefined,
  path: string,
): Promise<NamedPath['status']> => {
  const inRepository = revision === undefined ? undefined : repositoryPath(root, path);

  if (revision === undefined || inRepository === undefined) {
    return filesystemStatus(root, path);
  }

  return (await existsInCommit(root, revision, inRepository)) ? 'readable' : 'missing';
};

const namedPathGap = (path: NamedPath, section: NamedSection): EvidenceGap[] => {
  if (path.status === 'missing') {
    return [{ kind: 'missing', path: path.path, section }];
  }

  return path.status === 'unreadable' ? [{ kind: 'unreadable', path: path.path }] : [];
};

const checkNamedPaths = async (
  root: string,
  revision: string | undefined,
  paths: readonly string[],
  section: NamedSection,
  limits: EvidenceLimits,
): Promise<Collected<NamedPath>> => {
  const bounded = boundList(paths, limits.namedPaths, { list: section });

  const items = await Promise.all(
    bounded.items.map(async (path) => ({
      path,
      status: await namedPathStatus(root, revision, path),
    })),
  );

  return {
    items,
    gaps: [...items.flatMap((item) => namedPathGap(item, section)), ...bounded.gaps],
  };
};

const readNamedPaths = async (
  root: string,
  revision: string | undefined,
  directory: string,
  limits: EvidenceLimits,
): Promise<NamedPaths> => {
  const inputPath = join(directory, inputFileName);
  let input: string;

  try {
    input = await readFile(inputPath, 'utf8');
  } catch {
    const none: Collected<NamedPath> = { items: [], gaps: [] };

    return { rules: none, checks: none, gaps: [{ kind: 'unreadable', path: inputPath }] };
  }

  const named = namedPaths(input);
  const rules = await checkNamedPaths(root, revision, named.rules, 'rules', limits);
  const checks = await checkNamedPaths(root, undefined, named.checks, 'checks', limits);

  return { rules, checks, gaps: [] };
};

// Reads the evidence for the capture saved in directory. Writes only the freshness recapture.
export const readReviewEvidence = async (
  root: string,
  directory: string,
  limits = defaultEvidenceLimits,
): Promise<ReviewEvidence> => {
  const record = await readCaptureRecord(directory);
  const freshness = await checkFreshness(root, record, join(directory, recheckFileName));
  const captured = await captureTarget(root, record.target);
  const paths = boundList(captured.paths, limits.paths, { list: 'paths' });
  const revision = sourceRevision(record.target);
  const tests = await readTests(root, revision, paths.items, limits);
  const callers = await findCallers(root, revision, paths.items, limits);
  const named = await readNamedPaths(root, revision, directory, limits);

  const captureErrors: EvidenceGap[] =
    captured.errors.length > 0 ? [{ kind: 'incompleteCapture', reasons: captured.errors }] : [];

  const gaps = [
    ...freshnessGaps({ freshness, recordedHash: record.hash, evidenceHash: captured.hash }),
    ...captureErrors,
    ...captured.gaps,
    ...paths.gaps,
    ...tests.gaps,
    ...callers.gaps,
    ...named.gaps,
    ...named.rules.gaps,
    ...named.checks.gaps,
  ];

  return {
    target: record.target,
    base: record.base,
    head: record.head,
    hash: record.hash,
    freshness,
    paths: paths.items,
    tests: tests.items,
    callers: callers.items,
    rules: named.rules.items,
    checks: named.checks.items,
    gaps,
  };
};
