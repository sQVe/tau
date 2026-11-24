import { lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { open, openRequest, openTool } from './fixtures/openHarness.js';
import { contextOf, recordSession, setup } from './fixtures/toolHarness.js';
import { claimArchitectLock, holdArchitectLock } from './lock.js';
import { readAskRecords } from './record.js';
import { createArchitectTool } from './tool.js';

const architectDirectory = (root: string): string => join(root, '.tau', 'architect');

const linkArchitectDirectory = async (
  root: string,
  cleanup: (cleanup: () => Promise<void> | void) => void,
): Promise<string> => {
  const outside = temporaryDirectory(cleanup, 'tau-architect-link-');
  const target = join(outside, 'architect');

  await rename(architectDirectory(root), target);
  await symlink(target, architectDirectory(root));

  return target;
};

it('refuses a symlinked architect directory for both lock entry paths', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const outside = temporaryDirectory(onTestFinished, 'tau-architect-link-');

  await mkdir(join(root, '.tau'), { recursive: true });
  await symlink(outside, architectDirectory(root));

  await expect(claimArchitectLock(root)).rejects.toThrow('.tau/architect');
  await expect(holdArchitectLock(root)).rejects.toThrow('.tau/architect');

  expect(await readdir(outside)).toEqual([]);
  expect((await lstat(architectDirectory(root))).isSymbolicLink()).toBe(true);
});

it('refuses a tracked architect directory for both lock entry paths', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const tracked = join(architectDirectory(root), 'tracked.json');

  await mkdir(dirname(tracked), { recursive: true });
  await writeFile(tracked, 'tracked\n');
  await git(root, 'add', '--force', tracked);

  await expect(claimArchitectLock(root)).rejects.toThrow('.tau/architect');
  await expect(holdArchitectLock(root)).rejects.toThrow('.tau/architect');

  expect(await readFile(tracked, 'utf8')).toBe('tracked\n');
  expect(await readdir(join(root, '.tau'))).toEqual(['architect']);
});

it('ask launches nothing through a symlinked architect directory', async ({ onTestFinished }) => {
  const { root } = await setup(onTestFinished);

  await recordSession(root);
  await linkArchitectDirectory(root, onTestFinished);

  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await expect(
    tool.execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    ),
  ).rejects.toThrow('.tau/architect');

  expect(hc.calls).toEqual([]);
  expect(await readAskRecords(root)).toEqual({ records: [], gaps: [] });
});

it('open launches nothing through a symlinked architect directory', async ({ onTestFinished }) => {
  const { root } = await setup(onTestFinished);
  const { app, tool } = openTool(root);

  await recordSession(root);
  await linkArchitectDirectory(root, onTestFinished);

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow('.tau/architect');

  expect(app.calls).toEqual([]);
});

it('ask launches nothing through a tracked architect directory', async ({ onTestFinished }) => {
  const { root } = await setup(onTestFinished);

  await recordSession(root);
  await git(root, 'add', '--force', join(architectDirectory(root), 'record.json'));

  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await expect(
    tool.execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    ),
  ).rejects.toThrow('.tau/architect');

  expect(hc.calls).toEqual([]);
});

it('open launches nothing through a tracked architect directory', async ({ onTestFinished }) => {
  const { root } = await setup(onTestFinished);
  const { app, tool } = openTool(root);

  await recordSession(root);
  await git(root, 'add', '--force', join(architectDirectory(root), 'record.json'));

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow('.tau/architect');

  expect(app.calls).toEqual([]);
});
