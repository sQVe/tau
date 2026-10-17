import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { saveVerifiedSnapshot, verifySnapshot } from './fixCapture.js';
import { captureTarget, pinTarget } from './reviewCapture.js';

const isRoot = process.getuid?.() === 0;

const git = (root: string, ...commandArguments: string[]) =>
  promisify(execFile)('git', commandArguments, { cwd: root });

const writeAt = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

const blobHash = (content: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest('hex');

// Commits the files, then lets the caller change the working tree before the capture.
const capturedChange = async (
  files: Record<string, string>,
  change: (root: string) => Promise<void>,
  exclude: string[] = [],
) => {
  const root = await createTemporaryRepository(onTestFinished);

  for (const [path, content] of Object.entries(files)) {
    await writeAt(root, path, content);
  }

  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await change(root);

  const review = await mkdtemp(join(tmpdir(), 'tau-snapshot-save-'));
  onTestFinished(() => rm(review, { recursive: true, force: true }));

  const pinned = await pinTarget(root, { kind: 'workingTree', base: 'HEAD', exclude });

  if (pinned.kind !== 'workingTree') {
    throw new Error('Expected a working tree target.');
  }

  return { root, review, pinned, captured: await captureTarget(root, pinned) };
};

it('saves a deleted file as absent and a changed file as present', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n', 'b.txt': 'one\n' },
    async (directory) => {
      await rm(join(directory, 'a.txt'));
      await writeFile(join(directory, 'b.txt'), 'two\n');
    },
  );

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot).toEqual({ present: ['b.txt'], absent: ['a.txt'], skipped: [] });
  expect(await readdir(join(review, 'snapshot'))).toEqual(['b.txt']);
});

it('saves a file under a directory that became a file as absent', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'dir/a.txt': 'one\n' },
    async (directory) => {
      await rm(join(directory, 'dir'), { recursive: true });
      await writeFile(join(directory, 'dir'), 'now a file\n');
    },
  );

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot).toEqual({ present: ['dir'], absent: ['dir/a.txt'], skipped: [] });
});

it('skips a path that is no longer a regular file and keeps no copy of it', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n', 'b.txt': 'one\n' },
    async (directory) => {
      await rm(join(directory, 'a.txt'));
      await symlink('b.txt', join(directory, 'a.txt'));
      await writeFile(join(directory, 'b.txt'), 'two\n');
    },
  );

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot.present).toEqual(['b.txt']);

  expect(snapshot.skipped).toEqual([
    { kind: 'unreadable', path: 'a.txt', identity: null, existed: true },
  ]);

  expect(await readdir(join(review, 'snapshot'))).toEqual(['b.txt']);
});

it('records a changed binary file as skipped and does not copy it', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.bin': 'one\0\n', 'b.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.bin'), 'two\0\n');
      await writeFile(join(directory, 'b.txt'), 'two\n');
    },
  );

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);
  const identity = (await git(root, 'hash-object', 'a.bin')).stdout.trim();

  expect(snapshot).toEqual({
    present: ['b.txt'],
    absent: [],
    skipped: [{ kind: 'binary', path: 'a.bin', identity, existed: true }],
  });

  expect(await readdir(join(review, 'snapshot'))).toEqual(['b.txt']);
});

it('refuses a capture whose hash is not the hash of the tree now and removes the folder', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'two\n');
    },
  );

  await expect(
    saveVerifiedSnapshot(review, root, pinned, { ...captured, hash: 'stale' }),
  ).rejects.toThrow('working tree changed');

  expect(await readdir(review)).toEqual([]);
});

it('refuses a snapshot when the capture cannot be repeated and removes the folder', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'two\n');
    },
  );

  const unknownBase = { ...pinned, base: 'f'.repeat(40) };

  await expect(
    saveVerifiedSnapshot(review, root, unknownBase, { ...captured, hash: blobHash('') }),
  ).rejects.toThrow('working tree changed');

  expect(await readdir(review)).toEqual([]);
});

// A different text whose blob hash starts with the same character as the blob hash of the text.
const lookalike = (content: string) => {
  const first = blobHash(content).slice(0, 1);

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `wrong ${attempt}\n`;

    if (blobHash(candidate).startsWith(first)) {
      return candidate;
    }
  }

  throw new Error('No lookalike found.');
};

const saveCopy = async (review: string, path: string, content: string) => {
  await mkdir(dirname(join(review, 'snapshot', path)), { recursive: true });
  await writeFile(join(review, 'snapshot', path), content);
};

it('refuses a saved copy whose blob hash shares only its first character with the diff', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'two\n');
    },
  );

  const snapshot = { present: ['a.txt'], absent: [], skipped: [] };

  await saveCopy(review, 'a.txt', lookalike('two\n'));

  await expect(verifySnapshot(root, review, snapshot, captured, pinned.base)).rejects.toThrow(
    'does not match the capture',
  );
});

it('accepts the saved copy of a mode-only change when it holds the base content', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'other\n', 'b.txt': 'one\n' },
    async (directory) => {
      await chmod(join(directory, 'b.txt'), 0o755);
    },
  );

  const snapshot = { present: ['b.txt'], absent: [], skipped: [] };

  await saveCopy(review, 'b.txt', 'one\n');

  await expect(
    verifySnapshot(root, review, snapshot, captured, pinned.base),
  ).resolves.toBeUndefined();
});

