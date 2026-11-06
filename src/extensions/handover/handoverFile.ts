import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { readBoundedText } from '../../record.js';
import { climbsOut, ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';

// hc send and herdr-app pass the text as one argument, and Linux refuses one above 128 KiB.
const handoverByteLimit = 102_400;

const resolveHandoverFile = async (file: string, cwd: string): Promise<string> => {
  try {
    return await realpath(resolve(cwd, file));
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`handover file does not exist: ${file}`, {
        cause: error,
      });
    }

    throw error;
  }
};

export const readHandoverText = async (cwd: string, file: string): Promise<string> => {
  const root = await findTauRoot(cwd, 'handover');
  const directory = await ensureTauDirectory(root, 'handovers');
  const realFile = await resolveHandoverFile(file, cwd);
  const realDirectory = await realpath(directory);

  if (climbsOut(relative(realDirectory, realFile))) {
    throw new Error(`handover file is outside the .tau/handovers directory: ${file}`);
  }

  const text = await readBoundedText(realFile, handoverByteLimit, 'handover file');

  if (text === '') {
    throw new Error(`handover file is empty: ${file}`);
  }

  return text;
};
