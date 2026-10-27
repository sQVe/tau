import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { captureTarget, pinTarget } from './capture.js';
import { buildEndpoint, compareEndpoint } from './endpoint.js';
import { saveVerifiedSnapshot } from './fixCapture.js';
import { generationFolderName } from './record.js';

const isRoot = process.getuid?.() === 0;

const git = async (root: string, ...commandArguments: string[]) => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd: root });

  return stdout.trim();
};

const writeAt = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

const commitAll = async (root: string, message: string) => {
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', message);

  return git(root, 'rev-parse', 'HEAD');
};

// Commits the files, lets the caller change the working tree, then captures it and saves the
// verified snapshot the way a working tree review does.
const snapshotInput = async (
  files: Record<string, string>,
  change: (root: string) => Promise<void>,
) => {
  const root = await createTemporaryRepository(onTestFinished);

  // Git warns on stderr about each CRLF file it converts by default, and the capture treats a
  // warning as a failed diff.
  await git(root, 'config', 'core.safecrlf', 'false');

  for (const [path, content] of Object.entries(files)) {
    await writeAt(root, path, content);
  }

  await commitAll(root, 'first');
  await change(root);

  const directory = temporaryDirectory(onTestFinished, 'tau-endpoint-review-');
  const pinned = await pinTarget(root, { kind: 'workingTree', base: 'HEAD' });

  if (pinned.kind !== 'workingTree') {
    throw new Error('Expected a working tree target.');
  }

  const captured = await captureTarget(root, pinned);
  const snapshot = await saveVerifiedSnapshot(directory, root, pinned, captured);

  await mkdir(join(directory, generationFolderName));

  const input = {
    kind: 'workingTree' as const,
    directory,
    base: pinned.base,
    snapshot,
    patch: captured.bytes.toString('utf8'),
  };

  return { root, input };
};

it('finds the commit of the snapshot equal to its endpoint', async () => {
  const { root, input } = await snapshotInput(
    {
      '.gitattributes': '* text=auto eol=lf\n',
      'deleted.txt': 'gone\n',
      'run.sh': 'echo run\n',
      'kept.txt': 'kept\n',
    },
    async (directory) => {
      await writeAt(directory, 'new/added.txt', 'added\n');
      await rm(join(directory, 'deleted.txt'));
      await chmod(join(directory, 'run.sh'), 0o755);
      await writeAt(directory, 'crlf.txt', 'one\r\ntwo\r\n');
    },
  );

  const endpoint = await buildEndpoint(root, input);
  const commit = await commitAll(root, 'second');

  expect(await compareEndpoint(root, endpoint, commit)).toBe('equal');
});

it('finds a commit that changes the same paths differently from the endpoint', async () => {
  const { root, input } = await snapshotInput({ 'a.txt': 'one\ntwo\n' }, async (directory) => {
    await writeFile(join(directory, 'a.txt'), 'one\nchanged\n');
  });

  const endpoint = await buildEndpoint(root, input);

  await writeFile(join(root, 'a.txt'), 'one\nedited again\n');

  const commit = await commitAll(root, 'second');
  const committedPaths = await git(root, 'diff', '--name-only', input.base, commit);

  expect(committedPaths.split('\n')).toEqual(input.snapshot.present);
  expect(await compareEndpoint(root, endpoint, commit)).toBe('different');
});

it('builds the endpoint without touching the index and keeps unchanged blobs', async () => {
  const { root, input } = await snapshotInput(
    { 'changed.txt': 'one\n', 'kept.txt': 'kept\n', 'dir/kept.txt': 'nested\n' },
    async (directory) => {
      await writeFile(join(directory, 'changed.txt'), 'two\n');
    },
  );

  const indexHash = async () =>
    createHash('sha256')
      .update(await readFile(join(root, '.git', 'index')))
      .digest('hex');

  const before = await indexHash();
  const endpoint = await buildEndpoint(root, input);
  const after = await indexHash();

  if (endpoint.status !== 'complete') {
    throw new Error(`Expected a complete endpoint, got ${endpoint.status}`);
  }

  const blobOf = (tree: string, path: string) => git(root, 'rev-parse', `${tree}:${path}`);

  expect(after).toBe(before);
  expect(await blobOf(endpoint.tree, 'kept.txt')).toBe(await blobOf(endpoint.baseTree, 'kept.txt'));

  expect(await blobOf(endpoint.tree, 'dir/kept.txt')).toBe(
    await blobOf(endpoint.baseTree, 'dir/kept.txt'),
  );

  expect(await readdir(join(input.directory, generationFolderName))).toEqual([]);
});

