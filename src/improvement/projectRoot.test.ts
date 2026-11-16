import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTemporaryBareRoot,
  createTemporaryRepository,
  git,
} from '../../tests/gitRepository.ts';
import { findProjectRoot } from './projectRoot.ts';

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
});
