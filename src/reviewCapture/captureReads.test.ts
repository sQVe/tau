import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { captureTarget, pinTarget } from './capture.js';
import type { DirectReviewTarget } from './capture.js';
import { installFakeGit } from './fixtures/fakeGit.js';
import type { GitOverride } from './fixtures/fakeGit.js';

const git = async (root: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout;
};

const committedRepository = async (files: Record<string, string>) => {
  const root = await createTemporaryRepository(onTestFinished);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

// A repository whose files are in the base commit but not in the index, so a files target shows
// them in full and compares them with the base text.
const unindexedRepository = async (files: Record<string, string>) => {
  const root = await committedRepository(files);

  await git(root, 'rm', '--cached', '--quiet', '-r', '.');

  return root;
};

const capture = async (root: string, target: DirectReviewTarget, overrides: GitOverride[]) => {
  const pinned = await pinTarget(root, target);

  await installFakeGit(overrides);

  return captureTarget(root, pinned);
};

const failing = (match: string, script = 'echo "  broken  " >&2; exit 3'): GitOverride => ({
  match,
  script,
});

const files = (paths: string[]): DirectReviewTarget => ({ kind: 'files', paths });

it('compares each unindexed file with its own base text', async () => {
  const root = await unindexedRepository({
    'a.txt': 'the first file has a long first line\nshared\n',
    'b.txt': 'p\nq\n',
  });

  await writeFile(join(root, 'a.txt'), 'the first file has a long first line\nshared\nnew a\n');
  await writeFile(join(root, 'b.txt'), 'p\nq\nnew b\n');

  const result = await capture(root, files(['a.txt', 'b.txt']), []);
  const added = (result.addedBytes ?? Buffer.alloc(0)).toString('utf8');

  expect(result.errors).toEqual([]);
  const addedLines = added.split('\n').filter((line) => /^\+[^+]/.test(line));

  expect(addedLines).toEqual(['+new a', '+new b']);
});

it('captures an unindexed file whose base text is empty', async () => {
  const root = await unindexedRepository({ 'a.txt': '', 'b.txt': 'one\n' });

  await writeFile(join(root, 'a.txt'), 'new\n');

  const result = await capture(root, files(['a.txt', 'b.txt']), []);

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['a.txt', 'b.txt']);
});

it('adds nothing for a named file in the index and every line of a new file', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n' });

  await writeFile(join(root, 'new.txt'), 'new\n');

  const result = await capture(root, files(['a.txt', 'new.txt']), []);
  const added = (result.addedBytes ?? Buffer.alloc(0)).toString('utf8');
  const addedLines = added.split('\n').filter((line) => /^\+[^+]/.test(line));

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['a.txt', 'new.txt']);
  expect(addedLines).toEqual(['+new']);
});

it('compares only the requested file with its base text', async () => {
  const root = await unindexedRepository({ 'a.txt': 'alpha\n', 'b.txt': 'beta beta beta\n' });

  await writeFile(join(root, 'a.txt'), 'alpha\nnew a\n');
  await writeFile(join(root, 'b.txt'), 'beta beta beta\nnew b\n');

  const result = await capture(root, files(['a.txt']), []);
  const added = (result.addedBytes ?? Buffer.alloc(0)).toString('utf8');
  const addedLines = added.split('\n').filter((line) => /^\+[^+]/.test(line));

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['a.txt']);
  expect(addedLines).toEqual(['+new a']);
});

it('does not read the blob of a tree entry that is not a file', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n' });
  const link = join(root, 'sub');

  await mkdir(link);
  await git(link, 'init', '--quiet');
  await git(link, 'commit', '--quiet', '--allow-empty', '-m', 'one');
  await git(root, 'add', 'sub');
  await git(root, 'commit', '--quiet', '-m', 'link');
  await git(root, 'rm', '--cached', '--quiet', 'a.txt');

  const result = await capture(root, files(['a.txt']), []);

  expect(result.errors).toEqual([]);
});

