import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';

import { readCheckedText, resolveTextFile } from '../../fileText.js';
import { climbsOut, ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';

// hc send and herdr-app pass the text as one argument, and Linux refuses one above 128 KiB.
const handoverByteLimit = 102_400;

export const readHandoverText = async (cwd: string, file: string): Promise<string> => {
  const root = await findTauRoot(cwd, 'handover');
  const directory = await ensureTauDirectory(root, 'handovers');
  const realFile = await resolveTextFile(file, cwd, 'handover file');
  const realDirectory = await realpath(directory);

  if (climbsOut(relative(realDirectory, realFile))) {
    throw new Error(`handover file is outside the .tau/handovers directory: ${file}`);
  }

  return readCheckedText(realFile, file, {
    label: 'handover file',
    byteLimit: handoverByteLimit,
  });
};
