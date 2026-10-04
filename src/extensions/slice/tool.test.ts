import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { createLinearFake } from './fixtures/linearFake.js';
import { createSliceTool } from './tool.js';
import type { SliceInput } from './tool.js';

type Fake = ReturnType<typeof createLinearFake>;

const fixtures = join(import.meta.dirname, 'fixtures', 'plans');

const temporaryRepository = () => createTemporaryRepository(onTestFinished);

const run = async (fake: Fake, context: ExtensionToolContext, input: SliceInput) => {
  const tool = createSliceTool(fake.exec);
  const result = await tool.execute('call', input, undefined, undefined, context);

  return result.details as Record<string, unknown> & { directory: string };
};

const savedPlan = async (directory: string) =>
  JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
    container: { identifier: string | null };
    slices: { identifier: string | null }[];
  };

// Runs a read and checks that it changed no draft file and made no Linear write.
const expectReadOnly = async (fake: Fake, directory: string, read: () => Promise<unknown>) => {
  const planBefore = await readFile(join(directory, 'plan.json'), 'utf8');
  const writesBefore = fake.writes().length;

  const outcome: { value?: unknown; error?: string } = await read().then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );

  expect(await readFile(join(directory, 'plan.json'), 'utf8')).toBe(planBefore);
  expect(fake.writes()).toHaveLength(writesBefore);

  return outcome;
};

const setUp = async (fixture = 'version-1.json') => {
  const root = await temporaryRepository();
  const fake = createLinearFake();
  const approve = vi.fn<() => Promise<boolean>>(async () => true);
  const context = confirmContext(root, approve);
  const { directory } = await run(fake, context, { action: 'prepare', id: 'planning' });

  await copyFile(join(fixtures, fixture), join(directory, 'plan.json'));
  await writeFile(join(directory, 'container.md'), 'The design.\n');
  await writeFile(join(directory, 'slice-1.md'), 'Slice one.\n');
  await writeFile(join(directory, 'slice-2.md'), 'Slice two.\n');

  // Follows the draft when apply moves it to the container's identifier.
  let current = directory;

  const read = (container?: string) =>
    run(fake, context, {
      action: 'read',
      directory: current,
      ...(container === undefined ? {} : { container }),
    });

  const apply = async (applyContext: ExtensionToolContext = context, at = current) => {
    const { stateToken } = await run(fake, applyContext, { action: 'read', directory: at });

    const result = await run(fake, applyContext, {
      action: 'apply',
      directory: at,
      stateToken: String(stateToken),
    });

    current = result.directory;

    return result;
  };

  return { root, fake, context, approve, directory, read, apply };
};

// Creates the container and both slices, then returns the moved draft directory.
const appliedPlan = async () => {
  const setup = await setUp();
  const { directory } = await setup.apply();

  return { ...setup, directory };
};

