import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

type Cleanup = () => Promise<void> | void;

export type SuiteCleanup = (cleanup: Cleanup) => void;

interface HarnessState {
  trackedDirectories: Set<string>;
  handlersInstalled: boolean;
}

// A test file that resets modules loads a fresh copy of this module in the same process. The state
// lives on globalThis so every copy shares one directory set and one set of process handlers.
const stateKey = Symbol.for('tau.temporaryDirectoryHarness');

const sharedState = globalThis as { [stateKey]?: HarnessState };

const state = sharedState[stateKey] ?? {
  trackedDirectories: new Set<string>(),
  handlersInstalled: false,
};

sharedState[stateKey] = state;

const trackedDirectories = state.trackedDirectories;
const handledSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

const removeTrackedDirectories = (): void => {
  for (const directory of trackedDirectories) {
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
      removeTrackedDirectories();
      process.off(signal, handleSignal);
      process.kill(process.pid, signal);
    };

    process.on(signal, handleSignal);
  }
};

const installOnce = (): void => {
  if (state.handlersInstalled) {
    return;
  }

  state.handlersInstalled = true;
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
