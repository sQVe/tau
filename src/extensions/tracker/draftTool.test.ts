import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Value } from 'typebox/value';
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

const fixtures = join(import.meta.dirname, 'fixtures', 'drafts');

const saveDraft = async (root: string, name: string, fixture: string) => {
  const directory = join(root, '.tau', 'tickets', name);

  await mkdir(directory, { recursive: true });
  await copyFile(join(fixtures, fixture), join(directory, 'draft.json'));

  return directory;
};

it('returns the directory whose draft.json records the identifier', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const saved = await saveDraft(root, 'fix-login', 'version-1.json');

  const prepared = await prepare(root, { action: 'prepare', id: 'me-600' });

  expect(prepared).toEqual({
    directory: saved,
    draft: { version: 2, identifier: 'ME-600', reviewCommentId: 'c1', qualityCommentId: null },
    malformed: [],
  });

  expect(await readdir(join(root, '.tau', 'tickets'))).toEqual(['fix-login']);
});

it('refuses a directory named for the id that records another identifier', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await saveDraft(root, 'me-700', 'version-1.json');
  const path = join(directory, 'draft.json');
  const before = await readFile(path, 'utf8');

  await expect(prepare(root, { action: 'prepare', id: 'me-700' })).rejects.toThrow(
    new RegExp(`${path}.*ME-600.*me-700`),
  );

  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await readdir(join(root, '.tau', 'tickets'))).toEqual(['me-700']);
});

it('returns a directory named for the id whose draft records no identifier', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = join(root, '.tau', 'tickets', 'me-600');

  await mkdir(directory, { recursive: true });

  await writeFile(
    join(directory, 'draft.json'),
    '{"version":2,"identifier":null,"reviewCommentId":null,"qualityCommentId":null}',
  );

  expect(await prepare(root, { action: 'prepare', id: 'me-600' })).toEqual({
    directory,
    draft: { version: 2, identifier: null, reviewCommentId: null, qualityCommentId: null },
    malformed: [],
  });
});

it('lists a malformed draft.json in another directory and still prepares', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const other = await saveDraft(root, 'other', 'malformed.json');

  const prepared = await prepare(root, { action: 'prepare', id: 'me-600' });

  expect(prepared).toEqual({
    directory: join(root, '.tau', 'tickets', 'me-600'),
    draft: null,
    malformed: [join(other, 'draft.json')],
  });
});

it('refuses a malformed draft.json in the returned directory and creates nothing', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await saveDraft(root, 'me-600', 'malformed.json');

  await expect(prepare(root, { action: 'prepare', id: 'me-600' })).rejects.toThrow(
    /Malformed ticket draft .*me-600.draft\.json/,
  );

  expect(await readdir(join(root, '.tau', 'tickets'))).toEqual(['me-600']);
  expect(await readdir(join(root, '.tau'))).toEqual(['tickets']);
});

it('refuses two directories that record the same identifier', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await saveDraft(root, 'first', 'version-1.json');
  await saveDraft(root, 'second', 'version-1.json');

  await expect(prepare(root, { action: 'prepare', id: 'me-600' })).rejects.toThrow(
    /first.* and .*second/,
  );
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
      draft: null,
      malformed: [],
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

it('returns the details as JSON text beside the details', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const result = await createTrackerDraftTool().execute(
    'call',
    { action: 'prepare', id: 'me-600' },
    undefined,
    undefined,
    noUiContext(root),
  );

  const [content] = result.content;
  const text = content?.type === 'text' ? content.text : '';

  expect(content?.type).toBe('text');
  expect(JSON.parse(text)).toEqual(result.details);
});

it('does not read a plain file in the tickets directory as a draft directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const tickets = join(root, '.tau', 'tickets');

  await mkdir(tickets, { recursive: true });
  await writeFile(join(tickets, 'notes.txt'), 'x\n');

  expect(await prepare(root, { action: 'prepare', id: 'me-600' })).toEqual({
    directory: join(tickets, 'me-600'),
    draft: null,
    malformed: [],
  });
});

it('throws when the tickets path cannot be listed and creates nothing', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await mkdir(join(root, '.tau'));
  await writeFile(join(root, '.tau', 'tickets'), 'not a directory\n');

  await expect(prepare(root, { action: 'prepare', id: 'me-600' })).rejects.toMatchObject({
    code: 'ENOTDIR',
  });

  expect(await readdir(join(root, '.tau'))).toEqual(['tickets']);
});

it.each([
  { name: 'prepare with an id', input: { action: 'prepare', id: 'me-600' }, valid: true },
  { name: 'another action', input: { action: 'delete', id: 'me-600' }, valid: false },
  { name: 'an id that is not text', input: { action: 'prepare', id: 6 }, valid: false },
])('checks the tool input for $name', ({ input, valid }) => {
  expect(Value.Check(createTrackerDraftTool().parameters, input)).toBe(valid);
});

const record = (cwd: string, field: string, value: string, id = 'me-600') =>
  createTrackerDraftTool().execute(
    'call',
    { action: 'record', id, field, value } as never,
    undefined,
    undefined,
    noUiContext(cwd),
  );

it('records a field of the draft found by identifier and writes version 2', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const saved = await saveDraft(root, 'fix-login', 'version-1.json');

  const result = await record(root, 'qualityCommentId', 'q7');

  const expected = {
    version: 2,
    identifier: 'ME-600',
    reviewCommentId: 'c1',
    qualityCommentId: 'q7',
  };

  expect(result.details).toEqual({ directory: saved, draft: expected });
  expect(JSON.parse(await readFile(join(saved, 'draft.json'), 'utf8'))).toEqual(expected);
});

it('creates draft.json for a new directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  const result = await record(root, 'identifier', 'ME-601', 'me-601');

  expect(result.details).toEqual({
    directory: join(root, '.tau', 'tickets', 'me-601'),
    draft: { version: 2, identifier: 'ME-601', reviewCommentId: null, qualityCommentId: null },
  });
});

it('refuses a newer draft.json and leaves it unchanged', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const saved = await saveDraft(root, 'me-600', 'newer.json');
  const before = await readFile(join(saved, 'draft.json'), 'utf8');

  await expect(record(root, 'identifier', 'ME-600')).rejects.toThrow(/newer/);

  expect(await readFile(join(saved, 'draft.json'), 'utf8')).toBe(before);
});

it('refuses an invalid value and creates no ticket directory or ignore file', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await expect(record(root, 'identifier', 'nope', 'me-602')).rejects.toThrow(/Invalid value/);

  expect(await readdir(root)).toEqual(['.git']);
});

it('checks the tool input for record', () => {
  const tool = createTrackerDraftTool();
  const input = { action: 'record', id: 'me-600', field: 'identifier', value: 'ME-600' };

  expect(Value.Check(tool.parameters, input)).toBe(true);
  expect(Value.Check(tool.parameters, { ...input, field: 'version' })).toBe(false);
});

it.each([
  { name: 'field', input: { action: 'record', id: 'me-600', value: 'ME-600' }, error: /field/ },
  { name: 'value', input: { action: 'record', id: 'me-600', field: 'identifier' }, error: /value/ },
])('refuses record without a $name and creates nothing', async ({ input, error }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await expect(
    createTrackerDraftTool().execute(
      'call',
      input as never,
      undefined,
      undefined,
      noUiContext(root),
    ),
  ).rejects.toThrow(error);

  expect(await readdir(root)).toEqual(['.git']);
});
