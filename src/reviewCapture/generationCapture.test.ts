import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import {
  failureOf,
  inputHeader,
  preparedReview,
  captureWorkingTree,
  listDirectory,
  prepareDirectory,
  failGitCommand,
  fixRepository,
} from './fixtures/reviewDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';

it('appends the capture and its gaps after the Capture heading and saves the record', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'untracked.txt'), 'new\n');

  const result = await captureReviewDirectory(root, directory, {
    kind: 'workingTree',
    base: 'HEAD',
    exclude: ['generated.txt'],
  });

  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  const input = await readFile(join(directory, 'input.md'), 'utf8');
  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as unknown;
  const identity = await git(root, 'hash-object', join(directory, 'capture.json'));
  const patch = await git(root, 'hash-object', join(directory, 'capture', 'patch.diff'));
  const saved = await git(root, 'hash-object', join(directory, 'capture', 'input.md'));

  const copyLines = await Promise.all(
    ['tracked.txt', 'untracked.txt'].map(async (path) => {
      const copy = join(directory, 'snapshot', path);
      const blob = await git(root, 'hash-object', '--no-filters', copy);
      const mode = ((await stat(copy)).mode & 0o100) === 0 ? '100644' : '100755';

      return `${mode} ${blob.trim()} ${JSON.stringify(path)}`;
    }),
  );

  const manifest = join(temporaryDirectory(onTestFinished, 'tau-snapshot-manifest-'), 'manifest');

  await writeFile(manifest, `${copyLines.join('\n')}\nabsent []\nskipped []\n`);

  const snapshot = await git(root, 'hash-object', '--no-filters', manifest);

  expect(result['hash']).toMatch(/^[0-9a-f]{40}$/);

  expect(result).toEqual({
    hash: result['hash'],
    head,
    base: head,
    empty: false,
    paths: ['tracked.txt', 'untracked.txt'],
    gaps: [{ kind: 'excluded', path: 'generated.txt' }],
    identity: identity.trim(),
  });

  expect(await readFile(join(directory, 'capture', 'input.md'), 'utf8')).toBe(input);

  expect(input.startsWith(inputHeader)).toBe(true);
  expect(input).toContain('+two');
  expect(input).toContain('+new');
  expect(input.indexOf('## Gaps')).toBeGreaterThan(input.indexOf('+new'));
  expect(input).toContain('generated.txt');

  expect(record).toEqual({
    version: 5,
    target: { kind: 'workingTree', base: head, exclude: ['generated.txt'] },
    base: head,
    head,
    hash: result['hash'],
    snapshot: { present: ['tracked.txt', 'untracked.txt'], absent: [], skipped: [] },
    gaps: [{ kind: 'excluded', path: 'generated.txt' }],
    original: { patch: patch.trim(), input: saved.trim(), snapshot: snapshot.trim() },
    endpoint: { status: 'unsupported', reasons: [expect.stringContaining('generated.txt')] },
  });
});

it('writes a gap path with a newline and a backtick on one list line', async () => {
  const { root, directory } = await preparedReview();
  const path = 'odd`name\n- injected';

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  await captureReviewDirectory(root, directory, {
    kind: 'workingTree',
    base: 'HEAD',
    exclude: [path],
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
  expect(result).not.toHaveProperty('identity');
  expect(await listDirectory(directory)).toEqual(before);
});

it('refuses an input.md without the Capture heading and writes nothing', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(directory, 'input.md'), '# Review input\n');
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const before = await listDirectory(directory);

  expect(
    await failureOf(() =>
      captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
    ),
  ).toContain('## Capture');

  expect(await listDirectory(directory)).toEqual(before);
});

it('refuses a second capture into the same directory', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);

  const before = await listDirectory(directory);

  const failure = await failureOf(() =>
    captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
  );

  expect(failure).toContain('capture.json');
  expect(await listDirectory(directory)).toEqual(before);
});

it('fails the capture on a Git error and writes nothing', async () => {
  const { root, directory } = await preparedReview();
  const before = await listDirectory(directory);

  const failure = await failureOf(() =>
    captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'no-such-branch' }),
  );

  expect(failure).toContain('no-such-branch');
  expect(await listDirectory(directory)).toEqual(before);
});

