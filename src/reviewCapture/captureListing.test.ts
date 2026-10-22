import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { captureTarget, pinTarget } from './capture.js';
import type { DirectReviewTarget } from './capture.js';
import { installFakeGit } from './fixtures/fakeGit.js';
import type { GitOverride } from './fixtures/fakeGit.js';

const git = async (root: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout;
};

const isRoot = process.getuid?.() === 0;

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

const capture = async (root: string, target: DirectReviewTarget, overrides: GitOverride[] = []) => {
  const pinned = await pinTarget(root, target);

  await installFakeGit(overrides);

  return captureTarget(root, pinned);
};

const workingTree: DirectReviewTarget = { kind: 'workingTree', base: 'HEAD' };

const nestedRepository = async (root: string, name: string) => {
  const directory = join(root, name);

  await mkdir(directory);
  await git(directory, 'init', '--quiet');
  await git(directory, 'commit', '--quiet', '--allow-empty', '-m', 'inner');
};

it('reports a path that a files target lists nothing for, and keeps the others', async () => {
  const root = await committedRepository();

  const result = await capture(root, { kind: 'files', paths: ['tracked.txt', 'nope.txt'] });

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['tracked.txt']);
  expect(result.gaps).toEqual([{ kind: 'unmatched', path: 'nope.txt' }]);
});

it('fails the capture when Git cannot check a named path', async () => {
  const root = await committedRepository();

  const result = await capture(root, { kind: 'files', paths: ['tracked.txt'] }, [
    { match: ' ls-files -z -c -o --exclude-standard -- tracked.txt ', script: 'exit 3' },
  ]);

  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.gaps).not.toContainEqual({ kind: 'unmatched', path: 'tracked.txt' });
});

it('shows an unchanged named file in full and adds nothing from it', async () => {
  const root = await committedRepository();

  const result = await capture(root, { kind: 'files', paths: ['tracked.txt'] });

  expect(result.errors).toEqual([]);
  expect(result.bytes.toString('utf8')).toContain('+one');
  expect(result.addedBytes?.length).toBe(0);
});

it('lists the untracked files whole for a working tree and compares none with the base', async () => {
  const root = await committedRepository({ 'a.txt': 'one\ntwo\n' });

  await git(root, 'rm', '--cached', '--quiet', 'a.txt');

  const result = await capture(root, workingTree);
  const added = result.addedBytes?.toString('utf8') ?? '';

  expect(result.errors).toEqual([]);
  expect(added.split('\n').filter((line) => /^\+[^+]/.test(line))).toEqual(['+one', '+two']);
});

it('treats a working line that equals the size of the base text as added', async () => {
  const root = await committedRepository({ 'a.txt': 'x\n' });

  await git(root, 'rm', '--cached', '--quiet', 'a.txt');
  await writeFile(join(root, 'a.txt'), 'x\n2\n');

  const result = await capture(root, { kind: 'files', paths: ['a.txt'] });
  const added = result.addedBytes?.toString('utf8') ?? '';

  expect(added.split('\n').filter((line) => /^\+[^+]/.test(line))).toEqual(['+2']);
});

it('reports a committed Git link in a files target as a gap and keeps the other named files', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n' });

  await nestedRepository(root, 'sub');
  await git(root, 'add', 'sub');
  await git(root, 'commit', '--quiet', '-m', 'link');

  const result = await capture(root, { kind: 'files', paths: ['a.txt', 'sub'] });

  expect(result.errors).toEqual([]);
  expect(result.gaps).toEqual([{ kind: 'submodule', path: 'sub' }]);
  expect(result.paths).toEqual(['a.txt']);
});

it('reports an untracked nested repository as a gap named without a slash', async () => {
  const root = await committedRepository();

  await nestedRepository(root, 'inner');

  const result = await capture(root, workingTree);

  expect(result.errors).toEqual([]);
  expect(result.gaps).toEqual([{ kind: 'submodule', path: 'inner' }]);
});

it('does not read a Git link of the base tree as the text of a file with the same name', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n' });

  await nestedRepository(root, 'sub');
  await git(root, 'add', 'sub');
  await git(root, 'commit', '--quiet', '-m', 'link');
  await git(root, 'rm', '--cached', '--quiet', '-f', 'sub');
  await rm(join(root, 'sub'), { recursive: true, force: true });
  await writeFile(join(root, 'sub'), 'now a file\n');

  const result = await capture(root, { kind: 'files', paths: ['sub'] });

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['sub']);
});

const warning = (directory: string) =>
  `echo "warning: could not open directory '${directory}/': Permission denied" >&2; ` +
  `"$git" "$@"`;

const lockedDirectory = async (root: string) => {
  await mkdir(join(root, 'locked'));
  await chmod(join(root, 'locked'), 0o000);
  onTestFinished(() => chmod(join(root, 'locked'), 0o755));
};

it.skipIf(isRoot)(
  'reports a directory that Git could not open and the user cannot read as unreadable',
  async () => {
    const root = await committedRepository();

    await lockedDirectory(root);
    await writeFile(join(root, 'seen.txt'), 'seen\n');

    const result = await capture(root, workingTree, [
      { match: ' ls-files -z -o ', script: warning('locked') },
    ]);

    expect(result.errors).toEqual([]);
    expect(result.paths).toEqual(['seen.txt']);
    expect(result.gaps).toEqual([{ kind: 'unreadable', path: 'locked' }]);
  },
);

