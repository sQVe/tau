import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, vi } from 'vitest';

import { initializeRepository } from '../../../../tests/gitRepository.js';
import type { reviewComments } from '../commentReview.js';
import { createCommitTool as createReviewedCommitTool } from '../tool.js';
import type { CommitInput } from '../validation.js';

// Git tests use a clean reviewer.
// tests/commitFlow.integration.test.ts covers real Pi review.
export const createCommitTool = (pi: Pick<ExtensionAPI, 'exec'>) =>
  createReviewedCommitTool(pi, async () => ({ findings: [] }));

const execFileAsync = promisify(execFile);

// Vitest isolates this module and its cleanup hook per test file.
export const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export const runCommand = async (
  command: string,
  commandArguments: string[],
  workingDirectory: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArguments, {
      cwd: workingDirectory,
      ...(signal ? { signal } : {}),
    });

    return { stdout, stderr, code: 0, killed: false };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
      signal?: string | null;
    };

    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      code: failure.code ?? 1,
      killed: failure.killed === true || typeof failure.signal === 'string',
    };
  }
};

export const git = async (
  repositoryDirectory: string,
  commandArguments: string[],
): Promise<string> => {
  const result = await runCommand('git', commandArguments, repositoryDirectory);

  if (result.code !== 0) {
    throw new Error(`git ${commandArguments.join(' ')} failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout;
};

export const createTemporaryRepository = async (): Promise<string> => {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), 'tau-commit-'));
  temporaryDirectories.push(repositoryDirectory);

  await initializeRepository(repositoryDirectory);

  return repositoryDirectory;
};

export const writeRepositoryFile = async (
  repositoryDirectory: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const fullPath = join(repositoryDirectory, relativePath);

  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
};

export const getStoredCommitMessage = async (repositoryDirectory: string): Promise<string> => {
  const commitObject = await git(repositoryDirectory, ['cat-file', '-p', 'HEAD']);
  const separatorIndex = commitObject.indexOf('\n\n');

  if (separatorIndex === -1) {
    throw new Error('Could not locate commit message in git cat-file output');
  }

  return commitObject.slice(separatorIndex + 2);
};

export const commitContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: true,
    ui: {
      custom: () => {
        throw new Error('Unexpected approval UI');
      },
    },
  }) as never;

export const noUiContext = (repositoryDirectory: string) =>
  ({
    cwd: repositoryDirectory,
    hasUI: false,
    ui: {},
  }) as never;

export const executeCommit = async (repositoryDirectory: string, input: CommitInput) => {
  const commitTool = createCommitTool({
    exec(command: string, commandArguments: string[], options?: { cwd?: string }) {
      return runCommand(command, commandArguments, options?.cwd ?? repositoryDirectory);
    },
  });

  return commitTool.execute(
    'tool-call-1',
    input,
    undefined,
    undefined,
    commitContext(repositoryDirectory),
  );
};

export const fakeCommit = () => {
  const gitDirectory = mkdtempSync(join(tmpdir(), 'tau-mock-git-'));
  temporaryDirectories.push(gitDirectory);

  const custom = vi.fn<() => never>(() => {
    throw new Error('Unexpected approval UI');
  });
  const editor = vi.fn<() => never>(() => {
    throw new Error('Unexpected message editor');
  });

  let storedMessage = '';
  let stagedFiles: string[] = [];
  const exec = vi.fn<ExtensionAPI['exec']>(async (_command, commandArguments) => {
    let stdout = '';

    if (commandArguments.includes('add')) {
      stagedFiles = commandArguments.slice(commandArguments.indexOf('--') + 1);
    }

    if (commandArguments[0] === 'diff' && commandArguments.includes('--cached')) {
      stdout = stagedFiles.map((file) => `${file}\0`).join('');
    }

    if (commandArguments[0] === 'commit') {
      storedMessage = await readFile(commandArguments.at(-1)!, 'utf8');
      stagedFiles = [];
    }

    if (commandArguments.includes('reset')) {
      stagedFiles = [];
    }

    if (commandArguments[0] === 'cat-file') {
      stdout = `tree abc123\nparent abc123\n\n${storedMessage}`;
    }

    if (commandArguments[0] === 'rev-parse' || commandArguments[0] === 'write-tree') {
      stdout = commandArguments.includes('--absolute-git-dir') ? `${gitDirectory}\n` : 'abc123\n';
    }

    if (commandArguments.includes('--show-prefix')) {
      stdout = 'true\n\n';
    }

    return { code: 0, killed: false, stderr: '', stdout };
  });
  const review = vi.fn<typeof reviewComments>().mockResolvedValue({ findings: [] });
  const tool = createReviewedCommitTool({ exec }, review);
  const context = { cwd: '/repo', hasUI: true, ui: { custom, editor } };
  const input = {
    groups: [
      {
        files: ['README.md'],
        subject: 'feat: add thing',
        body: 'Original body',
      },
    ],
  };

  const execute = (signal?: AbortSignal) =>
    tool.execute('call', input, signal, undefined, context as never);

  return { custom, editor, exec, context, input, execute, review, gitDirectory };
};
