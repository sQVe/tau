import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { captureTarget, pinTarget } from './capture.js';
import { buildEndpoint, checkBinding, compareEndpoint } from './endpoint.js';
import { checkTransition } from './endpointTransition.js';
import { saveVerifiedSnapshot } from './fixCapture.js';
import { generationFolderName } from './record.js';

const isRoot = process.getuid?.() === 0;

const writeAt = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

const commitAll = async (root: string, message: string) => {
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', message);

  return git(root, 'rev-parse', 'HEAD');
};

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

  const input = { directory, target: pinned, gaps: [], patch: captured.bytes, snapshot };

  return { root, input, base: pinned.base, snapshot };
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
  const { root, input, base, snapshot } = await snapshotInput(
    { 'a.txt': 'one\ntwo\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.txt'), 'one\nchanged\n');
    },
  );

  const endpoint = await buildEndpoint(root, input);

  await writeFile(join(root, 'a.txt'), 'one\nedited again\n');

  const commit = await commitAll(root, 'second');
  const committedPaths = await git(root, 'diff', '--name-only', base, commit);

  expect(committedPaths.split('\n')).toEqual(snapshot.present);
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
  const { root, input, snapshot } = await snapshotInput(
    { 'a.bin': 'one\0\n' },
    async (directory) => {
      await writeFile(join(directory, 'a.bin'), 'two\0\n');
    },
  );

  const endpoint = await buildEndpoint(root, input);

  expect(snapshot.skipped).toMatchObject([{ kind: 'binary', path: 'a.bin' }]);
  expect(endpoint.status).toBe('unsupported');
  expect(await compareEndpoint(root, endpoint, 'HEAD')).toBe('unknown');
});

it.skipIf(isRoot)(
  'reports an endpoint as incomplete when the snapshot skipped an unreadable file',
  async () => {
    const { root, input, snapshot } = await snapshotInput(
      { 'a.txt': 'one\n' },
      async (directory) => {
        await writeFile(join(directory, 'secret.txt'), 'hidden\n');
        await chmod(join(directory, 'secret.txt'), 0o000);
      },
    );

    const endpoint = await buildEndpoint(root, input);

    expect(snapshot.skipped).toMatchObject([{ kind: 'unreadable', path: 'secret.txt' }]);
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

  expect(input.patch.toString('utf8')).toContain('rename to tool.sh');
  expect(await compareEndpoint(root, endpoint, commit)).toBe('equal');
});

it('reads the base mode of a renamed file whose name looks like pathspec magic', async () => {
  const { root, input } = await snapshotInput(
    { ':(glob)run.sh': 'echo run\n' },
    async (directory) => {
      await git(directory, 'mv', '--', ':(glob)run.sh', 'tool.sh');
    },
  );

  const endpoint = await buildEndpoint(root, input);
  const commit = await commitAll(root, 'renamed');

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

  const endpoint = await buildEndpoint(root, {
    directory: root,
    target: { kind: 'range', from, to },
    gaps: [],
    patch: Buffer.from(''),
    snapshot: undefined,
  });

  expect(endpoint).toEqual({
    status: 'complete',
    baseTree: await git(root, 'rev-parse', `${from}^{tree}`),
    tree: await git(root, 'rev-parse', `${to}^{tree}`),
  });

  expect(await compareEndpoint(root, endpoint, to)).toBe('equal');
  expect(await compareEndpoint(root, endpoint, from)).toBe('different');
});

it.each([
  { name: 'the predecessor endpoint tree', baseTree: 'b'.repeat(40), mismatches: [] },
  {
    name: 'another tree',
    baseTree: 'd'.repeat(40),
    mismatches: [expect.stringContaining(`not the endpoint ${'b'.repeat(40)}`) as string],
  },
])('binds a chained fix endpoint whose base tree is $name', async ({ baseTree, mismatches }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const predecessor = { review: 'review', identity: 'a'.repeat(40), endpointTree: 'b'.repeat(40) };

  const target = {
    kind: 'fix' as const,
    review: 'review',
    findingPaths: [],
    base: null,
    predecessor,
  };

  const endpoint = { status: 'complete' as const, baseTree, tree: 'c'.repeat(40) };

  expect(await checkBinding(root, endpoint, target)).toEqual(mismatches);
});

const transitionRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAt(root, 'kept.ts', 'one\n');
  await writeAt(root, 'moved.ts', 'a\nb\nc\n');
  await writeAt(root, 'removed.ts', 'gone\n');
  await writeAt(root, 'run.sh', 'echo\n');

  const first = await commitAll(root, 'first');

  const variant = async (change: () => Promise<void>) => {
    await git(root, 'checkout', '--quiet', '--detach', first);
    await change();

    return commitAll(root, 'variant');
  };

  const commits = {
    first,
    renamed: await variant(async () => {
      await writeAt(root, 'kept.ts', 'two\n');
      await git(root, 'mv', 'moved.ts', 'renamed.ts');
      await rm(join(root, 'removed.ts'));
      await chmod(join(root, 'run.sh'), 0o755);
    }),
    edited: await variant(() => writeAt(root, 'run.sh', 'echo two\n')),
    editedAgain: await variant(() => writeAt(root, 'run.sh', 'echo three\n')),
    editedExecutable: await variant(async () => {
      await writeAt(root, 'run.sh', 'echo two\n');
      await chmod(join(root, 'run.sh'), 0o755);
    }),
    deleted: await variant(() => rm(join(root, 'removed.ts'))),
    copied: await variant(() => writeAt(root, 'copy.ts', 'gone\n')),
    copiedAndDeleted: await variant(async () => {
      await writeAt(root, 'copy.ts', 'gone\n');
      await rm(join(root, 'removed.ts'));
    }),
    rewritten: await variant(() => writeAt(root, 'removed.ts', 'still here\n')),
  };

  return { root, commits };
};

type Variant = keyof Awaited<ReturnType<typeof transitionRepository>>['commits'];

it.each([
  { name: 'the patch of the same change', tree: 'renamed', patch: 'renamed', options: [] },
  {
    name: 'the same change with renames shown as deletions',
    tree: 'renamed',
    patch: 'renamed',
    options: ['--no-renames'],
  },
  { name: 'a content change', tree: 'edited', patch: 'edited', options: [] },
  {
    name: 'a patch that leaves out a deletion',
    tree: 'renamed',
    patch: 'renamed',
    options: ['--', ':!removed.ts'],
    mismatches: ['removed.ts'],
  },
  {
    name: 'a patch that leaves out a mode change',
    tree: 'renamed',
    patch: 'renamed',
    options: ['--', ':!run.sh'],
    mismatches: ['run.sh'],
  },
  {
    name: 'a patch of a path the trees keep',
    tree: 'first',
    patch: 'edited',
    mismatches: ['run.sh'],
  },
  {
    name: 'a patch with the same blob and another mode',
    tree: 'editedExecutable',
    patch: 'edited',
    mismatches: ['run.sh'],
  },
  {
    name: 'a patch with another blob',
    tree: 'edited',
    patch: 'editedAgain',
    mismatches: ['run.sh'],
  },
  {
    name: 'a patch that changes a path the trees delete',
    tree: 'deleted',
    patch: 'rewritten',
    mismatches: ['removed.ts'],
  },
  {
    name: 'a patch that copies a file the trees delete',
    tree: 'copiedAndDeleted',
    patch: 'copied',
    options: ['-C', '--find-copies-harder'],
    mismatches: ['removed.ts'],
  },
] satisfies {
  name: string;
  tree: Variant;
  patch: Variant;
  options?: string[];
  mismatches?: string[];
}[])('checks the transition against $name', async ({ tree, patch, options, mismatches: paths }) => {
  const { root, commits } = await transitionRepository();

  const patchText = await promisify(execFile)(
    'git',
    [
      'diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-M',
      commits.first,
      commits[patch],
      ...(options ?? []),
    ],
    { cwd: root },
  );

  const endpoint = {
    status: 'complete' as const,
    baseTree: await git(root, 'rev-parse', `${commits.first}^{tree}`),
    tree: await git(root, 'rev-parse', `${commits[tree]}^{tree}`),
  };

  const mismatches = await checkTransition(root, endpoint, patchText.stdout);
  const expected = (paths ?? []).map((path) => expect.stringContaining(path) as string);

  expect(mismatches).toEqual(expected);
});
