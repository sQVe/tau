import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { PackageManager, ResolvedPaths } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../../errors.js';
import { withFileLock } from '../../../fileLock/fileLock.js';
import type { Loadout } from '../types.js';
import { isLocalPackage, packagesToLoad } from '../workerPackages.js';

export type WorkerPackageManager = Pick<
  PackageManager,
  'listConfiguredPackages' | 'resolveExtensionSources'
>;

// Build Pi's package manager as the worker will: in its cwd and agent directory, with the project
// trusted.
export const piPackageManager = (loadout: Loadout): WorkerPackageManager => {
  const settingsManager = SettingsManager.create(loadout.cwd, loadout.agentDirectory, {
    projectTrusted: true,
  });

  return new DefaultPackageManager({
    cwd: loadout.cwd,
    agentDir: loadout.agentDirectory,
    settingsManager,
  });
};

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
  target: { source: string; agentDirectory: string },
  signal: AbortSignal,
): Promise<void> => {
  const { source } = target;
  let paths: ResolvedPaths;

  const install = () => manager.resolveExtensionSources([source], { temporary: true });

  try {
    paths = await untilAborted(withInstallLock(target, install, signal), signal, source);
  } catch (error) {
    if (error instanceof InstallStoppedError) {
      throw error;
    }

    throw new Error(`Worker profile package ${source} failed to install: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  // Pi skips a missing local path, and an npm or git install while offline, without an error.
  if (!hasResources(paths)) {
    throw new Error(
      `Worker profile package ${source} is missing or has no Pi resources; check the source and that Pi is online.`,
    );
  }
};

// Installs into Pi's temporary `-e` cache, where the worker finds each package without a download.
// Returns the sources the worker loads with -e.
export const installWorkerPackages = async (
  loadout: Loadout,
  packageManager: (loadout: Loadout) => WorkerPackageManager,
  signal: AbortSignal,
): Promise<string[]> => {
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

  for (const source of sources) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One install at a time, so a failure names its package and skips the rest.
    await installPackage(manager, { source, agentDirectory: loadout.agentDirectory }, signal);
  }

  return sources;
};
