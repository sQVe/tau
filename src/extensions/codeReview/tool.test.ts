import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    (await readdir(directory)).toSorted().map(async (name) => {
      const path = join(directory, name);
      const text = (await stat(path)).isDirectory() ? 'directory' : await readFile(path, 'utf8');

      return [name, text];
    }),
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
    version: 2,
    target: { kind: 'workingTree', base: head, exclude: ['generated.txt'] },
    base: head,
    head,
    hash: result['hash'],
    snapshot: { present: ['tracked.txt', 'untracked.txt'], absent: [], skipped: [] },
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

const fixRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'math.ts'), 'export const add = (a, b) => a + b;\n');
  await writeFile(join(root, 'src', 'use.ts'), "import { add } from './math.js';\nadd(1, 2);\n");
  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 1;\n');
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--quiet', '-m', 'first']);

  return root;
};

const prepareDirectory = async (root: string) => {
  const { directory } = (await run(root, { action: 'prepare' })) as { directory: string };

  await writeFile(join(directory, 'input.md'), inputHeader);

  return directory;
};

// Reviews an uncommitted edit of src/math.ts, then edits src/math.ts again.
const reviewedThenFixed = async () => {
  const root = await fixRepository();
  const review = await prepareDirectory(root);

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = (a, b) => a + b + 0;\n');
  await captureWorkingTree(root, review);
  await writeFile(join(root, 'src', 'math.ts'), 'export const add = (a, b) => b + a;\n');

  return { root, review, directory: await prepareDirectory(root) };
};

const captureFix = (
  root: string,
  directory: string,
  review: string,
  findingPaths: string[],
  exclude?: string[],
) =>
  run(root, {
    action: 'capture',
    directory,
    target: { kind: 'fix', review, findingPaths, ...(exclude === undefined ? {} : { exclude }) },
  });

it('captures only the diff since the reviewed capture and lists the callers of the fix', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const result = await captureFix(root, directory, review, ['src/math.ts']);
  const input = await readFile(join(directory, 'input.md'), 'utf8');

  expect(result).toMatchObject({
    paths: ['src/math.ts'],
    fixPaths: ['src/math.ts'],
    scope: 'fix',
    outsidePaths: [],
    empty: false,
  });

  expect(input).toContain('-export const add = (a, b) => a + b + 0;');
  expect(input).toContain('+export const add = (a, b) => b + a;');
  expect(input).not.toContain('-export const add = (a, b) => a + b;');

  const evidence = (await run(root, { action: 'evidence', directory })) as {
    callers: { module: string; path: string }[];
  };

  expect(evidence.callers.map((caller) => caller.path)).toEqual(['src/use.ts']);
});

it('returns the whole target scope and the outside file when the fix leaves the findings', async () => {
  const { root, review, directory } = await reviewedThenFixed();

  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 2;\n');

  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({
    fixPaths: ['src/other.ts', 'src/math.ts'].toSorted(),
    scope: 'wholeTarget',
    outsidePaths: ['src/other.ts'],
  });
});

it('captures a file that appeared and a file that disappeared since the review', async () => {
  const root = await fixRepository();
  const review = await prepareDirectory(root);

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = 3;\n');
  await writeFile(join(root, 'src', 'extra.ts'), 'export const extra = 1;\n');
  await captureWorkingTree(root, review);
  await rm(join(root, 'src', 'extra.ts'));
  await writeFile(join(root, 'src', 'added.ts'), 'export const added = 1;\n');

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, []);
  const input = await readFile(join(directory, 'input.md'), 'utf8');

  expect(result).toMatchObject({ fixPaths: ['src/added.ts', 'src/extra.ts'] });
  expect(input).toContain('deleted file mode');
  expect(input).toContain('--- a/src/extra.ts');
  expect(input).toContain('+++ b/src/added.ts');
});

it('captures the edit of a file the reviewed capture left out as unchanged', async () => {
  const { root, review, directory } = await reviewedThenFixed();

  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 2;\n');

  await captureFix(root, directory, review, ['src/math.ts', 'src/other.ts']);

  const input = await readFile(join(directory, 'input.md'), 'utf8');

  expect(input).toContain('-export const other = 1;\n+export const other = 2;');
});

