import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect, it } from 'vitest';

import { git } from '../../tests/gitRepository.js';
import { compareEndpoint } from './endpoint.js';
import type { Endpoint } from './endpoint.js';
import { readReviewEvidence } from './evidence.js';
import {
  failureOf,
  captureWorkingTree,
  listDirectory,
  prepareDirectory,
  fixRepository,
} from './fixtures/reviewDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';
import { checkReviewFreshness } from './pinnedCapture.js';
import type { ReviewTarget } from './target.js';

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
  captureReviewDirectory(root, directory, {
    kind: 'fix',
    review,
    findingPaths,
    ...(exclude === undefined ? {} : { exclude }),
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

  const evidence = (await readReviewEvidence(root, directory)) as {
    callers: { module: string; path: string }[];
  };

  expect(evidence.callers.map((caller) => caller.path)).toEqual(['src/use.ts']);
});

it('captures a fix against an earlier version 5 capture and leaves that capture unchanged', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const earlier = await readFile(join(review, 'capture.json'), 'utf8');

  expect(JSON.parse(earlier)).toMatchObject({ version: 5 });

  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ empty: false, fixPaths: ['src/math.ts'], scope: 'fix' });
  expect(await readFile(join(review, 'capture.json'), 'utf8')).toBe(earlier);
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
  await git(root, 'commit', '--quiet', '-am', 'second');

  await captureReviewDirectory(root, review, { kind: 'range', from: 'HEAD~1', to: 'HEAD' });

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = 4;\n');

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ fixPaths: ['src/math.ts'], scope: 'fix' });
  expect(await readFile(join(directory, 'input.md'), 'utf8')).toContain('-export const add = 3;');
});

it('records the fix capture with the earlier base and no snapshot', async () => {
  const { root, review, directory } = await reviewedThenFixed();

  const earlier = JSON.parse(await readFile(join(review, 'capture.json'), 'utf8')) as {
    endpoint: { tree: string };
  };

  const result = await captureFix(root, directory, review, ['src/math.ts']);
  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as object;

  expect(record).toEqual({
    version: 5,
    target: {
      kind: 'fix',
      review,
      findingPaths: ['src/math.ts'],
      base: result['base'],
      predecessor: {
        review,
        identity: expect.stringMatching(/^[0-9a-f]{40}$/) as string,
        endpointTree: earlier.endpoint.tree,
      },
    },
    base: result['base'],
    head: result['head'],
    hash: result['hash'],
    gaps: [],
    original: {
      patch: expect.stringMatching(/^[0-9a-f]{40}$/) as string,
      input: expect.stringMatching(/^[0-9a-f]{40}$/) as string,
    },
    endpoint: {
      status: 'complete',
      baseTree: earlier.endpoint.tree,
      tree: expect.stringMatching(/^[0-9a-f]{40}$/) as string,
      ref: `refs/tau/review-captures/${basename(directory)}`,
    },
  });

  expect(await readdir(directory)).not.toContain('snapshot');
});

it('refuses a fix review of a directory with no capture record and writes nothing', async () => {
  const { root, directory } = await reviewedThenFixed();
  const empty = await prepareDirectory(root);
  const before = await listDirectory(directory);

  const target = { kind: 'fix' as const, review: empty, findingPaths: [] };

  expect(await failureOf(() => captureReviewDirectory(root, directory, target))).toContain(
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

  expect(await failureOf(() => captureReviewDirectory(root, directory, target))).toContain(
    'no snapshot',
  );

  expect(await readdir(directory)).toEqual(['input.md']);
});

it('refuses a fix review of a version 1 record and writes nothing', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const saved = JSON.parse(await readFile(join(review, 'capture.json'), 'utf8')) as object;
  const { base, head, hash, ...rest } = saved as Record<string, unknown>;
  const record = { version: 1, target: rest['target'], base, head, hash };

  await writeFile(join(review, 'capture.json'), JSON.stringify(record));

  const target = { kind: 'fix' as const, review, findingPaths: [] };

  expect(await failureOf(() => captureReviewDirectory(root, directory, target))).toContain(
    'version 1',
  );

  expect(await readdir(directory)).toEqual(['input.md']);
});

