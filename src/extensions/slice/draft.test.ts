import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Plan } from './draft.js';
import { readDraft, readPlan, writePlan } from './draft.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'plans');

const draftDirectory = async (fixture: string | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-slice-draft-');

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

describe('a saved plan with invalid fields', () => {
  type Fields = Record<string, unknown>;

  const withSlice = (change: Fields) => ({ slices: [{ ...firstSlice, ...change }, secondSlice] });

  const firstSlice = {
    identifier: null,
    title: 'Record the lifecycle',
    file: 'slice-1.md',
    blockedBy: [],
  };

  const secondSlice = {
    identifier: null,
    title: 'Add the slice skill',
    file: 'slice-2.md',
    blockedBy: [1],
  };

  it.each([
    { case: 'a body file outside the draft', ...withSlice({ file: '../secret.md' }) },
    { case: 'a body file in a subdirectory', ...withSlice({ file: 'sub/one.md' }) },
    { case: 'a body file that starts with a dot', ...withSlice({ file: '.one.md' }) },
    { case: 'a body file that is not markdown', ...withSlice({ file: 'one.txt' }) },
    { case: 'a slice identifier in lowercase', ...withSlice({ identifier: 'me-1' }) },
    { case: 'a slice identifier without a number', ...withSlice({ identifier: 'ME-x' }) },
    { case: 'an empty slice title', ...withSlice({ title: '' }) },
    { case: 'a blank slice title', ...withSlice({ title: '  \t' }) },
    { case: 'a blocker of zero', ...withSlice({ blockedBy: [0] }) },
    { case: 'a negative blocker', ...withSlice({ blockedBy: [-1] }) },
    { case: 'a blocker that is not an integer', ...withSlice({ blockedBy: [1.5] }) },
    { case: 'an unknown slice field', ...withSlice({ extra: true }) },
    { case: 'an empty team', route: { team: '', project: null } },
    { case: 'a team that is not text', route: { team: 7, project: null } },
    { case: 'an empty project', route: { team: 'ME', project: '' } },
    { case: 'a project that is not text', route: { team: 'ME', project: 7 } },
    { case: 'an unknown route field', route: { team: 'ME', project: null, extra: 1 } },
    {
      case: 'a container identifier in lowercase',
      container: { identifier: 'me-1', title: 'Container', file: 'container.md' },
    },
    {
      case: 'a blank container title',
      container: { identifier: null, title: ' ', file: 'container.md' },
    },
    {
      case: 'a container body file outside the draft',
      container: { identifier: null, title: 'Container', file: '../container.md' },
    },
    {
      case: 'an unknown container field',
      container: { identifier: null, title: 'Container', file: 'container.md', extra: 1 },
    },
    { case: 'an unknown plan field', extra: 1 },
  ])('refuses $case', async ({ case: _case, ...fields }) => {
    const directory = await draftDirectory('version-1.json');
    const plan = { ...(await readPlan(directory)), ...fields };

    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    const outcome = await readWithoutChanges(directory, () => readPlan(directory));

    expect(outcome.error).toMatch(/^Malformed slice draft/);
  });

  it('accepts a plan without a project', async () => {
    const directory = await draftDirectory('version-1.json');
    const plan = { ...(await readPlan(directory)), route: { team: 'ME', project: null } };

    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    expect((await readPlan(directory))?.route.project).toBeNull();
  });

  it('refuses two slices with the same title', async () => {
    const directory = await draftDirectory('version-1.json');
    const plan = (await readPlan(directory))!;

    plan.slices[1]!.title = plan.slices[0]!.title;

    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    const outcome = await readWithoutChanges(directory, () => readPlan(directory));

    expect(outcome.error).toMatch(/^Malformed slice draft.*two slices use the title/);
  });

  it('accepts slices with different titles', async () => {
    const directory = await draftDirectory('version-1.json');

    expect((await readPlan(directory))?.slices).toHaveLength(2);
  });

  it.each([
    { case: 'null', text: 'null' },
    { case: 'a number', text: '5' },
    { case: 'a string', text: '"plan"' },
    { case: 'an object without a version', text: '{}' },
    { case: 'a version that is text', text: '{"version":"9"}' },
    { case: 'a version of null', text: '{"version":null}' },
  ])('calls $case malformed, not newer', async ({ text }) => {
    const directory = await draftDirectory(undefined);

    await writeFile(join(directory, 'plan.json'), text);

    const outcome = await readWithoutChanges(directory, () => readPlan(directory));

    expect(outcome.error).toMatch(/^Malformed slice draft/);
  });
});

describe('unreadable draft files', () => {
  it('rejects a plan that cannot be read instead of treating it as missing', async () => {
    const directory = await draftDirectory(undefined);

    await mkdir(join(directory, 'plan.json'));

    await expect(readDraft(directory)).rejects.toThrow(/EISDIR/);
  });

  it('rejects a body that cannot be read instead of naming it missing', async () => {
    const directory = await draftDirectory('version-1.json');

    await mkdir(join(directory, 'container.md'));

    await expect(readDraft(directory)).rejects.toThrow(/EISDIR/);
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

  it('reports the write error when the draft directory does not exist', async () => {
    const directory = join(await draftDirectory(undefined), 'missing');
    const plan = (await readPlan(await draftDirectory('version-1.json')))!;

    await expect(writePlan(directory, plan)).rejects.toMatchObject({ syscall: 'open' });
  });

  it('leaves no temporary file when the plan cannot be replaced', async () => {
    const directory = await draftDirectory(undefined);
    const plan = (await readPlan(await draftDirectory('version-1.json')))!;

    await mkdir(join(directory, 'plan.json', 'inside'), { recursive: true });

    await expect(writePlan(directory, plan)).rejects.toThrow(/plan\.json/);

    expect(await readdir(directory)).toEqual(['plan.json']);
  });
});
