import type { Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../../../errors/index.js';
import type { RunDiagnostics } from './types.js';

export const maximumRetainedRuns = 32;
const retentionMilliseconds = 7 * 24 * 60 * 60 * 1000;

const diagnosticsRoot = () => join(getAgentDir(), 'test-runs');
const runDirectoryName = /^run-[a-zA-Z0-9]{6}$/;

const metadataIfPresent = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const isPrivateDirectory = (metadata: Stats): boolean => {
  if (!metadata.isDirectory()) {
    return false;
  }

  if (process.getuid === undefined) {
    return true;
  }

  return metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0;
};

export const createDiagnosticsDirectory = async (): Promise<string> => {
  const root = diagnosticsRoot();

  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);

  if (!isPrivateDirectory(metadata)) {
    throw new Error(`Expected a private diagnostic directory owned by the current user: ${root}`);
  }

  return mkdtemp(join(root, 'run-'));
};

const readCandidate = async (directory: string) => {
  const metadata = await metadataIfPresent(directory);

  if (metadata?.isDirectory() !== true) {
    return undefined;
  }

  const completion = await metadataIfPresent(join(directory, 'completed'));
  const finished = completion?.isFile() === true;
  const timestamp = finished ? completion.mtimeMs : metadata.mtimeMs;

  return { directory, finished, timestamp };
};

export const pruneDiagnostics = async (
  root: string,
  now = Date.now(),
  currentDirectory?: string,
): Promise<void> => {
  const entries = await readdir(root, { withFileTypes: true });

  const directories = entries
    .filter((entry) => entry.isDirectory() && runDirectoryName.test(entry.name))
    .map((entry) => join(root, entry.name))
    .filter((directory) => directory !== currentDirectory);

  const collected = await Promise.all(directories.map(readCandidate));

  const candidates = collected
    .filter((candidate) => candidate !== undefined)
    .toSorted((left, right) => right.timestamp - left.timestamp);

  const expiredDirectories: string[] = [];
  let retained = currentDirectory === undefined ? 0 : 1;

  for (const candidate of candidates) {
    const expired = now - candidate.timestamp > retentionMilliseconds;

    if (candidate.finished) {
      retained += 1;
    }

    // Recent incomplete directories may belong to concurrent runs; old ones can remain after crashes.
    const overRetentionLimit = candidate.finished && retained > maximumRetainedRuns;

    if (expired || overRetentionLimit) {
      expiredDirectories.push(candidate.directory);
    }
  }

  await Promise.all(
    expiredDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
};

export const finishDiagnostics = async (diagnostics: RunDiagnostics | undefined): Promise<void> => {
  if (diagnostics === undefined || dirname(diagnostics.directory) !== diagnosticsRoot()) {
    return;
  }

  try {
    // Mark completion after observation checks input freshness and attempts to save the run record.
    await writeFile(join(diagnostics.directory, 'completed'), '', { mode: 0o600, flag: 'wx' });
    await pruneDiagnostics(dirname(diagnostics.directory), Date.now(), diagnostics.directory);
  } catch (error) {
    diagnostics.error = [diagnostics.error, `Diagnostic retention failed: ${String(error)}`]
      .filter(Boolean)
      .join('\n');
  }
};
