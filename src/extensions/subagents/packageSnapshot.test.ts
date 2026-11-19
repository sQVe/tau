import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
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

  expect(error).toContain('Cleanup refused');
  expect(existsSync(marker)).toBe(true);
});

it('refuses snapshot cleanup whose directory belongs to another owner', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-snapshot-mismatch-');
  const root = join(agentDirectory, 'tmp', 'tau-worker-packages');

  mkdirSync(join(root, 'first'), { recursive: true });
  mkdirSync(join(root, 'second'), { recursive: true });

  const error = await removeSnapshotDirectory({
    agentDirectory,
    directory: join(root, 'second'),
    snapshotName: 'first',
  });

  expect(error).toContain('does not match its owner');
  expect(existsSync(join(root, 'first'))).toBe(true);
  expect(existsSync(join(root, 'second'))).toBe(true);
});
