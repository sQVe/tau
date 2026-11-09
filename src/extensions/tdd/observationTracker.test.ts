import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { GitResult } from '../../git.js';
import { createObservationTracker } from './observationTracker.js';

const gitReply = vi.hoisted(() => ({ result: undefined as GitResult | undefined }));

vi.mock(import('../../git.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  runGit: async () => {
    if (gitReply.result === undefined) {
      throw new Error('No Git reply set.');
    }

    return gitReply.result;
  },
}));

const contextFor = (cwd: string) =>
  ({
    cwd,
    ui: { notify: () => undefined },
    isProjectTrusted: () => true,
  }) as unknown as ExtensionContext;

beforeEach(({ onTestFinished }) => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(onTestFinished, 'tau-tracker-agent-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  gitReply.result = undefined;
});

it('uses the checkout root that Git prints for a nested nextest session', async ({
  onTestFinished,
}) => {
  const root = temporaryDirectory(onTestFinished, 'tau-tracker-checkout-');
  const cwd = join(root, 'sub');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'tau.json'), JSON.stringify({ tdd: { runner: 'nextest' } }));

  gitReply.result = { exitCode: 0, stdout: Buffer.from(`${root}\n`), stderr: '' };

  const tracked = await createObservationTracker().observationFor(contextFor(cwd));

  expect(tracked.repositoryRoot).toBe(await realpath(root));
});

it('uses the session directory as the repository root outside a Git checkout', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-tracker-outside-');

  gitReply.result = {
    exitCode: 128,
    stdout: Buffer.from(''),
    stderr: 'fatal: not a git repository',
  };

  const tracked = await createObservationTracker().observationFor(contextFor(cwd));

  expect(tracked.repositoryRoot).toBe(tracked.cwd);
});

it('reports a failed Git call for the nextest runner instead of falling back to the session directory', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-tracker-git-failure-');
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'tau.json'), JSON.stringify({ tdd: { runner: 'nextest' } }));

  gitReply.result = {
    exitCode: null,
    stdout: Buffer.from(''),
    stderr: 'git rev-parse --show-toplevel timed out after 5000 ms',
  };

  await expect(createObservationTracker().observationFor(contextFor(cwd))).rejects.toThrow(
    'git rev-parse --show-toplevel timed out after 5000 ms',
  );
});

it('keeps the vitest observation when a Git call fails in a nested session', async ({
  onTestFinished,
}) => {
  const root = temporaryDirectory(onTestFinished, 'tau-tracker-vitest-nested-');
  const cwd = join(root, 'sub');
  await mkdir(cwd);
  const tracker = createObservationTracker();

  gitReply.result = { exitCode: 0, stdout: Buffer.from(`${root}\n`), stderr: '' };

  const first = await tracker.observationFor(contextFor(cwd));

  gitReply.result = {
    exitCode: null,
    stdout: Buffer.from(''),
    stderr: 'git rev-parse --show-toplevel timed out after 5000 ms',
  };

  const second = await tracker.observationFor(contextFor(cwd));

  expect(second.observation).toBe(first.observation);
});

it('keeps the vitest runner working when the Git call fails', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-tracker-vitest-git-failure-');

  gitReply.result = {
    exitCode: null,
    stdout: Buffer.from(''),
    stderr: 'git rev-parse --show-toplevel timed out after 5000 ms',
  };

  const tracked = await createObservationTracker().observationFor(contextFor(cwd));

  expect(tracked.loaded.config.runner).toBe('vitest');
});