it('captures the diff since a reviewed range from the working tree', async () => {
  const root = await fixRepository();
  const review = await prepareDirectory(root);

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = 3;\n');
  await git(root, ['commit', '--quiet', '-am', 'second']);

  await run(root, {
    action: 'capture',
    directory: review,
    target: { kind: 'range', from: 'HEAD~1', to: 'HEAD' },
  });

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = 4;\n');

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ fixPaths: ['src/math.ts'], scope: 'fix' });
  expect(await readFile(join(directory, 'input.md'), 'utf8')).toContain('-export const add = 3;');
});

it('records the fix capture with the earlier base and no snapshot', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const result = await captureFix(root, directory, review, ['src/math.ts']);
  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as object;

  expect(record).toEqual({
    version: 2,
    target: {
      kind: 'fix',
      review,
      findingPaths: ['src/math.ts'],
      base: result['base'],
    },
    base: result['base'],
    head: result['head'],
    hash: result['hash'],
  });

  expect(await readdir(directory)).not.toContain('snapshot');
});

it('refuses a fix review of a directory with no capture record and writes nothing', async () => {
  const { root, directory } = await reviewedThenFixed();
  const empty = await prepareDirectory(root);
  const before = await listDirectory(directory);

  const target = { kind: 'fix' as const, review: empty, findingPaths: [] };

  expect(await failureOf(root, { action: 'capture', directory, target })).toContain(
    'holds no capture record',
  );

  expect(await listDirectory(directory)).toEqual(before);
});

it('refuses a fix review of a record with no snapshot and writes nothing', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const saved = JSON.parse(await readFile(join(review, 'capture.json'), 'utf8')) as object;
  const { snapshot: _snapshot, ...record } = saved as { snapshot?: unknown };

  await writeFile(join(review, 'capture.json'), JSON.stringify(record));

  const target = { kind: 'fix' as const, review, findingPaths: [] };

  expect(await failureOf(root, { action: 'capture', directory, target })).toContain('no snapshot');
  expect(await readdir(directory)).toEqual(['input.md']);
});

it('refuses a fix review of a version 1 record and writes nothing', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const saved = JSON.parse(await readFile(join(review, 'capture.json'), 'utf8')) as object;
  const { snapshot: _snapshot, ...record } = saved as { snapshot?: unknown };

  await writeFile(join(review, 'capture.json'), JSON.stringify({ ...record, version: 1 }));

  const target = { kind: 'fix' as const, review, findingPaths: [] };

  expect(await failureOf(root, { action: 'capture', directory, target })).toContain('version 1');
  expect(await readdir(directory)).toEqual(['input.md']);
});

it('refuses a fix review of a fix capture', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const fix = await prepareDirectory(root);

  await captureFix(root, fix, review, ['src/math.ts']);

  const target = { kind: 'fix' as const, review: fix, findingPaths: [] };

  expect(await failureOf(root, { action: 'capture', directory, target })).toContain('fix capture');
  expect(await readdir(directory)).toEqual(['input.md']);
});

it('reports a fix capture fresh when nothing changed and stale after another edit', async () => {
  const { root, review, directory } = await reviewedThenFixed();

  await captureFix(root, directory, review, ['src/math.ts']);

  expect(await run(root, { action: 'freshness', directory })).toEqual({
    status: 'fresh',
    reasons: [],
  });

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = 5;\n');

  expect(await run(root, { action: 'freshness', directory })).toMatchObject({ status: 'stale' });
});

it('keeps a binary file out of the snapshot and reports it in the fix capture', async () => {
  const root = await fixRepository();
  const review = await prepareDirectory(root);

  await writeFile(join(root, 'logo.bin'), Buffer.from([0, 1, 2]));
  await captureWorkingTree(root, review);
  await writeFile(join(root, 'logo.bin'), Buffer.from([0, 1, 3]));

  const record = JSON.parse(await readFile(join(review, 'capture.json'), 'utf8')) as {
    snapshot: unknown;
  };

  expect(record.snapshot).toEqual({
    present: [],
    absent: [],
    skipped: [
      {
        kind: 'binary',
        path: 'logo.bin',
        identity: expect.stringMatching(/^[0-9a-f]{40}$/) as string,
      },
    ],
  });

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({
    fixPaths: ['logo.bin'],
    scope: 'wholeTarget',
    outsidePaths: ['logo.bin'],
    gaps: [{ kind: 'binary', path: 'logo.bin' }],
  });
});

