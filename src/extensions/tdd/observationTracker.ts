import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { runGit } from '../../git.js';
import { loadTddConfig } from './config.js';
import type { LoadedTddConfig } from './config.js';
import { createTestObservation, observationDirectory } from './observation.js';
import { repositoryRootFrom } from './repositoryRoot.js';
import type { RepositoryRoot } from './repositoryRoot.js';
import { runners } from './runner/runners.js';
import type { TestObservation } from './types.js';

interface TrackedObservation {
  cwd: string;
  repositoryRoot: string;
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

const createTracked = (
  cwd: string,
  repositoryRoot: string,
  key: string,
  loaded: LoadedTddConfig,
): TrackedObservation => ({
  cwd,
  repositoryRoot,
  key,
  loaded,
  observation: createTestObservation(cwd, loaded.config, repositoryRoot),
});

const findRepositoryRoot = async (cwd: string): Promise<RepositoryRoot> => {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], {
    timeoutMilliseconds: 5000,
  });

  const root = repositoryRootFrom(cwd, { ...result, stdout: result.stdout.toString('utf8') });

  return root.kind === 'error'
    ? root
    : { kind: 'root', path: await observationDirectory(root.path) };
};

export const createObservationTracker = (): ObservationTracker => {
  let current: TrackedObservation | undefined;
  let reportedConfigError: string | undefined;
  let sessionGeneration = 0;

  const observationFor = async (context: ExtensionContext): Promise<TrackedObservation> => {
    const startedGeneration = sessionGeneration;
    const cwd = await observationDirectory(context.cwd);

    const root = await findRepositoryRoot(cwd);

    const location = {
      cwd,
      repositoryRoot: root,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    };

    const loaded = loadTddConfig(location, context.ui, runners);

    // Loading fails a nextest config without a root. Other runners never read it, so they keep the
    // session directory and a Git failure cannot reset their observation.
    const readsRepositoryRoot = loaded.config.runner === runners.nextest.name;
    const repositoryRoot = readsRepositoryRoot && root.kind === 'root' ? root.path : cwd;

    const key = JSON.stringify(loaded);

    if (startedGeneration !== sessionGeneration) {
      return createTracked(cwd, repositoryRoot, key, loaded);
    }

    const changed = current?.cwd !== cwd || current.repositoryRoot !== repositoryRoot;

    if (changed || current?.key !== key) {
      current = createTracked(cwd, repositoryRoot, key, loaded);
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
