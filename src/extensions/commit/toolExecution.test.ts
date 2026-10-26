import { chmod } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  commitContext,
  createObservedCommitTool,
  createTemporaryRepository,
  executeCommit,
  getStoredCommitMessage,
  git,
  writeRepositoryFile,
} from './fixtures/commitTool.js';
import type { CommitInput } from './validation.js';

const installHook = async (directory: string, name: string, script: string): Promise<void> => {
  const hookPath = join('.git/hooks', name);

  await writeRepositoryFile(directory, hookPath, `#!/bin/sh\n${script}\n`);
  await chmod(join(directory, hookPath), 0o755);
};

const commitTracked = async (directory: string, file: string, content: string): Promise<void> => {
  await writeRepositoryFile(directory, file, content);
  await git(directory, ['add', file]);
  await git(directory, ['commit', '-m', 'chore: seed']);
};

describe('message bodies', () => {
  it.each([
    { name: 'no body', body: undefined, message: 'feat: a\n' },
    { name: 'an empty body', body: '', message: 'feat: a\n' },
    { name: 'a lone CR line ending', body: 'one\rtwo', message: 'feat: a\n\none\ntwo\n' },
  ])('stores the message for $name', async ({ body, message }) => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'a.txt', 'a');

    const group: CommitInput['groups'][number] = { files: ['a.txt'], subject: 'feat: a' };

    if (body !== undefined) {
      group.body = body;
    }

    const result = await executeCommit(directory, { groups: [group] });

    expect(await getStoredCommitMessage(directory)).toBe(message);
    expect(result.details.groups[0]?.subject).toBe('feat: a');
  });

  it('reports no body for a commit without one', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'a.txt', 'a');

    const result = await executeCommit(directory, {
      groups: [{ files: ['a.txt'], subject: 'feat: a' }],
    });

    expect(result.details.groups[0]?.body).toBeNull();
  });
});

describe('reports of hook-written messages', () => {
  it.each([
    {
      name: 'a subject without a line break',
      written: 'fix: rewritten',
      subject: 'fix: rewritten',
      body: null,
    },
    {
      name: 'a body right after the subject',
      written: 'fix: rewritten\nfirst\nsecond\n',
      subject: 'fix: rewritten',
      body: 'first\nsecond\n',
    },
    {
      name: 'a body after a blank line',
      written: 'fix: rewritten\n\nfirst\nsecond\n',
      subject: 'fix: rewritten',
      body: 'first\nsecond\n',
    },
  ])('splits $name', async ({ written, subject, body }) => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'a.txt', 'a');

    await installHook(
      directory,
      'commit-msg',
      `printf '${written.replaceAll('\n', '\\n')}' > "$1"`,
    );

    const result = await executeCommit(directory, {
      groups: [{ files: ['a.txt'], subject: 'feat: a' }],
    });

    expect(result.details.groups[0]).toMatchObject({
      subject,
      body,
      message: written,
      hookChanges: { message: true },
    });
  });

  it('reports the first commit when its message or author mentions a parent', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'a.txt', 'a');
    vi.stubEnv('GIT_AUTHOR_NAME', 'The parent abc');

    const result = await executeCommit(directory, {
      groups: [{ files: ['a.txt'], subject: 'feat: a', body: 'parent abc123' }],
    }).finally(() => vi.unstubAllEnvs());

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    expect(result.details.groups[0]?.sha).toBe(head);
  });
});

it('keeps a backslash in a committed file name', async () => {
  const directory = await createTemporaryRepository();
  await writeRepositoryFile(directory, String.raw`we\ird.txt`, 'a');

  const result = await executeCommit(directory, {
    groups: [{ files: [String.raw`we\ird.txt`], subject: 'feat: a' }],
  });

  expect(result.details.groups[0]?.files).toEqual([String.raw`we\ird.txt`]);
});

const fixupGroups: CommitInput = {
  groups: [{ files: ['a.txt'], fixup: { target: 'HEAD', kind: 'fixup' } }],
};

