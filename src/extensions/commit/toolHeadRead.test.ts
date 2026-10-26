import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GitResult } from '../../git.js';
import {
  commitContext,
  createObservedCommitTool,
  createTemporaryRepository,
  git,
  writeRepositoryFile,
} from './fixtures/commitTool.js';
import type { CommitInput } from './validation.js';

const singleGroup: CommitInput = { groups: [{ files: ['a.txt'], subject: 'feat: a' }] };

const deniedRead: GitResult = {
  exitCode: 128,
  stdout: Buffer.alloc(0),
  stderr: 'fatal: unable to read HEAD: Permission denied\n',
};

const readsHead = (commandArguments: string[]): boolean =>
  commandArguments[0] === 'rev-parse' &&
  commandArguments.some((argument) => argument.startsWith('HEAD'));

describe('a failed HEAD read', () => {
  it('leaves staging untouched when the group fails after its snapshot', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'a.txt', 'one\n');
    await git(directory, ['add', 'a.txt']);
    await git(directory, ['commit', '-m', 'chore: seed']);
    await writeRepositoryFile(directory, 'a.txt', 'two\n');

    const controller = new AbortController();

    const tool = createObservedCommitTool({
      afterCommand: async (commandArguments) => {
        if (readsHead(commandArguments)) {
          controller.abort();
        }
      },
      override: (commandArguments) => (readsHead(commandArguments) ? deniedRead : undefined),
    });

    await expect(
      tool.execute('call', singleGroup, controller.signal, undefined, commitContext(directory)),
    ).rejects.toThrow(/rev-parse.*HEAD.* failed: fatal: unable to read HEAD: Permission denied/);

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('a.txt\n');
    expect(await git(directory, ['rev-list', '--count', 'HEAD'])).toBe('1\n');
  });

  it('leaves staging untouched after a failed first commit', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'a.txt', 'one\n');
    await writeRepositoryFile(directory, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    await chmod(join(directory, '.git/hooks/pre-commit'), 0o755);

    let commitRan = false;

    const tool = createObservedCommitTool({
      afterCommand: async (commandArguments) => {
        commitRan ||= commandArguments[0] === 'commit';
      },
      override: (commandArguments) =>
        commitRan && readsHead(commandArguments) ? deniedRead : undefined,
    });

    await expect(
      tool.execute('call', singleGroup, undefined, undefined, commitContext(directory)),
    ).rejects.toThrow(/rev-parse.*HEAD.* failed: fatal: unable to read HEAD: Permission denied/);

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('a.txt\n');
  });
});
