import { createHash } from 'node:crypto';
import { cp, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { errorMessage } from '../../errors.js';
import { removeAgentTemporaryFolder } from './workerScratch.js';

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

const snapshotRootName = 'tau-worker-packages';

export const snapshotDirectoryFor = (agentDirectory: string, launchId: string): string =>
  join(agentDirectory, 'tmp', snapshotRootName, launchId);

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

  if (directory !== snapshotDirectoryFor(agentDirectory, snapshotName)) {
    return 'Package snapshot name does not match its owner. Cleanup refused.';
  }

  return removeAgentTemporaryFolder(agentDirectory, snapshotRootName, snapshotName);
};