const workingTreeTarget = { kind: 'workingTree' as const, base: 'HEAD' };

const reviewOf = async (
  root: string,
  edits: Record<string, string>,
  target: NonNullable<CodeReviewInput['target']>,
) => {
  const review = await prepareDirectory(root);

  for (const [path, text] of Object.entries(edits)) {
    await writeFile(join(root, path), text);
  }

  await run(root, {
    action: 'capture',
    directory: review,
    target,
  });

  return review;
};

it('captures a reviewed file restored to its base value', async () => {
  const root = await fixRepository();
  const edits = { 'src/other.ts': 'export const other = 2;\n' };
  const review = await reviewOf(root, edits, workingTreeTarget);

  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 1;\n');

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/other.ts']);

  expect(result).toMatchObject({ empty: false, fixPaths: ['src/other.ts'], scope: 'fix' });

  expect(await readFile(join(directory, 'input.md'), 'utf8')).toContain(
    '-export const other = 2;\n+export const other = 1;',
  );
});

it('captures an edit outside the files of a named-files review', async () => {
  const root = await fixRepository();

  const review = await reviewOf(
    root,
    { 'src/math.ts': 'export const add = 3;\n' },
    { kind: 'files', paths: ['src/math.ts'] },
  );

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = 4;\n');
  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 9;\n');

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({
    fixPaths: ['src/math.ts', 'src/other.ts'],
    scope: 'wholeTarget',
    outsidePaths: ['src/other.ts'],
  });
});

it('leaves a deleted path out of the fix capture when a glob excludes it', async () => {
  const root = await fixRepository();
  const review = await reviewOf(root, { 'generated.txt': 'one\n' }, workingTreeTarget);

  await rm(join(root, 'generated.txt'));

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, [], ['*.txt']);

  expect(result).toMatchObject({ fixPaths: [], scope: 'fix', outsidePaths: [] });
});

it('keeps the gap of a skipped binary file that was deleted', async () => {
  const root = await fixRepository();
  const review = await reviewOf(root, { 'logo.bin': '\0\u0001' }, workingTreeTarget);

  await rm(join(root, 'logo.bin'));

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, []);

  expect(result).toMatchObject({ gaps: [{ kind: 'binary', path: 'logo.bin' }] });
});

it('counts a new symlink as a fix path outside the findings', async () => {
  const { root, review, directory } = await reviewedThenFixed();

  await symlink('src/math.ts', join(root, 'linked.ts'));

  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ scope: 'wholeTarget', outsidePaths: ['linked.ts'] });
});

it('captures the deletion of a saved file that now lies under a regular file', async () => {
  const root = await fixRepository();

  await mkdir(join(root, 'module'));
  await writeFile(join(root, 'module', 'index.ts'), 'export const one = 1;\n');

  const review = await reviewOf(root, {}, workingTreeTarget);

  await rm(join(root, 'module'), { recursive: true });
  await writeFile(join(root, 'module'), 'plain\n');

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['module/index.ts', 'module']);

  expect(result).toMatchObject({ fixPaths: ['module', 'module/index.ts'] });

  expect(await readFile(join(directory, 'input.md'), 'utf8')).toContain('deleted file mode');
});

it('applies an exclude when a file replaces a directory with the same name', async () => {
  const root = await fixRepository();

  await mkdir(join(root, 'module'));
  await writeFile(join(root, 'module', 'index.ts'), 'export const one = 1;\n');

  const review = await reviewOf(root, {}, workingTreeTarget);

  await rm(join(root, 'module'), { recursive: true });
  await writeFile(join(root, 'module'), 'plain\n');

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, [], ['unrelated.txt']);

  expect(result).toMatchObject({ fixPaths: ['module', 'module/index.ts'] });
});

it('counts a skipped binary restored to its base value as an outside change', async () => {
  const root = await fixRepository();

  await writeFile(join(root, 'logo.bin'), Buffer.from([0, 1, 2]));
  await git(root, ['add', 'logo.bin']);
  await git(root, ['commit', '--quiet', '-m', 'logo']);

  const review = await reviewOf(root, { 'logo.bin': '\0\u0009' }, workingTreeTarget);

  await writeFile(join(root, 'logo.bin'), Buffer.from([0, 1, 2]));

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ scope: 'wholeTarget', outsidePaths: ['logo.bin'] });
});
