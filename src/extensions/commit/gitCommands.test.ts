import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { createTemporaryRepository, execInRequestedDirectory } from './fixtures/commitTool.js';
import {
  listCommitPaths,
  listStagedPaths,
  readIndexEntries,
  repositoryPathPrefix,
  restoreIndexEntries,
  stageFiles,
  unstageFiles,
  runGit,
} from './gitCommands.js';

const slowReadMilliseconds = 120_000;

// Finishes a command after `slowReadMilliseconds`, unless the caller sets an earlier deadline.
const slowGit = (stdout: string): Pick<ExtensionAPI, 'exec'> => ({
  exec: (_command, _commandArguments, options) =>
    new Promise((resolve) => {
      const deadline = options?.timeout;
      const killed = deadline !== undefined && deadline < slowReadMilliseconds;
      const resultOutput = killed ? '' : stdout;
      const completionDelay = killed ? deadline : slowReadMilliseconds;

      setTimeout(() => {
        resolve({ code: 0, killed, stdout: resultOutput, stderr: '' });
      }, completionDelay);
    }),
});

const slowReads = [
  {
    name: 'staged paths',
    read: (pi: Pick<ExtensionAPI, 'exec'>) => listStagedPaths(pi, '/repo'),
    stdout: 'a.txt\0b.txt\0',
    expected: ['a.txt', 'b.txt'],
  },
  {
    name: 'index entries',
    read: (pi: Pick<ExtensionAPI, 'exec'>) => readIndexEntries(pi, '/repo', ['a.txt']),
    stdout: '100644 abc 0\ta.txt\0',
    expected: new Map([['a.txt', '100644,abc,a.txt']]),
  },
  {
    name: 'commit paths',
    read: (pi: Pick<ExtensionAPI, 'exec'>) => listCommitPaths(pi, '/repo', 'abc'),
    stdout: 'a.txt\0',
    expected: ['a.txt'],
  },
  {
    name: 'the repository prefix',
    read: (pi: Pick<ExtensionAPI, 'exec'>) => repositoryPathPrefix(pi, '/repo'),
    stdout: 'true\nsub/\n',
    expected: 'sub/',
  },
  {
    name: 'a staging run',
    read: (pi: Pick<ExtensionAPI, 'exec'>) => stageFiles(pi, '/repo', ['a.txt']),
    stdout: 'staged',
    expected: 'staged',
  },
  {
    name: 'an unstaging run',
    read: (pi: Pick<ExtensionAPI, 'exec'>) => unstageFiles(pi, '/repo', ['a.txt']),
    stdout: 'unstaged',
    expected: 'unstaged',
  },
  {
    name: 'an index restore',
    read: (pi: Pick<ExtensionAPI, 'exec'>) =>
      restoreIndexEntries(pi, '/repo', ['100644,abc,a.txt'], []),
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

describe('runGit', () => {
  it('identifies the failing command after global Git options', async () => {
    const repositoryDirectory = await createTemporaryRepository();

    await expect(
      runGit(
        {
          exec: (command, commandArguments, options) =>
            execInRequestedDirectory(command, commandArguments, options),
        },
        repositoryDirectory,
        ['--literal-pathspecs', 'ls-tree', 'missing-tree'],
      ),
    ).rejects.toThrow('git --literal-pathspecs ls-tree missing-tree failed');
  });
});
