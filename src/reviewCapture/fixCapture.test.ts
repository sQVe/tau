import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { saveVerifiedSnapshot, verifySnapshot } from './fixCapture.js';
import { captureTarget, pinTarget } from './reviewCapture.js';

const pinWorkingTree = async (root: string) => {
  const pinned = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });

  if (pinned.kind !== 'workingTree') {
    throw new Error('Expected a working tree target.');
  }

  return pinned;
};

it('refuses a snapshot that no longer matches the captured bytes and leaves no folder', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'a.txt'), 'one\n');
  await promisify(execFile)('git', ['add', '.'], { cwd: root });
  await promisify(execFile)('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'two\n');

  const review = await mkdtemp(join(tmpdir(), 'tau-fix-snapshot-'));
  onTestFinished(() => rm(review, { recursive: true, force: true }));
  await mkdir(review, { recursive: true });

  const pinned = await pinWorkingTree(root);
  const captured = await captureTarget(root, pinned);

  await writeFile(join(root, 'a.txt'), 'three\n');

  await expect(saveVerifiedSnapshot(review, root, pinned, captured)).rejects.toThrow(
    'Nothing was written',
  );

  expect(await readdir(review)).toEqual([]);
});

it('refuses a saved copy whose bytes differ from the captured bytes, even when the tree matches again', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'a.txt'), 'one\n');
  await promisify(execFile)('git', ['add', '.'], { cwd: root });
  await promisify(execFile)('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'two\n');

  const review = await mkdtemp(join(tmpdir(), 'tau-fix-verify-'));
  onTestFinished(() => rm(review, { recursive: true, force: true }));

  const pinned = await pinWorkingTree(root);
  const captured = await captureTarget(root, pinned);
  const snapshot = { present: ['a.txt'], absent: [], skipped: [] };

  await mkdir(join(review, 'snapshot'));
  await writeFile(join(review, 'snapshot', 'a.txt'), 'three\n');

  await expect(verifySnapshot(root, review, snapshot, captured, pinned.base)).rejects.toThrow(
    'does not match the capture',
  );

  await writeFile(join(review, 'snapshot', 'a.txt'), 'two\n');

  await expect(
    verifySnapshot(root, review, snapshot, captured, pinned.base),
  ).resolves.toBeUndefined();
});

it('accepts a snapshot of a file that Git converts on check-in', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitattributes'), 'a.txt text eol=crlf\n');
  await writeFile(join(root, 'a.txt'), 'one\r\n');
  await promisify(execFile)('git', ['add', '.'], { cwd: root });
  await promisify(execFile)('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'two\r\n');

  const review = await mkdtemp(join(tmpdir(), 'tau-fix-filters-'));
  onTestFinished(() => rm(review, { recursive: true, force: true }));

  const pinned = await pinWorkingTree(root);
  const captured = await captureTarget(root, pinned);

  await expect(saveVerifiedSnapshot(review, root, pinned, captured)).resolves.toMatchObject({
    present: ['a.txt'],
  });
});

const committedFile = async (name: string, mode?: number) => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, name), 'one\n');
  await promisify(execFile)('git', ['add', '.'], { cwd: root });
  await promisify(execFile)('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });

  if (mode !== undefined) {
    await chmod(join(root, name), mode);
  } else {
    await writeFile(join(root, name), 'two\n');
  }

  const review = await mkdtemp(join(tmpdir(), 'tau-fix-quoted-'));
  onTestFinished(() => rm(review, { recursive: true, force: true }));

  const pinned = await pinWorkingTree(root);
  const captured = await captureTarget(root, pinned);

  await mkdir(join(review, 'snapshot'));

  return { root, review, pinned, captured };
};

it('refuses a wrong saved copy of a file with a quoted path', async () => {
  const { root, review, pinned, captured } = await committedFile('café.ts');
  const snapshot = { present: ['café.ts'], absent: [], skipped: [] };

  await writeFile(join(review, 'snapshot', 'café.ts'), 'three\n');

  await expect(verifySnapshot(root, review, snapshot, captured, pinned.base)).rejects.toThrow(
    'does not match the capture',
  );

  await writeFile(join(review, 'snapshot', 'café.ts'), 'two\n');

  await expect(
    verifySnapshot(root, review, snapshot, captured, pinned.base),
  ).resolves.toBeUndefined();
});

it('verifies a mode-only change against the base blob', async () => {
  const { root, review, pinned, captured } = await committedFile('a.txt', 0o755);
  const snapshot = { present: ['a.txt'], absent: [], skipped: [] };

  await writeFile(join(review, 'snapshot', 'a.txt'), 'three\n');

  await expect(verifySnapshot(root, review, snapshot, captured, pinned.base)).rejects.toThrow(
    'does not match the capture',
  );
});

const renamedRepository = async (edit: boolean) => {
  const root = await createTemporaryRepository(onTestFinished);

  const git = (...commandArguments: string[]) =>
    promisify(execFile)('git', commandArguments, { cwd: root });

  await writeFile(join(root, 'old.ts'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');

  const base = (await git('rev-parse', 'HEAD')).stdout.trim();

  await git('mv', 'old.ts', 'new.ts');

  if (edit) {
    await writeFile(join(root, 'new.ts'), 'one\ntwo\nthree\nfour\nfive\nseven\n');
  }

  const review = await mkdtemp(join(tmpdir(), 'tau-fix-rename-'));
  onTestFinished(() => rm(review, { recursive: true, force: true }));

  const pinned = await pinTarget(root, { kind: 'workingTree', base });

  if (pinned.kind !== 'workingTree') {
    throw new Error('Expected a working tree target.');
  }

  return { root, review, pinned, captured: await captureTarget(root, pinned) };
};

it.each([false, true])('verifies the snapshot of a rename (edited: %s)', async (edit) => {
  const { root, review, pinned, captured } = await renamedRepository(edit);

  await expect(saveVerifiedSnapshot(review, root, pinned, captured)).resolves.toMatchObject({
    present: ['new.ts'],
  });
});

it.each([false, true])('refuses a wrong saved copy of a rename (edited: %s)', async (edit) => {
  const { root, review, pinned, captured } = await renamedRepository(edit);
  const snapshot = { present: ['new.ts'], absent: ['old.ts'], skipped: [] };

  await mkdir(join(review, 'snapshot'));
  await writeFile(join(review, 'snapshot', 'new.ts'), 'wrong\n');

  await expect(verifySnapshot(root, review, snapshot, captured, pinned.base)).rejects.toThrow(
    'does not match the capture',
  );
});