it('refuses a fix review of an earlier capture whose saved input changed and writes nothing', async () => {
  const { root, review, directory } = await reviewedThenFixed();

  await writeFile(join(review, 'capture', 'input.md'), 'changed\n');

  const target = { kind: 'fix' as const, review, findingPaths: [] };

  expect(await failureOf(() => captureReviewDirectory(root, directory, target))).toContain(
    'altered',
  );

  expect(await readdir(directory)).toEqual(['input.md']);
});

it('captures a fix against an earlier version 2 capture', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const saved = JSON.parse(await readFile(join(review, 'capture.json'), 'utf8')) as object;

  const {
    gaps: _gaps,
    original: _original,
    endpoint: _endpoint,
    ...rest
  } = saved as Record<string, unknown>;

  await writeFile(join(review, 'capture.json'), JSON.stringify({ ...rest, version: 2 }));

  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ empty: false, fixPaths: ['src/math.ts'], scope: 'fix' });
});

it('refuses a fix review of a fix capture with no complete endpoint', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const saved = JSON.parse(await readFile(join(review, 'capture.json'), 'utf8')) as object;
  const { endpoint: _endpoint, ...rest } = saved as Record<string, unknown>;
  const fix = await prepareDirectory(root);

  await writeFile(join(review, 'capture.json'), JSON.stringify({ ...rest, version: 3 }));
  await captureFix(root, fix, review, ['src/math.ts']);

  const target = { kind: 'fix' as const, review: fix, findingPaths: [] };

  expect(await failureOf(() => captureReviewDirectory(root, directory, target))).toContain(
    'fix capture with no complete endpoint',
  );

  expect(await readdir(directory)).toEqual(['input.md']);
});

it('keeps a committed fix capture fresh except for HEAD and its endpoint equal to the commit', async () => {
  const { root, review, directory } = await reviewedThenFixed();
  const fix = await prepareDirectory(root);

  await captureFix(root, directory, review, ['src/math.ts']);
  await writeFile(join(root, 'src', 'other.ts'), 'export const other = 2;\n');
  await captureFix(root, fix, directory, ['src/other.ts']);
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'fixed');

  const record = JSON.parse(await readFile(join(fix, 'capture.json'), 'utf8')) as {
    endpoint: Endpoint;
  };

  const freshness = await checkReviewFreshness(root, fix);

  expect(await compareEndpoint(root, record.endpoint, 'HEAD')).toBe('equal');
  expect(freshness).toEqual({ status: 'stale', reasons: [expect.stringContaining('HEAD moved')] });
});

it('reports a fix capture fresh when nothing changed and stale after another edit', async () => {
  const { root, review, directory } = await reviewedThenFixed();

  await captureFix(root, directory, review, ['src/math.ts']);

  expect(await checkReviewFreshness(root, directory)).toEqual({
    status: 'fresh',
    reasons: [],
  });

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = 5;\n');

  expect(await checkReviewFreshness(root, directory)).toMatchObject({ status: 'stale' });
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
        existed: true,
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

const reviewOf = async (root: string, edits: Record<string, string>, target: ReviewTarget) => {
  const review = await prepareDirectory(root);

  for (const [path, text] of Object.entries(edits)) {
    await writeFile(join(root, path), text);
  }

  await captureReviewDirectory(root, review, target);

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
  await git(root, 'add', 'logo.bin');
  await git(root, 'commit', '--quiet', '-m', 'logo');

  const review = await reviewOf(root, { 'logo.bin': '\0\u0009' }, workingTreeTarget);

  await writeFile(join(root, 'logo.bin'), Buffer.from([0, 1, 2]));

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ scope: 'wholeTarget', outsidePaths: ['logo.bin'] });
});

it('counts the deletion of a reviewed symlink as an outside change', async () => {
  const root = await fixRepository();

  await symlink('src/math.ts', join(root, 'linked.ts'));

  const review = await reviewOf(root, {}, workingTreeTarget);

  await rm(join(root, 'linked.ts'));

  const directory = await prepareDirectory(root);
  const result = await captureFix(root, directory, review, ['src/math.ts']);

  expect(result).toMatchObject({ scope: 'wholeTarget', outsidePaths: ['linked.ts'] });
});
