import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { readCompletedCapture } from './completedCapture.js';
import { compareEndpoint } from './endpoint.js';
import { captureGeneration } from './generation.js';
import { inputFileName, recordFileName } from './record.js';
import type { ReviewTarget } from './target.js';

const writeAt = async (root: string, path: string, content: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

const commitAll = async (root: string, message: string) => {
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', message);

  return git(root, 'rev-parse', 'HEAD');
};

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAt(root, 'src/kept.ts', 'one\n');
  await commitAll(root, 'first');

  return root;
};

const reviewDirectory = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-generation-endpoint-');

  await writeFile(join(directory, inputFileName), '# Review input\n\n## Capture\n');

  return directory;
};

const capturedRecord = async (root: string, target: ReviewTarget) => {
  const directory = await reviewDirectory();

  await captureGeneration(root, directory, target);

  const text = await readFile(join(directory, recordFileName), 'utf8');

  return { directory, record: JSON.parse(text) as Record<string, unknown> };
};

it('records the tree a commit of the captured working tree would have', async () => {
  const root = await committedRepository();

  await writeAt(root, 'src/added.ts', 'new\n');
  await writeAt(root, 'src/kept.ts', 'two\n');

  const { record } = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });

  await commitAll(root, 'second');

  expect(record).toMatchObject({
    version: 5,
    endpoint: { status: 'complete', tree: await git(root, 'rev-parse', 'HEAD^{tree}') },
  });
});

it('records the tree of the range end and keeps it with a ref', async () => {
  const root = await committedRepository();

  await writeAt(root, 'src/kept.ts', 'two\n');
  await commitAll(root, 'second');

  const { directory, record } = await capturedRecord(root, {
    kind: 'range',
    from: 'HEAD~1',
    to: 'HEAD',
  });

  const ref = `refs/tau/review-captures/${basename(directory)}`;

  expect(record['endpoint']).toEqual({
    status: 'complete',
    baseTree: await git(root, 'rev-parse', 'HEAD~1^{tree}'),
    tree: await git(root, 'rev-parse', 'HEAD^{tree}'),
    ref,
  });

  expect(await git(root, 'rev-parse', `${ref}^{tree}`)).toBe(
    await git(root, 'rev-parse', 'HEAD^{tree}'),
  );

  expect(await git(root, 'rev-parse', `${ref}^`)).toBe(await git(root, 'rev-parse', 'HEAD~1'));

  expect(await readCompletedCapture(root, directory)).toMatchObject({
    status: 'completed',
    endpoint: 'complete',
  });
});

it('records the committed tree of a working tree that renames, deletes, and changes modes', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAt(root, 'moved.ts', 'export const moved = 1;\nexport const other = 2;\n');
  await writeAt(root, 'removed.ts', 'gone\n');
  await writeAt(root, 'script.sh', 'echo one\n');
  await commitAll(root, 'first');
  await git(root, 'mv', 'moved.ts', 'renamed.ts');
  await rm(join(root, 'removed.ts'));
  await chmod(join(root, 'script.sh'), 0o755);

  const { directory, record } = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });

  await commitAll(root, 'second');

  expect(record['endpoint']).toMatchObject({
    status: 'complete',
    tree: await git(root, 'rev-parse', 'HEAD^{tree}'),
  });

  expect((await readCompletedCapture(root, directory)).status).toBe('completed');
});

it('reads a record whose endpoint tree belongs to another capture as altered', async () => {
  const root = await committedRepository();

  await writeAt(root, 'src/kept.ts', 'two\n');

  const first = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });

  await writeAt(root, 'src/kept.ts', 'three\n');

  const second = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });
  const secondEndpoint = second.record['endpoint'] as Record<string, unknown>;

  const swapped = {
    ...first.record,
    endpoint: { ...(first.record['endpoint'] as object), tree: secondEndpoint['tree'] },
  };

  await writeFile(join(first.directory, recordFileName), JSON.stringify(swapped));

  const decision = await readCompletedCapture(root, first.directory);

  expect(decision.status).toBe('altered');
  expect(decision.reasons).toEqual([expect.stringContaining('src/kept.ts')]);
});

it('keeps a range capture completed after its topic branch is deleted and pruned', async () => {
  const root = await committedRepository();
  const trunk = await git(root, 'branch', '--show-current');

  await git(root, 'switch', '--quiet', '-c', 'topic');
  await writeAt(root, 'src/kept.ts', 'two\n');

  const from = await git(root, 'rev-parse', 'HEAD');
  const to = await commitAll(root, 'topic change');
  const { directory } = await capturedRecord(root, { kind: 'range', from, to });

  await git(root, 'switch', '--quiet', trunk);
  await git(root, 'branch', '--quiet', '-D', 'topic');
  await git(root, 'reflog', 'expire', '--expire=now', '--all');
  await git(root, 'gc', '--quiet', '--prune=now');

  expect(await readCompletedCapture(root, directory)).toMatchObject({
    status: 'completed',
    endpoint: 'complete',
  });
});

it('reads a capture whose endpoint ref was deleted and objects pruned as missing', async () => {
  const root = await committedRepository();

  await writeAt(root, 'src/added.ts', 'only in the endpoint\n');

  const { directory, record } = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });
  const endpoint = record['endpoint'] as Record<string, string>;

  await git(root, 'update-ref', '-d', endpoint['ref'] ?? '');
  await git(root, 'prune', '--expire=now');

  const decision = await readCompletedCapture(root, directory);

  expect(decision.status).toBe('missing');
  expect(decision.reasons).toEqual([expect.stringContaining(endpoint['tree'] ?? '')]);
});

