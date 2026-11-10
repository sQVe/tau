import type { parseCLI } from 'vitest/node';

type CliOptions = ReturnType<typeof parseCLI>['options'];

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
