import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { clearSnapshotMarker, markSnapshotUnused, readUnusedSince } from './snapshotMarker.js';

const markerName = '.tau-unused-since';
const hour = 3_600_000;

const setup = () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-marker-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const snapshotRoot = join(agentDirectory, 'tmp', 'tau-worker-packages');
  const snapshot = join(snapshotRoot, 'snapshot-a');

  mkdirSync(snapshot, { recursive: true });

  return { agentDirectory, snapshotRoot, snapshot };
};

it('writes a marker dated at the given time and reads it back', async () => {
  const { agentDirectory, snapshot } = setup();
  const now = Date.now() - hour;

  expect(await markSnapshotUnused(agentDirectory, 'snapshot-a', now)).toBeUndefined();
  expect(Math.abs(statSync(join(snapshot, markerName)).mtimeMs - now)).toBeLessThan(2);
  expect(Math.abs(((await readUnusedSince(snapshot)) ?? 0) - now)).toBeLessThan(2);
});

it('does not follow a symlink at the marker path when it writes', async () => {
  const { agentDirectory, snapshot } = setup();
  const victim = join(agentDirectory, 'victim');

  writeFileSync(victim, 'keep');
  symlinkSync(victim, join(snapshot, markerName));

  const error = await markSnapshotUnused(agentDirectory, 'snapshot-a', Date.now() - hour);

  expect(error).toContain('snapshot-a');
  expect(readFileSync(victim, 'utf8')).toBe('keep');
  expect(statSync(victim).mtimeMs).toBeGreaterThan(Date.now() - hour / 2);
});

it('removes a symlink at the marker path without touching its target', async () => {
  const { agentDirectory, snapshot } = setup();
  const victim = join(agentDirectory, 'victim');

  writeFileSync(victim, 'keep');
  symlinkSync(victim, join(snapshot, markerName));

  expect(await clearSnapshotMarker(agentDirectory, 'snapshot-a')).toBeUndefined();
  expect(existsSync(join(snapshot, markerName))).toBe(false);
  expect(readFileSync(victim, 'utf8')).toBe('keep');
});

it('refuses a redirected snapshot root for a write and a removal', async () => {
  const { agentDirectory, snapshotRoot } = setup();
  const elsewhere = temporaryDirectory(onTestFinished, 'tau-marker-redirect-');
  const target = join(elsewhere, 'snapshot-a');

  mkdirSync(target);
  writeFileSync(join(target, markerName), '');
  mkdirSync(join(agentDirectory, 'tmp'), { recursive: true });
  rmSync(snapshotRoot, { recursive: true });
  symlinkSync(elsewhere, snapshotRoot);

  const written = await markSnapshotUnused(agentDirectory, 'snapshot-b', Date.now());
  const cleared = await clearSnapshotMarker(agentDirectory, 'snapshot-a');

  expect(written).toContain('redirected');
  expect(cleared).toContain('redirected');
  expect(existsSync(join(target, markerName))).toBe(true);
});

it('refuses a snapshot name that is a path', async () => {
  const { agentDirectory } = setup();

  expect(await markSnapshotUnused(agentDirectory, '../escape', Date.now())).toContain('Invalid');
  expect(await clearSnapshotMarker(agentDirectory, 'a/b')).toContain('Invalid');
});
