import { createHash } from 'node:crypto';
import { cp, mkdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { errorMessage, isMissingFile } from '../../../errors.js';

interface SnapshotRequest {
  agentDirectory: string;
  source: string;
  packageRoot: string;
  snapshotDirectory: string;
}

interface SnapshotCleanup {
  agentDirectory: string;
  directory: string;
  snapshotName: string;
}

class SnapshotError extends Error {
  override name = 'SnapshotError';
}

export const snapshotDirectoryFor = (agentDirectory: string, launchId: string): string =>
  join(agentDirectory, 'tmp', 'tau-worker-packages', launchId);

const npmUnitFolder = (source: string, packageRoot: string): string => {
  const marker = `${sep}node_modules${sep}`;
  const index = packageRoot.lastIndexOf(marker);

  if (index === -1) {
    throw new SnapshotError(
      `Worker profile package ${source} installed without a node_modules folder; check the source.`,
    );
  }

  return packageRoot.slice(0, index);
};

// Pi's npm install root holds the package's dependencies beside it, so the copy takes the whole
// root. A Git checkout is its own install unit.
const installUnit = (source: string, packageRoot: string): string =>
  source.trimStart().startsWith('npm:') ? npmUnitFolder(source, packageRoot) : packageRoot;

const temporaryPath = (temporaryFolder: string, path: string, source: string): string => {
  const relativePath = relative(temporaryFolder, path);
  const escapes = relativePath === '' || isAbsolute(relativePath) || relativePath.startsWith('..');

  if (escapes) {
    throw new SnapshotError(
      `Worker profile package ${source} installed outside Pi's temporary package folder; check the source.`,
    );
  }

  return relativePath;
};

export const snapshotPackageRoot = async (request: SnapshotRequest): Promise<string> => {
  const { agentDirectory, source, packageRoot, snapshotDirectory } = request;

  try {
    const temporaryFolder = join(agentDirectory, 'tmp', 'extensions');
    const unitFolder = installUnit(source, packageRoot);
    const unitPath = temporaryPath(temporaryFolder, unitFolder, source);
    const packagePath = temporaryPath(temporaryFolder, packageRoot, source);

    const sourceName = createHash('sha256').update(source).digest('hex');
    const sourceDirectory = join(snapshotDirectory, sourceName);

    await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });

    await cp(unitFolder, join(sourceDirectory, unitPath), {
      recursive: true,
      verbatimSymlinks: true,
    });

    return join(sourceDirectory, packagePath);
  } catch (error) {
    if (error instanceof SnapshotError) {
      throw error;
    }

    throw new SnapshotError(
      `Worker profile package ${source} failed to snapshot its install: ${errorMessage(error)}`,
      { cause: error },
    );
  }
};

// Returns the cleanup error, so a caller without a handle can still report it.
export const removeSnapshotDirectory = async (
  request: SnapshotCleanup,
): Promise<string | undefined> => {
  const { agentDirectory, directory, snapshotName } = request;

  try {
    if (snapshotName === '' || snapshotName === '.' || snapshotName === '..') {
      throw new Error('Invalid package snapshot owner. Cleanup refused.');
    }

    if (basename(directory) !== snapshotName) {
      throw new Error('Package snapshot name does not match its owner. Cleanup refused.');
    }

    const canonicalAgent = await realpath(agentDirectory);
    const expectedRoot = join(canonicalAgent, 'tmp', 'tau-worker-packages');
    const canonicalRoot = await realpath(expectedRoot);

    if (canonicalRoot !== expectedRoot) {
      throw new Error('Package snapshot root is redirected. Cleanup refused.');
    }

    const canonicalParent = await realpath(dirname(directory));

    if (canonicalParent !== canonicalRoot) {
      throw new Error('Package snapshot is outside the trusted root. Cleanup refused.');
    }

    await rm(join(canonicalRoot, snapshotName), { recursive: true, force: true });

    return undefined;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    return errorMessage(error);
  }
};