describe('slice tool apply', () => {
  it('makes no Linear write when the user declines', async () => {
    const { root, fake, directory, apply } = await setUp();
    const decline = vi.fn<() => Promise<boolean>>(async () => false);

    const result = await apply(confirmContext(root, decline), directory);

    expect(result['status']).toBe('declined');
    expect(decline).toHaveBeenCalledOnce();
    expect(fake.writes()).toEqual([]);
    expect(await savedPlan(directory)).toMatchObject({ container: { identifier: null } });
  });

  it('makes no Linear write in a session without UI', async () => {
    const { root, fake, directory, apply } = await setUp();

    await expect(apply(noUiContext(root), directory)).rejects.toThrow(/needs a session with UI/);
    expect(fake.writes()).toEqual([]);
  });

  it('creates the container and slices in order and records each identifier', async () => {
    const { root, fake, approve, directory } = await appliedPlan();

    expect(approve).toHaveBeenCalledOnce();
    expect(directory).toBe(join(root, '.tau', 'slices', 'me-1'));

    expect(await savedPlan(directory)).toMatchObject({
      container: { identifier: 'ME-1' },
      slices: [{ identifier: 'ME-2' }, { identifier: 'ME-3' }],
    });

    expect(fake.issues.get('ME-1')).toMatchObject({ parent: null, projectId: 'project-tau' });

    expect(fake.issues.get('ME-2')).toMatchObject({
      parent: 'ME-1',
      teamId: 'team-me',
      projectId: 'project-tau',
      description: 'Slice one.\n',
    });

    expect(fake.issues.get('ME-3')).toMatchObject({ parent: 'ME-1', blockedBy: ['ME-2'] });
  });

  it('refuses when the container project differs from the route', async () => {
    const { fake, directory, read, apply } = await appliedPlan();

    fake.issues.get('ME-1')!.projectId = null;

    await expect(read()).resolves.toMatchObject({
      problems: [expect.stringMatching(/ME-1 is in team ME and no project/)],
    });

    await expect(apply(undefined, directory)).rejects.toThrow(/no project/);
  });

  it('refuses when Linear changed since the read', async () => {
    const { fake, context, directory } = await appliedPlan();
    const { stateToken } = await run(fake, context, { action: 'read', directory });

    fake.issues.get('ME-2')!.title = 'Renamed in Linear';
    const writesBefore = fake.writes().length;

    await expect(
      run(fake, context, { action: 'apply', directory, stateToken: String(stateToken) }),
    ).rejects.toThrow(/changed since the read/);

    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('retries after a partial failure by creating only the missing slices', async () => {
    const { fake, directory, apply } = await setUp();

    // Writes: container, slice 1, slice 2.
    fake.failWrite(3);

    const moved = join(directory, '..', 'me-1');

    await expect(apply()).rejects.toMatchObject({
      directory: moved,
      applied: [
        { kind: 'createContainer' },
        { kind: 'moveDraft' },
        { kind: 'createSlice', number: 1 },
      ],
      notApplied: [
        { kind: 'createSlice', number: 2 },
        { kind: 'addBlockedBy', number: 2, blocker: 1 },
        { kind: 'repairOrder' },
      ],
    });

    await apply(undefined, moved);

    expect([...fake.issues.keys()]).toEqual(['ME-1', 'ME-2', 'ME-3']);

    expect(await savedPlan(moved)).toMatchObject({
      slices: [{ identifier: 'ME-2' }, { identifier: 'ME-3' }],
    });
  });

  it('refuses to create a slice whose title matches an unrecorded child', async () => {
    const { fake, directory, apply } = await appliedPlan();
    const plan = await savedPlan(directory);

    plan.slices[1]!.identifier = null;
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    const writesBefore = fake.writes().length;

    await expect(apply(undefined, directory)).rejects.toThrow(/ME-3 under ME-1 has the same title/);
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('never changes a merged slice', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.pullRequests = ['https://github.com/sQVe/tau/pull/1'];
    fake.mergedPullRequests.add('https://github.com/sQVe/tau/pull/1');
    await writeFile(join(directory, 'slice-1.md'), 'Changed after merge.\n');
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);

    expect(result['status']).toBe('unchanged');
    expect(fake.writes()).toHaveLength(writesBefore);
  });

  it('updates a changed unmerged slice and its dependencies', async () => {
    const { fake, directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    const plan = await savedPlan(directory);

    await writeFile(
      join(directory, 'plan.json'),
      JSON.stringify({
        ...plan,
        slices: plan.slices.map((slice) => Object.assign(slice, { blockedBy: [] })),
      }),
    );

    await apply(undefined, directory);

    expect(fake.issues.get('ME-3')).toMatchObject({
      description: 'Slice two, revised.\n',
      blockedBy: [],
    });
  });

  it('repairs the slice order once', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.sortOrder = 5;
    fake.issues.get('ME-3')!.sortOrder = 1;
    const result = await apply(undefined, directory);
    const orders = ['ME-2', 'ME-3'].map((identifier) => fake.issues.get(identifier)!.sortOrder);

    expect(result['orderInPlace']).toBe(true);
    expect(orders[0]).toBeLessThan(orders[1]!);
  });

  it('refuses when the draft changes during the confirm', async () => {
    const { root, fake, directory, apply } = await setUp();

    const changeDuringConfirm = vi.fn<() => Promise<boolean>>(async () => {
      await writeFile(join(directory, 'slice-1.md'), 'Changed during the confirm.\n');

      return true;
    });

    await expect(apply(confirmContext(root, changeDuringConfirm), directory)).rejects.toThrow(
      /changed since the read/,
    );

    expect(fake.writes()).toEqual([]);
  });

  it('never changes a merged one-slice ticket', async () => {
    const { fake, directory, read, apply } = await setUp();
    const url = 'https://github.com/sQVe/tau/pull/7';

    fake.addIssue({
      identifier: 'ME-1',
      title: 'Old title',
      description: 'Old.\n',
      pullRequests: [url],
    });

    fake.mergedPullRequests.add(url);

    await writeFile(
      join(directory, 'plan.json'),
      JSON.stringify({
        version: 1,
        route: { team: 'ME', project: 'Tau' },
        container: { identifier: 'ME-1', title: 'New title', file: 'container.md' },
        slices: [],
      }),
    );

    await expect(read()).resolves.toMatchObject({ writes: [], problems: [] });
    await apply(undefined, directory);

    expect(fake.writes()).toEqual([]);
    expect(fake.issues.get('ME-1')).toMatchObject({ title: 'Old title', description: 'Old.\n' });
  });

  it('creates every slice before it marks one blocked by a later slice', async () => {
    const { fake, directory, apply } = await setUp();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { blockedBy: number[] }[];
    };

    plan.slices[0]!.blockedBy = [2];
    plan.slices[1]!.blockedBy = [];
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    await apply();

    expect(fake.issues.get('ME-2')).toMatchObject({ blockedBy: ['ME-3'] });
  });

  it('reports a wrong order that no move can fix', async () => {
    const { fake, directory, apply } = await appliedPlan();

    for (const [identifier, sortOrder] of [
      ['ME-2', 5],
      ['ME-3', 1],
    ] as const) {
      const url = `https://github.com/sQVe/tau/pull/${sortOrder}`;

      fake.issues.get(identifier)!.pullRequests = [url];
      fake.issues.get(identifier)!.sortOrder = sortOrder;
      fake.mergedPullRequests.add(url);
    }

    const result = await apply(undefined, directory);

    expect(result['orderInPlace']).toBe(false);
  });

  it('finishes the draft move on a retry after the move fails', async () => {
    const { fake, directory, apply } = await setUp();
    const target = join(directory, '..', 'me-1');

    await mkdir(target);
    await writeFile(join(target, 'blocker.txt'), 'in the way\n');

    await expect(apply()).rejects.toMatchObject({
      directory,
      applied: [{ kind: 'createContainer' }],
      notApplied: [
        { kind: 'moveDraft' },
        { kind: 'createSlice', number: 1 },
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    });

    await rm(target, { recursive: true });
    const result = await apply(undefined, directory);

    expect(result.directory).toBe(target);
    expect([...fake.issues.keys()]).toEqual(['ME-1', 'ME-2', 'ME-3']);
    expect(await savedPlan(target)).toMatchObject({ container: { identifier: 'ME-1' } });
  });

  it('reports a created ticket whose identifier could not be saved', async () => {
    const { fake, context, directory } = await setUp();
    const planFile = join(directory, 'plan.json');
    const { stateToken } = await run(fake, context, { action: 'read', directory });

    // Replaces plan.json with a directory once Linear creates the container, so the save fails.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);

      if (commandArguments[1]?.includes('issueCreate') === true) {
        await rm(planFile);
        await mkdir(planFile);
      }

      return result;
    });

    const failure = tool.execute(
      'call',
      { action: 'apply', directory, stateToken: String(stateToken) },
      undefined,
      undefined,
      context,
    );

    const failureDetails = (await failure.catch((error: unknown) => error)) as {
      created: unknown;
      applied: unknown[];
      notApplied: unknown[];
    };

    expect(failureDetails).toMatchObject({
      created: { identifier: 'ME-1', url: 'https://linear.app/me/issue/ME-1' },
      applied: [{ kind: 'createContainer', identifier: 'ME-1' }],
    });

    expect(failureDetails.notApplied.slice(0, 2)).toMatchObject([
      { kind: 'saveIdentifier', identifier: 'ME-1' },
      { kind: 'moveDraft' },
    ]);

    expect([...fake.issues.keys()]).toEqual(['ME-1']);
  });

  it('creates tickets whose titles look like other JSON values', async () => {
    const { fake, directory, apply } = await setUp();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      container: { title: string };
      slices: { title: string }[];
    };

    plan.container.title = '123';
    plan.slices[0]!.title = 'true';
    plan.slices[1]!.title = 'null';
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    await apply();

    expect(
      ['ME-1', 'ME-2', 'ME-3'].map((identifier) => fake.issues.get(identifier)?.title),
    ).toEqual(['123', 'true', 'null']);
  });
});

