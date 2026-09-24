import type * as fileSystem from 'node:fs/promises';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  temporaryDirectories,
  runCommand,
  git,
  createTemporaryRepository,
  writeRepositoryFile,
  getStoredCommitMessage,
  commitContext,
  executeCommit,
  fakeCommit,
} from './fixtures/commitTool.js';
import { createCommitTool } from './tool.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>();

  return {
    ...original,
    rm: vi.fn<typeof rm>(original.rm),
  };
});

describe('message policy', () => {
  it('preserves normalized whitespace without Git cleanup', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: requested  ', body: '# keep  \r\n\r\n' }],
    });

    expect(await getStoredCommitMessage(directory)).toBe('feat: requested  \n\n# keep  \n\n');
    expect(JSON.stringify(result.content)).toContain('Git hooks: run');
  });

  it('commits and reports the actual hook-rewritten message', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');
    await writeRepositoryFile(
      directory,
      '.git/hooks/commit-msg',
      '#!/bin/sh\nprintf "fix: rewritten\\n\\nHook body  \\n" > "$1"\n',
    );
    await chmod(join(directory, '.git/hooks/commit-msg'), 0o755);

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: requested' }],
    });

    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('1\n');
    expect(await getStoredCommitMessage(directory)).toBe('fix: rewritten\n\nHook body  \n');
    expect(result.details.groups[0]).toMatchObject({
      subject: 'fix: rewritten',
      body: 'Hook body  \n',
      message: 'fix: rewritten\n\nHook body  \n',
      files: ['requested'],
      hookChanges: { files: [], message: true },
    });
    expect(JSON.stringify(result.content)).toContain('Hook changed the commit message');
  });

  it('keeps earlier group hashes when a message hook stops a batch', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'first', 'value');
    await writeRepositoryFile(directory, 'second', 'value');
    await writeRepositoryFile(
      directory,
      '.git/hooks/commit-msg',
      '#!/bin/sh\nif grep -q second "$1"; then echo invalid message >&2; exit 1; fi\n',
    );
    await chmod(join(directory, '.git/hooks/commit-msg'), 0o755);

    const failure = await executeCommit(directory, {
      groups: [
        { files: ['first'], subject: 'feat: first' },
        { files: ['second'], subject: 'feat: second' },
      ],
    }).catch((error: unknown) => String(error));

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    expect(failure).toContain(`Group 1/2: ${head} feat: first`);
    expect(failure).toContain('Group 2/2: git commit failed:\ninvalid message');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it.each(['group failure', 'cancellation'])(
    'keeps successful hashes and %s when temporary cleanup fails',
    async (outcome) => {
      const directory = await createTemporaryRepository();
      await writeRepositoryFile(directory, 'first', 'value');
      await writeRepositoryFile(directory, 'second', 'value');
      const original = await vi.importActual<typeof fileSystem>('node:fs/promises');
      const controller = new AbortController();
      let stagings = 0;
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (String(path).includes('tau-commit-message-')) {
          temporaryDirectories.push(String(path));

          throw new Error('cleanup denied');
        }

        await original.rm(path, options);
      });
      const tool = createCommitTool({
        exec: (command, argumentsList, options) => {
          if (argumentsList.includes('add')) {
            stagings += 1;

            if (stagings === 2) {
              if (outcome === 'group failure') {
                return Promise.resolve({
                  code: 1,
                  killed: false,
                  stdout: '',
                  stderr: 'primary group failure',
                });
              }

              controller.abort();
            }
          }

          return runCommand(command, argumentsList, options?.cwd ?? directory);
        },
      });

      try {
        const first = await tool.execute(
          'first',
          {
            groups: [{ files: ['first'], subject: 'feat: first' }],
          },
          undefined,
          undefined,
          commitContext(directory),
        );
        const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

        expect(first.details.groups[0]?.sha).toBe(head);
        expect(JSON.stringify(first.content)).toContain('cleanup denied');

        const second = await tool
          .execute(
            'second',
            {
              groups: [{ files: ['second'], subject: 'feat: second' }],
            },
            controller.signal,
            undefined,
            commitContext(directory),
          )
          .catch((error: unknown) => String(error));

        const report = JSON.stringify(second);

        expect(report).toContain(
          outcome === 'group failure' ? 'primary group failure' : 'Commit cancelled',
        );
        expect(report).toContain('cleanup denied');
        expect((await git(directory, ['rev-parse', 'HEAD'])).trim()).toBe(head);
        expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
      } finally {
        vi.mocked(rm).mockImplementation(original.rm);
      }
    },
  );

  it('rejects NUL in every group before any Git operation', async () => {
    const { exec, context } = fakeCommit();
    const tool = createCommitTool({ exec });

    for (const invalid of [
      { subject: 'feat: bad\0hidden' },
      { subject: 'feat: good', body: 'bad\0hidden' },
    ]) {
      await expect(
        tool.execute(
          'nul',
          {
            groups: [
              { files: ['one'], subject: 'feat: one' },
              { files: ['two'], ...invalid },
            ],
          },
          undefined,
          undefined,
          context as never,
        ),
      ).rejects.toThrow(/NUL/);
    }

    expect(exec).not.toHaveBeenCalled();
  });
});
