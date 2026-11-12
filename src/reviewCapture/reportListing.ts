import { join } from 'node:path';

import { existingEntry } from '../tauDirectory.js';
import { reportFileNames } from './reports.js';

const isRegularFile = async (path: string) => {
  const entry = await existingEntry(path);

  return entry?.isFile() === true;
};

export const listReports = async (directory: string): Promise<string[]> => {
  const exists = await Promise.all(
    reportFileNames.map((name) => isRegularFile(join(directory, name))),
  );

  return reportFileNames.filter((_, index) => exists[index] === true);
};
