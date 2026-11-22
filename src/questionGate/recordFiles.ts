import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage, isMissingFile } from '../errors.ts';
import type { ShadowRecordGap } from './record.ts';

interface RecordFileEntry<Value> {
  path: string;
  record: Value;
}

export interface RecordFilesRead<Value> {
  entries: RecordFileEntry<Value>[];
  gaps: ShadowRecordGap[];
}

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const listRecordNames = async (
  directory: string,
  name: RegExp,
  label: string,
): Promise<string[]> => {
  try {
    const names = await readdir(directory);

    return names.filter((entry) => name.test(entry)).toSorted();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw new Error(`Could not read ${label}s in ${directory}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
};

const isSingleRegularFile = async (path: string): Promise<boolean> => {
  const stats = await lstat(path);

  return stats.isFile() && stats.nlink === 1;
};

export const readRecordFiles = async <Value>(
  directory: string,
  name: RegExp,
  label: string,
  readOne: (path: string) => Promise<Value | undefined>,
): Promise<RecordFilesRead<Value>> => {
  const names = await listRecordNames(directory, name, label);
  const entries: RecordFileEntry<Value>[] = [];
  const gaps: ShadowRecordGap[] = [];

  for (const fileName of names) {
    const path = join(directory, fileName);

    try {
      // oxlint-disable-next-line no-await-in-loop -- Reading in name order keeps gap order stable.
      const regular = await isSingleRegularFile(path);

      if (!regular) {
        gaps.push({
          path,
          reason: `${capitalize(label)} ${path} is not a regular file with one link.`,
        });

        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- Reading in name order keeps gap order stable.
      const record = await readOne(path);

      if (record === undefined) {
        gaps.push({
          path,
          reason: `${capitalize(label)} ${path} disappeared before it could be read.`,
        });

        continue;
      }

      entries.push({ path, record });
    } catch (error) {
      gaps.push({ path, reason: errorMessage(error) });
    }
  }

  return { entries, gaps };
};
