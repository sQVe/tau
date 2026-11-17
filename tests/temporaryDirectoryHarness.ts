import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

type Cleanup = () => Promise<void> | void;

export type SuiteCleanup = (cleanup: Cleanup) => void;

// Vitest ignores a hook registered inside another hook, so call this during suite definition.
export const suiteCleanup = (): SuiteCleanup => {
  const cleanups: Cleanup[] = [];

  afterAll(async () => {
    for (const cleanup of cleanups.toReversed()) {
      await cleanup();
    }
  });

  return (cleanup) => {
    cleanups.push(cleanup);
  };
};

export const temporaryDirectory = (
  onTestFinished: (cleanup: () => void) => void,
  prefix: string,
): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return directory;
};
