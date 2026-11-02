import { realpathSync } from 'node:fs';
import type { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const observeInstallLockRead = (
  original: typeof readFile,
  agentDirectory: string,
  observed: () => void,
): typeof readFile => {
  // The install lock lives in the real path of the cache, so a symlinked temporary directory must
  // resolve here too. The cache folder may not exist yet, so only the agent directory resolves.
  const heldPath = join(realpathSync(agentDirectory), 'tmp', 'extensions', '.tau-install.lock.1');

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
