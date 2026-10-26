import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { removeSnapshotDirectory } from './packageSnapshot.js';

it.each(['.', '..'])('refuses snapshot cleanup whose owner is %s', async (snapshotName) => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-snapshot-owner-');
  const root = join(agentDirectory, 'tmp', 'tau-worker-packages');
  const marker = join(root, 'keep.txt');

  mkdirSync(root, { recursive: true });
  writeFileSync(marker, 'keep');

  const error = await removeSnapshotDirectory({
    agentDirectory,
    directory: `${root}/${snapshotName}`,
    snapshotName,
  });

  expect(error).toContain('snapshot owner');
  expect(existsSync(marker)).toBe(true);
});
