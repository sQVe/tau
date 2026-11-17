import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readCheckState } from '../../checkRecord/identity.js';
import { createEvidenceRepository } from './fixtures/evidenceRepository.js';

const runName = 'run-a';
const itemName = 'journeys/check';

const currentTree = async (root: string): Promise<string> => {
  const { tree } = await readCheckState(root);

  if (tree === null) {
    throw new Error('The test repository has no tree identity.');
  }

  return tree;
};

const excludeTauDirectory = async (root: string): Promise<void> => {
  await writeFile(join(root, '.git', 'info', 'exclude'), '.tau/\n', { flag: 'a' });
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};

const writeRun = async (root: string, tree: string): Promise<void> => {
  const directory = join(root, '.tau', 'verification', runName);

  await writeJson(join(directory, 'run.json'), {
    version: 1,
    run: runName,
    target: '482',
    head: '1111111111111111111111111111111111111111',
    dirty: false,
    platform: { os: 'linux', arch: 'x64' },
    startedAt: '2026-11-16T10:00:00.000Z',
    treeAtLaunch: tree,
    treeAtStop: tree,
    launch: { exitCode: 0, logPath: 'launch.log' },
    doctor: { exitCode: 0, logPath: 'doctor.log' },
    stop: { exitCode: 0, logPath: 'stop.log' },
    items: [{ item: itemName, steps: 1 }],
  });

  await writeJson(join(directory, 'items', `${itemName}.json`), {
    version: 1,
    run: runName,
    item: itemName,
    drive: 'hand',
    steps: [{ number: 1, status: 'passed', artifacts: [] }],
    endState: { status: 'passed' },
  });
};

const setUp = async () => {
  const repository = await createEvidenceRepository(onTestFinished);

  await excludeTauDirectory(repository.root);

  return repository;
};

it('reports a verification result as fresh on the run tree', async () => {
  const { root, run } = await setUp();

  await writeRun(root, await currentTree(root));

  const evidence = await run();

  expect(evidence.verification).toEqual([
    {
      target: '482',
      item: itemName,
      run: runName,
      fresh: true,
      result: 'passed',
      counts: { passed: 1, differs: 0, blocked: 0, notRun: 0 },
    },
  ]);
});

it('reports the result as stale after a content change', async () => {
  const { root, run } = await setUp();

  await writeRun(root, await currentTree(root));
  await writeFile(join(root, 'feature.txt'), 'changed\n');

  const evidence = await run();

  expect(evidence.verification).toEqual([
    {
      target: '482',
      item: itemName,
      run: runName,
      fresh: false,
      reason: 'treeChangedSinceRun',
      result: 'passed',
      counts: { passed: 1, differs: 0, blocked: 0, notRun: 0 },
    },
  ]);
});

it('keeps the result fresh after a commit of identical content', async () => {
  const { root, run } = await setUp();

  await writeFile(join(root, 'feature.txt'), 'uncommitted\n');
  await writeRun(root, await currentTree(root));

  await git(root, 'add', 'feature.txt');
  await git(root, 'commit', '--quiet', '-m', 'commit the recorded change');

  const evidence = await run();

  expect(evidence.verification).toEqual([
    {
      target: '482',
      item: itemName,
      run: runName,
      fresh: true,
      result: 'passed',
      counts: { passed: 1, differs: 0, blocked: 0, notRun: 0 },
    },
  ]);
});

it("lists a worktree's run from the main checkout and after the worktree is removed", async () => {
  const { root, run, runFrom } = await setUp();
  const launching = join(temporaryDirectory(onTestFinished, 'tau-pr-worktree-'), 'launching');
  const preparing = join(temporaryDirectory(onTestFinished, 'tau-pr-worktree-'), 'preparing');

  await git(root, 'add', '.pi/tau.json');
  await git(root, 'commit', '--quiet', '-m', 'commit the config');
  await git(root, 'worktree', 'add', '--quiet', launching, 'HEAD');
  await git(root, 'worktree', 'add', '--quiet', preparing, 'HEAD');
  await writeRun(root, await currentTree(launching));

  const expected = [
    {
      target: '482',
      item: itemName,
      run: runName,
      fresh: true,
      result: 'passed',
      counts: { passed: 1, differs: 0, blocked: 0, notRun: 0 },
    },
  ];

  expect((await run()).verification).toEqual(expected);
  expect((await runFrom(preparing)).verification).toEqual(expected);

  await git(root, 'worktree', 'remove', '--force', launching);

  expect((await run()).verification).toEqual(expected);
  expect((await runFrom(preparing)).verification).toEqual(expected);

  await writeFile(join(preparing, 'feature.txt'), 'changed\n');

  expect((await runFrom(preparing)).verification).toEqual([
    {
      target: '482',
      item: itemName,
      run: runName,
      fresh: false,
      reason: 'treeChangedSinceRun',
      result: 'passed',
      counts: { passed: 1, differs: 0, blocked: 0, notRun: 0 },
    },
  ]);
});

it('reports a failed shared-root resolution as a verification gap', async () => {
  const { root, run } = await setUp();

  await rm(join(root, '.git'), { recursive: true, force: true });

  const evidence = await run();

  expect(evidence.verification).toBeNull();

  expect(evidence.gaps).toContainEqual({
    kind: 'verification',
    reason: expect.stringContaining(
      'git rev-parse --path-format=absolute --git-common-dir failed',
    ) as unknown,
  });
});

it('reports a malformed run.json as a gap', async () => {
  const { root, run } = await setUp();

  await mkdir(join(root, '.tau', 'verification', 'broken'), { recursive: true });
  await writeFile(join(root, '.tau', 'verification', 'broken', 'run.json'), '{');

  const evidence = await run();

  expect(evidence.verification).toEqual([]);

  expect(evidence.gaps).toContainEqual({
    kind: 'verificationRecord',
    run: 'broken',
    item: null,
    problem: expect.any(String) as unknown,
  });
});

it('reports a failed runs read as a verification gap', async () => {
  const { root, run } = await setUp();

  await mkdir(join(root, '.tau'), { recursive: true });
  await writeFile(join(root, '.tau', 'verification'), 'not a directory\n');

  const evidence = await run();

  expect(evidence.verification).toBeNull();

  expect(evidence.gaps).toContainEqual({
    kind: 'verification',
    reason: expect.any(String) as unknown,
  });
});

it('reports a failed tree read as a gap and keeps results without identity', async () => {
  const { root, run } = await setUp();

  await writeRun(root, await currentTree(root));
  await writeFile(join(root, '.git', 'index'), 'corrupt index\n');

  const evidence = await run();

  expect(evidence.verification).toEqual([
    {
      target: '482',
      item: itemName,
      run: runName,
      fresh: false,
      reason: 'noIdentity',
      result: 'passed',
      counts: { passed: 1, differs: 0, blocked: 0, notRun: 0 },
    },
  ]);

  expect(evidence.gaps).toContainEqual({
    kind: 'verification',
    reason: expect.any(String) as unknown,
  });
});

it('returns an empty verification list without a verification directory', async () => {
  const { run } = await setUp();

  const evidence = await run();

  expect(evidence.verification).toEqual([]);

  expect(
    evidence.gaps.filter((gap) => gap.kind === 'verification' || gap.kind === 'verificationRecord'),
  ).toEqual([]);
});
