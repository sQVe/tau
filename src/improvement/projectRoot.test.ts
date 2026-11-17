import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import {
  createTemporaryBareRoot,
  createTemporaryRepository,
  git,
} from '../../tests/gitRepository.ts';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { findOptionalProjectRoot, findProjectRoot } from './projectRoot.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('findProjectRoot', () => {
  it('returns the bare root from a linked worktree and from the bare root', async () => {
    const root = await createTemporaryBareRoot((cleanup) => cleanups.push(cleanup));
    await git(root, 'worktree', 'add', '--quiet', '--orphan', 'main');
    const expected = await realpath(root);

    const fromWorktree = await findProjectRoot(join(root, 'main'));
    const fromBareRoot = await findProjectRoot(root);

    expect({ fromWorktree, fromBareRoot }).toEqual({
      fromWorktree: expected,
      fromBareRoot: expected,
    });
  });

  it('returns the checkout root for a plain repository', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    expect(await findProjectRoot(root)).toBe(await realpath(root));
  });

  it('stops when its signal is aborted', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    await expect(findProjectRoot(root, { signal: AbortSignal.abort() })).rejects.toThrow(
      /git rev-parse/u,
    );
  });
});

describe('findOptionalProjectRoot', () => {
  it('returns the root inside a repository', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    expect(await findOptionalProjectRoot(root)).toBe(await realpath(root));
  });

  it('returns null outside a repository', async () => {
    const directory = temporaryDirectory(onTestFinished, 'tau-outside-');

    expect(await findOptionalProjectRoot(directory)).toBeNull();
  });

  it('rejects for a directory that does not exist', async () => {
    const root = await createTemporaryRepository((cleanup) => cleanups.push(cleanup));

    await expect(findOptionalProjectRoot(join(root, 'missing'))).rejects.toThrow(/git rev-parse/u);
  });
});
