import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isMissingFile } from './errors.js';

export interface TextFileRules {
  label: string;
  byteLimit: number;
}

export const resolveTextFile = async (
  file: string,
  cwd: string,
  label: string,
): Promise<string> => {
  try {
    return await realpath(resolve(cwd, file));
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`${label} does not exist: ${file}`, { cause: error });
    }

    throw error;
  }
};

export const readCheckedText = async (
  realFile: string,
  file: string,
  rules: TextFileRules,
): Promise<string> => {
  const handle = await open(realFile, constants.O_RDONLY | constants.O_NONBLOCK);

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error(`${rules.label} is not a regular file: ${file}`);
    }

    const buffer = Buffer.alloc(rules.byteLimit + 1);
    let total = 0;

    while (total < buffer.length) {
      // oxlint-disable-next-line no-await-in-loop -- One bounded read depends on the bytes read before.
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);

      if (bytesRead === 0) {
        break;
      }

      total += bytesRead;
    }

    if (total === 0) {
      throw new Error(`${rules.label} is empty: ${file}`);
    }

    if (total > rules.byteLimit) {
      throw new Error(`${rules.label} is larger than ${rules.byteLimit} bytes: ${file}`);
    }

    return buffer.subarray(0, total).toString('utf8');
  } finally {
    await handle.close();
  }
};
