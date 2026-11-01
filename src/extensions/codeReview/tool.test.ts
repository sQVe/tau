import { lstat, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { Value } from 'typebox/value';
import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { codeReviewToolParameters, createCodeReviewTool } from './tool.js';
import type { CodeReviewInput } from './tool.js';

const run = async (root: string, input: CodeReviewInput) => {
  const tool = createCodeReviewTool();
  const result = await tool.execute('call', input, undefined, undefined, noUiContext(root));

  return result.details;
};

const failureOf = (root: string, input: CodeReviewInput) =>
  run(root, input).then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

const readCheckout = async (root: string): Promise<unknown[][]> => {
  const gitDirectory = join(root, '.git');

  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  const paths = entries
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => path !== gitDirectory && !path.startsWith(`${gitDirectory}${sep}`))
    .toSorted();

  return Promise.all(
    paths.map(async (path) => {
      const status = await lstat(path);

      if (status.isSymbolicLink()) {
        return [path, 'link', await readlink(path)];
      }

      if (status.isDirectory()) {
        return [path, 'directory'];
      }

      return [path, await readFile(path, 'utf8')];
    }),
  );
};

const preparedReview = async () => {
  const root = await committedRepository();
  const { directory } = (await run(root, { action: 'prepare' })) as { directory: string };

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');

  return { root, directory };
};

it('prepares a fresh review directory that Git ignores', async () => {
  const root = await committedRepository();
  const first = (await run(root, { action: 'prepare' })) as { directory: string };
  const second = (await run(root, { action: 'prepare' })) as { directory: string };

  expect(first.directory).toMatch(/\/\.tau\/workers\/review-[^/]+$/);
  expect(second.directory).not.toBe(first.directory);
  expect(await git(root, 'status', '--porcelain')).toBe('');
});

it('accepts each documented action in the parameters Pi validates and rejects an unknown one', () => {
  const actions = ['prepare', 'capture', 'freshness', 'evidence'];

  for (const action of actions) {
    expect(Value.Check(codeReviewToolParameters, { action })).toBe(true);
  }

  expect(Value.Check(codeReviewToolParameters, { action: 'delete' })).toBe(false);
});

it('gives the model the result as JSON text in the tool content', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const result = await createCodeReviewTool().execute(
    'call',
    { action: 'capture', directory, target: { kind: 'workingTree', base: 'HEAD' } },
    undefined,
    undefined,
    noUiContext(root),
  );

  const [block] = result.content;

  expect(block?.type).toBe('text');
  expect(JSON.parse(block?.type === 'text' ? block.text : '')).toEqual(result.details);
  expect(result.details['paths']).toEqual(['tracked.txt']);
});

it('reports fresh through the freshness action for an unchanged capture', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await run(root, { action: 'capture', directory, target: { kind: 'workingTree', base: 'HEAD' } });

  expect(await run(root, { action: 'freshness', directory })).toEqual({
    status: 'fresh',
    reasons: [],
  });
});

it('returns the evidence of a saved capture through the evidence action', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await run(root, { action: 'capture', directory, target: { kind: 'workingTree', base: 'HEAD' } });

  expect(await run(root, { action: 'evidence', directory })).toMatchObject({
    paths: ['tracked.txt'],
    freshness: { status: 'fresh', reasons: [] },
    gaps: [],
  });
});

it('names the missing target when capture gets none and writes nothing', async () => {
  const { directory, root } = await preparedReview();
  const before = await readCheckout(root);

  expect(await failureOf(root, { action: 'capture', directory })).toContain('target');
  expect(await readCheckout(root)).toEqual(before);
});

it.each(['capture', 'freshness', 'evidence'] as const)(
  'names the missing directory when %s gets none',
  async (action) => {
    const root = await committedRepository();
    const before = await readCheckout(root);

    expect(await failureOf(root, { action })).toContain('directory');
    expect(await readCheckout(root)).toEqual(before);
  },
);
