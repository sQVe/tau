import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isRecord } from '../../schema.js';

const run = promisify(execFile);

const hunkStart = /^@@ /m;

const differingOutput = (error: unknown): string => {
  if (isRecord(error) && error.code === 1 && typeof error.stdout === 'string') {
    return error.stdout;
  }

  throw error;
};

// `git diff --no-index` exits 1 when the files differ. The header names temporary files, so the
// result starts at the first hunk and gets a header with the reviewed path.
export const diffFiles = async (
  original: string,
  staged: string,
  path: string,
): Promise<string> => {
  const output = await run('git', [
    'diff',
    '--no-index',
    '--no-color',
    '--',
    original,
    staged,
  ]).then(
    ({ stdout }) => stdout,
    (error: unknown) => differingOutput(error),
  );

  const start = output.search(hunkStart);
  const hunks = start === -1 ? '' : output.slice(start);

  return `--- a/${path}\n+++ b/${path}\n${hunks}`;
};
