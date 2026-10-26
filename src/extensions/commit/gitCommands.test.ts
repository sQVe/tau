import { describe, expect, it, vi } from 'vitest';

import { runGit } from '../../git.js';
import type { GitResult } from '../../git.js';
import { createTemporaryRepository } from './fixtures/commitTool.js';
import {
  currentHead,
  listCommitPaths,
  listStagedPaths,
  readIndexEntries,
  repositoryPathPrefix,
  restoreIndexEntries,
  stageFiles,
  readGitText,
  unstageFiles,
} from './gitCommands.js';

const slowReadMilliseconds = 120_000;

// Finishes a command after `slowReadMilliseconds`, unless the caller sets an earlier deadline.
const slowGit =
  (stdout: string): typeof runGit =>
  (_cwd, _commandArguments, options) =>
    new Promise<GitResult>((resolve) => {
      const deadline = options?.timeoutMilliseconds;
      const timedOut = typeof deadline === 'number' && deadline < slowReadMilliseconds;
      const resultOutput = timedOut ? '' : stdout;
      const completionDelay = timedOut ? deadline : slowReadMilliseconds;

      setTimeout(() => {
        resolve({
          exitCode: timedOut ? null : 0,
          stdout: Buffer.from(resultOutput),
          stderr: '',
        });
      }, completionDelay);
    });

const slowReads = [
  {
    name: 'staged paths',
    read: (runner: typeof runGit) => listStagedPaths(runner, '/repo'),
    stdout: 'a.txt\0b.txt\0',
    expected: ['a.txt', 'b.txt'],
  },
  {
    name: 'index entries',
    read: (runner: typeof runGit) => readIndexEntries(runner, '/repo', ['a.txt']),
    stdout: '100644 abc 0\ta.txt\0',
    expected: new Map([['a.txt', '100644,abc,a.txt']]),
  },
  {
    name: 'commit paths',
    read: (runner: typeof runGit) => listCommitPaths(runner, '/repo', 'abc'),
    stdout: 'a.txt\0',
    expected: ['a.txt'],
  },
  {
    name: 'the repository prefix',
    read: (runner: typeof runGit) => repositoryPathPrefix(runner, '/repo'),
    stdout: 'true\nsub/\n',
    expected: 'sub/',
  },
  {
    name: 'a staging run',
    read: (runner: typeof runGit) => stageFiles(runner, '/repo', ['a.txt']),
    stdout: 'staged',
    expected: 'staged',
  },
  {
    name: 'an unstaging run',
    read: (runner: typeof runGit) => unstageFiles(runner, '/repo', ['a.txt']),
    stdout: 'unstaged',
    expected: 'unstaged',
  },
  {
    name: 'an index restore',
    read: (runner: typeof runGit) => restoreIndexEntries(runner, '/repo', ['100644,abc,a.txt'], []),
    stdout: 'restored',
    expected: 'restored',
  },
];

describe('slow index operations', () => {
  it.each(slowReads)('finishes $name that outlasts the default deadline', async (slowRead) => {
    vi.useFakeTimers();

    try {
      const outcome = slowRead.read(slowGit(slowRead.stdout));

      await vi.advanceTimersByTimeAsync(slowReadMilliseconds);

      expect(await outcome).toEqual(slowRead.expected);
    } finally {
      vi.useRealTimers();
    }
  });
});

const failingHeadRead =
  (result: Pick<GitResult, 'exitCode' | 'stderr'>): typeof runGit =>
  async () => ({ ...result, stdout: Buffer.from('partial') });

const unresolvedHeadGit: typeof runGit = async () => ({
  exitCode: 1,
  stdout: Buffer.alloc(0),
  stderr: '',
});

describe('currentHead', () => {
  it('reads the HEAD commit', async () => {
    const repositoryDirectory = await createTemporaryRepository();
    await runGit(repositoryDirectory, ['commit', '--allow-empty', '-m', 'chore: seed']);

    const expected = await runGit(repositoryDirectory, ['rev-parse', 'HEAD']);

    expect(await currentHead(runGit, repositoryDirectory)).toBe(
      expected.stdout.toString('utf8').trim(),
    );
  });

  it('reads no HEAD on an unborn branch', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    expect(await currentHead(runGit, repositoryDirectory)).toBeNull();
  });

  it.each([
    { name: 'a failed read', exitCode: 128, stderr: 'fatal: Permission denied' },
    { name: 'a killed read', exitCode: null, stderr: 'git was killed' },
  ])('reports $name with Git stderr', async ({ exitCode, stderr }) => {
    await expect(currentHead(failingHeadRead({ exitCode, stderr }), '/repo')).rejects.toThrow(
      stderr,
    );
  });

  it('reports a HEAD that names neither a commit nor a branch', async () => {
    await expect(currentHead(unresolvedHeadGit, '/repo')).rejects.toThrow(
      'git symbolic-ref --quiet HEAD failed: HEAD names no branch or commit',
    );
  });
});

describe('readGitText', () => {
  it('identifies the failing command after global Git options', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await expect(
      readGitText(runGit, repositoryDirectory, ['--literal-pathspecs', 'ls-tree', 'missing-tree']),
    ).rejects.toThrow('git --literal-pathspecs ls-tree missing-tree failed');
  });
});
