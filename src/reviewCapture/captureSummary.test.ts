import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { installCommandShim } from '../../tests/commandShimFake.js';
import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { captureTarget, pinTarget } from './capture.js';

const defaultFiles = { 'tracked.txt': 'one\n' };

const committedRepository = async (files: Record<string, string> = defaultFiles) => {
  const root = await createTemporaryRepository(onTestFinished);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

const capture = async (root: string, target: Parameters<typeof pinTarget>[1]) =>
  captureTarget(root, await pinTarget(root, target));

const numberedLines = (prefix: string, count: number) =>
  Array.from({ length: count }, (_value, index) => `${prefix} ${index}\n`).join('');

it('captures a file with ten or more added and deleted lines', async () => {
  const root = await committedRepository({ 'long.txt': numberedLines('old', 12) });

  await writeFile(join(root, 'long.txt'), numberedLines('new', 25));

  const result = await capture(root, { kind: 'workingTree', base: 'HEAD' });

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['long.txt']);
  expect(result.gaps).toEqual([]);
});

it.each([
  { name: 'diff.noprefix', setting: ['diff.noprefix', 'true'] },
  { name: 'diff.mnemonicPrefix', setting: ['diff.mnemonicPrefix', 'true'] },
])('prints a/ and b/ header paths whatever $name says', async ({ setting }) => {
  const root = await committedRepository({ 'a.txt': 'one\n' });
  const first = (await git(root, 'rev-parse', 'HEAD')).trim();

  await git(root, 'config', ...setting);
  await writeFile(join(root, 'a.txt'), 'two\n');
  await writeFile(join(root, 'u.txt'), 'new\n');

  const workingTree = await capture(root, { kind: 'workingTree', base: 'HEAD' });
  const text = workingTree.bytes.toString('utf8');

  expect(text).toContain('diff --git a/a.txt b/a.txt');
  expect(text).toContain('diff --git a/u.txt b/u.txt');

  await git(root, 'commit', '--quiet', '-am', 'second');

  const range = await capture(root, { kind: 'range', from: first, to: 'HEAD' });
  const commit = await capture(root, { kind: 'rootCommit', commit: first });

  expect(range.bytes.toString('utf8')).toContain('diff --git a/a.txt b/a.txt');
  expect(commit.bytes.toString('utf8')).toContain('diff --git a/a.txt b/a.txt');
});

const committedLink = async () => {
  const root = await committedRepository({ 'tracked.txt': 'one\n' });
  const link = join(root, 'sub');

  await mkdir(link);
  await git(link, 'init', '--quiet');
  await git(link, 'commit', '--quiet', '--allow-empty', '-m', 'one');
  await git(root, 'add', 'sub');
  await git(root, 'commit', '--quiet', '-m', 'link');

  return root;
};

it('reports a Git link that the working tree no longer holds as a gap', async () => {
  const root = await committedLink();

  await rm(join(root, 'sub'), { recursive: true });

  const result = await capture(root, { kind: 'workingTree', base: 'HEAD' });

  expect(result.errors).toEqual([]);
  expect(result.gaps).toEqual([{ kind: 'submodule', path: 'sub' }]);
});

it('reports a file that replaces a Git link as a gap', async () => {
  const root = await committedLink();

  await rm(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub'), 'plain\n');

  const result = await capture(root, { kind: 'workingTree', base: 'HEAD' });

  expect(result.errors).toEqual([]);
  expect(result.gaps).toContainEqual({ kind: 'submodule', path: 'sub' });
});

it('fails the capture when a changed named file disappears after the diff', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const target = await pinTarget(root, { kind: 'files', paths: ['tracked.txt'] });
  const marker = join(root, '.git', 'changed-marker');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [
      {
        match: ' diff ',
        script: `"$real" "$@"; status=$?; if [ ! -e '${marker}' ]; then : > '${marker}'; rm '${join(root, 'tracked.txt')}'; fi; exit $status`,
      },
    ],
  });

  const result = await captureTarget(root, target);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('tracked.txt');
});

it('captures a named file in a deleted directory as a deletion without a gap', async () => {
  const root = await committedRepository({ 'dir/a.txt': 'one\n' });

  await rm(join(root, 'dir'), { recursive: true });

  const result = await capture(root, { kind: 'files', paths: ['dir/a.txt'] });

  expect(result.errors).toEqual([]);
  expect(result.gaps).toEqual([]);
  expect(result.paths).toEqual(['dir/a.txt']);
});

it('reports an untracked link to a directory as unreadable', async () => {
  const root = await committedRepository();

  await mkdir(join(root, 'dir'));
  await writeFile(join(root, 'dir', 'inside.txt'), 'inside\n');
  await symlink('dir', join(root, 'link'));

  const result = await capture(root, { kind: 'workingTree', base: 'HEAD' });

  expect(result.errors).toEqual([]);
  expect(result.gaps).toEqual([{ kind: 'unreadable', path: 'link' }]);
  expect(result.paths).toEqual(['dir/inside.txt']);
});

