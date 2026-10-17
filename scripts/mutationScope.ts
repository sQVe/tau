export type GlobMatcher = (path: string, glob: string) => boolean;

export interface Command {
  mode: 'changed' | 'audit';
  base?: string;
  paths: string[];
  maxMutants: number;
  configPath?: string;
}

export interface MergedConfig {
  mutate: string[];
  reporters: string[];
  jsonReporter: { fileName: string };
  thresholds: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LineRange {
  start: number;
  end: number;
}

// Undefined ranges mean every line of the file.
export interface FileScope {
  path: string;
  ranges?: LineRange[];
}

const hunkPattern = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// A file is production code when a positive glob matches it and no `!` glob does.
export const isProductionFile = (
  path: string,
  mutateGlobs: string[],
  matches: GlobMatcher,
): boolean => {
  const negated = mutateGlobs.filter((glob) => glob.startsWith('!'));
  const positive = mutateGlobs.filter((glob) => !glob.startsWith('!'));
  const excluded = negated.some((glob) => matches(path, glob.slice(1)));

  return !excluded && positive.some((glob) => matches(path, glob));
};

const octalLength = 3;

const escapes: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '"': 34,
  '\\': 92,
};

const encoder = new TextEncoder();

// Decodes the body of a path that Git C-quotes into bytes, then reads the bytes as UTF-8 once.
const decodeQuoted = (body: string) => {
  const bytes: number[] = [];

  for (let index = 0; index < body.length; index += 1) {
    const literal = /^[^\\]+/.exec(body.slice(index));
    const octal = /^[0-3][0-7]{2}/.exec(body.slice(index + 1, index + 1 + octalLength));

    if (literal !== null) {
      bytes.push(...encoder.encode(literal[0]));
      index += literal[0].length - 1;
    } else if (octal === null) {
      bytes.push(escapes[body[index + 1] ?? ''] ?? 0);
      index += 1;
    } else {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octalLength;
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
};

// The new path of a `+++ ` header, or undefined for /dev/null. Git adds a trailing tab to a path
// with a space and C-quotes a path with a quote, tab, backslash, or newline.
const headerPath = (line: string) => {
  if (line.startsWith('+++ "b/') && line.endsWith('"')) {
    return decodeQuoted(line.slice('+++ "b/'.length, -1));
  }

  return line.startsWith('+++ b/') ? line.slice('+++ b/'.length).replace(/\t$/, '') : undefined;
};

// Reads the added line ranges of a zero-context diff. A hunk that adds no lines gives no range.
const addedRanges = (diff: string) => {
  const ranges = new Map<string, LineRange[]>();
  let path: string | undefined;
  let bodyLines = 0;

  for (const line of diff.split('\n')) {
    if (bodyLines > 0 && /^[-+ ]/.test(line)) {
      bodyLines -= 1;

      continue;
    }

    bodyLines = 0;

    if (line.startsWith('+++ ')) {
      path = headerPath(line);

      continue;
    }

    const hunk = hunkPattern.exec(line);

    if (path === undefined || hunk === null) {
      continue;
    }

    const removed = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const start = Number(hunk[2]);
    const count = hunk[3] === undefined ? 1 : Number(hunk[3]);

    bodyLines = removed + count;

    if (count > 0) {
      ranges.set(path, [...(ranges.get(path) ?? []), { start, end: start + count - 1 }]);
    }
  }

  return ranges;
};

// mutationScope parses plain `+++ b/` headers and reads every line in a hunk as added. The
// algorithm and inter-hunk context change which lines those are, so these arguments override the
// user's diff settings.
export const changedLinesDiffArguments = (base: string): string[] => [
  '-c',
  'core.quotePath=false',
  'diff',
  '-U0',
  '--inter-hunk-context=0',
  '--diff-algorithm=histogram',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--end-of-options',
  base,
  '--',
];

// Turns `git diff -U0` output and the untracked paths into the production files to mutate.
// Tracked files keep their added lines, untracked files count whole. The result is sorted by path.
export const changedScope = (
  diff: string,
  untracked: string[],
  isProduction: (path: string) => boolean,
): FileScope[] => {
  const tracked = [...addedRanges(diff)].map(([path, ranges]) => ({ path, ranges }));
  const whole = untracked.map((path) => ({ path }));
  const scopes: FileScope[] = [...tracked, ...whole];

  return scopes
    .filter(({ path }) => isProduction(path))
    .toSorted((left, right) => (left.path < right.path ? -1 : 1));
};

// Whole files, sorted. A path outside the mutate globs is not production code.
export const auditScope = (paths: string[], isProduction: (path: string) => boolean): FileScope[] =>
  [...new Set(paths)]
    .filter((path) => isProduction(path))
    .toSorted()
    .map((path) => ({ path }));

export const rejectedAuditPaths = (
  paths: string[],
  isProduction: (path: string) => boolean,
): string[] => paths.filter((path) => !isProduction(path));

// A path is a literal name, but Stryker reads each `mutate` entry as a glob. It turns a backslash
// into a path separator, so each glob character goes in a bracket class instead.
const escapeGlob = (path: string) => path.replaceAll(/[*?[{}()]/g, '[$&]');

export const mutatePatterns = ({ path, ranges }: FileScope): string[] => {
  const glob = escapeGlob(path);

  return ranges === undefined ? [glob] : ranges.map(({ start, end }) => `${glob}:${start}-${end}`);
};

// Gives each file its budget in order. A file that does not fit is left out, and a later file
// that fits still runs.
export const fitCap = (
  counts: { path: string; mutants: number }[],
  cap: number,
): { run: string[]; unmutated: string[] } => {
  const run: string[] = [];
  const unmutated: string[] = [];
  let used = 0;

  for (const { path, mutants } of counts) {
    if (mutants === 0) {
      continue;
    }

    if (used + mutants > cap) {
      unmutated.push(path);

      continue;
    }

    used += mutants;
    run.push(path);
  }

  return { run, unmutated };
};

// Mutants that a disable comment or `excludedMutations` ignores never run, so they use no cap.
export const countedMutants = (mutants: readonly { status?: string }[]): number =>
  mutants.filter(({ status }) => status !== 'Ignored').length;

const defaultMaxMutants = 500;

const usageText = 'Usage: mutation changed <base> | mutation audit <path>...';

const takeOptions = (argv: string[]) => {
  const positionals: string[] = [];
  const options = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    if (argument.startsWith('-') && argument !== '--max-mutants' && argument !== '--config') {
      throw new Error(`Unknown option "${argument}". ${usageText}`);
    }

    if (argument !== '--max-mutants' && argument !== '--config') {
      positionals.push(argument);

      continue;
    }

    const value = argv[index + 1];

    if (value === undefined) {
      throw new Error(`${argument} needs a value.`);
    }

    options.set(argument, value);
    index += 1;
  }

  return { positionals, options };
};

const parseMaxMutants = (text: string | undefined) => {
  if (text === undefined) {
    return defaultMaxMutants;
  }

  const maxMutants = Number(text);

  if (text.trim() === '' || !Number.isInteger(maxMutants) || maxMutants < 1) {
    throw new Error('--max-mutants takes a positive integer.');
  }

  return maxMutants;
};

// Every refusal throws its own error.
export const parseCommand = (argv: string[]): Command => {
  const { positionals, options } = takeOptions(argv);
  const [mode, ...rest] = positionals;
  const maxMutants = parseMaxMutants(options.get('--max-mutants'));
  const configPath = options.get('--config');
  const extra = configPath === undefined ? {} : { configPath };

  if (mode === 'changed') {
    const [base] = rest;

    if (base === undefined) {
      throw new Error('changed needs a base. Usage: mutation changed <base>');
    }

    if (rest.length > 1) {
      throw new Error('changed takes one base only.');
    }

    return { mode, base, paths: [], maxMutants, ...extra };
  }

  if (mode === 'audit') {
    if (rest.length === 0) {
      throw new Error('audit needs at least one path. Usage: mutation audit <path>...');
    }

    return { mode, paths: rest, maxMutants, ...extra };
  }

  throw new Error(`Unknown mode "${mode ?? ''}". ${usageText}`);
};

// The config Stryker runs: the repository config with the computed scope. Only buildMutationReport
// decides the exit code, so the break threshold is off.
export const mergedConfig = (
  config: { thresholds?: Record<string, unknown> | undefined },
  mutate: string[],
  reportPath: string,
): MergedConfig => ({
  ...config,
  mutate,
  reporters: ['json', 'progress'],
  jsonReporter: { fileName: reportPath },
  thresholds: { ...config.thresholds, break: null },
});

// Returns the reason a config's `mutate` list cannot select files, or undefined when it can.
export const mutateConfigError = (mutate: unknown, configPath: string): string | undefined => {
  if (!Array.isArray(mutate)) {
    return `${configPath} needs a "mutate" list of globs.`;
  }

  if (mutate.length === 0) {
    return `${configPath} has an empty "mutate" list.`;
  }

  const hasPositive = mutate.some((glob) => typeof glob === 'string' && !glob.startsWith('!'));

  return hasPositive ? undefined : `${configPath} has a "mutate" list with only "!" globs.`;
};

// A file the cap let run with mutants to test must appear in Stryker's report with a mutant.
// Otherwise Stryker selected nothing for it, and a pass would hide the file.
export const unreportedFiles = (
  ran: { path: string; mutants: number }[],
  reportedPaths: string[],
): string[] =>
  ran
    .filter(({ path, mutants }) => mutants > 0 && !reportedPaths.includes(path))
    .map(({ path }) => path);
