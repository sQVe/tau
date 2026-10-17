import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { installFakeGit } from './fixtures/fakeGit.js';
import { leavesRoot, pinTarget, readHead, runCaptureCommand } from './reviewCapture.js';

const git = async (root: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout;
};

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

it('returns the output of a command that succeeds', async () => {
  const root = await committedRepository();

  const result = await runCaptureCommand(root, ['show', 'HEAD:tracked.txt']);

  expect(result.stdout?.toString('utf8')).toBe('one\n');
  expect(result.error).toBeUndefined();
});

it('reports the exit code and the trimmed message of a command that fails', async () => {
  const root = await committedRepository();

  const result = await runCaptureCommand(root, ['show', 'HEAD:missing.txt']);

  expect(result.stdout).toBeUndefined();
  expect(result.error).toMatch(/^exit 128: fatal: .*[^\n]$/);
});

it('reports the trimmed message of a command that exits 0 and prints to stderr', async () => {
  const root = await committedRepository();

  await installFakeGit([{ match: ' show ', script: 'echo "  warning text  " >&2; echo out' }]);

  const result = await runCaptureCommand(root, ['show', 'HEAD']);

  expect(result).toEqual({ error: 'warning text' });
});

it('reports a command that cannot start', async () => {
  const result = await runCaptureCommand(join(await committedRepository(), 'missing'), ['status']);

  expect(result.stdout).toBeUndefined();
  expect(result.error).toContain('ENOENT');
});

it.each([
  { path: '..', leaves: true },
  { path: '../a', leaves: true },
  { path: '/etc', leaves: true },
  { path: '..rules.md', leaves: false },
  { path: 'a/../b', leaves: false },
  { path: '', leaves: false },
])('says whether the relative path $path leaves the root', ({ path, leaves }) => {
  expect(leavesRoot(path)).toBe(leaves);
});

it('reads HEAD', async () => {
  const root = await committedRepository();

  expect(await readHead(root)).toEqual({ head: (await git(root, 'rev-parse', 'HEAD')).trim() });
});

it('reports a repository with no commit instead of a HEAD', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const result = await readHead(root);

  expect(result.head).toBeUndefined();
  expect(result.error).toContain('git rev-parse --verify HEAD failed: exit 128');
});

it('reports a HEAD that Git prints as empty', async () => {
  const root = await committedRepository();

  await installFakeGit([{ match: ' rev-parse --verify HEAD ', script: 'exit 0' }]);

  const result = await readHead(root);

  expect(result).toEqual({ error: 'git rev-parse --verify HEAD failed: no output' });
});

it('pins a branch whose name ends in a dash', async () => {
  const root = await committedRepository();

  await git(root, 'branch', 'topic-');

  const target = await pinTarget(root, { kind: 'workingTree', base: 'topic-' });

  expect(target).toEqual({
    kind: 'workingTree',
    base: (await git(root, 'rev-parse', 'HEAD')).trim(),
  });
});

it('refuses a revision that Git resolves to nothing', async () => {
  const root = await committedRepository();

  await installFakeGit([{ match: ' rev-parse --verify ', script: 'exit 0' }]);

  await expect(pinTarget(root, { kind: 'workingTree', base: 'HEAD' })).rejects.toThrow(
    'Git cannot resolve HEAD to a commit.',
  );
});

const missingRoot = '/nonexistent/tau-review-root';

it('refuses a files target with no path', async () => {
  await expect(pinTarget(missingRoot, { kind: 'files', paths: [] })).rejects.toThrow(
    'A files target needs at least one path.',
  );
});

it('names the parent of a root commit target that has one', async () => {
  const root = await committedRepository();
  const parent = (await git(root, 'rev-parse', 'HEAD')).trim();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');

  await expect(pinTarget(root, { kind: 'rootCommit', commit: 'HEAD' })).rejects.toThrow(
    new RegExp(`has a parent. Capture it as a range from ${parent}\\.$`),
  );
});

it('refuses a root commit target when Git cannot list its parents', async () => {
  const root = await committedRepository();

  await installFakeGit([{ match: ' rev-list ', script: 'echo broken >&2; exit 3' }]);

  await expect(pinTarget(root, { kind: 'rootCommit', commit: 'HEAD' })).rejects.toThrow(
    'git rev-list --parents --max-count=1 --end-of-options',
  );
});

it('refuses a revision that starts with a dash', async () => {
  await expect(pinTarget(missingRoot, { kind: 'workingTree', base: '--output=x' })).rejects.toThrow(
    'A revision must not start with a dash: --output=x',
  );
});

it('refuses a revision that Git cannot find', async () => {
  const root = await committedRepository();

  await expect(pinTarget(root, { kind: 'workingTree', base: 'nowhere' })).rejects.toThrow(
    'Git cannot resolve nowhere to a commit.',
  );
});

it('accepts a command whose stderr holds only whitespace', async () => {
  const root = await committedRepository();

  await installFakeGit([{ match: ' show ', script: 'echo >&2; echo out' }]);

  const result = await runCaptureCommand(root, ['show', 'HEAD']);

  expect(result.stdout?.toString('utf8')).toBe('out\n');
});
