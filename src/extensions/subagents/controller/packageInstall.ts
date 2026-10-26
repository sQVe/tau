import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PackageManager, ResolvedPaths } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../../errors.js';
import { withFileLock } from '../../../fileLock/fileLock.js';
import type { Loadout } from '../types.js';
import { isLocalPackage, packagesToLoad } from '../workerPackages.js';
import {
  removeSnapshotDirectory,
  snapshotDirectoryFor,
  snapshotPackageRoot,
} from './packageSnapshot.js';
import type { WorkerPackage } from './types.js';

export type WorkerPackageManager = Pick<
  PackageManager,
  'listConfiguredPackages' | 'resolveExtensionSources'
>;

// Pi expands `~` and reads a file:// URL as its path.
const localPath = (path: string): string => {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return path.startsWith('file://') ? fileURLToPath(path) : path;
};

// Pi resolves a local source from the directory of the settings that name it, and `-e` from the cwd.
const absoluteSource = (source: string, baseDirectory: string): string =>
  isLocalPackage(source) ? resolve(baseDirectory, localPath(source.trim())) : source;

const hasResources = (paths: ResolvedPaths): boolean =>
  [paths.extensions, paths.skills, paths.prompts, paths.themes].some(
    (resources) => resources.length > 0,
  );

const packageRoot = (paths: ResolvedPaths): string | undefined =>
  [paths.extensions, paths.skills, paths.prompts, paths.themes]
    .flatMap((resources) => resources.map((resource) => resource.metadata.packageRoot))
    .find((root) => root !== undefined);

const timedOut = (signal: AbortSignal): boolean =>
  signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';

class InstallStoppedError extends Error {
  override name = 'InstallStoppedError';

  constructor(source: string, signal: AbortSignal) {
    const reason = timedOut(signal) ? 'ran out of launch time' : 'was cancelled';

    super(`Worker profile package ${source} install ${reason}.`);
  }
}

// Pi's npm install and git clone take no signal, so an abort stops the wait, not the download.
const untilAborted = <Value>(
  work: Promise<Value>,
  signal: AbortSignal,
  source: string,
): Promise<Value> => {
  // An abandoned install may still fail later; its error has no reader.
  work.catch(() => undefined);

  if (signal.aborted) {
    return Promise.reject(new InstallStoppedError(source, signal));
  }

  const stopped = Promise.withResolvers<never>();

  const abort = () => {
    stopped.reject(new InstallStoppedError(source, signal));
  };

  signal.addEventListener('abort', abort, { once: true });

  return Promise.race([work, stopped.promise]).finally(() => {
    signal.removeEventListener('abort', abort);
  });
};

const withInstallLock = async <Value>(
  target: { source: string; agentDirectory: string },
  install: () => Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  const temporaryFolder = join(target.agentDirectory, 'tmp', 'extensions');

  await mkdir(temporaryFolder, { recursive: true, mode: 0o700 });
  const cache = await realpath(temporaryFolder);

  return withFileLock(
    {
      lockPath: join(cache, '.tau-install.lock'),
      checkout: target.agentDirectory,
      signal,
      pollMilliseconds: 25,
      onWaiting: () => undefined,
      cancelled: () => new InstallStoppedError(target.source, signal),
    },
    install,
  );
};

const installPackage = async (
  manager: WorkerPackageManager,
  target: { source: string; agentDirectory: string; snapshotDirectory: string },
  signal: AbortSignal,
): Promise<WorkerPackage> => {
  const { source, agentDirectory, snapshotDirectory } = target;

  const install = async (): Promise<WorkerPackage> => {
    let paths: ResolvedPaths;

    try {
      paths = await manager.resolveExtensionSources([source], { temporary: true });
    } catch (error) {
      throw new Error(
        `Worker profile package ${source} failed to install: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    }

    // Pi skips a missing local path, and an npm or git install while offline, without an error.
    if (!hasResources(paths)) {
      throw new Error(
        `Worker profile package ${source} is missing or has no Pi resources; check the source and that Pi is online.`,
      );
    }

    if (isLocalPackage(source)) {
      return { source, path: source };
    }

    const path = packageRoot(paths);

    if (path === undefined) {
      throw new Error(
        `Worker profile package ${source} installed without a package root; check the source.`,
      );
    }

    const snapshot = await snapshotPackageRoot({
      agentDirectory,
      source,
      packageRoot: path,
      snapshotDirectory,
    });

    return { source, path: snapshot };
  };

  const work = withInstallLock(target, install, signal);

  const cleanup = {
    agentDirectory,
    directory: snapshotDirectory,
    snapshotName: basename(snapshotDirectory),
  };

  try {
    return await untilAborted(work, signal, source);
  } catch (error) {
    if (error instanceof InstallStoppedError) {
      // An abandoned install may still copy. Remove the snapshot only after the copy settles.
      void work
        .finally(() => {
          removeSnapshotDirectory(cleanup).catch(() => undefined);
        })
        .catch(() => undefined);

      throw error;
    }

    const cleanupError = await removeSnapshotDirectory(cleanup);

    if (cleanupError !== undefined) {
      throw new Error(
        `${errorMessage(error)} Also failed to remove the launch package snapshot: ${cleanupError}`,
        { cause: error },
      );
    }

    throw error;
  }
};

export const installWorkerPackages = async (
  loadout: Loadout,
  packageManager: (loadout: Loadout) => WorkerPackageManager,
  signal: AbortSignal,
  snapshotDirectory = snapshotDirectoryFor(loadout.agentDirectory, randomUUID()),
): Promise<WorkerPackage[]> => {
  if (loadout.packages.length === 0) {
    return [];
  }

  const manager = packageManager(loadout);

  const configured = manager
    .listConfiguredPackages()
    .map(({ source, scope }) =>
      absoluteSource(source, scope === 'user' ? loadout.agentDirectory : join(loadout.cwd, '.pi')),
    );

  const profile = loadout.packages.map((source) => absoluteSource(source, loadout.cwd));
  const sources = packagesToLoad(profile, configured);
  const packages: WorkerPackage[] = [];

  for (const source of sources) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One install at a time, so a failure names its package and skips the rest.
    const installed = await installPackage(
      manager,
      { source, agentDirectory: loadout.agentDirectory, snapshotDirectory },
      signal,
    );

    packages.push(installed);
  }

  return packages;
};