it.each([
  {
    name: 'ls-files cannot list the untracked files',
    overrides: [failing(' ls-files -z -c -o ')],
    error: 'git ls-files -z -c -o --exclude-standard -- a.txt failed: exit 3: broken',
  },
  {
    name: 'ls-files cannot list the index',
    overrides: [failing(' ls-files -z -s ')],
    error: 'git ls-files -z -s -- a.txt failed: exit 3: broken',
  },
  {
    name: 'ls-tree cannot list the base tree',
    overrides: [failing(' ls-tree ')],
    error: 'ls-tree -r -z --end-of-options',
  },
  {
    name: 'cat-file fails',
    overrides: [failing(' cat-file ')],
    error: 'git cat-file --batch failed: exit 3: broken',
  },
  {
    name: 'cat-file fails without a message',
    overrides: [failing(' cat-file ', 'exit 3')],
    error: 'git cat-file --batch failed: exit 3: ',
  },
  {
    name: 'cat-file prints to stderr and exits 0',
    overrides: [failing(' cat-file ', 'echo noise >&2; exec "$git" "$@"')],
    error: 'git cat-file --batch failed: exit 0: noise',
  },
])('fails the capture once when $name', async ({ overrides, error }) => {
  const root = await unindexedRepository({ 'a.txt': 'one\n' });

  const result = await capture(root, files(['a.txt']), overrides);

  const distinct = [...new Set(result.errors)];

  expect(distinct).toHaveLength(1);
  expect(distinct[0]).toContain(error);
});

it.each([
  { name: 'a missing object', output: 'deadbeef missing\\n' },
  { name: 'a size that is not a number', output: 'deadbeef blob many\\nabc\\n' },
  { name: 'a header with no end', output: 'deadbeef blob 3' },
])('fails the capture on cat-file output with $name', async ({ output }) => {
  const root = await unindexedRepository({ 'a.txt': 'one\n' });

  const result = await capture(root, files(['a.txt']), [
    failing(' cat-file ', `cat >/dev/null; printf '${output}'`),
  ]);

  expect(result.errors).toEqual(['git cat-file --batch printed unexpected output.']);
});

it('fails the capture when cat-file cannot start', async () => {
  const root = await unindexedRepository({ 'a.txt': 'one\n' });

  const result = await capture(root, files(['a.txt']), [failing(' cat-file ', 'kill -9 $$')]);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('git cat-file --batch failed:');
});

it('fails the capture when Git does not name the object format', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n' });

  const result = await capture(root, { kind: 'workingTree', base: 'HEAD' }, [
    failing(' rev-parse --show-object-format ', 'echo md5'),
  ]);

  expect(result.errors).toEqual(['git rev-parse --show-object-format failed: md5']);
  expect(result.hash).toBe('');
});

it('fails the capture when Git cannot give the object format', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n' });

  const result = await capture(root, { kind: 'workingTree', base: 'HEAD' }, [
    failing(' rev-parse --show-object-format '),
  ]);

  expect(result.errors).toEqual(['git rev-parse --show-object-format failed: exit 3: broken']);
});

it('hashes the capture of a SHA-256 repository the way Git does', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-sha256-');

  await git(root, 'init', '--quiet', '--object-format=sha256', '--initial-branch=main');
  await writeFile(join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await writeFile(join(root, 'a.txt'), 'two\n');

  const pinned = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });
  const result = await captureTarget(root, pinned);
  const header = Buffer.from(`blob ${result.bytes.length}\0`);
  const expected = createHash('sha256').update(header).update(result.bytes).digest('hex');

  expect(result.errors).toEqual([]);
  expect(result.hash).toBe(expected);
});

it('accepts cat-file output with only whitespace on stderr', async () => {
  const root = await unindexedRepository({ 'a.txt': 'one\n' });

  const result = await capture(root, files(['a.txt']), [
    failing(' cat-file ', 'echo >&2; exec "$git" "$@"'),
  ]);

  expect(result.errors).toEqual([]);
});
