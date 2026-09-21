import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { reviewGit } from './commentReview.js';
import { normalizeRepositoryPath } from './validation.js';

export const listStagedPaths = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const output = await reviewGit(
    pi,
    workingDirectory,
    ['diff', '--cached', '--no-relative', '--name-only', '--diff-filter=ACMRDT', '-z'],
    { timeout: null },
  );

  return output
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeRepositoryPath(file));
};

export const validateFileRequests = async (workingDirectory: string, files: string[]) => {
  await Promise.all(
    files.map(async (file) => {
      const status = await lstat(join(workingDirectory, file)).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });

      if (status?.isDirectory()) {
        throw new Error(
          `Directory requests are not supported: ${file}. Name each file explicitly.`,
        );
      }
    }),
  );
};

// Literal pathspecs prevent glob expansion from staging unrequested files.
export const stageFiles = (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
) =>
  reviewGit(pi, workingDirectory, ['--literal-pathspecs', 'add', '--', ...files], {
    timeout: null,
  });

export const unstageFiles = (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
) =>
  reviewGit(pi, workingDirectory, ['--literal-pathspecs', 'reset', '--', ...files], {
    timeout: null,
  });

// Staged paths are repository-relative; requested paths are relative to the working directory.
export const repositoryPathPrefix = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
) => {
  const output = await reviewGit(pi, workingDirectory, ['rev-parse', '--show-prefix'], {
    timeout: null,
  });

  return output.replace(/\n$/, '');
};

// HEAD is unresolved before the first commit.
export const currentHead = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const result = await pi.exec('git', ['rev-parse', 'HEAD'], { cwd: workingDirectory });

  return result.code === 0 ? result.stdout.trim() : null;
};

export const listCommitPaths = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  commitHash: string,
) => {
  const output = await reviewGit(
    pi,
    workingDirectory,
    [
      'diff-tree',
      '--root',
      '--diff-merges=first-parent',
      '--no-relative',
      '-r',
      '--no-commit-id',
      '--no-renames',
      '--name-only',
      '-z',
      commitHash,
    ],
    { timeout: null },
  );

  return output
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeRepositoryPath(file));
};