describe('slice tool read', () => {
  it('reads the container, slices in order, merged state, dependencies, and the draft', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.issues.get('ME-2')!.pullRequests = ['https://github.com/sQVe/tau/pull/1'];
    fake.mergedPullRequests.add('https://github.com/sQVe/tau/pull/1');
    fake.addIssue({ identifier: 'ME-9', title: 'Dropped', parent: 'ME-1', sortOrder: 9 });

    const { value: result } = (await expectReadOnly(fake, directory, read)) as { value: unknown };

    expect(result).toMatchObject({
      draft: { container: { identifier: 'ME-1' } },
      container: {
        identifier: 'ME-1',
        children: [
          { identifier: 'ME-2', merged: true, blockedBy: [] },
          { identifier: 'ME-3', merged: false, blockedBy: ['ME-2'] },
          { identifier: 'ME-9' },
        ],
      },
      writes: [],
      problems: [],
      dropped: ['ME-9'],
    });
  });

  it('reads a container before the draft has a plan', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = confirmContext(root, async () => true);

    fake.addIssue({ identifier: 'ME-4', title: 'Existing' });
    const { directory } = await run(fake, context, { action: 'prepare', id: 'me-4' });

    await expect(
      run(fake, context, { action: 'read', directory, container: 'ME-4' }),
    ).resolves.toMatchObject({ draft: null, container: { identifier: 'ME-4', children: [] } });
  });

  it('reports a container that Linear does not have', async () => {
    const { fake, directory, read } = await setUp();
    const outcome = await expectReadOnly(fake, directory, () => read('ME-77'));

    expect(outcome.error).toMatch(/no issue ME-77/);
  });

  it('names malformed linear output', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.overrideOutput('api', 'not json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/not JSON: not json/);
  });

  it('names linear output with missing fields', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.overrideOutput('api', JSON.stringify({ data: { issue: { identifier: 'ME-1' } } }));
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/unexpected output/);
  });

  it('names malformed gh output', async () => {
    const { fake, directory, read } = await appliedPlan();

    fake.issues.get('ME-2')!.pullRequests = ['https://github.com/sQVe/tau/pull/1'];
    fake.overrideOutput('pr view', '{"status": "MERGED"}');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/gh pr view .* unexpected output/);
  });

  it('reads the previous draft format', async () => {
    const { fake, directory, read } = await setUp('version-1.json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome).toMatchObject({
      value: {
        draft: { version: 1 },
        writes: [
          { kind: 'createContainer' },
          { kind: 'createSlice', number: 1 },
          { kind: 'createSlice', number: 2 },
          { kind: 'addBlockedBy', number: 2, blocker: 1 },
        ],
      },
    });

    const { writes } = outcome.value as { writes: { text?: unknown }[] };

    expect(writes.every((write) => typeof write.text === 'string')).toBe(true);
  });

  it('rejects a newer draft format', async () => {
    const { fake, directory, read } = await setUp('newer.json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/newer format/);
  });

  it('rejects a malformed draft', async () => {
    const { fake, directory, read } = await setUp('malformed.json');
    const outcome = await expectReadOnly(fake, directory, read);

    expect(outcome.error).toMatch(/Malformed slice draft .*plan\.json/);
  });
});

describe('slice tool prepare', () => {
  it('reuses the draft that records the container', async () => {
    const { root, fake, context, directory } = await appliedPlan();

    const prepared = await run(fake, context, { action: 'prepare', id: 'me-1' });

    expect(prepared.directory).toBe(directory);
    expect(directory.startsWith(join(root, '.tau', 'slices'))).toBe(true);
  });
});
