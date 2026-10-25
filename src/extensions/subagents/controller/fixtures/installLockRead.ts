import type { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const observeInstallLockRead = (
  original: typeof readFile,
  agentDirectory: string,
  observed: () => void,
): typeof readFile => {
  const heldPath = join(agentDirectory, 'tmp', 'extensions', '.tau-install.lock.1');

  const read = async (...parameters: Parameters<typeof readFile>) => {
    const content = await original(...parameters);

    if (parameters[0] === heldPath) {
      const owner = JSON.parse(content.toString()) as { released?: boolean };

      if (owner.released !== true) {
        observed();
      }
    }

    return content;
  };

  return read as typeof readFile;
};
