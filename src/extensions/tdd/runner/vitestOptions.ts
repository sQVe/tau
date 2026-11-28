import type { parseCLI } from 'vitest/node';

type CliOptions = ReturnType<typeof parseCLI>['options'];

const commandWords = new Set(['run', 'related']);

const testNameFilterFlags = ['-t', '--testNamePattern', '--test-name-pattern'];

// The installed parser clears the pattern for the "t" alias and for any run of leading dashes.
const clearedTestNameFilterPattern = /^-+no-(?:t|testNamePattern|test-name-pattern)$/u;

const isTestNameFilter = (argument: string): boolean =>
  testNameFilterFlags.some((flag) => argument === flag || argument.startsWith(`${flag}=`));

export const verificationArgvError = (verificationArgv: readonly string[]): string | null => {
  if (verificationArgv[0] !== 'vitest') {
    return 'verificationArgv must start with "vitest" for the vitest runner.';
  }

  const [first, ...afterFirst] = verificationArgv.slice(1);
  const hasCommand = first !== undefined && commandWords.has(first);
  const options = hasCommand ? afterFirst : verificationArgv.slice(1);

  if (options.includes('--')) {
    return 'verificationArgv must not pass "--"; Tau appends its own options after the configured arguments.';
  }

  if (options.some(isTestNameFilter)) {
    return 'verificationArgv must not set a test name filter; a focused run sets its own exact names.';
  }

  if (options.some((argument) => clearedTestNameFilterPattern.test(argument))) {
    return 'verificationArgv must not clear or negate the test name filter; a focused run sets its own exact names.';
  }

  const positional = options.find((argument) => !argument.startsWith('-'));

  if (positional !== undefined) {
    return `verificationArgv must not pass the positional argument "${positional}"; write flag values with "=", such as --reporter=json, because Tau selects the files for a scoped run.`;
  }

  return null;
};

export const passesReporters = (runnerArguments: readonly string[]): boolean =>
  runnerArguments.some(
    (argument) => argument === '--reporter' || argument.startsWith('--reporter='),
  );

// Vitest's public parser does not apply the CLI's private startup normalization.
export const normalizeVitestOptions = (filters: string[], options: CliOptions): CliOptions => {
  const normalized = { ...options };

  if (normalized.exclude) {
    normalized.cliExclude = normalized.exclude;
    delete normalized.exclude;
  }

  if (filters.some((filter) => filter.includes(':'))) {
    normalized.includeTaskLocation ??= true;
  }

  if (typeof normalized.typecheck?.only === 'boolean') {
    normalized.typecheck = { ...normalized.typecheck };
    normalized.typecheck.enabled ??= true;
  }

  if (normalized.clearCache === true || Boolean(normalized.listTags)) {
    normalized.watch = false;
    normalized.run = true;
  }

  return normalized;
};
