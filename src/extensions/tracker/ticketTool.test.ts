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
import { createLinearFake } from '../../../tests/linearFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createTicketTool } from './ticketTool.js';

interface PrepareParameters {
  action: 'prepare';
  id?: string;
}

const createTool = () => createTicketTool(createLinearFake().exec);

const prepare = async (cwd: string, parameters: PrepareParameters) => {
  const result = await createTool().execute(
    'call',
    parameters,
    undefined,
    undefined,
    noUiContext(cwd),
  );

  if (!('directory' in result.details) || !('draft' in result.details)) {
    throw new Error('Expected prepared draft');
  }

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
    draft: { version: 3, identifier: 'ME-600', comments: { '# Code review: ME-600': 'c1' } },
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
    draft: { version: 3, identifier: null, comments: {} },
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

  const result = await createTool().execute(
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
  expect(Value.Check(createTool().parameters, input)).toBe(valid);
});

it('refuses a newer draft.json and leaves it unchanged', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const saved = await saveDraft(root, 'me-600', 'newer.json');
  const before = await readFile(join(saved, 'draft.json'), 'utf8');

  await expect(prepare(root, { action: 'prepare', id: 'me-600' })).rejects.toThrow(/newer/);

  expect(await readFile(join(saved, 'draft.json'), 'utf8')).toBe(before);
});

it.each([
  {
    name: 'ticket',
    input: { action: 'comment', heading: '# Report', bodyFile: 'body.md' },
    error: /ticket/,
  },
  {
    name: 'heading',
    input: { action: 'comment', ticket: 'ME-1', bodyFile: 'body.md' },
    error: /heading/,
  },
  {
    name: 'bodyFile',
    input: { action: 'comment', ticket: 'ME-1', heading: '# Report' },
    error: /bodyFile/,
  },
  { name: 'cancel ticket', input: { action: 'cancel' }, error: /ticket/ },
  {
    name: 'valid ticket',
    input: { action: 'cancel', ticket: '../escape' },
    error: /Invalid ticket/,
  },
])('refuses a request without $name and writes nothing', async ({ input, error }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createLinearFake();

  await expect(
    createTicketTool(fake.exec).execute(
      'call',
      input as never,
      undefined,
      undefined,
      noUiContext(root),
    ),
  ).rejects.toThrow(error);

  expect(fake.calls).toEqual([]);
  expect(await readdir(root)).toEqual(['.git']);
});

it('routes comments and cancellation through the ticket tool', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createLinearFake();
  const issue = fake.addIssue({ title: 'Target', state: { type: 'canceled', name: 'Canceled' } });
  const tool = createTicketTool(fake.exec);
  const bodyFile = join(root, 'body.md');
  await writeFile(bodyFile, '# Report\nDone');

  const added = await tool.execute(
    'call',
    { action: 'comment', ticket: issue.identifier, heading: '# Report', bodyFile },
    undefined,
    undefined,
    noUiContext(root),
  );

  const canceled = await tool.execute(
    'call',
    { action: 'cancel', ticket: issue.identifier },
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(added.details).toMatchObject({ status: 'added' });
  expect(canceled.details).toEqual({ status: 'unchanged', identifier: issue.identifier });
  expect(fake.comments.size).toBe(1);
});
