import { describe, expect, it, vi } from 'vitest';

import { runGit } from '../../git.js';
import type { GitResult } from '../../git.js';
import { createTemporaryRepository } from './fixtures/commitTool.js';
import {
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

describe('readGitText', () => {
  it('identifies the failing command after global Git options', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await expect(
      readGitText(runGit, repositoryDirectory, ['--literal-pathspecs', 'ls-tree', 'missing-tree']),
    ).rejects.toThrow('git --literal-pathspecs ls-tree missing-tree failed');
  });
});