it.skipIf(process.getuid?.() === 0)(
  'captures a changed file under an unreadable directory as an unreadable gap',
  async () => {
    const root = await fixRepository();

    await mkdir(join(root, 'locked'));
    await writeFile(join(root, 'locked', 'a.ts'), 'export const a = 1;\n');
    await git(root, 'add', '--all');
    await git(root, 'commit', '--quiet', '-m', 'locked');
    await writeFile(join(root, 'locked', 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(root, 'src', 'math.ts'), 'export const add = 9;\n');
    await chmod(join(root, 'locked'), 0o000);
    onTestFinished(() => chmod(join(root, 'locked'), 0o755));

    const review = await prepareDirectory(root);
    const result = await captureWorkingTree(root, review);

    expect(result['gaps']).toContainEqual({ kind: 'unreadable', path: 'locked/a.ts' });
  },
);

it('captures a root commit with a null base in the result and the saved record', async () => {
  const { root, directory } = await preparedReview();
  const commit = (await git(root, 'rev-parse', 'HEAD')).trim();

  const result = await captureReviewDirectory(root, directory, {
    kind: 'rootCommit',
    commit,
  });

  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as unknown;

  expect(result).toMatchObject({ base: null, head: commit, paths: ['tracked.txt'] });
  expect(record).toMatchObject({ base: null, head: commit });
});

it('refuses an incomplete capture and writes nothing', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await writeFile(join(root, 'untracked.txt'), 'new\n');

  const before = await listDirectory(directory);

  await failGitCommand('diff');

  expect(
    await failureOf(() =>
      captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
    ),
  ).toContain('forced failure');

  expect(await listDirectory(directory)).toEqual(before);
});

it('refuses a capture when HEAD cannot be read and writes nothing', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const before = await listDirectory(directory);

  await failGitCommand('--verify HEAD');

  expect(
    await failureOf(() =>
      captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
    ),
  ).toContain('forced failure');

  expect(await listDirectory(directory)).toEqual(before);
});

it.each(['## Capture \n', '## Capture\r\n'])(
  'accepts a Capture heading with trailing whitespace: %j',
  async (heading) => {
    const { root, directory } = await preparedReview();

    await writeFile(join(directory, 'input.md'), `# Review input\n\n${heading}`);
    await writeFile(join(root, 'tracked.txt'), 'two\n');

    const result = await captureWorkingTree(root, directory);

    expect(result['empty']).toBe(false);
    expect(await readFile(join(directory, 'input.md'), 'utf8')).toContain('+two');
  },
);

it('names the missing heading when input.md has no heading at all', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(directory, 'input.md'), 'plain text\n');
  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const before = await listDirectory(directory);

  expect(
    await failureOf(() =>
      captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' }),
    ),
  ).toContain('## Capture');

  expect(await listDirectory(directory)).toEqual(before);
});

// Commits src/a.test.ts, then replaces src with a link to an outside folder with its own a.test.ts.
const linkedDirectoryReview = async () => {
  const { root, directory } = await preparedReview();
  const outside = temporaryDirectory(onTestFinished, 'tau-review-outside-');

  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.test.ts'), 'tracked\n');
  await git(root, 'add', '--all');
  await git(root, 'commit', '--quiet', '-m', 'src');
  await writeFile(join(outside, 'a.test.ts'), 'outside secret\n');
  await rm(join(root, 'src'), { recursive: true });
  await symlink(outside, join(root, 'src'));

  return { root, directory };
};

it('reports a named file under a directory that links outside the repository as unreadable', async () => {
  const { root, directory } = await linkedDirectoryReview();

  const result = await captureReviewDirectory(root, directory, {
    kind: 'files',
    paths: ['src/a.test.ts'],
  });

  expect(result['gaps']).toContainEqual({ kind: 'unreadable', path: 'src/a.test.ts' });
  expect(await readFile(join(directory, 'input.md'), 'utf8')).not.toContain('outside secret');
});

it('reports an untracked link to a directory as unreadable', async () => {
  const { root, directory } = await linkedDirectoryReview();

  const result = await captureWorkingTree(root, directory);

  expect(result['gaps']).toContainEqual({ kind: 'unreadable', path: 'src' });
  expect(await readFile(join(directory, 'input.md'), 'utf8')).not.toContain('outside secret');
});
