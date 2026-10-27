import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { configurationGlobs } from './config.js';
import type { TddConfig } from './config.js';
import { closesLoop, createInputRules } from './inputGlob.js';

const isVanishedEntry = (error: unknown) => isMissingFile(error) || hasErrorCode(error, 'ENOTDIR');

const isDanglingLink = (error: unknown) => isMissingFile(error) || hasErrorCode(error, 'ELOOP');

const readDirectory = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isVanishedEntry(error)) {
      return [];
    }

    throw error;
  }
};

const readLink = async <Result>(read: () => Promise<Result>): Promise<Result | null> => {
  try {
    return await read();
  } catch (error) {
    if (isDanglingLink(error)) {
      return null;
    }

    throw error;
  }
};

export const listInputs = async (cwd: string, config: TddConfig): Promise<string[]> => {
  const includeGlobs = [
    ...config.productionGlobs,
    ...config.testGlobs,
    ...config.testSupportGlobs,
    ...configurationGlobs,
  ];

  const rules = createInputRules(includeGlobs, config.excludedGlobs);
  const inputs: string[] = [];

  // A symlinked directory is entered unless its real path is one of its own ancestors.
  const realDirectory = async (directory: string, entry: Dirent, parentReal: string) => {
    if (entry.isDirectory()) {
      return join(parentReal, entry.name);
    }

    if (!entry.isSymbolicLink()) {
      return null;
    }

    const target = await readLink(() => realpath(resolve(cwd, directory, entry.name)));
    const info = target === null ? null : await readLink(() => stat(target));

    return info?.isDirectory() === true ? target : null;
  };

  const visit = async (
    directory: string,
    ancestors: ReadonlySet<string>,
    real: string,
  ): Promise<void> => {
    const entries = await readDirectory(resolve(cwd, directory));

    await Promise.all(
      entries.map(async (entry) => {
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`;

        // A path that is neither listed nor entered is not resolved, so its link cannot fail the
        // walk on a target it does not need.
        if (!rules.isInput(path) && !rules.entersDirectory(path)) {
          return;
        }

        const childReal = await realDirectory(directory, entry, real);

        if (childReal === null) {
          if (rules.isInput(path)) {
            inputs.push(path);
          }
        } else if (rules.entersDirectory(path) && !closesLoop(childReal, ancestors)) {
          await visit(path, new Set([...ancestors, childReal]), childReal);
        }
      }),
    );
  };

  const root = await realpath(cwd);

  await visit('', new Set([root]), root);

  return inputs;
};

// Content is checked at bounded checkpoints, not as an atomic snapshot.
export const fingerprintInputs = async (
  cwd: string,
  config: TddConfig,
  files: string[],
): Promise<string> => {
  const paths = [...files, ...(await listInputs(cwd, config))];

  const digest = createHash('sha256');

  const entries = await Promise.all(
    [...new Set(paths.map((path) => resolve(cwd, path)))].toSorted().map(async (file) => {
      try {
        const content = await readFile(file);

        return [file, createHash('sha256').update(content).digest('hex')];
      } catch (error) {
        // A symlink to a directory is listed as a file but cannot be hashed.
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
};
