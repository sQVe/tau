import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createDiagnosticsDirectory, maximumRetainedRuns, pruneDiagnostics } from './retention.js';

it('retains recent completed runs while pruning old and excess diagnostics without touching active runs', async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'tau-retention-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const completed: string[] = [];

  for (let index = 0; index < maximumRetainedRuns + 2; index += 1) {
    const name = `run-${String(index).padStart(6, '0')}`;
    const directory = join(root, name);

    await mkdir(directory);
    await writeFile(join(directory, 'completed'), '');

    await utimes(
      join(directory, 'completed'),
      new Date(now - index * 1000),
      new Date(now - index * 1000),
    );

    completed.push(name);
  }

  const expired = join(root, 'run-expire');
  const abandoned = join(root, 'run-abando');
  const active = join(root, 'run-active');
  const unrelated = join(root, 'other-directory');

  for (const path of [expired, abandoned, active, unrelated]) {
    await mkdir(path);
  }

  await writeFile(join(expired, 'completed'), '');
  const old = new Date(now - 7 * 24 * 60 * 60 * 1000 - 1);
  await utimes(join(expired, 'completed'), old, old);
  await utimes(abandoned, old, old);
  await writeFile(join(unrelated, 'keep'), 'user data');
  await symlink(unrelated, join(root, 'run-linked'), 'dir');

  await pruneDiagnostics(root, now);

  expect((await readdir(root)).toSorted()).toEqual(
    [
      ...completed.slice(0, maximumRetainedRuns),
      'run-active',
      'run-linked',
      'other-directory',
    ].toSorted(),
  );

  expect(await readdir(unrelated)).toEqual(['keep']);

  const current = join(root, 'run-curren');
  await mkdir(current);
  await writeFile(join(current, 'completed'), '');
  await utimes(join(current, 'completed'), old, old);

  await pruneDiagnostics(root, now, current);

  expect((await readdir(root)).toSorted()).toEqual(
    [
      ...completed.slice(0, maximumRetainedRuns - 1),
      'run-curren',
      'run-active',
      'run-linked',
      'other-directory',
    ].toSorted(),
  );
});

it('rejects a symlink at the diagnostic storage root', async ({ onTestFinished }) => {
  const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-retention-root-'));
  const target = join(agentDirectory, 'other');
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(async () => {
    vi.unstubAllEnvs();

    await rm(agentDirectory, { recursive: true, force: true });
  });

  await mkdir(target);
  await symlink(target, join(agentDirectory, 'test-runs'), 'dir');

  await expect(createDiagnosticsDirectory()).rejects.toThrow(
    'Expected a private diagnostic directory',
  );

  expect(await readdir(target)).toEqual([]);
});
