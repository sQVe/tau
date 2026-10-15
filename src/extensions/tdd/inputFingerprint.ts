import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { configurationGlobs } from './config.js';
import type { TddConfig } from './config.js';
import { createInputRules } from './inputGlob.js';
import type { PatternScope } from './inputGlob.js';

const unreadableDirectoryCodes = ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'];

const isUnreadableDirectory = (error: unknown) =>
  isMissingFile(error) || unreadableDirectoryCodes.some((code) => hasErrorCode(error, code));

const readDirectory = async (directory: string) => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isUnreadableDirectory(error)) {
      return [];
    }

    throw error;
  }
};

const listInputs = async (cwd: string, config: TddConfig): Promise<string[]> => {
  const includeGlobs = [
    ...config.productionGlobs,
    ...config.testGlobs,
    ...config.testSupportGlobs,
    ...configurationGlobs,
  ];

  const rules = createInputRules(includeGlobs, config.excludedGlobs);
  const inputs: string[] = [];

  const linkedScope = async (directory: string, path: string, scope?: PatternScope) => {
    const naming = rules.followsLink(path, scope);

    if (naming === null) {
      return null;
    }

    const name = path.slice(path.lastIndexOf('/') + 1);
    const target = await stat(resolve(cwd, directory, name)).catch(() => null);

    return target?.isDirectory() === true ? naming : null;
  };

  const visit = async (directory: string, scope?: PatternScope): Promise<void> => {
    const entries = await readDirectory(resolve(cwd, directory));

    await Promise.all(
      entries.map(async (entry) => {
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
        const linked = entry.isSymbolicLink() ? await linkedScope(directory, path, scope) : null;
        const isDirectory = entry.isDirectory() || linked !== null;

        if (isDirectory) {
          if (rules.entersDirectory(entry.name, path)) {
            await visit(path, linked ?? scope);
          }
        } else if (rules.isInput(path, scope)) {
          inputs.push(path);
        }
      }),
    );
  };

  await visit('');

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
