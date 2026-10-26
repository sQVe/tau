import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runGit } from '../../git.js';
import {
  commitContext,
  createTemporaryRepository,
  executeCommit,
  fakeCommit,
  git,
  writeRepositoryFile,
} from './fixtures/commitTool.js';
import { createCommitTool } from './tool.js';

describe('direct commit staging', () => {
  it('preserves untimed wrappers and bounded Git calls', async () => {
    const { execute, runner } = fakeCommit();
    const signal = new AbortController().signal;

    await execute(signal);

    const untimedCalls = runner.mock.calls.filter(([, argumentsList]) => {
      const queryFlags =
        argumentsList.includes('--show-prefix') || argumentsList.includes('--cached');

      const commands = argumentsList.includes('add') || argumentsList[0] === 'diff-tree';

      return queryFlags || commands;
    });

    expect(untimedCalls).toHaveLength(7);

    for (const call of untimedCalls) {
      expect(call[0]).toBe('/repo');
      expect(call[2]).toEqual({ timeoutMilliseconds: null });
    }

    for (const command of ['ls-files', 'write-tree', 'cat-file']) {
      const calls = runner.mock.calls.filter(([, argumentsList]) => argumentsList[0] === command);

      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        expect(call[0]).toBe('/repo');

        expect(call[2]).toEqual({
          timeoutMilliseconds: 30_000,
          ...(command === 'write-tree' ? { signal } : {}),
        });
      }
    }

    const headCalls = runner.mock.calls.filter(
      ([, argumentsList]) =>
        argumentsList[0] === 'rev-parse' && argumentsList.at(-1)?.startsWith('HEAD') === true,
    );

    const hookDiff = runner.mock.calls.find(
      ([, argumentsList]) => argumentsList[0] === 'diff' && !argumentsList.includes('--cached'),
    );

    const snapshotHeadCalls = headCalls.slice(0, -1);

    expect(snapshotHeadCalls.length).toBeGreaterThan(0);

    for (const call of snapshotHeadCalls) {
      expect(call[2]).toEqual({ timeoutMilliseconds: null });
    }

    expect(headCalls.at(-1)?.[2]).toEqual({ timeoutMilliseconds: 30_000 });
    expect(hookDiff?.[2]).toEqual({ timeoutMilliseconds: 30_000 });
  });

  it('stops and unstages when Git staging is killed despite a zero exit code', async () => {
    const { execute, runner } = fakeCommit();
    const executeGit = runner.getMockImplementation()!;

    runner.mockImplementation(async (cwd, argumentsList, options) => {
      const result = await executeGit(cwd, argumentsList, options);

      return argumentsList.includes('add')
        ? { ...result, exitCode: null, stderr: 'staging interrupted' }
        : result;
    });

    await expect(execute()).rejects.toThrow('staging interrupted');

    expect(runner.mock.calls.some((call) => call[1][0] === 'commit')).toBe(false);

    expect(runner).toHaveBeenLastCalledWith(
      '/repo',
      ['--literal-pathspecs', 'reset', '--', 'README.md'],
      { timeoutMilliseconds: null },
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

  it('commits from a cwd whose name contains a newline', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'part\nrest/requested', 'requested');

    await executeCommit(join(directory, 'part\nrest'), {
      groups: [{ files: ['requested'], subject: 'feat: requested' }],
    });

    expect(await git(directory, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])).toBe(
      'part\nrest/requested\0',
    );
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
    ).rejects.toThrow(`(${container})`);

    expect(await git(join(container, 'feature'), ['status', '--porcelain'])).toBe('?? requested\n');
    expect(await git(container, ['rev-list', '--all', '--count'])).toBe('1\n');
  });

  it('preserves concurrent staging before the candidate snapshot', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'requested');
    await writeRepositoryFile(directory, 'other', 'working bytes');

    const tool = createCommitTool(async (cwd, argumentsList, options) => {
      const result = await runGit(cwd, argumentsList, options);

      if (argumentsList.includes('add')) {
        await writeRepositoryFile(directory, 'other', 'staged bytes');
        await git(directory, ['add', 'other']);
        await writeRepositoryFile(directory, 'other', 'working bytes');
      }

      return result;
    });

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

    const tool = createCommitTool(runGit);

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

    const tool = createCommitTool(async (cwd, argumentsList, options) => {
      if (argumentsList.includes('reset')) {
        return { stdout: Buffer.alloc(0), stderr: 'reset denied', exitCode: 1 };
      }

      if (argumentsList[0] === 'write-tree') {
        return { stdout: Buffer.alloc(0), stderr: 'snapshot exploded', exitCode: 1 };
      }

      return runGit(cwd, argumentsList, options);
    });

    const failure = await tool
      .execute(
        'group-error',
        { groups: [{ files: ['requested'], subject: 'feat: requested' }] },
        undefined,
        undefined,
        commitContext(directory),
      )
      .catch((error: unknown) => String(error));

    expect(failure).toContain('snapshot exploded');
    expect(failure).toContain('reset denied');
  });

  it('commits requested files without changing unrelated working and untracked files', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'other', 'original\n');
    await git(directory, ['add', 'other']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    await writeRepositoryFile(directory, 'other', 'working edit\n');
    await writeRepositoryFile(directory, 'untracked', 'keep me\n');
    await writeRepositoryFile(directory, 'requested', 'requested bytes\n');

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: direct staging' }],
    });

    expect(result.details.groups[0]?.sha).toBe(
      (await git(directory, ['rev-parse', 'HEAD'])).trim(),
    );

    expect(await git(directory, ['show', 'HEAD:requested'])).toBe('requested bytes\n');
    expect(await readFile(join(directory, 'other'), 'utf8')).toBe('working edit\n');
    expect(await readFile(join(directory, 'untracked'), 'utf8')).toBe('keep me\n');
  });
});