it('refuses a complete endpoint for a snapshot that skipped a binary file', async () => {
  const { root, input } = await snapshotInput({ 'a.bin': 'one\0\n' }, async (directory) => {
    await writeFile(join(directory, 'a.bin'), 'two\0\n');
  });

  const endpoint = await buildEndpoint(root, input);

  expect(input.snapshot.skipped).toMatchObject([{ kind: 'binary', path: 'a.bin' }]);
  expect(endpoint.status).toBe('unsupported');
  expect(await compareEndpoint(root, endpoint, 'HEAD')).toBe('unknown');
});

it.skipIf(isRoot)(
  'reports an endpoint as incomplete when the snapshot skipped an unreadable file',
  async () => {
    const { root, input } = await snapshotInput({ 'a.txt': 'one\n' }, async (directory) => {
      await writeFile(join(directory, 'secret.txt'), 'hidden\n');
      await chmod(join(directory, 'secret.txt'), 0o000);
    });

    const endpoint = await buildEndpoint(root, input);

    expect(input.snapshot.skipped).toMatchObject([{ kind: 'unreadable', path: 'secret.txt' }]);
    expect(endpoint.status).toBe('incomplete');
  },
);

it('keeps the base mode of a file renamed without a content change', async () => {
  const { root, input } = await snapshotInput({ 'run.sh': 'echo run\n' }, async (directory) => {
    await chmod(join(directory, 'run.sh'), 0o755);
    await commitAll(directory, 'executable');
    await git(directory, 'mv', 'run.sh', 'tool.sh');
  });

  const endpoint = await buildEndpoint(root, input);
  const commit = await commitAll(root, 'renamed');

  expect(input.patch).toContain('rename to tool.sh');
  expect(await compareEndpoint(root, endpoint, commit)).toBe('equal');
});

it('refuses a complete endpoint for a changed symbolic link', async () => {
  const { root, input } = await snapshotInput({ 'a.txt': 'one\n' }, async (directory) => {
    await symlink('a.txt', join(directory, 'link'));
  });

  const endpoint = await buildEndpoint(root, input);

  expect(endpoint.status).toBe('unsupported');
});

it('compares as unknown once the endpoint tree object is gone', async () => {
  const { root, input } = await snapshotInput({ 'a.txt': 'one\n' }, async (directory) => {
    await writeFile(join(directory, 'a.txt'), 'two\n');
  });

  const endpoint = await buildEndpoint(root, input);

  if (endpoint.status !== 'complete') {
    throw new Error(`Expected a complete endpoint, got ${endpoint.status}`);
  }

  await rm(join(root, '.git', 'objects', endpoint.tree.slice(0, 2), endpoint.tree.slice(2)));

  expect(await compareEndpoint(root, endpoint, 'HEAD')).toBe('unknown');
});

it('takes the trees of a range from its commits', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAt(root, 'a.txt', 'one\n');

  const from = await commitAll(root, 'first');

  await writeAt(root, 'a.txt', 'two\n');

  const to = await commitAll(root, 'second');
  const endpoint = await buildEndpoint(root, { kind: 'range', from, to });

  expect(endpoint).toEqual({
    status: 'complete',
    baseTree: await git(root, 'rev-parse', `${from}^{tree}`),
    tree: await git(root, 'rev-parse', `${to}^{tree}`),
  });

  expect(await compareEndpoint(root, endpoint, to)).toBe('equal');
  expect(await compareEndpoint(root, endpoint, from)).toBe('different');
});
