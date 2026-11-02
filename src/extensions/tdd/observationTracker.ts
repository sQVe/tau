import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { loadTddConfig } from './config.js';
import type { LoadedTddConfig } from './config.js';
import { createTestObservation, observationDirectory } from './observation.js';
import type { TestObservation } from './types.js';

export interface TrackedObservation {
  cwd: string;
  key: string;
  loaded: LoadedTddConfig;
  observation: TestObservation;
}

export interface ObservationTracker {
  observationFor: (context: ExtensionContext) => Promise<TrackedObservation>;
  recordConfigError: (message: string) => boolean;
  clearConfigError: () => void;
  startSession: () => void;
  shutdownSession: () => void;
}

const createTracked = (cwd: string, key: string, loaded: LoadedTddConfig): TrackedObservation => ({
  cwd,
  key,
  loaded,
  observation: createTestObservation(cwd, loaded.config),
});

export const createObservationTracker = (): ObservationTracker => {
  let current: TrackedObservation | undefined;
  let reportedConfigError: string | undefined;
  let sessionGeneration = 0;

  const observationFor = async (context: ExtensionContext): Promise<TrackedObservation> => {
    const startedGeneration = sessionGeneration;
    const cwd = await observationDirectory(context.cwd);

    const location = {
      cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    };

    const loaded = loadTddConfig(location, context.ui);

    const key = JSON.stringify(loaded);

    if (startedGeneration !== sessionGeneration) {
      return createTracked(cwd, key, loaded);
    }

    if (current?.cwd !== cwd || current.key !== key) {
      current = createTracked(cwd, key, loaded);
    }

    return current;
  };

  return {
    observationFor,

    recordConfigError(message) {
      if (reportedConfigError === message) {
        return false;
      }

      reportedConfigError = message;

      return true;
    },

    clearConfigError() {
      reportedConfigError = undefined;
    },

    startSession() {
      sessionGeneration += 1;
      current = undefined;
      reportedConfigError = undefined;
    },

    shutdownSession() {
      sessionGeneration += 1;
      current = undefined;
    },
  };
};
