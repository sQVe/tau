import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../../errors.js';
import { unknownPaths } from './fileRequests.js';
import type { FileRequest } from './fileRequests.js';
import { normalizeRepositoryPath } from './validation.js';

interface RunGitOptions {
  signal?: AbortSignal | undefined;
  timeout?: number | null;
}

const defaultTimeoutMilliseconds = 30_000;

export const runGit = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  commandArguments: string[],
  options: RunGitOptions = {},
): Promise<string> => {
  const result = await pi.exec('git', commandArguments, {
    cwd: workingDirectory,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout === null ? {} : { timeout: options.timeout ?? defaultTimeoutMilliseconds }),
  });

  if (result.code !== 0 || result.killed) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

export const readIndex = (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
): Promise<string> => runGit(pi, workingDirectory, ['ls-files', '--stage', '--debug', '-v', '-z']);

export const writeTree = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const tree = await runGit(pi, workingDirectory, ['write-tree'], { signal });

  return tree.trim();
};

export const listStagedPaths = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
): Promise<string[]> => {
  const output = await runGit(
    pi,
    workingDirectory,
    [
      'diff',
      '--cached',
      '--no-relative',
      '--no-renames',
      '--name-only',
      '--diff-filter=ACMRDT',
      '-z',
    ],
    { timeout: null },
  );

  return output
    .split('\0')
    .filter(Boolean)
    .map((file) => normalizeRepositoryPath(file));
};

export const validateFileRequests = async (
  workingDirectory: string,
  requests: Omit<FileRequest, 'exists'>[],
): Promise<void> => {
  const facts = await Promise.all(
    requests.map(async (request) => {
      const status = await lstat(join(workingDirectory, request.file)).catch((error: unknown) => {
        if (isMissingFile(error)) {
          return null;
        }

        throw error;
      });

      if (status?.isDirectory() === true) {
        throw new Error(
          `Directory requests are not supported: ${request.file}. Name each file explicitly.`,
        );
      }

      return { ...request, exists: status !== null };
    }),
  );

  const unknown = unknownPaths(facts);

  if (unknown.length > 0) {
    throw new Error(
      `Unknown paths: ${unknown.join(', ')}. Name only files that exist or that Git tracks.`,
    );
  }
};

// Literal pathspecs prevent glob expansion from staging unrequested files.
export const stageFiles = (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
): Promise<string> =>
  runGit(pi, workingDirectory, ['--literal-pathspecs', 'add', '--', ...files], {
    timeout: null,
  });

// Maps each repository path with an index entry to `mode,object,path` for `update-index --cacheinfo`.
export const readIndexEntries = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
): Promise<Map<string, string>> => {
  const output = await runGit(
    pi,
    workingDirectory,
    ['--literal-pathspecs', 'ls-files', '--stage', '--full-name', '-z', '--', ...files],
    { timeout: null },
  );

  return new Map(
    output
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [mode, object] = line.slice(0, tab).split(' ');
        const file = normalizeRepositoryPath(line.slice(tab + 1));

        return [file, `${mode},${object},${file}`] as const;
      }),
  );
};

export const restoreIndexEntries = (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  entries: string[],
  removedFiles: string[],
): Promise<string> =>
  runGit(
    pi,
    workingDirectory,
    [
      'update-index',
      '--add',
      ...entries.flatMap((entry) => ['--cacheinfo', entry]),
      '--force-remove',
      '--',
      ...removedFiles,
    ],
    { timeout: null },
  );

export const unstageFiles = (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  files: string[],
): Promise<string> =>
  runGit(pi, workingDirectory, ['--literal-pathspecs', 'reset', '--', ...files], {
    timeout: null,
  });

// Staged paths are repository-relative; requested paths are relative to the working directory.
// Outside a work tree, such as a bare repository's folder, the index lists unrelated paths.
export const repositoryPathPrefix = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
): Promise<string> => {
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
export const currentHead = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
): Promise<string | null> => {
  const result = await pi.exec('git', ['rev-parse', 'HEAD'], { cwd: workingDirectory });

  return result.code === 0 ? result.stdout.trim() : null;
};

export const listCommitPaths = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  commitHash: string,
): Promise<string[]> => {
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
