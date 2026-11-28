import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

// Two paths to one session file, such as a symlink and its target, must name one lock.
export const canonicalSessionFile = async (sessionFile: string): Promise<string> => {
  const resolvedFile = await realpath(sessionFile).catch(() => undefined);

  if (resolvedFile !== undefined) {
    return resolvedFile;
  }

  const directory = dirname(sessionFile);
  const resolvedDirectory = await realpath(directory).catch(() => resolve(directory));

  return join(resolvedDirectory, basename(sessionFile));
};
