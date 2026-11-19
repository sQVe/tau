import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

type Cleanup = () => Promise<void> | void;

export type SuiteCleanup = (cleanup: Cleanup) => void;

const diagRemoval = (where: string, directory: string): void => {
  if (directory.includes('attribution-target')) {
    process.stderr.write(
      `DIAG removal ${where} pid=${process.pid} now=${Date.now()} dir=${directory}\n${new Error('stack').stack}\n`,
    );
  }
};

const trackedDirectories = new Set<string>();
const handledSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

const removeTrackedDirectories = (): void => {
  for (const directory of trackedDirectories) {
    diagRemoval('removeTrackedDirectories', directory);

    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // The process is leaving; a directory that cannot be removed stays.
    }
  }
};

const installExitHandlers = (): void => {
  process.on('exit', removeTrackedDirectories);

  for (const signal of handledSignals) {
    const handleSignal = () => {
      process.stderr.write(
        `DIAG signal ${signal} pid=${process.pid} now=${Date.now()} tracked=${[...trackedDirectories].join(',')}\n`,
      );

      removeTrackedDirectories();
      process.off(signal, handleSignal);
      process.kill(process.pid, signal);
    };

    process.on(signal, handleSignal);
  }
};

let exitHandlersInstalled = false;

const installOnce = (): void => {
  if (exitHandlersInstalled) {
    return;
  }

  exitHandlersInstalled = true;
  installExitHandlers();
};

export const trackTemporaryDirectory = (directory: string): void => {
  installOnce();
  trackedDirectories.add(directory);
};

export const forgetTemporaryDirectory = (directory: string): void => {
  trackedDirectories.delete(directory);
};

const removeTemporaryDirectory = (directory: string): void => {
  diagRemoval('removeTemporaryDirectory', directory);
  rmSync(directory, { recursive: true, force: true });
  forgetTemporaryDirectory(directory);
};

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

  trackTemporaryDirectory(directory);

  onTestFinished(() => {
    removeTemporaryDirectory(directory);
  });

  return directory;
};
