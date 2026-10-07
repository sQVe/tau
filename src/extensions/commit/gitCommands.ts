import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../../errors.js';
import { fixupSubjectSearchWord, selectFixupTargetReference } from './autosquash.js';
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

export const isCommitAncestor = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  target: string,
  head: string,
): Promise<boolean> => {
  const ancestor = await pi.exec('git', ['merge-base', '--is-ancestor', target, head], {
    cwd: workingDirectory,
    timeout: defaultTimeoutMilliseconds,
  });

  if (ancestor.killed || ancestor.code > 1) {
    throw new Error(`Could not check fixup target ancestry: ${ancestor.stderr || ancestor.stdout}`);
  }

  return ancestor.code === 0;
};

const scanFixupCandidates = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  subject: string,
  signal: AbortSignal | undefined,
): Promise<{ commitHash: string; subject: string }[]> => {
  const word = fixupSubjectSearchWord(subject);

  if (word === '') {
    return [];
  }

  // History size is unbounded; cancellation replaces a fixed scan deadline.
  const output = await runGit(
    pi,
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
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  target: string,
  signal: AbortSignal | undefined,
): Promise<{ commitHash: string; reference: string }> => {
  const resolved = await pi.exec(
    'git',
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${target}^{commit}`],
    { cwd: workingDirectory, timeout: defaultTimeoutMilliseconds },
  );

  if (resolved.code !== 0 || resolved.killed) {
    throw new Error(`Fixup target does not resolve to a commit: ${target}`);
  }

  const commitHash = resolved.stdout.trim();

  if (!(await isCommitAncestor(pi, workingDirectory, commitHash, 'HEAD'))) {
    throw new Error(`Fixup target is not an ancestor of HEAD: ${target}`);
  }

  const parents = await runGit(pi, workingDirectory, [
    'log',
    '--no-show-signature',
    '-1',
    '--format=%P',
    commitHash,
  ]);

  if (parents.trim().split(' ').length > 1) {
    throw new Error(`Fixup target is a merge commit: ${target}`);
  }

  const subject = await runGit(pi, workingDirectory, [
    'log',
    '--no-show-signature',
    '-1',
    '--format=%s',
    commitHash,
  ]);

  const candidates = await scanFixupCandidates(pi, workingDirectory, subject, signal);

  const reference = selectFixupTargetReference(subject.replace(/\n$/, ''), commitHash, candidates);

  return { commitHash, reference };
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
