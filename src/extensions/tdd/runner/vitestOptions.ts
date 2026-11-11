import type { parseCLI } from 'vitest/node';

type CliOptions = ReturnType<typeof parseCLI>['options'];

// Any CLI reporter replaces the reporters in the project config, so Tau may add
// its own reporter only when the arguments already name one.
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
