import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createCodeReviewTool } from './tool.js';
import type { CodeReviewInput } from './tool.js';

const git = async (root: string, commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout;
};

const run = async (root: string, input: CodeReviewInput) => {
  const tool = createCodeReviewTool();
  const result = await tool.execute('call', input, undefined, undefined, noUiContext(root));

  return result.details;
};

const failureOf = (root: string, input: CodeReviewInput) =>
  run(root, input).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const inputHeader = '# Review input\n\nTarget: the working tree.\n\n## Capture\n';

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, ['add', 'tracked.txt']);
  await git(root, ['commit', '--quiet', '-m', 'first']);

  return root;
};

const preparedReview = async () => {
  const root = await committedRepository();
  const { directory } = (await run(root, { action: 'prepare' })) as { directory: string };

  await writeFile(join(directory, 'input.md'), inputHeader);

  return { root, directory };
};

const captureWorkingTree = (root: string, directory: string) =>
  run(root, { action: 'capture', directory, target: { kind: 'workingTree', base: 'HEAD' } });

const listDirectory = async (directory: string) =>
  Promise.all(
    (await readdir(directory))
      .toSorted()
      .map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
  );

it('prepares a fresh review directory that Git ignores', async () => {
  const root = await committedRepository();
  const first = (await run(root, { action: 'prepare' })) as { directory: string };
  const second = (await run(root, { action: 'prepare' })) as { directory: string };

  expect(first.directory).toMatch(/\/\.tau\/workers\/review-[^/]+$/);
  expect(second.directory).not.toBe(first.directory);
  expect(await git(root, ['status', '--porcelain'])).toBe('');
});

it('refuses to prepare through a symlinked .tau/workers', async () => {
  const root = await committedRepository();
  const outside = await mkdtemp(join(tmpdir(), 'tau-review-outside-'));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));

  await mkdir(join(root, '.tau'));
  await symlink(outside, join(root, '.tau', 'workers'));

  expect(await failureOf(root, { action: 'prepare' })).toContain('symlink');
  expect(await readdir(outside)).toEqual([]);
});

it('appends the capture and its gaps after the Capture heading and saves the record', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'untracked.txt'), 'new\n');

  const result = await run(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: 'HEAD', exclude: ['generated.txt'] },
  });

  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const input = await readFile(join(directory, 'input.md'), 'utf8');
  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as unknown;

  expect(result['hash']).toMatch(/^[0-9a-f]{40}$/);

  expect(result).toEqual({
    hash: result['hash'],
    head,
    base: head,
    empty: false,
    paths: ['tracked.txt', 'untracked.txt'],
    gaps: [{ kind: 'excluded', path: 'generated.txt' }],
  });

  expect(input.startsWith(inputHeader)).toBe(true);
  expect(input).toContain('+two');
  expect(input).toContain('+new');
  expect(input.indexOf('## Gaps')).toBeGreaterThan(input.indexOf('+new'));
  expect(input).toContain('generated.txt');

  expect(record).toEqual({
    version: 1,
    target: { kind: 'workingTree', base: head, exclude: ['generated.txt'] },
    base: head,
    head,
    hash: result['hash'],
  });
});

it('writes a gap path with a newline and a backtick on one list line', async () => {
  const { root, directory } = await preparedReview();
  const path = 'odd`name\n- injected';

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  await run(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: 'HEAD', exclude: [path] },
  });

  const input = await readFile(join(directory, 'input.md'), 'utf8');
  const gaps = input.slice(input.indexOf('## Gaps')).split('\n');

  expect(gaps.filter((line) => line.startsWith('- '))).toHaveLength(1);
  expect(gaps.some((line) => line.startsWith('- injected'))).toBe(false);
});

it('returns empty for an empty capture and writes nothing', async () => {
  const { root, directory } = await preparedReview();
  const before = await listDirectory(directory);
  const result = await captureWorkingTree(root, directory);

  expect(result['empty']).toBe(true);
  expect(await listDirectory(directory)).toEqual(before);
});

it('refuses an input.md without the Capture heading and writes nothing', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(directory, 'input.md'), '# Review input\n');
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const before = await listDirectory(directory);

  expect(
    await failureOf(root, {
      action: 'capture',
      directory,
      target: { kind: 'workingTree', base: 'HEAD' },
    }),
  ).toContain('## Capture');

  expect(await listDirectory(directory)).toEqual(before);
});

it('refuses a second capture into the same directory', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);

  const before = await listDirectory(directory);

  const failure = await failureOf(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: 'HEAD' },
  });

  expect(failure).toContain('capture.json');
  expect(await listDirectory(directory)).toEqual(before);
});