describe('fixup ancestry check', () => {
  it.each([
    { name: 'killed with exit code 0', result: { exitCode: null } },
    { name: 'failed with exit code 2', result: { exitCode: 2 } },
  ])('rejects a merge-base $name', async ({ result }) => {
    const directory = await createTemporaryRepository();
    await commitTracked(directory, 'a.txt', 'one\n');
    await writeRepositoryFile(directory, 'a.txt', 'two\n');

    const head = await git(directory, ['rev-parse', 'HEAD']);
    const index = await git(directory, ['ls-files', '--stage']);

    const tool = createObservedCommitTool({
      override: (commandArguments) =>
        commandArguments[0] === 'merge-base'
          ? { stdout: Buffer.alloc(0), stderr: 'merge-base broke', ...result }
          : undefined,
    });

    await expect(
      tool.execute('call', fixupGroups, undefined, undefined, commitContext(directory)),
    ).rejects.toThrow(/Could not check fixup target ancestry: merge-base broke/);

    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(directory, ['ls-files', '--stage'])).toBe(index);
  });
});

describe('index restore after a failed group', () => {
  it('restores the content a requested file had in the index', async () => {
    const directory = await createTemporaryRepository();
    await commitTracked(directory, 'a.txt', 'one\n');
    await writeRepositoryFile(directory, 'a.txt', 'staged\n');
    await git(directory, ['add', 'a.txt']);
    await writeRepositoryFile(directory, 'a.txt', 'working\n');
    await installHook(directory, 'pre-commit', 'exit 1');

    await expect(
      executeCommit(directory, { groups: [{ files: ['a.txt'], subject: 'feat: a' }] }),
    ).rejects.toThrow(/git commit failed/);

    expect(await git(directory, ['show', ':a.txt'])).toBe('staged\n');
    expect(await git(directory, ['rev-list', '--count', 'HEAD'])).toBe('1\n');
  });

  it('unstages a requested file that was not staged before', async () => {
    const directory = await createTemporaryRepository();
    await commitTracked(directory, 'a.txt', 'one\n');
    await writeRepositoryFile(directory, 'a.txt', 'working\n');
    await installHook(directory, 'pre-commit', 'exit 1');

    await expect(
      executeCommit(directory, { groups: [{ files: ['a.txt'], subject: 'feat: a' }] }),
    ).rejects.toThrow(/git commit failed/);

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await git(directory, ['diff', '--name-only'])).toBe('a.txt\n');
  });

  it('stages a deletion again when staging the request undid it', async () => {
    const directory = await createTemporaryRepository();
    await commitTracked(directory, 'a.txt', 'one\n');
    await git(directory, ['rm', '--cached', '--quiet', 'a.txt']);

    await expect(
      executeCommit(directory, { groups: [{ files: ['a.txt'], subject: 'feat: a' }] }),
    ).rejects.toThrow(/No staged changes/);

    expect(await git(directory, ['diff', '--cached', '--name-status'])).toBe('D\ta.txt\n');
  });
});

const expectUntouched = async (directory: string) => {
  expect(await git(directory, ['rev-list', '--count', 'HEAD'])).toBe('1\n');
  expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
};

describe('cancellation', () => {
  const singleGroup: CommitInput = { groups: [{ files: ['a.txt'], subject: 'feat: a' }] };

  const cancelledDetails = {
    sha: '',
    files: ['a.txt'],
    subject: 'feat: a',
    body: null,
  };

  const prepare = async () => {
    const directory = await createTemporaryRepository();
    await commitTracked(directory, 'a.txt', 'one\n');
    await writeRepositoryFile(directory, 'a.txt', 'two\n');

    return directory;
  };

  it('stops after staging the request and restores the index', async () => {
    const directory = await prepare();
    const controller = new AbortController();

    const tool = createObservedCommitTool({
      afterCommand: async (commandArguments) => {
        if (commandArguments.includes('add')) {
          controller.abort();
        }
      },
    });

    const result = await tool.execute(
      'call',
      singleGroup,
      controller.signal,
      undefined,
      commitContext(directory),
    );

    expect(result.details.groups).toEqual([cancelledDetails]);
    await expectUntouched(directory);
  });

  it('stops after the staged snapshot and restores the index', async () => {
    const directory = await prepare();
    const controller = new AbortController();

    const tool = createObservedCommitTool({
      afterCommand: async (commandArguments) => {
        if (commandArguments.join(' ') === 'rev-parse --verify --quiet HEAD^{commit}') {
          controller.abort();
        }
      },
    });

    const result = await tool.execute(
      'call',
      singleGroup,
      controller.signal,
      undefined,
      commitContext(directory),
    );

    expect(result.details.groups).toEqual([cancelledDetails]);
    await expectUntouched(directory);
  });

  it('reports cancellation before an error about the staging area', async () => {
    const directory = await prepare();
    const controller = new AbortController();
    await writeRepositoryFile(directory, 'other.txt', 'other\n');
    await git(directory, ['add', 'other.txt']);

    const tool = createObservedCommitTool({
      afterCommand: async (commandArguments) => {
        if (commandArguments.includes('--full-name')) {
          controller.abort();
        }
      },
    });

    const result = await tool.execute(
      'call',
      singleGroup,
      controller.signal,
      undefined,
      commitContext(directory),
    );

    expect(result.details.groups).toEqual([cancelledDetails]);
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('other.txt\n');
  });
});