it('verifies an unchanged saved path against the base content', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n', 'b.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'b.txt'), 'two\n');
    },
  );

  const snapshot = { present: ['a.txt'], absent: [], skipped: [] };

  await saveCopy(review, 'a.txt', 'one\n');

  await expect(
    verifySnapshot(root, review, snapshot, captured, pinned.base),
  ).resolves.toBeUndefined();
});

it('refuses a saved path that neither the diff nor the base holds', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'two\n');
    },
  );

  const snapshot = { present: ['ghost.txt'], absent: [], skipped: [] };

  await saveCopy(review, 'ghost.txt', 'one\n');

  await expect(verifySnapshot(root, review, snapshot, captured, pinned.base)).rejects.toThrow(
    'does not match the capture',
  );
});

it('does not take the base blob of a symbolic link as the content of a saved copy', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n' },
    async (directory) => {
      await symlink('target', join(directory, 'link'));
      await git(directory, 'add', 'link');
      await git(directory, 'commit', '--quiet', '-m', 'link');
      await writeFile(join(directory, 'a.txt'), 'two\n');
    },
  );

  const snapshot = { present: ['link'], absent: [], skipped: [] };

  await saveCopy(review, 'link', 'target');

  await expect(verifySnapshot(root, review, snapshot, captured, pinned.base)).rejects.toThrow(
    'does not match the capture',
  );
});

it('keeps the diff sections of a rename and of a file named like the end of its header apart', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.ts': 'one\ntwo\nthree\nfour\n', 'cde.ts': 'one\n' },
    async (directory) => {
      await rename(join(directory, 'a.ts'), join(directory, 'zbcde.ts'));
      await git(directory, 'add', '-A');
      await writeFile(join(directory, 'cde.ts'), 'two\n');
    },
  );

  expect(captured.errors).toEqual([]);

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot.present.toSorted()).toEqual(['cde.ts', 'zbcde.ts']);
});

it('keeps the diff section of a file whose text mentions a rename of another file', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n', 'z.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'two\n');
      await writeFile(join(directory, 'z.txt'), 'rename to a.txt\n');
    },
  );

  await expect(saveVerifiedSnapshot(review, root, pinned, captured)).resolves.toMatchObject({
    present: ['a.txt', 'z.txt'],
  });

  expect(await readFile(join(review, 'snapshot', 'a.txt'), 'utf8')).toBe('two\n');
});

it('records a deleted binary file as skipped with no identity', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.bin': 'one\0\n', 'b.txt': 'one\n' },
    async (directory) => {
      await rm(join(directory, 'a.bin'));
      await writeFile(join(directory, 'b.txt'), 'two\n');
    },
  );

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot.skipped).toEqual([
    { kind: 'binary', path: 'a.bin', identity: null, existed: false },
  ]);
});

it('does not record an excluded path as skipped', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n', 'b.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'two\n');
      await writeFile(join(directory, 'b.txt'), 'two\n');
    },
    ['b.txt'],
  );

  expect(captured.gaps).toEqual([{ kind: 'excluded', path: 'b.txt' }]);

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot).toEqual({ present: ['a.txt'], absent: [], skipped: [] });
});

it('records an unreadable file as skipped with no identity', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'a.txt': 'one\n', 'b.txt': 'one\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'two\n');
      await writeFile(join(directory, 'b.txt'), 'two\n');
      await chmod(join(directory, 'a.txt'), 0o000);
    },
  );

  onTestFinished(() => chmod(join(root, 'a.txt'), 0o644));
  expect(captured.gaps).toEqual([{ kind: 'unreadable', path: 'a.txt' }]);

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot.skipped).toEqual([
    { kind: 'unreadable', path: 'a.txt', identity: null, existed: true },
  ]);
});

it('records a changed submodule as skipped', async () => {
  const { root, review, pinned, captured } = await capturedChange(
    { 'b.txt': 'one\n' },
    async (directory) => {
      const submodule = join(directory, 'sub');

      await mkdir(submodule);
      await git(submodule, 'init', '--quiet');
      await git(submodule, 'commit', '--quiet', '--allow-empty', '-m', 'one');
      await git(directory, 'add', 'sub');
      await git(directory, 'commit', '--quiet', '-m', 'sub');
      await git(submodule, 'commit', '--quiet', '--allow-empty', '-m', 'two');
    },
  );

  expect(captured.gaps).toEqual([{ kind: 'submodule', path: 'sub' }]);

  const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

  expect(snapshot.skipped).toMatchObject([{ kind: 'submodule', path: 'sub' }]);
});

it.skipIf(isRoot)(
  'records a changed file in a directory that cannot be searched as existing (skipped as root, who can search every directory)',
  async () => {
    const { root, review, pinned, captured } = await capturedChange(
      { 'dir/a.txt': 'one\n', 'b.txt': 'one\n' },
      async (directory) => {
        await writeFile(join(directory, 'dir/a.txt'), 'two\n');
        await writeFile(join(directory, 'b.txt'), 'two\n');
        await chmod(join(directory, 'dir'), 0o000);
        onTestFinished(() => chmod(join(directory, 'dir'), 0o755));
      },
    );

    expect(captured.errors).toEqual([]);

    const snapshot = await saveVerifiedSnapshot(review, root, pinned, captured);

    expect(snapshot.present).toEqual(['b.txt']);
    const child = snapshot.skipped.find((entry) => entry.path === 'dir/a.txt');

    expect(child).toEqual({ kind: 'unreadable', path: 'dir/a.txt', identity: null, existed: true });
  },
);
