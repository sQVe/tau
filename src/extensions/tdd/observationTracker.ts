import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { loadTddConfig } from './config.js';
import type { LoadedTddConfig } from './config.js';
import { createTestObservation, observationDirectory } from './observation.js';
import { runners } from './runner/runners.js';
import type { TestObservation } from './types.js';

interface TrackedObservation {
  cwd: string;
  key: string;
  loaded: LoadedTddConfig;
  observation: TestObservation;
}

type EditObservation =
  | { kind: 'observed'; tracked: TrackedObservation }
  | { kind: 'paused'; message: string; notify: boolean };

export interface ObservationTracker {
  observationFor: (context: ExtensionContext) => Promise<TrackedObservation>;
  observationForEdit: (context: ExtensionContext) => Promise<EditObservation>;
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

    const loaded = loadTddConfig(location, context.ui, runners);

    const key = JSON.stringify(loaded);

    if (startedGeneration !== sessionGeneration) {
      return createTracked(cwd, key, loaded);
    }

    if (current?.cwd !== cwd || current.key !== key) {
      current = createTracked(cwd, key, loaded);
    }

    return current;
  };

  const reportConfigError = (message: string): boolean => {
    if (reportedConfigError === message) {
      return false;
    }

    reportedConfigError = message;

    return true;
  };

  const observationForEdit = async (context: ExtensionContext): Promise<EditObservation> => {
    const startedGeneration = sessionGeneration;
    const isCurrentSession = () => startedGeneration === sessionGeneration;
    let tracked: TrackedObservation;

    try {
      tracked = await observationFor(context);
    } catch (error) {
      const message = `TDD hints are paused: ${error instanceof Error ? error.message : String(error)}`;

      if (!isCurrentSession()) {
        return { kind: 'paused', message, notify: true };
      }

      return { kind: 'paused', message, notify: reportConfigError(message) };
    }

    if (isCurrentSession()) {
      reportedConfigError = undefined;
    }

    return { kind: 'observed', tracked };
  };

  return {
    observationFor,
    observationForEdit,

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