describe('changes after the snapshot', () => {
  const singleGroup: CommitInput = { groups: [{ files: ['a.txt'], subject: 'feat: a' }] };

  const cancelAfterSnapshot = async (
    change: (directory: string) => Promise<void>,
  ): Promise<{ directory: string; outcome: Promise<unknown> }> => {
    const directory = await createTemporaryRepository();
    await commitTracked(directory, 'a.txt', 'one\n');
    await writeRepositoryFile(directory, 'a.txt', 'two\n');

    const controller = new AbortController();

    const tool = createObservedCommitTool({
      afterCommand: async (commandArguments) => {
        if (commandArguments.join(' ') === 'rev-parse --verify --quiet HEAD^{commit}') {
          controller.abort();
          await change(directory);
        }
      },
    });

    const outcome = tool.execute(
      'call',
      singleGroup,
      controller.signal,
      undefined,
      commitContext(directory),
    );

    return { directory, outcome };
  };

  it('leaves the index alone when another writer staged a file', async () => {
    const { directory, outcome } = await cancelAfterSnapshot(async (repository) => {
      await writeRepositoryFile(repository, 'other.txt', 'other\n');
      await git(repository, ['add', 'other.txt']);
    });

    await expect(outcome).rejects.toThrow(/Concurrent staging was left untouched/);

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('a.txt\nother.txt\n');
  });

  it('leaves the index alone when another writer moved HEAD', async () => {
    const { directory, outcome } = await cancelAfterSnapshot(async (repository) => {
      const moved = await git(repository, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'x']);

      await git(repository, ['update-ref', 'HEAD', moved.trim()]);
    });

    await expect(outcome).rejects.toThrow(/Concurrent staging was left untouched/);

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('a.txt\n');
  });
});

const prepareSeededRepository = async () => {
  const directory = await createTemporaryRepository();
  await writeRepositoryFile(directory, 'a.txt', 'one\n');
  await writeRepositoryFile(directory, 'other.txt', 'other\n');
  await git(directory, ['add', 'a.txt', 'other.txt']);
  await git(directory, ['commit', '-m', 'chore: seed']);

  return directory;
};

const snapshotIndexState = async (directory: string) => ({
  head: await git(directory, ['rev-parse', 'HEAD']),
  index: await git(directory, ['ls-files', '--stage']),
  flags: await git(directory, ['ls-files', '-v']),
});

describe('skip-worktree flags after a failed group', () => {
  it('keeps the flag of an unrelated file when a hook rejects the commit', async () => {
    const directory = await prepareSeededRepository();
    await git(directory, ['update-index', '--skip-worktree', 'other.txt']);
    await writeRepositoryFile(directory, 'a.txt', 'two\n');
    await installHook(directory, 'pre-commit', 'exit 1');

    const before = await snapshotIndexState(directory);

    await expect(
      executeCommit(directory, { groups: [{ files: ['a.txt'], subject: 'feat: a' }] }),
    ).rejects.toThrow(/git commit failed/);

    expect(await snapshotIndexState(directory)).toEqual({ ...before });
    expect(before.flags).toContain('S other.txt');
  });

  it('keeps the flag of a requested file when staging it fails', async () => {
    const directory = await prepareSeededRepository();
    await git(directory, ['update-index', '--skip-worktree', 'a.txt']);
    await writeRepositoryFile(directory, 'a.txt', 'two\n');

    const before = await snapshotIndexState(directory);

    await expect(
      executeCommit(directory, { groups: [{ files: ['a.txt'], subject: 'feat: a' }] }),
    ).rejects.toThrow(/failed/);

    expect(await snapshotIndexState(directory)).toEqual({ ...before });
    expect(before.flags).toContain('S a.txt');
  });
});
