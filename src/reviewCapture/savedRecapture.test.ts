import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { installCommandShim } from '../../tests/commandShimFake.js';
import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { savedArtifactState } from './fixtures/reviewDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';
import { checkReviewFreshness } from './pinnedCapture.js';
import { prepareReviewDirectory } from './reviewPrepare.js';
import { readSavedRecapture } from './savedRecapture.js';

const execFileAsync = promisify(execFile);

// Captures a working-tree edit with CRLF line endings, then saves the recapture by checking freshness.
const savedReview = async (root: string) => {
  const directory = await prepareReviewDirectory(root, Date.now());

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');
  await writeFile(join(root, 'tracked.txt'), 'a\r\nb\r\n');

  const captured = await captureReviewDirectory(root, directory, {
    kind: 'workingTree',
    base: 'HEAD',
  });

  await checkReviewFreshness(root, directory);

  return { directory, captured };
};

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

const readRecheckOrNull = (directory: string) =>
  readFile(join(directory, 'recheck.diff')).catch(() => null);

// Every saved artifact in the review directory, with nested captures and snapshots, and the capture
// refs. A read must leave both unchanged.
const savedState = async (root: string, directory: string) => ({
  artifacts: await savedArtifactState(directory),
  refs: await git(root, 'for-each-ref', 'refs/tau/review-captures/'),
});

it('returns the recheck bytes, their hash, and the recorded hash and base', async () => {
  const root = await committedRepository();
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  const { directory, captured } = await savedReview(root);
  const before = await savedState(root, directory);

  const saved = await readSavedRecapture(root, directory);

  expect(saved).toEqual({
    directory,
    recordedBase: head,
    recordedHash: captured.hash,
    recheck: expect.any(Buffer) as Buffer,
    recheckHash: captured.hash,
  });

  expect(saved.recheck.equals(await readFile(join(directory, 'recheck.diff')))).toBe(true);
  expect(saved.recheck.toString('utf8')).toContain('+a\r\n+b\r\n');
  expect(await savedState(root, directory)).toEqual(before);
});

it('keeps the bytes it read when recheck.diff is replaced afterwards', async () => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);

  const saved = await readSavedRecapture(root, directory);
  const original = Buffer.from(saved.recheck);

  await writeFile(join(directory, 'recheck.diff'), 'replaced\n');

  expect(saved.recheck.equals(original)).toBe(true);
});

it('hashes the recheck with a sha256 object format repository', async () => {
  const root = temporaryDirectory(onTestFinished, 'tau-sha256-repository-');

  await execFileAsync('git', ['init', '--quiet', '--object-format=sha256'], { cwd: root });
  await git(root, 'config', 'user.name', 'Tau Test');
  await git(root, 'config', 'user.email', 'tau@example.test');
  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const { directory, captured } = await savedReview(root);
  const saved = await readSavedRecapture(root, directory);

  expect(captured.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(saved.recheckHash).toBe(captured.hash);
});

it('refuses a review directory whose recheck.diff is missing and creates none', async () => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);

  await rm(join(directory, 'recheck.diff'));

  const before = await savedState(root, directory);

  await expect(readSavedRecapture(root, directory)).rejects.toThrow('No recheck.diff');

  await expect(readSavedRecapture(root, directory)).rejects.toMatchObject({
    cause: { code: 'ENOENT' },
  });

  expect(await readRecheckOrNull(directory)).toBeNull();
  expect(await savedState(root, directory)).toEqual(before);
});

it('propagates a read error other than a missing recheck.diff', async () => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);

  await rm(join(directory, 'recheck.diff'));
  await mkdir(join(directory, 'recheck.diff'));

  const failure = await readSavedRecapture(root, directory).catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'EISDIR' });
  expect(String(failure)).not.toContain('No recheck.diff');
});

it('refuses a review directory without a capture record and changes nothing', async () => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);

  await rm(join(directory, 'capture.json'));

  const before = await savedState(root, directory);

  await expect(readSavedRecapture(root, directory)).rejects.toThrow('No capture record');
  expect(await savedState(root, directory)).toEqual(before);
});

it.each([
  ['malformed JSON', '{not json'],
  ['a newer record version', JSON.stringify({ version: 99 })],
])('refuses a capture record with %s and changes nothing', async (_name, text) => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);

  await writeFile(join(directory, 'capture.json'), text);

  const before = await savedState(root, directory);

  await expect(readSavedRecapture(root, directory)).rejects.toThrow(
    join(directory, 'capture.json'),
  );

  expect(await savedState(root, directory)).toEqual(before);
});

it('refuses a linked recheck.diff and never reads through it', async () => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);
  const outside = temporaryDirectory(onTestFinished, 'tau-saved-recapture-outside-');

  await writeFile(join(outside, 'recheck.diff'), 'outside\n');
  await rm(join(directory, 'recheck.diff'));
  await symlink(join(outside, 'recheck.diff'), join(directory, 'recheck.diff'));

  const before = await savedState(root, directory);

  await expect(readSavedRecapture(root, directory)).rejects.toThrow('symlink');
  expect(await readFile(join(outside, 'recheck.diff'), 'utf8')).toBe('outside\n');
  expect(await savedState(root, directory)).toEqual(before);
});

it('refuses a recheck whose object format Git cannot report and changes nothing', async () => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);
  const before = await savedState(root, directory);

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [
      {
        match: ' --show-object-format',
        script: "echo 'forced failure' >&2; exit 2",
      },
    ],
  });

  await expect(readSavedRecapture(root, directory)).rejects.toThrow('show-object-format');
  expect(await savedState(root, directory)).toEqual(before);
});

it('sees a change to a nested snapshot file or capture artifact in the saved state', async () => {
  const root = await committedRepository();
  const { directory } = await savedReview(root);
  const before = await savedState(root, directory);

  expect(before.artifacts).toEqual(
    expect.arrayContaining([
      expect.arrayContaining(['capture/patch.diff', 'file']),
      expect.arrayContaining(['capture/input.md', 'file']),
      expect.arrayContaining(['snapshot/tracked.txt', 'file']),
    ]),
  );

  await writeFile(join(directory, 'snapshot', 'tracked.txt'), 'changed\n');

  expect(await savedState(root, directory)).not.toEqual(before);
});
