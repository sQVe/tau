import type { PathLike } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { git } from '../../tests/gitRepository.js';
import {
  failureOf,
  preparedReview,
  captureWorkingTree,
  listDirectory,
} from './fixtures/reviewDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';

const failures = vi.hoisted(() => ({
  append: false,
  publish: false,
  remove: false,
  restore: false,
}));

const isLiveInput = (path: string) =>
  path.endsWith('input.md') && !path.endsWith(join('capture', 'input.md'));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    appendFile: async (...parameters: Parameters<typeof actual.appendFile>) => {
      if (failures.append) {
        await actual.appendFile(parameters[0], 'cut-off');

        throw new Error('append failed');
      }

      return actual.appendFile(...parameters);
    },
    writeFile: async (...parameters: Parameters<typeof actual.writeFile>) => {
      const [target] = parameters;

      if (failures.restore && typeof target === 'string' && isLiveInput(target)) {
        throw new Error('restore failed');
      }

      return actual.writeFile(...parameters);
    },
    rm: async (...parameters: Parameters<typeof actual.rm>) => {
      if (failures.remove && String(parameters[0]).endsWith('snapshot')) {
        throw new Error('remove failed');
      }

      return actual.rm(...parameters);
    },
  };
});

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    linkSync: (existingPath: PathLike, newPath: PathLike) => {
      if (failures.publish && String(newPath).endsWith('capture.json')) {
        throw new Error('link failed');
      }

      actual.linkSync(existingPath, newPath);
    },
  };
});

it.each([
  { step: 'the append to input.md', failing: 'append', message: 'append failed' },
  { step: 'the capture.json write', failing: 'publish', message: 'link failed' },
] as const)('restores the review directory when $step fails, so a retry succeeds', async (row) => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const before = await listDirectory(directory);

  failures[row.failing] = true;

  onTestFinished(() => {
    failures[row.failing] = false;
  });

  expect(
    await failureOf(() =>
      captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
    ),
  ).toContain(row.message);

  expect(await listDirectory(directory)).toEqual(before);

  failures[row.failing] = false;

  expect(await captureWorkingTree(root, directory)).toMatchObject({ empty: false });

  expect((await readdir(directory)).toSorted()).toEqual([
    'capture',
    'capture.json',
    'input.md',
    'snapshot',
  ]);
});

it('keeps a snapshot folder it did not create when a capture without a snapshot fails', async () => {
  const { root, directory } = await preparedReview();
  const commit = (await git(root, 'rev-parse', 'HEAD')).trim();

  await mkdir(join(directory, 'snapshot'));
  await writeFile(join(directory, 'snapshot', 'unrelated.txt'), 'keep\n');

  failures.publish = true;

  onTestFinished(() => {
    failures.publish = false;
  });

  expect(
    await failureOf(() => captureReviewDirectory(root, directory, { kind: 'rootCommit', commit })),
  ).toContain('link failed');

  expect(await readFile(join(directory, 'snapshot', 'unrelated.txt'), 'utf8')).toBe('keep\n');
});

it('removes the snapshot, names both failures, and keeps the cause when restoring input.md fails', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  failures.publish = true;
  failures.restore = true;

  onTestFinished(() => {
    failures.publish = false;
    failures.restore = false;
  });

  const failure = await captureReviewDirectory(root, directory, {
    kind: 'workingTree',
    base: 'HEAD',
  }).then(
    () => new Error('no error'),
    (error: unknown) => error as Error,
  );

  expect(failure.message.startsWith('link failed')).toBe(true);
  expect(failure.message).toContain('restoring input.md: restore failed');
  expect(failure.message).not.toContain('removing the snapshot');
  expect(failure.cause).toMatchObject({ message: 'link failed' });
  expect(await readdir(directory)).toEqual(['input.md']);
});

it('names every failed cleanup step when restoring input.md and removing the snapshot both fail', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  failures.publish = true;
  failures.restore = true;
  failures.remove = true;

  onTestFinished(() => {
    failures.publish = false;
    failures.restore = false;
    failures.remove = false;
  });

  const message = await failureOf(() =>
    captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
  );

  expect(message).toContain('link failed');
  expect(message).toContain('restoring input.md: restore failed');
  expect(message).toContain('removing the snapshot: remove failed');
});

it('restores input.md and throws the capture error when removing the snapshot fails', async () => {
  const { root, directory } = await preparedReview();
  const input = await readFile(join(directory, 'input.md'));

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  failures.publish = true;
  failures.remove = true;

  onTestFinished(() => {
    failures.publish = false;
    failures.remove = false;
  });

  expect(
    await failureOf(() =>
      captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
    ),
  ).toContain('link failed');

  expect(await readFile(join(directory, 'input.md'))).toEqual(input);
});
