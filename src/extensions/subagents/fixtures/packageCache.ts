import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const packageName = (source: string): string => {
  const name = source.trimStart().replace(/^npm:/, '').split('@')[0] ?? source;

  return name.replace(/[^a-zA-Z0-9._-]+/g, '-');
};

export const fakePackageRoot = (agentDirectory: string, source: string): string => {
  if (source.trimStart().startsWith('npm:')) {
    return join(
      agentDirectory,
      'tmp',
      'extensions',
      'npm',
      'shared',
      'node_modules',
      packageName(source),
    );
  }

  return join(agentDirectory, 'tmp', 'extensions', 'git', packageName(source));
};

export const launchIdFor = (source: string): string => `launch-${packageName(source)}`;

export const snapshotDirectory = (agentDirectory: string, launchId: string): string =>
  join(agentDirectory, 'tmp', 'tau-worker-packages', launchId);

export const sourceSnapshotDirectory = (directory: string, source: string): string => {
  const sourceName = createHash('sha256').update(source).digest('hex');

  return join(directory, sourceName);
};

export const fakePackageSnapshot = (
  agentDirectory: string,
  launchId: string,
  source: string,
): string => {
  const temporaryFolder = join(agentDirectory, 'tmp', 'extensions');
  const packageRoot = fakePackageRoot(agentDirectory, source);

  const directory = sourceSnapshotDirectory(snapshotDirectory(agentDirectory, launchId), source);

  return join(directory, relative(temporaryFolder, packageRoot));
};

export const writeFakePackage = (
  agentDirectory: string,
  source: string,
  content = source,
): string => {
  const path = fakePackageRoot(agentDirectory, source);

  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'content.txt'), content);

  return path;
};
