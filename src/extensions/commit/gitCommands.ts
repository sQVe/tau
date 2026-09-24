import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../../errors/index.js';
import { normalizeRepositoryPath } from './validation.js';

interface RunGitOptions {
  signal?: AbortSignal | undefined;
  timeout?: number | null;
}

export const runGit = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  commandArguments: string[],
  options: RunGitOptions = {},
) => {
  const result = await pi.exec('git', commandArguments, {
    cwd: workingDirectory,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout === null ? {} : { timeout: options.timeout ?? 30_000 }),
  });

  if (result.code !== 0 || result.killed) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

export const readIndex = (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) =>
  runGit(pi, workingDirectory, ['ls-files', '--stage', '--debug', '-v', '-z']);

export const writeTree = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  signal: AbortSignal | undefined,
) => {
  const tree = await runGit(pi, workingDirectory, ['write-tree'], { signal });

  return tree.trim();
};

export const listStagedPaths = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const output = await runGit(
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
        if (isMissingFile(error)) {
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
  runGit(pi, workingDirectory, ['--literal-pathspecs', 'add', '--', ...files], {
    timeout: null,
  });

export const unstageFiles = (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
) =>
  runGit(pi, workingDirectory, ['--literal-pathspecs', 'reset', '--', ...files], {
    timeout: null,
  });

// Staged paths are repository-relative; requested paths are relative to the working directory.
// Outside a work tree, such as a bare repository's folder, the index lists unrelated paths.
export const repositoryPathPrefix = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
) => {
  const output = await runGit(
    pi,
    workingDirectory,
    ['rev-parse', '--is-inside-work-tree', '--show-prefix'],
    { timeout: null },
  );
  // The prefix is a path, so only the first line break separates the two answers.
  const [insideWorkTree, ...prefixLines] = output.split('\n');

  if (insideWorkTree !== 'true') {
    throw new Error(
      `The session cwd (${workingDirectory}) is not a Git work tree. Commit from a session in the worktree that owns the files.`,
    );
  }

  return prefixLines.join('\n').replace(/\n$/, '');
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
  const output = await runGit(
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
