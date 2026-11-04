import type { TestRunner } from './types.js';
import { vitestRunner } from './vitest.js';

export type RunnerTable = Readonly<Record<string, TestRunner>>;

export const runners = { vitest: vitestRunner } as const;

export const defaultRunnerName = 'vitest';

export const defaultRunner = runners[defaultRunnerName];

export const knownRunnerNames = (table: RunnerTable): string[] => Object.keys(table).toSorted();

export const findRunner = (name: string, table: RunnerTable): TestRunner | undefined =>
  Object.hasOwn(table, name) ? table[name] : undefined;

export const lookupRunner = (name: string, table: RunnerTable = runners): TestRunner => {
  const runner = findRunner(name, table);

  if (runner === undefined) {
    throw new Error(`Unknown TDD runner: ${name}`);
  }

  return runner;
};
