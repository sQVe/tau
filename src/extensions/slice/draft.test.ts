import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { Plan } from './draft.js';
import { readDraft, readPlan, rejectLinkedDraftFiles, writePlan } from './draft.js';

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

  it.each([
    { case: 'two slices', container: null, slices: ['ME-2', 'ME-2'] },
    { case: 'the container and a slice', container: 'ME-2', slices: ['ME-2', null] },
  ])('rejects an identifier that $case share', async ({ container, slices }) => {
    const directory = await draftDirectory('version-1.json');
    const plan = (await readPlan(directory))!;

    plan.container.identifier = container;

    for (const [index, slice] of plan.slices.entries()) {
      slice.identifier = slices[index] ?? null;
    }

    await writePlan(directory, plan);

    const outcome = await readWithoutChanges(directory, () => readPlan(directory));

    expect(outcome.error).toMatch(/^Malformed slice draft.*ME-2/);
  });

  it.each([
    {
      case: 'a repeated blocker',
      blockedBy: [[], [1, 1]],
      error: /slice 2 .*slice 1 more than once/,
    },
    { case: 'a two-slice cycle', blockedBy: [[2], [1]], error: /slices 1, 2/ },
    { case: 'a three-slice cycle', blockedBy: [[3], [1], [2]], error: /slices 1, 3, 2/ },
  ])('rejects $case', async ({ blockedBy, error }) => {
    const directory = await draftDirectory('version-1.json');
    const plan = (await readPlan(directory))!;

    plan.slices.push({ identifier: null, title: 'Third', file: 'slice-3.md', blockedBy: [] });

    for (const [index, slice] of plan.slices.entries()) {
      slice.blockedBy = blockedBy[index] ?? [];
    }

    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    const outcome = await readWithoutChanges(directory, () => readPlan(directory));

    expect(outcome.error).toMatch(/^Malformed slice draft/);
    expect(outcome.error).toMatch(error);
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

  it('keeps the saved plan when the save fails', async () => {
    const directory = await draftDirectory('version-1.json');
    const before = await readFile(join(directory, 'plan.json'), 'utf8');
    const plan = (await readPlan(directory))!;

    // JSON.stringify throws on a bigint, so the save fails before it writes anything.
    const unsaveable = { ...plan, version: 1n } as unknown as Plan;

    await expect(writePlan(directory, unsaveable)).rejects.toThrow(/BigInt/);

    expect(await readFile(join(directory, 'plan.json'), 'utf8')).toBe(before);
    expect(await readdir(directory)).toEqual(['plan.json']);
  });

  it('leaves no temporary file when the plan cannot be replaced', async () => {
    const directory = await draftDirectory(undefined);
    const plan = (await readPlan(await draftDirectory('version-1.json')))!;

    await mkdir(join(directory, 'plan.json', 'inside'), { recursive: true });

    await expect(writePlan(directory, plan)).rejects.toThrow(/plan\.json/);

    expect(await readdir(directory)).toEqual(['plan.json']);
  });
});

describe('rejectLinkedDraftFiles', () => {
  it('refuses a draft file with another hard link', async () => {
    const directory = await draftDirectory('version-1.json');
    const outside = join(await draftDirectory(undefined), 'secret.md');

    await writeFile(outside, 'Not for Linear.\n');
    await link(outside, join(directory, 'slice-1.md'));

    await expect(rejectLinkedDraftFiles(directory)).rejects.toThrow(/hard link: .*slice-1\.md$/);
    expect(await readFile(outside, 'utf8')).toBe('Not for Linear.\n');
  });
});
