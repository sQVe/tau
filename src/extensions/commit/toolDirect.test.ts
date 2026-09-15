import { chmod, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  commitContext,
  createTemporaryRepository,
  executeCommit,
  git,
  runCommand,
  writeRepositoryFile,
} from '../../../tests/commitTool.js';
import { createCommitTool } from './tool.js';

describe('direct commit staging', () => {
  it('rejects duplicate group paths before staging', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'working');

    await expect(
      executeCommit(directory, {
        groups: [
          { files: ['requested'], subject: 'feat: one' },
          { files: ['./requested'], subject: 'feat: two' },
        ],
      }),
    ).rejects.toThrow(/assigned.*multiple groups/i);

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('working');
  });

  it('reports earlier commits and preserves concurrent staging during a later review', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'first', 'first');
    await writeRepositoryFile(directory, 'second', 'second');
    let reviews = 0;
    const tool = createCommitTool(
      {
        exec: (command, arguments_, options) =>
          runCommand(command, arguments_, options?.cwd ?? directory),
      },
      async () => {
        reviews += 1;

        if (reviews === 2) {
          await writeRepositoryFile(directory, 'second', 'concurrent');
          await git(directory, ['add', 'second']);
        }

        return { findings: [] };
      },
    );

    const failure = await tool
      .execute(
        'batch',
        {
          groups: [
            { files: ['first'], subject: 'feat: first' },
            { files: ['second'], subject: 'feat: second' },
          ],
        },
        undefined,
        undefined,
        commitContext(directory),
      )
      .catch((error: unknown) => String(error));
    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    expect(failure).toContain(`Group 1/2: ${head} feat: first`);
    expect(failure).toContain('Concurrent staging was left untouched');
    expect(await git(directory, ['show', ':second'])).toBe('concurrent');
  });
  it('ignores obsolete commands and commits without creating recovery data', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'other', 'original\n');
    await git(directory, ['add', 'other']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    await writeRepositoryFile(directory, 'other', 'working edit\n');
    await writeRepositoryFile(directory, 'untracked', 'keep me\n');
    await writeRepositoryFile(directory, 'requested', 'requested bytes\n');
    await writeRepositoryFile(
      directory,
      'tau.json',
      JSON.stringify({
        prepare: ['sh', '-c', 'exit 81'],
        check: ['sh', '-c', 'exit 82'],
        checkMessage: ['sh', '-c', 'exit 83'],
      }),
    );
    const before = await readdir(join(directory, '.git'));

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested', 'tau.json'], subject: 'feat: direct staging' }],
    });

    expect(result.details.groups[0]?.sha).toBe(
      (await git(directory, ['rev-parse', 'HEAD'])).trim(),
    );
    expect(await git(directory, ['show', 'HEAD:requested'])).toBe('requested bytes\n');
    expect(await readFile(join(directory, 'other'), 'utf8')).toBe('working edit\n');
    expect(await readFile(join(directory, 'untracked'), 'utf8')).toBe('keep me\n');
    expect(await readdir(join(directory, '.git'))).toEqual(before);
    expect(await git(directory, ['for-each-ref', '--format=%(refname)'])).not.toContain('recovery');
    expect(result.details.groups[0]).not.toHaveProperty('projectCheck');
    expect(result.details.groups[0]).not.toHaveProperty('messageCheck');
  });

  it('runs installed hooks even when obsolete configuration requests skipping them', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'tau.json', '{"hooks":"skip"}');
    await writeRepositoryFile(directory, 'requested', 'value');
    await writeRepositoryFile(
      directory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\necho hook diagnostic >&2\nexit 1\n',
    );
    await chmod(join(directory, '.git/hooks/pre-commit'), 0o755);

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested', 'tau.json'], subject: 'feat: run hooks' }],
      }),
    ).rejects.toThrow('hook diagnostic');

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    expect((await git(directory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });
});
