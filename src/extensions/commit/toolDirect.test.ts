import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  commitContext,
  createTemporaryRepository,
  executeCommit,
  fakeCommit,
  git,
  runCommand,
  writeRepositoryFile,
} from '../../../tests/commitTool.js';
import { createCommitTool } from './tool.js';

describe('direct commit staging', () => {
  it('preserves untimed wrappers and bounded review calls', async () => {
    const { execute, exec } = fakeCommit();
    const signal = new AbortController().signal;

    await execute(signal);

    const untimedCalls = exec.mock.calls.filter(([, argumentsList]) => {
      const queryFlags =
        argumentsList.includes('--show-prefix') || argumentsList.includes('--cached');
      const commands = argumentsList.includes('add') || argumentsList[0] === 'diff-tree';

      return queryFlags || commands;
    });

    expect(untimedCalls).toHaveLength(5);

    for (const call of untimedCalls) {
      expect(call[2]).toEqual({ cwd: '/repo' });
    }

    for (const command of ['ls-files', 'write-tree', 'cat-file']) {
      const calls = exec.mock.calls.filter(([, argumentsList]) => argumentsList[0] === command);

      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        expect(call[2]).toEqual({
          cwd: '/repo',
          timeout: 30_000,
          ...(command === 'write-tree' ? { signal } : {}),
        });
      }
    }

    const headCalls = exec.mock.calls.filter(
      ([, argumentsList]) => argumentsList[0] === 'rev-parse' && argumentsList[1] === 'HEAD',
    );
    const hookDiff = exec.mock.calls.find(
      ([, argumentsList]) => argumentsList[0] === 'diff' && !argumentsList.includes('--cached'),
    );

    expect(headCalls.at(-1)?.[2]).toEqual({ cwd: '/repo', timeout: 30_000 });
    expect(hookDiff?.[2]).toEqual({ cwd: '/repo', timeout: 30_000 });
  });

  it('stops and unstages when Git staging is killed despite a zero exit code', async () => {
    const { execute, exec, review } = fakeCommit();
    const executeGit = exec.getMockImplementation()!;

    exec.mockImplementation(async (command, argumentsList, options) => {
      const result = await executeGit(command, argumentsList, options);

      return argumentsList.includes('add')
        ? { ...result, killed: true, stderr: 'staging interrupted' }
        : result;
    });

    await expect(execute()).rejects.toThrow('staging interrupted');

    expect(review).not.toHaveBeenCalled();
    expect(exec.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);
    expect(exec).toHaveBeenLastCalledWith(
      'git',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { cwd: '/repo' },
    );
  });

  it('preserves unrelated staging outside nested cwd with relative diffs enabled', async () => {
    const directory = await createTemporaryRepository();
    await git(directory, ['config', 'diff.relative', 'true']);
    await writeRepositoryFile(directory, 'sub/requested', 'requested');
    await writeRepositoryFile(directory, 'other', 'staged bytes');
    await git(directory, ['add', 'other']);
    await writeRepositoryFile(directory, 'other', 'working bytes');

    await expect(
      executeCommit(join(directory, 'sub'), {
        groups: [{ files: ['requested'], subject: 'feat: requested' }],
      }),
    ).rejects.toThrow('other paths are already staged: other');

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('other\n');
    expect(await git(directory, ['show', ':other'])).toBe('staged bytes');
    expect(await readFile(join(directory, 'other'), 'utf8')).toBe('working bytes');
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('0\n');
  });

  it('refuses early when the session cwd is not a work tree', async () => {
    const source = await createTemporaryRepository();
    await writeRepositoryFile(source, 'tracked', 'tracked');
    await git(source, ['add', 'tracked']);
    await git(source, ['commit', '--quiet', '-m', 'initial']);
    const container = await createTemporaryRepository();
    await git(container, ['clone', '--quiet', '--bare', source, '.bare']);
    await rm(join(container, '.git'), { recursive: true });
    await writeFile(join(container, '.git'), 'gitdir: .bare\n');
    await git(container, ['worktree', 'add', '--quiet', 'feature']);
    await writeRepositoryFile(join(container, 'feature'), 'requested', 'requested');

    await expect(
      executeCommit(container, {
        groups: [{ files: ['feature/requested'], subject: 'feat: requested' }],
      }),
    ).rejects.toThrow(/not a Git work tree.*session in the worktree that owns the files/);

    expect(await git(join(container, 'feature'), ['status', '--porcelain'])).toBe('?? requested\n');
    expect(await git(container, ['rev-list', '--all', '--count'])).toBe('1\n');
  });

  it('preserves concurrent staging before the candidate snapshot', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'requested');
    await writeRepositoryFile(directory, 'other', 'working bytes');
    const tool = createCommitTool(
      {
        exec: async (command, argumentsList, options) => {
          const result = await runCommand(command, argumentsList, options?.cwd ?? directory);

          if (argumentsList.includes('add')) {
            await writeRepositoryFile(directory, 'other', 'staged bytes');
            await git(directory, ['add', 'other']);
            await writeRepositoryFile(directory, 'other', 'working bytes');
          }

          return result;
        },
      },
      async () => ({ findings: [] }),
    );

    await expect(
      tool.execute(
        'concurrent',
        {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        },
        undefined,
        undefined,
        commitContext(directory),
      ),
    ).rejects.toThrow(/Concurrent staging was left untouched/);

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('other\nrequested\n');
    expect(await git(directory, ['show', ':other'])).toBe('staged bytes');
    expect(await readFile(join(directory, 'other'), 'utf8')).toBe('working bytes');
    expect((await git(directory, ['rev-list', '--all', '--count'])).trim()).toBe('0');
  });

  it('commits and reports hook-added paths outside a nested working directory', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'baseline', 'baseline');
    await git(directory, ['add', 'baseline']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();
    await git(directory, ['config', 'diff.relative', 'true']);
    await writeRepositoryFile(directory, 'sub/requested', 'requested');
    await writeRepositoryFile(directory, 'root.txt', 'root');
    await writeRepositoryFile(directory, 'sibling/extra', 'sibling');
    await writeRepositoryFile(directory, 'sub/extra', 'local');
    await writeRepositoryFile(
      directory,
      '.git/hooks/pre-commit',
      '#!/bin/sh\ngit add -- root.txt sibling/extra sub/extra\n',
    );
    await chmod(join(directory, '.git/hooks/pre-commit'), 0o755);
    const tool = createCommitTool(
      {
        exec: (command, argumentsList, options) =>
          runCommand(command, argumentsList, options?.cwd ?? directory),
      },
      async () => ({ findings: [] }),
    );

    const result = await tool.execute(
      'nested',
      { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
      undefined,
      undefined,
      commitContext(join(directory, 'sub')),
    );

    expect((await git(directory, ['rev-parse', 'HEAD^'])).trim()).toBe(head);
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    expect(result.details.groups[0]).toMatchObject({
      files: ['root.txt', 'sibling/extra', 'sub/extra', 'sub/requested'],
      hookChanges: { files: ['root.txt', 'sibling/extra', 'sub/extra'], message: false },
    });
    expect(JSON.stringify(result.content)).toContain(
      'Hook changed paths: root.txt, sibling/extra, sub/extra',
    );
    expect(await git(directory, ['show', 'HEAD:root.txt'])).toBe('root');
    expect(await git(directory, ['show', 'HEAD:sibling/extra'])).toBe('sibling');
    expect(await git(directory, ['show', 'HEAD:sub/extra'])).toBe('local');
    expect(await readFile(join(directory, 'root.txt'), 'utf8')).toBe('root');
    expect(await readFile(join(directory, 'sibling/extra'), 'utf8')).toBe('sibling');
    expect(await readFile(join(directory, 'sub/extra'), 'utf8')).toBe('local');
  });

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

  it('keeps the group error when unstaging after it also fails', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'working');
    const tool = createCommitTool(
      {
        exec: async (command, argumentsList, options) =>
          argumentsList.includes('reset')
            ? { stdout: '', stderr: 'reset denied', code: 1, killed: false }
            : runCommand(command, argumentsList, options?.cwd ?? directory),
      },
      () => Promise.reject(new Error('review exploded')),
    );

    const failure = await tool
      .execute(
        'group-error',
        { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
        undefined,
        undefined,
        commitContext(directory),
      )
      .catch((error: unknown) => String(error));

    expect(failure).toContain('review exploded');
    expect(failure).toContain('reset denied');
  });

  it('reports earlier commits and preserves concurrent staging during a later review', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'first', 'first');
    await writeRepositoryFile(directory, 'second', 'second');
    let reviews = 0;
    const tool = createCommitTool(
      {
        exec: (command, argumentsList, options) =>
          runCommand(command, argumentsList, options?.cwd ?? directory),
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
