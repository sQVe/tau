import { readCheckState } from '../../checkRecord/identity.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { withIgnoredNote } from '../../config/repositoryCommand.js';
import { readVerificationTarget } from '../../config/verificationTargets.js';
import type { VerificationTarget } from '../../config/verificationTargets.js';
import { readGit, runGit } from '../../git.js';
import { existingEntry } from '../../tauDirectory.js';
import type { RunRecord } from '../../verification/records.js';
import { readRun, runRecordPath } from '../../verification/verification.js';

export interface RunFacts {
  head: string | null;
  dirty: boolean;
  platform: { os: string; arch: string };
  tree: string | null;
}

const notConfiguredMessage = (ignored: string | undefined): string =>
  withIgnoredNote(
    'No verification target is configured. Add verification.targets to .pi/tau.json in the repository, such as {"app": {"launch": ["pnpm", "app:up"], "doctor": ["pnpm", "app:doctor"], "stop": ["pnpm", "app:down"]}}.',
    ignored,
  );

const readHead = async (root: string): Promise<string | null> => {
  const result = await runGit(root, ['rev-parse', '--verify', 'HEAD']);

  return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : null;
};

const readDirty = async (root: string): Promise<boolean> =>
  (await readGit(root, ['status', '--porcelain'])) !== '';

export const readRunFacts = async (root: string): Promise<RunFacts> => {
  const state = await readCheckState(root);

  return {
    head: await readHead(root),
    dirty: await readDirty(root),
    platform: { os: process.platform, arch: process.arch },
    tree: state.tree,
  };
};

const missingRunRecordMessage = (path: string, run: string) =>
  `The run ${run} has no run record at ${path}.`;

// Reads metadata only, so a run record that is not a regular file is refused before anything opens
// it.
export const requireRunRecordFile = async (directory: string, run: string): Promise<void> => {
  const path = runRecordPath(directory);
  const entry = await existingEntry(path);

  if (entry === undefined) {
    throw new Error(missingRunRecordMessage(path, run));
  }

  if (!entry.isFile()) {
    throw new Error(`Refusing to read a run record that is not a regular file: ${path}`);
  }
};

export const readRunRecordOrThrow = async (directory: string, run: string): Promise<RunRecord> => {
  const path = runRecordPath(directory);
  const read = await readRun(directory);

  if (read.status === 'valid') {
    return read.record;
  }

  if (read.status === 'missing') {
    throw new Error(missingRunRecordMessage(path, run));
  }

  throw new Error(`The run record ${path} is malformed: ${read.problem}`);
};

export const readTarget = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  name: string,
): VerificationTarget => {
  const read = readVerificationTarget(location, ui, name);

  if (read.kind === 'notConfigured') {
    throw new Error(notConfiguredMessage(read.ignored));
  }

  if (read.kind === 'unknown') {
    throw new Error(
      `Unknown verification target ${name}. Configured targets: ${read.names.join(', ')}.`,
    );
  }

  return read.target;
};
