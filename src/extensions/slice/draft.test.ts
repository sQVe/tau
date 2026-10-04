import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { readDraft, readPlan, writePlan } from './draft.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'plans');

const draftDirectory = async (fixture: string | undefined) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-slice-draft-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  if (fixture !== undefined) {
    await copyFile(join(fixtures, fixture), join(directory, 'plan.json'));
  }

  return directory;
};

const snapshot = async (directory: string) => {
  const names = await readdir(directory);

  return Promise.all(
    names.toSorted().map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
  );
};

// Runs a read and checks that it changed no file in the draft.
const readWithoutChanges = async (directory: string, read: () => Promise<unknown>) => {
  const before = await snapshot(directory);

  const outcome: { value?: unknown; error?: string } = await read().then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );

  expect(await snapshot(directory)).toEqual(before);

  return outcome;
};

describe('readPlan', () => {
  it.each([
    { case: 'current', fixture: 'version-1.json', outcome: { value: { version: 1 } } },
    { case: 'missing', fixture: undefined, outcome: { value: undefined } },
  ])('reads a $case plan without changing the draft', async ({ fixture, outcome }) => {
    const directory = await draftDirectory(fixture);

    expect(await readWithoutChanges(directory, () => readPlan(directory))).toMatchObject(outcome);
  });

  it.each([
    { case: 'malformed', fixture: 'malformed.json', error: /^Malformed slice draft/ },
    { case: 'newer', fixture: 'newer.json', error: /newer format/ },
  ])('rejects a $case plan without changing the draft', async ({ fixture, error }) => {
    const directory = await draftDirectory(fixture);
    const outcome = await readWithoutChanges(directory, () => readPlan(directory));

    expect(outcome.error).toMatch(error);
  });
});

describe('readDraft', () => {
  it('reads the plan and its bodies without changing the draft', async () => {
    const directory = await draftDirectory('version-1.json');

    await writeFile(join(directory, 'container.md'), 'Design.\n');
    await writeFile(join(directory, 'slice-1.md'), 'One.\n');
    await writeFile(join(directory, 'slice-2.md'), 'Two.\n');

    expect(await readWithoutChanges(directory, () => readDraft(directory))).toMatchObject({
      value: { containerBody: 'Design.\n', sliceBodies: ['One.\n', 'Two.\n'] },
    });
  });

  it('returns undefined when the draft has no plan', async () => {
    const directory = await draftDirectory(undefined);

    expect(await readWithoutChanges(directory, () => readDraft(directory))).toEqual({
      value: undefined,
    });
  });

  it('names a missing body file', async () => {
    const directory = await draftDirectory('version-1.json');

    await writeFile(join(directory, 'container.md'), 'Design.\n');

    const outcome = await readWithoutChanges(directory, () => readDraft(directory));

    expect(outcome.error).toMatch(/names slice-1\.md/);
  });

  it('rejects a malformed plan', async () => {
    const directory = await draftDirectory('malformed.json');

    const outcome = await readWithoutChanges(directory, () => readDraft(directory));

    expect(outcome.error).toMatch(/^Malformed slice draft/);
  });
});

describe('writePlan', () => {
  it('refuses to save through a linked plan', async () => {
    const directory = await draftDirectory(undefined);
    const outside = await draftDirectory('version-1.json');
    const plan = await readPlan(outside);

    await symlink(join(outside, 'plan.json'), join(directory, 'plan.json'));
    const before = await readFile(join(outside, 'plan.json'), 'utf8');

    await expect(
      writePlan(directory, { ...plan!, container: { ...plan!.container, identifier: 'ME-9' } }),
    ).rejects.toThrow(/symlink/);

    expect(await readFile(join(outside, 'plan.json'), 'utf8')).toBe(before);
  });
});
