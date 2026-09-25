import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  commitContext,
  createTemporaryRepository,
  executeCommit,
  git,
  runCommand,
  writeRepositoryFile,
} from './fixtures/commitTool.js';
import { createCommitTool } from './tool.js';

const installHook = async (directory: string, name: string, script: string) => {
  const path = `.git/hooks/${name}`;

  await writeRepositoryFile(directory, path, `#!/bin/sh\n${script}\n`);
  await chmod(join(directory, path), 0o755);
};

const createPendingMerge = async () => {
  const directory = await createTemporaryRepository();
  await writeRepositoryFile(directory, 'base', 'base');
  await git(directory, ['add', 'base']);
  await git(directory, ['commit', '-m', 'test: base']);
  await git(directory, ['checkout', '-b', 'side']);
  await writeRepositoryFile(directory, 'second', 'second');
  await git(directory, ['add', 'second']);
  await git(directory, ['commit', '-m', 'test: side']);
  await git(directory, ['checkout', '-']);
  await writeRepositoryFile(directory, 'main-only', 'main');
  await git(directory, ['add', 'main-only']);
  await git(directory, ['commit', '-m', 'test: main']);
  await git(directory, ['merge', '--no-commit', '--no-ff', 'side']);
  await git(directory, ['reset', '--', 'second']);
  await writeRepositoryFile(directory, 'first', 'first');

  return directory;
};