const summaryOutput = (printf: string) => ({
  match: ' --raw --numstat ',
  script: `printf '${printf}'`,
});

const captureWithSummary = async (printf: string) => {
  const root = await committedRepository();
  const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });

  await installCommandShim('git', { otherCalls: 'real', overrides: [summaryOutput(printf)] });

  return captureTarget(root, target);
};

it.each([
  { name: 'a summary that holds no NUL', printf: 'abc', error: 'no end to the diff summary' },
  {
    name: 'a numstat record with no end',
    printf: '1\\t1\\tfile\\000',
    error: 'no end to the diff summary',
  },
  {
    name: 'a raw record that stops in the middle',
    printf: ':100644 100644 aaa bbb M\\000file',
    error: 'in the middle of an entry',
  },
  {
    name: 'a numstat line with text before the counts',
    printf: 'x1\\t2\\tfile\\000\\000',
    error: 'numstat line it should not',
  },
  {
    name: 'a numstat line with no tab',
    printf: 'file\\000\\000',
    error: 'numstat line it should not',
  },
])('fails the capture on $name', async ({ printf, error }) => {
  const result = await captureWithSummary(printf);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain(error);
  expect(result.paths).toEqual([]);
});

it.each([
  {
    name: 'a link that changes to a file',
    printf: ':160000 100644 aaa bbb M\\000sub\\0001\\t1\\tsub\\000\\000',
  },
  {
    name: 'a file that changes to a link',
    printf: ':100644 160000 aaa bbb M\\000sub\\0001\\t1\\tsub\\000\\000',
  },
])('reports $name as a gap', async ({ printf }) => {
  const result = await captureWithSummary(printf);

  expect(result.errors).toEqual([]);
  expect(result.gaps).toEqual([{ kind: 'submodule', path: 'sub' }]);
  expect(result.paths).toEqual(['sub']);
});

it('reads both paths of a rename and of a copy', async () => {
  const printf =
    ':100644 100644 aaa bbb R100\\000old.txt\\000new.txt\\000:100644 100644 aaa bbb C050\\000from.txt\\000to.txt\\000' +
    '0\\t0\\t\\000old.txt\\000new.txt\\0000\\t0\\t\\000from.txt\\000to.txt\\000\\000';

  const result = await captureWithSummary(printf);

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['from.txt', 'new.txt', 'old.txt', 'to.txt']);
});

it('treats a named file that the diff shows as deleted as a deletion', async () => {
  const root = await committedRepository({ 'gone.txt': 'one\n', 'kept.txt': 'one\n' });
  const target = await pinTarget(root, { kind: 'files', paths: ['gone.txt', 'kept.txt'] });

  await rm(join(root, 'gone.txt'));

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [
      summaryOutput(':100644 000000 aaa 000 D\\000gone.txt\\0000\\t1\\tgone.txt\\000\\000'),
    ],
  });

  const deletedFile = await captureTarget(root, target);

  expect(deletedFile.errors).toEqual([]);
});

it('fails the capture when the diff command fails', async () => {
  const root = await committedRepository();
  const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [{ match: ' --raw --numstat ', script: 'echo broken >&2; exit 3' }],
  });

  const result = await captureTarget(root, target);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('failed: exit 3: broken');
  expect(result.paths).toEqual([]);
});

const untrackedFileCapture = async (script: string) => {
  const root = await committedRepository();

  await writeFile(join(root, 'new.txt'), 'new\n');

  const target = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [{ match: ' --no-index ', script }],
  });

  return captureTarget(root, target);
};

it.each([
  { name: 'exit code 2 with no message', script: 'exit 2', error: 'exit 2: ' },
  {
    name: 'exit code 128 and a message',
    script: 'echo "  oops  " >&2; exit 128',
    error: 'exit 128: oops',
  },
])('fails the capture of an untracked file on $name', async ({ script, error }) => {
  const result = await untrackedFileCapture(script);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.endsWith(error)).toBe(true);
});

it('fails the capture of an untracked file when the diff cannot start', async () => {
  const result = await untrackedFileCapture('kill -9 $$');

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('git diff');
});

it('captures an untracked file whose diff prints only whitespace to stderr', async () => {
  const result = await untrackedFileCapture('echo >&2; exec "$real" "$@"');

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['new.txt']);
});

it('reports an untracked binary file as a gap', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, 'text.txt'), 'binary files are not mentioned here\n');

  const result = await capture(root, { kind: 'workingTree', base: 'HEAD' });

  expect(result.gaps).toEqual([{ kind: 'binary', path: 'data.bin' }]);
});
