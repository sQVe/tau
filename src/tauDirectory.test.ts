import { createHook } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryBareRoot, createTemporaryRepository, git } from '../tests/gitRepository.ts';
import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.ts';
import { findSharedRepositoryRoot } from './tauDirectory.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const pendingCleanups = cleanups.splice(0);
  const cleanupPromises = pendingCleanups.map((cleanup) => cleanup());

  await Promise.all(cleanupPromises);
});

describe('findSharedRepositoryRoot', () => {
  it('returns the bare root from a linked worktree and from the bare root', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));
    await git(root, 'worktree', 'add', '--quiet', '--orphan', 'main');
    const expected = await realpath(root);

    const fromWorktree = await findSharedRepositoryRoot(join(root, 'main'));
    const fromBareRoot = await findSharedRepositoryRoot(root);

    expect({ fromWorktree, fromBareRoot }).toEqual({
      fromWorktree: expected,
      fromBareRoot: expected,
    });
  });

  it('returns the checkout root for a plain repository', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    expect(await findSharedRepositoryRoot(root)).toBe(await realpath(root));
  });

  it('returns the clone root from a linked worktree of a normal clone', async () => {
    const source = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const clone = temporaryDirectory(onTestFinished, 'tau-clone-');

    await git(source, 'clone', '--quiet', source, clone);
    await git(clone, 'worktree', 'add', '--quiet', '--orphan', 'main');

    expect(await findSharedRepositoryRoot(join(clone, 'main'))).toBe(await realpath(clone));
  });

  it('returns a conventional bare repository itself, not its parent', async () => {
    const parent = temporaryDirectory(onTestFinished, 'tau-bare-');
    const repository = join(parent, 'app.git');

    await git(parent, 'init', '--quiet', '--bare', repository);

    expect(await findSharedRepositoryRoot(repository)).toBe(await realpath(repository));
  });

  it('stops when its signal is aborted', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    await expect(findSharedRepositoryRoot(root, { signal: AbortSignal.abort() })).rejects.toThrow(
      /git rev-parse/u,
    );
  });

  it('stops a run that is aborted after it starts', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    await expect(
      findSharedRepositoryRoot(root, { signal: AbortSignal.timeout(0) }),
    ).rejects.toThrow(/git rev-parse/u);
  });

  it('stops when its signal is aborted after Git returns', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));
    const controller = new AbortController();
    let armed = true;

    const hook = createHook({
      init: (_asyncId, type) => {
        if (armed && type === 'FSREQPROMISE') {
          armed = false;
          controller.abort();
        }
      },
    });

    hook.enable();

    try {
      await expect(findSharedRepositoryRoot(root, { signal: controller.signal })).rejects.toThrow(
        /aborted/u,
      );
    } finally {
      hook.disable();
    }
  });
});