describe('hook outcomes', () => {
  it('reports pending merge paths against the first parent', async () => {
    const directory = await createPendingMerge();

    const result = await executeCommit(directory, {
      groups: [{ files: ['first', 'second'], subject: 'feat: merge' }],
    });

    expect(result.details.groups[0]!.files).toEqual(['first', 'second']);

    expect(
      (await git(directory, ['show', '-s', '--format=%P', 'HEAD'])).trim().split(' '),
    ).toHaveLength(2);
  });

  it('stops a later group consumed by a merge hook', async () => {
    const directory = await createPendingMerge();

    await installHook(
      directory,
      'pre-commit',
      'echo invocation >> generated; git add generated second',
    );

    const failure = await executeCommit(directory, {
      groups: [
        { files: ['first'], subject: 'feat: merge' },
        { files: ['second'], subject: 'feat: second' },
      ],
    }).catch((error: unknown) => String(error));

    expect(failure).toContain('already committed by an earlier hook');
    expect(await readFile(join(directory, 'generated'), 'utf8')).toBe('invocation\n');
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('4\n');
    expect(await git(directory, ['show', 'HEAD:second'])).toBe('second');
  });

  it('rejects an empty candidate before hooks', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');
    await git(directory, ['add', 'requested']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    const head = await git(directory, ['rev-parse', 'HEAD']);
    await installHook(directory, 'pre-commit', 'echo invocation >> generated; git add generated');

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested'], subject: 'feat: unchanged' }],
      }),
    ).rejects.toThrow('No staged changes');

    await expect(readFile(join(directory, 'generated'))).rejects.toThrow(/ENOENT/);
    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await git(directory, ['status', '--short'])).toBe('');
  });

  it.each([false, true])(
    'does not attribute a concurrent commit before hash capture to this group: %s',
    async (hasParent) => {
      const directory = await createTemporaryRepository();

      if (hasParent) {
        await writeRepositoryFile(directory, 'base', 'base');
        await git(directory, ['add', 'base']);
        await git(directory, ['commit', '-m', 'test: baseline']);
      }

      await writeRepositoryFile(directory, 'requested', 'value');
      let concurrentHead = '';

      const tool = createCommitTool({
        exec: async (command, argumentsList, options) => {
          const result = await runCommand(command, argumentsList, options?.cwd ?? directory);

          if (argumentsList[0] === 'commit') {
            await writeRepositoryFile(directory, 'other', 'other');
            await git(directory, ['add', 'other']);
            await git(directory, ['commit', '-m', 'test: concurrent writer']);
            concurrentHead = (await git(directory, ['rev-parse', 'HEAD'])).trim();
            await writeRepositoryFile(directory, 'other', 'staged edit');
            await git(directory, ['add', 'other']);
          }

          return result;
        },
      });

      const failure = await tool
        .execute(
          'race',
          {
            groups: [{ files: ['requested'], subject: 'feat: requested' }],
          },
          undefined,
          undefined,
          commitContext(directory),
        )
        .catch((error: unknown) => String(error));

      expect(failure).toContain('HEAD changed');
      expect(failure).toContain('Git commit succeeded.');
      expect(failure).not.toContain(`Git commit succeeded: ${concurrentHead}`);
      expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(`${concurrentHead}\n`);
      expect(await git(directory, ['show', ':other'])).toBe('staged edit');
      expect(await git(directory, ['show', 'HEAD^:requested'])).toBe('value');
    },
  );

  it('preserves raw hook output when unstaging fails', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');

    await installHook(
      directory,
      'commit-msg',
      'printf "  subject-empty  \\n"; printf "  commitlint rejected  \\n" >&2; exit 1',
    );

    const tool = createCommitTool({
      exec: (command, argumentsList, options) =>
        argumentsList.includes('reset')
          ? Promise.resolve({ code: 1, killed: false, stdout: '', stderr: 'index locked\n' })
          : runCommand(command, argumentsList, options?.cwd ?? directory),
    });

    const failure = await tool
      .execute(
        'failure',
        {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        },
        undefined,
        undefined,
        commitContext(directory),
      )
      .catch((error: unknown) => String(error));

    expect(failure).toContain('  subject-empty  \n  commitlint rejected  \n');
    expect(failure).toContain('index locked');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('requested\n');
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('0\n');
  });

  it('unstages only requested paths after a hook edits and stages files then fails', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');

    await installHook(
      directory,
      'pre-commit',
      'printf formatted > requested; printf generated > extra; git add requested extra; echo failed >&2; exit 1',
    );

    await expect(
      executeCommit(directory, {
        groups: [{ files: ['requested'], subject: 'feat: requested' }],
      }),
    ).rejects.toThrow('failed');

    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('extra\n');
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('formatted');
    expect(await git(directory, ['show', ':extra'])).toBe('generated');
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('0\n');
  });

  it('leaves concurrent HEAD and staging untouched after a failed commit', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');
    await writeRepositoryFile(directory, 'other', 'other');

    const tool = createCommitTool({
      exec: async (command, argumentsList, options) => {
        if (argumentsList[0] === 'commit') {
          await git(directory, ['commit', '-m', 'test: concurrent writer']);
          await git(directory, ['add', 'other']);

          return { code: 1, killed: false, stdout: 'raw output\n', stderr: 'raw error\n' };
        }

        return runCommand(command, argumentsList, options?.cwd ?? directory);
      },
    });

    const failure = await tool
      .execute(
        'failure',
        {
          groups: [{ files: ['requested'], subject: 'feat: requested' }],
        },
        undefined,
        undefined,
        commitContext(directory),
      )
      .catch((error: unknown) => String(error));

    expect(failure).toContain('raw output\nraw error\n');
    expect(failure).toContain('HEAD changed');
    expect(await git(directory, ['log', '-1', '--format=%s'])).toBe('test: concurrent writer\n');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('other\n');
  });

  it.each(['rev-parse', 'diff-tree', 'cat-file', 'diff'])(
    'reports commit success when post-commit %s fails',
    async (failingCommand) => {
      const directory = await createTemporaryRepository();
      await writeRepositoryFile(directory, 'requested', 'value');
      let committed = false;

      const tool = createCommitTool({
        exec: async (command, argumentsList, options) => {
          if (committed && argumentsList[0] === failingCommand) {
            return { code: 1, killed: false, stdout: '', stderr: 'report unavailable' };
          }

          const result = await runCommand(command, argumentsList, options?.cwd ?? directory);

          if (argumentsList[0] === 'commit') {
            committed = true;
          }

          return result;
        },
      });

      const failure = await tool
        .execute(
          'report',
          {
            groups: [{ files: ['requested'], subject: 'feat: requested' }],
          },
          undefined,
          undefined,
          commitContext(directory),
        )
        .catch((error: unknown) => String(error));

      const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

      expect(failure).toContain('Git commit succeeded');
      expect(failure).toContain('report unavailable');
      expect(failure).toContain('Do not retry this group');

      expect(failure).toContain(
        failingCommand === 'rev-parse' || failingCommand === 'cat-file' ? head.slice(0, 7) : head,
      );

      expect(await git(directory, ['show', 'HEAD:requested'])).toBe('value');
      expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    },
  );

  it('warns about sensitive paths committed by a hook without undoing them', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');
    await installHook(directory, 'pre-commit', 'printf private > .env; git add .env');

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: requested' }],
    });

    expect(result.details.groups[0]!.files).toEqual(['.env', 'requested']);
    expect(JSON.stringify(result.content)).toContain('Warning: committed sensitive paths: .env');
    expect(await git(directory, ['show', 'HEAD:.env'])).toBe('private');
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('1\n');
  });

  it('reports files removed from the candidate and added by a hook', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');

    await installHook(
      directory,
      'pre-commit',
      'git rm --cached requested; printf generated > extra; git add extra',
    );

    const result = await executeCommit(directory, {
      groups: [{ files: ['requested'], subject: 'feat: requested' }],
    });

    expect(result.details.groups[0]).toMatchObject({
      files: ['extra'],
      hookChanges: { files: ['extra', 'requested'], message: false },
    });

    expect(await git(directory, ['show', 'HEAD:extra'])).toBe('generated');
    expect(await readFile(join(directory, 'requested'), 'utf8')).toBe('value');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
  });

  it('pins reporting to the commit hash without changing later HEAD or staging', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'requested', 'value');
    await writeRepositoryFile(directory, 'other', 'other');
    let commitHash = '';
    let concurrentHead = '';

    const tool = createCommitTool({
      exec: async (command, argumentsList, options) => {
        if (argumentsList[0] === 'diff-tree') {
          commitHash = argumentsList.at(-1)!;
          await git(directory, ['add', 'other']);
          await git(directory, ['commit', '-m', 'test: concurrent writer']);
          concurrentHead = (await git(directory, ['rev-parse', 'HEAD'])).trim();
          await writeRepositoryFile(directory, 'other', 'staged edit');
          await git(directory, ['add', 'other']);
        }

        return runCommand(command, argumentsList, options?.cwd ?? directory);
      },
    });

    const result = await tool.execute(
      'report',
      {
        groups: [{ files: ['requested'], subject: 'feat: requested' }],
      },
      undefined,
      undefined,
      commitContext(directory),
    );

    expect(result.details.groups[0]).toMatchObject({
      sha: commitHash,
      subject: 'feat: requested',
      files: ['requested'],
      hookChanges: { files: [], message: false },
    });

    expect(await git(directory, ['rev-parse', 'HEAD'])).toBe(`${concurrentHead}\n`);
    expect(await git(directory, ['show', ':other'])).toBe('staged edit');
  });

  it('stops remaining groups when an earlier hook fully consumed the next group', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'first', 'first');
    await writeRepositoryFile(directory, 'second', 'second');
    await writeRepositoryFile(directory, 'third', 'third');

    await installHook(
      directory,
      'pre-commit',
      'echo invocation >> generated; git add generated second',
    );

    const failure = await executeCommit(directory, {
      groups: [
        { files: ['first'], subject: 'feat: first' },
        { files: ['second'], subject: 'feat: second' },
        { files: ['third'], subject: 'feat: third' },
      ],
    }).catch((error: unknown) => String(error));

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    expect(failure).toContain('already committed by an earlier hook');
    expect(failure).toContain(`Group 1/3: ${head} feat: first`);
    expect(failure).toContain('Hook changed paths: generated, second');
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('1\n');
    expect(await git(directory, ['show', 'HEAD:second'])).toBe('second');
    expect(await readFile(join(directory, 'generated'), 'utf8')).toBe('invocation\n');
    expect(await readFile(join(directory, 'third'), 'utf8')).toBe('third');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await git(directory, ['status', '--short'])).toBe('?? third\n');
  });

  it('stops a consumed group that also requests an unchanged tracked file', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'unchanged', 'baseline');
    await git(directory, ['add', 'unchanged']);
    await git(directory, ['commit', '-m', 'test: baseline']);
    await writeRepositoryFile(directory, 'first', 'first');
    await writeRepositoryFile(directory, 'second', 'second');
    await writeRepositoryFile(directory, 'third', 'third');

    await installHook(
      directory,
      'pre-commit',
      'echo invocation >> generated; git add generated second',
    );

    const failure = await executeCommit(directory, {
      groups: [
        { files: ['first'], subject: 'feat: first' },
        { files: ['second', 'unchanged'], subject: 'feat: second' },
        { files: ['third'], subject: 'feat: third' },
      ],
    }).catch((error: unknown) => String(error));

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    expect(failure).toContain('Requested changes were already committed by an earlier hook');
    expect(failure).toContain(`Group 1/3: ${head} feat: first`);
    expect(failure).toContain('Hook changed paths: generated, second');
    expect(await git(directory, ['rev-list', '--all', '--count'])).toBe('2\n');
    expect(await git(directory, ['show', 'HEAD:unchanged'])).toBe('baseline');
    expect(await readFile(join(directory, 'generated'), 'utf8')).toBe('invocation\n');
    expect(await readFile(join(directory, 'third'), 'utf8')).toBe('third');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    expect(await git(directory, ['status', '--short'])).toBe('?? third\n');
  });

  it.each([false, true])(
    'commits remaining changes after hook overlap with new working changes: %s',
    async (partialOverlap) => {
      const directory = await createTemporaryRepository();
      await writeRepositoryFile(directory, 'first', 'first');
      await writeRepositoryFile(directory, 'second', 'second');
      await writeRepositoryFile(directory, 'third', 'third');

      await installHook(
        directory,
        'pre-commit',
        'if [ ! -f .git/hook-ran ]; then git add second; printf new > second; touch .git/hook-ran; fi',
      );

      const result = await executeCommit(directory, {
        groups: [
          { files: ['first'], subject: 'feat: first' },
          {
            files: partialOverlap ? ['second', 'third'] : ['second'],
            subject: 'feat: remaining',
          },
        ],
      });

      expect(result.details.groups).toHaveLength(2);
      expect(await git(directory, ['show', 'HEAD:second'])).toBe('new');
      expect(await git(directory, ['show', 'HEAD^:second'])).toBe('second');

      expect(result.details.groups[1]!.files).toEqual(
        partialOverlap ? ['second', 'third'] : ['second'],
      );

      expect(await git(directory, ['ls-tree', '--name-only', 'HEAD', '--', 'third'])).toBe(
        partialOverlap ? 'third\n' : '',
      );

      expect(await readFile(join(directory, 'third'), 'utf8')).toBe('third');

      expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
    },
  );

  it('reports hook deltas for earlier commits when a later group fails', async () => {
    const directory = await createTemporaryRepository();
    await writeRepositoryFile(directory, 'first', 'first');
    await writeRepositoryFile(directory, 'second', 'second');
    await installHook(directory, 'pre-commit', 'printf generated > extra; git add extra');

    await installHook(
      directory,
      'commit-msg',
      'if grep -q second "$1"; then echo rejected >&2; exit 1; fi',
    );

    const failure = await executeCommit(directory, {
      groups: [
        { files: ['first'], subject: 'feat: first' },
        { files: ['second'], subject: 'feat: second' },
      ],
    }).catch((error: unknown) => String(error));

    const head = (await git(directory, ['rev-parse', 'HEAD'])).trim();

    expect(failure).toContain(`Group 1/2: ${head} feat: first`);
    expect(failure).toContain('Hook changed paths: extra');
    expect(await git(directory, ['show', 'HEAD:extra'])).toBe('generated');
    expect(await git(directory, ['diff', '--cached', '--name-only'])).toBe('');
  });
});