it('reads a capture whose endpoint lost a blob object as missing', async () => {
  const root = await committedRepository();

  await writeAt(root, 'src/added.ts', 'only in the endpoint\n');

  const { directory, record } = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });
  const endpoint = record['endpoint'] as { status: 'complete'; baseTree: string; tree: string };
  const blob = await git(root, 'rev-parse', `${endpoint.tree}:src/added.ts`);

  await rm(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

  const decision = await readCompletedCapture(root, directory);

  expect(decision.status).toBe('missing');
  expect(decision.reasons).toEqual([expect.stringContaining(blob)]);
  expect(await compareEndpoint(root, endpoint, 'HEAD')).toBe('unknown');
});

const committedPair = async (root: string, kept: string) => {
  await git(root, 'checkout', '--quiet', '--orphan', `pair-${kept}`);
  await writeAt(root, 'src/kept.ts', `${kept}\n`);
  await writeAt(root, 'src/changed.ts', 'one\n');

  const base = await commitAll(root, 'pair base');

  await writeAt(root, 'src/changed.ts', 'two\n');

  const tip = await commitAll(root, 'pair tip');

  return {
    base,
    tip,
    baseTree: await git(root, 'rev-parse', `${base}^{tree}`),
    tree: await git(root, 'rev-parse', `${tip}^{tree}`),
  };
};

it('reads a record whose endpoint trees make the same change to other content as altered', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const foreign = await committedPair(root, 'unreviewed');
  const reviewed = await committedPair(root, 'safe');

  await git(root, 'checkout', '--quiet', reviewed.base);
  await writeAt(root, 'src/changed.ts', 'two\n');

  const { directory, record } = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });

  const replaced = {
    ...record,
    endpoint: {
      ...(record['endpoint'] as object),
      baseTree: foreign.baseTree,
      tree: foreign.tree,
    },
  };

  await writeFile(join(directory, recordFileName), JSON.stringify(replaced));

  const decision = await readCompletedCapture(root, directory);

  expect(decision.status).toBe('altered');
  expect(decision.reasons).toEqual([expect.stringContaining(foreign.baseTree)]);
});

it('reads a range record whose endpoint trees make the same change to other content as altered', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const foreign = await committedPair(root, 'unreviewed');
  const reviewed = await committedPair(root, 'safe');

  const { directory, record } = await capturedRecord(root, {
    kind: 'range',
    from: reviewed.base,
    to: reviewed.tip,
  });

  const replaced = {
    ...record,
    endpoint: {
      ...(record['endpoint'] as object),
      baseTree: foreign.baseTree,
      tree: foreign.tree,
    },
  };

  await writeFile(join(directory, recordFileName), JSON.stringify(replaced));

  const decision = await readCompletedCapture(root, directory);

  expect(decision.status).toBe('altered');

  expect(decision.reasons).toEqual([
    expect.stringContaining(foreign.baseTree),
    expect.stringContaining(foreign.tree),
  ]);
});

const isRoot = process.getuid?.() === 0;

it.skipIf(isRoot)('records an incomplete endpoint for an unreadable gap', async () => {
  const root = await committedRepository();

  await writeAt(root, 'src/kept.ts', 'two\n');
  await writeAt(root, 'secret.txt', 'hidden\n');
  await chmod(join(root, 'secret.txt'), 0o000);

  const { record } = await capturedRecord(root, { kind: 'workingTree', base: 'HEAD' });

  expect(record['endpoint']).toEqual({
    status: 'incomplete',
    reasons: [expect.stringContaining('secret.txt')],
  });
});

const nestedRepository = async (root: string) => {
  const module = join(root, 'module');

  await mkdir(module);
  await git(module, 'init', '--quiet');
  await writeAt(module, 'inner.txt', 'inner\n');
  await commitAll(module, 'inner');
};

it.each([
  {
    name: 'a files target',
    target: { kind: 'files', paths: ['src/kept.ts'] },
    change: (root: string) => writeAt(root, 'src/kept.ts', 'two\n'),
  },
  {
    name: 'a root commit target',
    target: { kind: 'rootCommit', commit: 'HEAD' },
    change: () => Promise.resolve(),
  },
  {
    name: 'an excluded path',
    target: { kind: 'workingTree', base: 'HEAD', exclude: ['src/other.ts'] },
    change: async (root: string) => {
      await writeAt(root, 'src/kept.ts', 'two\n');
      await writeAt(root, 'src/other.ts', 'left out\n');
    },
  },
  {
    name: 'a binary gap',
    target: { kind: 'workingTree', base: 'HEAD' },
    change: (root: string) => writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2, 0, 255])),
  },
  {
    name: 'a submodule gap',
    target: { kind: 'workingTree', base: 'HEAD' },
    change: async (root: string) => {
      await nestedRepository(root);
      await writeAt(root, 'src/kept.ts', 'two\n');
    },
  },
] satisfies { name: string; target: ReviewTarget; change: (root: string) => Promise<void> }[])(
  'records an unsupported endpoint and no ref for $name',
  async ({ target, change }) => {
    const root = await committedRepository();

    await change(root);

    const { directory, record } = await capturedRecord(root, target);

    expect(record['endpoint']).toEqual({
      status: 'unsupported',
      reasons: [expect.any(String)],
    });

    expect(await git(root, 'for-each-ref', 'refs/tau/')).toBe('');

    expect(await readCompletedCapture(root, directory)).toMatchObject({
      status: 'completed',
      endpoint: 'unsupported',
    });
  },
);
