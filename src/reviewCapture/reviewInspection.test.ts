import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { readInspectedEvidence } from './evidence.js';
import {
  captureWorkingTree,
  failureOf,
  preparedReview,
  prepareDirectory,
} from './fixtures/reviewDirectoryHarness.js';
import { checkReviewFreshness } from './pinnedCapture.js';
import { recordFileName } from './record.js';
import { readRecord, requireRecord } from './recordRead.js';
import { inspectReview } from './reviewCapture.js';
import type { ReviewInspection } from './reviewCapture.js';

const afterRead = vi.hoisted(() => ({
  path: '',
  run: undefined as (() => Promise<void>) | undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    readFile: (async (...parameters: Parameters<typeof actual.readFile>) => {
      const bytes = await actual.readFile(...parameters);
      const run = parameters[0] === afterRead.path ? afterRead.run : undefined;

      if (run !== undefined) {
        afterRead.run = undefined;
        await run();
      }

      return bytes;
    }) as typeof actual.readFile,
  };
});

it('returns the saved recheck, the current capture, and stale freshness', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  const saved = await captureWorkingTree(root, directory);
  await checkReviewFreshness(root, directory);
  const recheck = await readFile(join(directory, 'recheck.diff'));

  await writeFile(join(root, 'tracked.txt'), 'three\n');

  const inspection = await inspectReview(root, directory);

  expect(inspection.recheck).toEqual({ status: 'read', bytes: recheck, hash: saved.hash });
  expect(inspection.capture.hash).not.toBe(saved.hash);
  expect(inspection.capture.paths).toEqual(['tracked.txt']);
  expect(inspection.freshness.status).toBe('stale');
});

it('describes the first record when capture.json is replaced during inspection', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);
  const first = requireRecord(await readRecord(directory)).record;

  await writeFile(join(root, 'tracked.txt'), 'three\n');
  const second = await prepareDirectory(root);

  await captureWorkingTree(root, second);

  const recordPath = join(directory, recordFileName);
  const replacement = await readFile(join(second, recordFileName));

  afterRead.path = recordPath;
  afterRead.run = () => writeFile(recordPath, replacement);

  const inspection = await inspectReview(root, directory);

  expect(inspection.generation).toEqual([]);
  expect(inspection.record).toEqual(first);
});

it('builds review evidence from an inspection', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);

  const inspection: ReviewInspection = await inspectReview(root, directory);
  const evidence = await readInspectedEvidence(root, inspection);

  expect(evidence.hash).toBe(inspection.record.hash);
  expect(evidence.freshness).toEqual(inspection.freshness);
});

it('reports a recheck read error when recheck.diff is missing', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);

  const inspection = await inspectReview(root, directory);

  expect(inspection.recheck).toMatchObject({ status: 'error' });
  expect(inspection.recheck).toHaveProperty('error', expect.stringContaining('recheck.diff'));
});

it('reports a recheck read error when recheck.diff cannot be read', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);
  await mkdir(join(directory, 'recheck.diff'));

  const inspection = await inspectReview(root, directory);

  expect(inspection.recheck).toMatchObject({ status: 'error' });
});

it('refuses a review directory without capture.json', async () => {
  const { root, directory } = await preparedReview();

  expect(await failureOf(() => inspectReview(root, directory))).toContain('No capture record');
});

it('refuses a malformed capture.json', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(directory, 'capture.json'), '{"version": 1, "target": {}}');

  expect(await failureOf(() => inspectReview(root, directory))).toContain(
    'Malformed capture record',
  );
});