it('fails the capture on a Git error and writes nothing', async () => {
  const { root, directory } = await preparedReview();
  const before = await listDirectory(directory);

  const failure = await failureOf(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: 'no-such-branch' },
  });

  expect(failure).toContain('no-such-branch');
  expect(await listDirectory(directory)).toEqual(before);
});

it.each([
  ['a directory outside .tau/workers', (root: string) => join(root, 'review-outside')],
  ['a worker directory not named review-*', (root: string) => join(root, '.tau/workers/task-1')],
  ['a nested review directory', (root: string) => join(root, '.tau/workers/review-a/inner')],
  ['the workers directory itself', (root: string) => join(root, '.tau/workers')],
])('refuses %s for capture and freshness', async (_name, directoryOf) => {
  const root = await committedRepository();
  const directory = directoryOf(root);

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'input.md'), inputHeader);
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const capture = await failureOf(root, {
    action: 'capture',
    directory,
    target: { kind: 'workingTree', base: 'HEAD' },
  });

  const freshness = await failureOf(root, { action: 'freshness', directory });

  expect(capture).toContain('.tau/workers/review-');
  expect(freshness).toContain('.tau/workers/review-');
  expect(await readFile(join(directory, 'input.md'), 'utf8')).toBe(inputHeader);
});

it('refuses a review directory that is a symlink', async () => {
  const root = await committedRepository();
  const outside = await mkdtemp(join(tmpdir(), 'tau-review-outside-'));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));

  await run(root, { action: 'prepare' });
  await writeFile(join(outside, 'input.md'), inputHeader);
  await symlink(outside, join(root, '.tau/workers/review-linked'));
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const directory = join(root, '.tau/workers/review-linked');

  expect(
    await failureOf(root, {
      action: 'capture',
      directory,
      target: { kind: 'workingTree', base: 'HEAD' },
    }),
  ).toContain('symlink');

  expect(await readFile(join(outside, 'input.md'), 'utf8')).toBe(inputHeader);
});

it('reports fresh for an unchanged tree and saves the recapture as recheck.diff', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const captured = await captureWorkingTree(root, directory);
  const freshness = await run(root, { action: 'freshness', directory });
  const recheckHash = await git(root, ['hash-object', join(directory, 'recheck.diff')]);

  expect(freshness).toEqual({ status: 'fresh', reasons: [] });
  expect(recheckHash.trim()).toBe(captured['hash']);
});

it('reports stale after the working tree changes', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);
  await writeFile(join(root, 'tracked.txt'), 'three\n');

  const freshness = await run(root, { action: 'freshness', directory });

  expect(freshness['status']).toBe('stale');
});

it('reports stale after a new commit with the same content', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);
  await git(root, ['commit', '--quiet', '--allow-empty', '-m', 'empty']);

  const freshness = await run(root, { action: 'freshness', directory });

  expect(freshness['status']).toBe('stale');
});

it('reports unknown when the recapture fails and leaves no recheck.diff', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const captured = await captureWorkingTree(root, directory);
  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as object;
  const missingCommit = 'f'.repeat(40);

  await writeFile(
    join(directory, 'capture.json'),
    JSON.stringify({ ...record, target: { kind: 'workingTree', base: missingCommit } }),
  );

  await writeFile(join(directory, 'recheck.diff'), 'an earlier recheck\n');

  const freshness = await run(root, { action: 'freshness', directory });

  expect(captured['empty']).toBe(false);
  expect(freshness['status']).toBe('unknown');
  expect(await readdir(directory)).not.toContain('recheck.diff');
});

it('refuses a saved target revision that Git could read as an option and writes nothing outside', async () => {
  const { root, directory } = await preparedReview();
  const outside = await mkdtemp(join(tmpdir(), 'tau-review-outside-'));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);

  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as object;
  const base = `--output=${join(outside, 'written.diff')}`;

  await writeFile(
    join(directory, 'capture.json'),
    JSON.stringify({ ...record, target: { kind: 'workingTree', base } }),
  );

  expect(await failureOf(root, { action: 'freshness', directory })).toContain('/target/base');
  expect(await readdir(outside)).toEqual([]);
});

it('refuses freshness without a saved record', async () => {
  const { root, directory } = await preparedReview();

  expect(await failureOf(root, { action: 'freshness', directory })).toContain('capture.json');
});

it('returns the evidence for a saved capture', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const captured = await captureWorkingTree(root, directory);
  const evidence = await run(root, { action: 'evidence', directory });

  expect(evidence).toMatchObject({
    hash: captured['hash'],
    head: captured['head'],
    base: captured['base'],
    freshness: { status: 'fresh', reasons: [] },
    paths: ['tracked.txt'],
    gaps: [],
  });
});
