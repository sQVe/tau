import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, onTestFinished, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createTemporaryRepository as createRepository } from '../../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { runGit } from '../../../git.js';
import type { GitResult } from '../../../git.js';
import { createCommitTool } from '../tool.js';
import type { CommitInput } from '../validation.js';

type GitRunner = typeof runGit;

type CommitToolResult = ReturnType<ReturnType<typeof createCommitTool>['execute']>;

interface ObservedCommands {
  // Runs after each finished command, before the tool sees its result.
  afterCommand?: (commandArguments: string[]) => Promise<void>;
  // Replaces the real result of a command when it returns one.
  override?: (commandArguments: string[]) => GitResult | undefined;
}

interface FakeCommit {
  custom: Mock<() => never>;
  editor: Mock<() => never>;
  runner: Mock<GitRunner>;
  context: {
    cwd: string;
    hasUI: boolean;
    ui: { custom: Mock<() => never>; editor: Mock<() => never> };
  };
  input: CommitInput;
  execute: (signal?: AbortSignal) => CommitToolResult;
  gitDirectory: string;
}

const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.restoreAllMocks();

  await Promise.all(repositoryCleanups.splice(0).map((cleanup) => cleanup()));
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

const repositoryCleanups: (() => Promise<void>)[] = [];

export const createTemporaryRepository = (): Promise<string> =>
  createRepository((cleanup) => {
    repositoryCleanups.push(cleanup);
  }, 'tau-commit-');

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

export const commitContext = (repositoryDirectory: string): ExtensionToolContext =>
  ({
    cwd: repositoryDirectory,
    hasUI: true,
    ui: {
      custom: () => {
        throw new Error('Unexpected approval UI');
      },
    },
  }) as unknown as ExtensionToolContext;

export const createObservedCommitTool = (
  observed: ObservedCommands,
): ReturnType<typeof createCommitTool> =>
  createCommitTool(async (cwd, commandArguments, options) => {
    const result = await runGit(cwd, commandArguments, options);

    await observed.afterCommand?.(commandArguments);

    return observed.override?.(commandArguments) ?? result;
  });

export const executeCommit = async (
  repositoryDirectory: string,
  input: CommitInput,
): CommitToolResult => {
  const commitTool = createCommitTool(runGit);

  return commitTool.execute(
    'tool-call-1',
    input,
    undefined,
    undefined,
    commitContext(repositoryDirectory),
  );
};

export const fakeCommit = (): FakeCommit => {
  const gitDirectory = temporaryDirectory(onTestFinished, 'tau-mock-git-');

  const custom = vi.fn<() => never>(() => {
    throw new Error('Unexpected approval UI');
  });

  const editor = vi.fn<() => never>(() => {
    throw new Error('Unexpected message editor');
  });

  let storedMessage = '';
  let stagedFiles: string[] = [];

  const runner = vi.fn<GitRunner>(async (_cwd, commandArguments) => {
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

    if (commandArguments.includes('ls-files') && commandArguments.includes('--full-name')) {
      const files = commandArguments.slice(commandArguments.indexOf('--') + 1);

      stdout = files.map((file) => `100644 abc123 0\t${file}\0`).join('');
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

    return { exitCode: 0, stderr: '', stdout: Buffer.from(stdout) };
  });

  const tool = createCommitTool(runner);
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

  return { custom, editor, runner, context, input, execute, gitDirectory };
};
