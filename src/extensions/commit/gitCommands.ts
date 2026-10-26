import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { isMissingFile } from '../../errors.js';
import type { GitResult, runGit } from '../../git.js';
import { fixupSubjectSearchWord, selectFixupTargetReference } from './autosquash.js';
import { unknownPaths } from './fileRequests.js';
import type { FileRequest } from './fileRequests.js';
import { normalizeRepositoryPath } from './validation.js';

type GitRunner = typeof runGit;

interface ReadTextOptions {
  signal?: AbortSignal | undefined;
  timeout?: number | null;
}

const defaultTimeoutMilliseconds = 30_000;

export const decodeOutput = (result: GitResult): string => result.stdout.toString('utf8');

const failureText = (result: GitResult): string => result.stderr || decodeOutput(result);

export const readGitText = async (
  runner: GitRunner,
  workingDirectory: string,
  commandArguments: string[],
  options: ReadTextOptions = {},
): Promise<string> => {
  const result = await runner(workingDirectory, commandArguments, {
    timeoutMilliseconds:
      options.timeout === undefined ? defaultTimeoutMilliseconds : options.timeout,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (result.exitCode !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${failureText(result)}`);
  }

  return decodeOutput(result);
};

export const isCommitAncestor = async (
  runner: GitRunner,
  workingDirectory: string,
  target: string,
  head: string,
): Promise<boolean> => {
  const ancestor = await runner(workingDirectory, ['merge-base', '--is-ancestor', target, head], {
    timeoutMilliseconds: defaultTimeoutMilliseconds,
  });

  if (ancestor.exitCode === null || ancestor.exitCode > 1) {
    throw new Error(`Could not check fixup target ancestry: ${failureText(ancestor)}`);
  }

  return ancestor.exitCode === 0;
};

const scanFixupCandidates = async (
  runner: GitRunner,
  workingDirectory: string,
  subject: string,
  signal: AbortSignal | undefined,
): Promise<{ commitHash: string; subject: string }[]> => {
  const word = fixupSubjectSearchWord(subject);

  if (word === '') {
    return [];
  }

  // History size is unbounded; cancellation replaces a fixed scan deadline.
  const output = await readGitText(
    runner,
    workingDirectory,
    ['log', '--no-show-signature', '--format=%H%x00%s', '-F', `--grep=${word}`, 'HEAD', '--'],
    { timeout: null, signal },
  );

  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('\0');

      if (separator === -1) {
        throw new Error('Invalid fixup candidate record: missing subject separator.');
      }

      return { commitHash: line.slice(0, separator), subject: line.slice(separator + 1) };
    });
};

export const resolveFixupTarget = async (
  runner: GitRunner,
  workingDirectory: string,
  target: string,
  signal: AbortSignal | undefined,
): Promise<{ commitHash: string; reference: string }> => {
  const resolved = await runner(
    workingDirectory,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${target}^{commit}`],
    {
      timeoutMilliseconds: defaultTimeoutMilliseconds,
    },
  );

  if (resolved.exitCode !== 0) {
    throw new Error(`Fixup target does not resolve to a commit: ${target}`);
  }

  const commitHash = decodeOutput(resolved).trim();

  if (!(await isCommitAncestor(runner, workingDirectory, commitHash, 'HEAD'))) {
    throw new Error(`Fixup target is not an ancestor of HEAD: ${target}`);
  }

  const parents = await readGitText(runner, workingDirectory, [
    'log',
    '--no-show-signature',
    '-1',
    '--format=%P',
    commitHash,
  ]);

  if (parents.trim().split(' ').length > 1) {
    throw new Error(`Fixup target is a merge commit: ${target}`);
  }

  const subject = await readGitText(runner, workingDirectory, [
    'log',
    '--no-show-signature',
    '-1',
    '--format=%s',
    commitHash,
  ]);

  const candidates = await scanFixupCandidates(runner, workingDirectory, subject, signal);

  const reference = selectFixupTargetReference(subject.replace(/\n$/, ''), commitHash, candidates);

  return { commitHash, reference };
};

export const readIndex = (runner: GitRunner, workingDirectory: string): Promise<string> =>
  readGitText(runner, workingDirectory, ['ls-files', '--stage', '--debug', '-v', '-z']);

export const writeTree = async (
  runner: GitRunner,
  workingDirectory: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const tree = await readGitText(runner, workingDirectory, ['write-tree'], { signal });

  return tree.trim();
};

export const listStagedPaths = async (
  runner: GitRunner,
  workingDirectory: string,
): Promise<string[]> => {
  const output = await readGitText(
    runner,
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
  runner: GitRunner,
  workingDirectory: string,
  files: string[],
): Promise<string> =>
  readGitText(runner, workingDirectory, ['--literal-pathspecs', 'add', '--', ...files], {
    timeout: null,
  });

// Maps each repository path with an index entry to `mode,object,path` for `update-index --cacheinfo`.
export const readIndexEntries = async (
  runner: GitRunner,
  workingDirectory: string,
  files: string[],
): Promise<Map<string, string>> => {
  const output = await readGitText(
    runner,
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
  runner: GitRunner,
  workingDirectory: string,
  entries: string[],
  removedFiles: string[],
): Promise<string> =>
  readGitText(
    runner,
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
  runner: GitRunner,
  workingDirectory: string,
  files: string[],
): Promise<string> =>
  readGitText(runner, workingDirectory, ['--literal-pathspecs', 'reset', '--', ...files], {
    timeout: null,
  });

// Staged paths are repository-relative; requested paths are relative to the working directory.
// Outside a work tree, such as a bare repository's folder, the index lists unrelated paths.
export const repositoryPathPrefix = async (
  runner: GitRunner,
  workingDirectory: string,
): Promise<string> => {
  const output = await readGitText(
    runner,
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

export class HeadReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadReadError';
  }
}

const headReadError = (commandArguments: string[], result: GitResult): HeadReadError =>
  new HeadReadError(
    `git ${commandArguments.join(' ')} failed: ${failureText(result) || 'HEAD names no branch or commit'}`,
  );

export const currentHead = async (
  runner: GitRunner,
  workingDirectory: string,
): Promise<string | null> => {
  const verifyArguments = ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'];
  const verified = await runner(workingDirectory, verifyArguments, { timeoutMilliseconds: null });

  if (verified.exitCode === 0) {
    return decodeOutput(verified).trim();
  }

  if (verified.exitCode !== 1) {
    throw headReadError(verifyArguments, verified);
  }

  const branchArguments = ['symbolic-ref', '--quiet', 'HEAD'];
  const branch = await runner(workingDirectory, branchArguments, { timeoutMilliseconds: null });

  if (branch.exitCode !== 0) {
    throw headReadError(branchArguments, branch);
  }

  const branchName = decodeOutput(branch).trim();
  const referenceArguments = ['rev-parse', '--verify', '--quiet', branchName];

  const reference = await runner(workingDirectory, referenceArguments, {
    timeoutMilliseconds: null,
  });

  if (reference.exitCode === 0) {
    throw new HeadReadError(`HEAD names ${branchName}, which does not point to a commit`);
  }

  if (reference.exitCode !== 1) {
    throw headReadError(referenceArguments, reference);
  }

  return null;
};

export const listCommitPaths = async (
  runner: GitRunner,
  workingDirectory: string,
  commitHash: string,
): Promise<string[]> => {
  const output = await readGitText(
    runner,
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