it.skipIf(isRoot)('reports two unopened directories that the user cannot read', async () => {
  const root = await committedRepository();

  await lockedDirectory(root);
  await mkdir(join(root, 'locked-two'));
  await chmod(join(root, 'locked-two'), 0o000);
  onTestFinished(() => chmod(join(root, 'locked-two'), 0o755));

  const script = [
    `echo "warning: could not open directory 'locked/': Permission denied" >&2`,
    `echo "warning: could not open directory 'locked-two/': Permission denied" >&2`,
    'exec "$git" "$@"',
  ].join('; ');

  const result = await capture(root, workingTree, [{ match: ' ls-files -z -o ', script }]);

  expect(result.errors).toEqual([]);

  expect(result.gaps).toEqual([
    { kind: 'unreadable', path: 'locked' },
    { kind: 'unreadable', path: 'locked-two' },
  ]);
});

it('keeps a warning about a directory the user can read as an error', async () => {
  const root = await committedRepository();

  await mkdir(join(root, 'open'));

  const result = await capture(root, workingTree, [
    { match: ' ls-files -z -o ', script: warning('open') },
  ]);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain("could not open directory 'open/': Permission denied");
});

it('keeps a readable directory as an error even when another warning names a locked one', async () => {
  const root = await committedRepository();

  await lockedDirectory(root);
  await mkdir(join(root, 'open'));

  const script = [
    `echo "warning: could not open directory 'locked/': Permission denied" >&2`,
    `echo "warning: could not open directory 'open/': Permission denied" >&2`,
    'exec "$git" "$@"',
  ].join('; ');

  const result = await capture(root, workingTree, [{ match: ' ls-files -z -o ', script }]);

  expect(result.errors).toHaveLength(1);
  expect(result.gaps).toEqual([]);
});

it.each([
  { name: 'another message', script: 'echo "fatal: something else" >&2; exec "$git" "$@"' },
  {
    name: 'another message beside a warning',
    script:
      `echo "warning: could not open directory 'locked/': Permission denied" >&2; ` +
      'echo "something else" >&2; exec "$git" "$@"',
  },
  {
    name: 'a warning with text around it',
    script:
      `echo "note: warning: could not open directory 'locked/': Permission denied" >&2; ` +
      'exec "$git" "$@"',
  },
  {
    name: 'a warning that holds more text',
    script:
      `echo "warning: could not open directory 'locked/': Permission denied (again)" >&2; ` +
      'exec "$git" "$@"',
  },
])('keeps $name on stderr as an error', async ({ script }) => {
  const root = await committedRepository();

  await lockedDirectory(root);

  const result = await capture(root, workingTree, [{ match: ' ls-files -z -o ', script }]);

  expect(result.errors).toHaveLength(1);
  expect(result.gaps).toEqual([]);
});

it('keeps the exit code and message when ls-files fails', async () => {
  const root = await committedRepository();

  const result = await capture(root, workingTree, [
    { match: ' ls-files -z -o ', script: 'echo "  broken  " >&2; exit 3' },
  ]);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.endsWith('failed: exit 3: broken')).toBe(true);
});

it('keeps the message when ls-files exits 0 and prints to stderr', async () => {
  const root = await committedRepository();

  const result = await capture(root, workingTree, [
    { match: ' ls-files -z -o ', script: 'echo "  noise  " >&2; exec "$git" "$@"' },
  ]);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]?.endsWith('failed: noise')).toBe(true);
});

it('accepts ls-files that prints only whitespace to stderr', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'new.txt'), 'new\n');

  const result = await capture(root, workingTree, [
    { match: ' ls-files -z -o ', script: 'echo >&2; exec "$git" "$@"' },
  ]);

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['new.txt']);
});

it('keeps the exit code when ls-files cannot start', async () => {
  const root = await committedRepository();

  const result = await capture(root, workingTree, [
    { match: ' ls-files -z -o ', script: 'kill -9 $$' },
  ]);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('failed: exit -1:');
});

it('does not list untracked or unchanged files for a range', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n', 'b.txt': 'one\n' });
  const first = (await git(root, 'rev-parse', 'HEAD')).trim();

  await writeFile(join(root, 'a.txt'), 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');
  await writeFile(join(root, 'untracked.txt'), 'new\n');

  const result = await capture(root, { kind: 'range', from: first, to: 'HEAD' });

  expect(result.errors).toEqual([]);
  expect(result.paths).toEqual(['a.txt']);
});

it('does not report a named untracked file as unmatched', async () => {
  const root = await committedRepository();

  await writeFile(join(root, 'new.txt'), 'new\n');

  const result = await capture(root, { kind: 'files', paths: ['new.txt'] });

  expect(result.errors).toEqual([]);
  expect(result.gaps).toEqual([]);
  expect(result.paths).toEqual(['new.txt']);
});

it('fails the capture when Git cannot check one of two named paths', async () => {
  const root = await committedRepository({ 'a.txt': 'one\n', 'b.txt': 'one\n' });

  const result = await capture(root, { kind: 'files', paths: ['a.txt', 'b.txt'] }, [
    { match: ' --exclude-standard -- b.txt ', script: 'echo broken >&2; exit 3' },
  ]);

  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('-- b.txt failed: exit 3: broken');
  expect(result.gaps).toEqual([]);
});

it('reports a tracked file below a link that leads outside the checkout as unreadable', async () => {
  const root = await committedRepository({ 'dir/a.txt': 'one\n', 'b.txt': 'one\n' });
  const outside = await mkdtemp(join(tmpdir(), 'tau-outside-'));
  onTestFinished(() => rm(outside, { recursive: true, force: true }));

  await writeFile(join(outside, 'a.txt'), 'outside secret\n');
  await rm(join(root, 'dir'), { recursive: true });
  await symlink(outside, join(root, 'dir'));

  const result = await capture(root, { kind: 'files', paths: ['b.txt', 'dir'] });

  expect(result.bytes.toString('utf8')).not.toContain('outside secret');
  expect(result.gaps).toContainEqual({ kind: 'unreadable', path: 'dir/a.txt' });
});
