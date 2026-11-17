import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shouldRemoveTemporaryOutput } from './outputRetention.ts';
import type { TemporaryOutputFacts } from './outputRetention.ts';

const millisecondsPerDay = 86_400_000;
const retentionDays = 1;
const retentionMilliseconds = retentionDays * millisecondsPerDay;

const removeEntry = (path: string, facts: TemporaryOutputFacts): void => {
  if (!shouldRemoveTemporaryOutput(facts)) {
    return;
  }

  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Retention is best effort; a directory that cannot be removed stays for the next save.
  }
};

// Outputs stay so a tool result can point at them, but only for a bounded time. A directory that
// another user owns, or that is not an old directory, is left alone.
export const pruneTemporaryOutput = (root: string, prefix: string, now = Date.now()): void => {
  let entries: string[];

  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(root, entry);

    try {
      const metadata = lstatSync(path);

      removeEntry(path, {
        matchesPrefix: entry.startsWith(prefix),
        isDirectory: metadata.isDirectory(),
        ownerId: metadata.uid,
        currentUserId: process.getuid?.(),
        modifiedAt: metadata.mtimeMs,
        now,
        retentionMilliseconds,
      });
    } catch {
      // An entry that vanished or cannot be read stays for the next save.
    }
  }
};

const createTemporaryOutputDirectory = async (prefix: string): Promise<string> => {
  pruneTemporaryOutput(tmpdir(), prefix);

  return mkdtemp(join(tmpdir(), prefix));
};

export const createTemporaryOutputDirectorySync = (prefix: string): string => {
  pruneTemporaryOutput(tmpdir(), prefix);

  return mkdtempSync(join(tmpdir(), prefix));
};

// mkdtemp creates the directory readable only by its owner, outside the worktree under test.
export const saveFullOutput = async (prefix: string, text: string): Promise<string> => {
  const directory = await createTemporaryOutputDirectory(prefix);
  const path = join(directory, 'output.log');

  await writeFile(path, text, { mode: 0o600 });

  return path;
};
