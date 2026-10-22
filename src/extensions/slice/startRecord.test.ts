import { copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readStartDraft, writeStart } from './startRecord.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'starts');

const recordDirectory = async (fixture: string | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-start-record-');

  if (fixture !== undefined) {
    await copyFile(join(fixtures, fixture), join(directory, 'start.json'));
  }

  await writeFile(join(directory, 'agent-1.md'), 'One.\n');
  await writeFile(join(directory, 'agent-2.md'), 'Two.\n');

  return directory;
};

describe('readStartDraft', () => {
  it('reads a version 1 record and its body files', async () => {
    const directory = await recordDirectory('version-1.json');
    const draft = await readStartDraft(directory);

    expect(draft?.start.tickets.map((ticket) => ticket.identifier)).toEqual([null, 'AI-12']);
    expect(draft?.bodies).toEqual(['One.\n', 'Two.\n']);
  });

  it('reports a missing record as undefined', async () => {
    const directory = await recordDirectory(undefined);

    await expect(readStartDraft(directory)).resolves.toBeUndefined();
  });

  it.each([
    { case: 'malformed', fixture: 'malformed.json', message: 'Malformed start record' },
    { case: 'newer', fixture: 'newer.json', message: 'newer format than this Tau reads' },
  ])('refuses a $case record', async ({ fixture, message }) => {
    const directory = await recordDirectory(fixture);

    await expect(readStartDraft(directory)).rejects.toThrow(message);
  });

  it('refuses a record that is not JSON', async () => {
    const directory = await recordDirectory(undefined);

    await writeFile(join(directory, 'start.json'), 'not json');

    await expect(readStartDraft(directory)).rejects.toThrow('not JSON');
  });

  it('refuses a record that names a missing body file', async () => {
    const directory = await recordDirectory('version-1.json');

    await rm(join(directory, 'agent-2.md'));

    await expect(readStartDraft(directory)).rejects.toThrow('agent-2.md');
  });

  it('refuses two tickets with the same title', async () => {
    const directory = await recordDirectory('version-1.json');
    const draft = await readStartDraft(directory);

    if (draft === undefined) {
      throw new Error('The fixture has no record.');
    }

    const [first, second] = draft.start.tickets;

    await writeStart(directory, {
      ...draft.start,
      tickets: [first!, { ...second!, title: first!.title }],
    });

    await expect(readStartDraft(directory)).rejects.toThrow('two tickets use the title');
  });
});

describe('readStartDraft without writes', () => {
  it.each([
    { case: 'current', fixture: 'version-1.json' },
    { case: 'missing', fixture: undefined },
    { case: 'malformed', fixture: 'malformed.json' },
    { case: 'newer', fixture: 'newer.json' },
  ])('leaves every file unchanged for a $case record', async ({ fixture }) => {
    const directory = await recordDirectory(fixture);

    const snapshot = async () =>
      Promise.all(
        (await readdir(directory))
          .toSorted()
          .map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
      );

    const before = await snapshot();

    await readStartDraft(directory).catch(() => undefined);

    expect(await snapshot()).toEqual(before);
  });
});

describe('writeStart', () => {
  it('saves a record that readStartDraft reads back, and leaves no temporary file', async () => {
    const directory = await recordDirectory('version-1.json');
    const draft = await readStartDraft(directory);

    draft!.start.tickets[0]!.identifier = 'AI-20';
    await writeStart(directory, draft!.start);

    const saved = JSON.parse(await readFile(join(directory, 'start.json'), 'utf8')) as {
      tickets: { identifier: string }[];
    };

    expect(saved.tickets[0]?.identifier).toBe('AI-20');

    expect((await readdir(directory)).toSorted()).toEqual([
      'agent-1.md',
      'agent-2.md',
      'start.json',
    ]);
  });
});
