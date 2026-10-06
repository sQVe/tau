import { createHash } from 'node:crypto';
import { glob, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { configurationGlobs } from './config.js';
import type { TddConfig } from './config.js';

// Content is checked at bounded checkpoints, not as an atomic snapshot.
export const fingerprintInputs = async (
  cwd: string,
  config: TddConfig,
  files: string[],
): Promise<string | null> => {
  try {
    const paths = [...files];

    // Bun, which runs Pi, rejects the `withFileTypes` option of `glob`.
    for await (const file of glob(
      [
        ...config.productionGlobs,
        ...config.testGlobs,
        ...config.testSupportGlobs,
        ...configurationGlobs,
      ],
      { cwd, exclude: config.excludedGlobs },
    )) {
      paths.push(file);
    }

    const digest = createHash('sha256');

    const entries = await Promise.all(
      [...new Set(paths.map((path) => resolve(cwd, path)))].toSorted().map(async (file) => {
        try {
          const content = await readFile(file);

          return [file, createHash('sha256').update(content).digest('hex')];
        } catch (error) {
          // A glob such as `src/**` also matches directories, which cannot be hashed.
          if (hasErrorCode(error, 'EISDIR')) {
            return null;
          }

          if (!isMissingFile(error)) {
            throw error;
          }

          return [file, null];
        }
      }),
    );

    digest.update(JSON.stringify(entries.filter((entry) => entry !== null)));

    return digest.digest('hex');
  } catch {
    // A reminder must not discard a test report or turn a successful edit into an error.
    return null;
  }
};
