import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import { hasErrorCode, isMissingFile } from '../src/errors.ts';
import { pathCommands } from './pathCommands.ts';
import type { PathEntry } from './pathCommands.ts';

interface DirectoryListing {
  directory: string;
  // Undefined means the directory exists but cannot be listed.
  entries: PathEntry[] | undefined;
}

// A PATH entry that is absent or names a file holds no commands.
const isMissingDirectory = (error: unknown) =>
  isMissingFile(error) || hasErrorCode(error, 'ENOTDIR');

const canExecute = (path: string) => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

const readEntry = (directory: string, name: string): PathEntry | undefined => {
  const path = join(directory, name);

  try {
    const stats = statSync(path, { bigint: true });

    return {
      name,
      isFile: stats.isFile(),
      executable: stats.isFile() && canExecute(path),
      identity: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`,
    };
  } catch {
    return undefined;
  }
};

const readDirectory = (directory: string): PathEntry[] | undefined => {
  let names: string[];

  try {
    names = readdirSync(directory);
  } catch (error) {
    return isMissingDirectory(error) ? [] : undefined;
  }

  return names.flatMap((name) => {
    const entry = readEntry(directory, name);

    return entry === undefined ? [] : [entry];
  });
};

// An empty PATH entry means the current directory, and resolve maps it to that.
// oxlint-disable-next-line node/no-process-env -- The commands on the caller's PATH decide the fingerprint.
const pathDirectories = (process.env.PATH ?? '').split(delimiter).map((entry) => resolve(entry));

const listings: DirectoryListing[] = pathDirectories.map((directory) => ({
  directory,
  entries: readDirectory(directory),
}));

const unlistable = listings.find(({ entries }) => entries === undefined);

// oxlint-disable-next-line node/no-process-env -- The test tasks run with the caller's environment.
const environment = { ...process.env };

if (unlistable === undefined) {
  const commands = pathCommands(listings.map(({ entries }) => entries ?? []));

  environment.TAU_PATH_COMMANDS = createHash('sha256').update(commands).digest('hex');
} else {
  // The commands in that directory are unknown, so no earlier result may replay.
  environment.TAU_PATH_COMMANDS = `unlistable-${randomUUID()}`;

  process.stderr.write(
    `Cannot list PATH directory ${unlistable.directory}, so every test project runs.\n`,
  );
}

const result = spawnSync('vp', ['run', '--concurrency-limit', '2', 'vitest:all'], {
  stdio: 'inherit',
  env: environment,
});

if (result.error) {
  process.stderr.write(`Could not run the test projects: ${result.error.message}\n`);
}

process.exitCode = result.status ?? 1;
