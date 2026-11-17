import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.ts';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { findOptionalProjectRoot } from './projectRoot.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const cleanupTasks = cleanups.splice(0).map((cleanup) => cleanup());
  await Promise.all(cleanupTasks);
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
