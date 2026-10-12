import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished } from 'vitest';

import {
  createTemporaryBareRoot,
  createTemporaryRepository,
} from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createTrackerDraftTool } from './draftTool.js';

interface PrepareParameters {
  action: 'prepare';
  id?: string;
}

const prepare = async (cwd: string, parameters: PrepareParameters) => {
  const result = await createTrackerDraftTool().execute(
    'call',
    parameters as { action: 'prepare'; id: string },
    undefined,
    undefined,
    noUiContext(cwd),
  );

  return result.details;
};

const repositories = [
  { kind: 'worktree', create: createTemporaryRepository },
  { kind: 'bare root', create: createTemporaryBareRoot },
];

it.each(repositories)('prepares and reuses a ticket draft in a $kind', async ({ create }) => {
  const root = await create(onTestFinished);

  const prepared = await prepare(root, { action: 'prepare', id: 'me-600' });

  expect(prepared.directory).toBe(join(root, '.tau', 'tickets', 'me-600'));
  expect((await stat(prepared.directory)).isDirectory()).toBe(true);
  expect(await readFile(join(root, '.tau', '.gitignore'), 'utf8')).toMatch(/\*\n$/);

  await writeFile(join(prepared.directory, 'draft.md'), 'saved\n');

  expect(await prepare(root, { action: 'prepare', id: 'me-600' })).toEqual(prepared);
  expect(await readFile(join(prepared.directory, 'draft.md'), 'utf8')).toBe('saved\n');
});

it('ignores the draft directory in Git', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const { directory } = await prepare(root, { action: 'prepare', id: 'me-600' });

  await writeFile(join(directory, 'ticket.md'), 'body\n');

  const { stdout } = await promisify(execFile)('git', ['status', '--porcelain'], { cwd: root });

  expect(stdout).toBe('');
});

it.each(repositories)(
  'prepares at the root from a nested directory in a $kind',
  async ({ create }) => {
    const root = await create(onTestFinished);
    const nested = join(root, 'nested');

    await mkdir(nested);

    expect(await prepare(nested, { action: 'prepare', id: 'a-slug' })).toEqual({
      directory: join(root, '.tau', 'tickets', 'a-slug'),
    });

    expect(await readdir(nested)).toEqual([]);
  },
);

const refusedIds: { label: string; parameters: PrepareParameters }[] = [
  { label: 'missing', parameters: { action: 'prepare' } },
  ...['../x', 'Me-600', '', '-a', 'a/b', 'a b'].map((id) => ({
    label: id,
    parameters: { action: 'prepare' as const, id },
  })),
];

it.each(refusedIds)('refuses id $label and creates nothing', async ({ parameters }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await expect(prepare(root, parameters)).rejects.toThrow(/id/);

  expect(await readdir(root)).toEqual(['.git']);
});
