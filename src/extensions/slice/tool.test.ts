import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
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

const snapshotDraft = async (directory: string) => {
  const names = await readdir(directory);

  return Promise.all(
    names.toSorted().map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
  );
};

// Runs a read and checks that it changed no draft file and made no Linear write.
const expectReadOnly = async (fake: Fake, directory: string, read: () => Promise<unknown>) => {
  const draftBefore = await snapshotDraft(directory);
  const writesBefore = fake.writes().length;

  const outcome: { value?: unknown; error?: string } = await read().then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );

  expect(await snapshotDraft(directory)).toEqual(draftBefore);
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

const outsideDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-slice-outside-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return directory;
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

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

  it('creates the container in the route project when another team has a project with that name', async () => {
    const { fake, apply } = await setUp();

    fake.addProject({ id: 'project-other-tau', name: 'Tau', teamId: 'team-other' });
    await apply();

    expect(fake.issues.get('ME-1')).toMatchObject({ teamId: 'team-me', projectId: 'project-tau' });
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

  it('refuses to create a container again after a create whose output was lost', async () => {
    const { fake, context, directory, apply } = await setUp();
    const { stateToken } = await run(fake, context, { action: 'read', directory });

    // Linear creates the container, but the call fails as if the output were lost.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);
      const created = commandArguments[1]?.includes('issueCreate') === true;

      return created ? { code: 1, killed: false, stdout: '', stderr: 'timeout' } : result;
    });

    await expect(
      tool.execute(
        'call',
        { action: 'apply', directory, stateToken: String(stateToken) },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({ applied: [] });

    await expect(apply(undefined, directory)).rejects.toThrow(/no container identifier, but ME-1/);
    expect([...fake.issues.keys()]).toEqual(['ME-1']);
    expect(await savedPlan(directory)).toMatchObject({ container: { identifier: null } });
  });

  it('shows the new title and the body file of an update in the confirm', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { title: string }[];
    };

    plan.slices[0]!.title = 'Record the renamed lifecycle';
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');

    const confirm = vi.fn<(title: string, message: string) => Promise<boolean>>(async () => false);

    await apply(confirmContext(root, confirm), directory);
    const message = confirm.mock.calls[0]?.[1] ?? '';

    expect(message).toContain('Record the renamed lifecycle');
    expect(message).toContain('slice-2.md');
    expect(message).not.toContain('Slice two, revised.');
    expect(fake.issues.get('ME-2')?.title).toBe('Record the lifecycle');
  });

  it('stops before the next step when the call is aborted', async () => {
    const { fake, context, directory } = await setUp();
    const { stateToken } = await run(fake, context, { action: 'read', directory });
    const controller = new AbortController();

    // Aborts once Linear creates the container.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);

      if (commandArguments[1]?.includes('issueCreate') === true) {
        controller.abort();
      }

      return result;
    });

    await expect(
      tool.execute(
        'call',
        { action: 'apply', directory, stateToken: String(stateToken) },
        controller.signal,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({
      applied: [{ kind: 'createContainer' }],
      notApplied: [
        { kind: 'moveDraft' },
        { kind: 'createSlice', number: 1 },
        { kind: 'createSlice', number: 2 },
        { kind: 'addBlockedBy', number: 2, blocker: 1 },
      ],
    });

    expect([...fake.issues.keys()]).toEqual(['ME-1']);
    expect(await savedPlan(directory)).toMatchObject({ container: { identifier: 'ME-1' } });
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

  it('lists no order move when the order is in place', async () => {
    const { directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    const result = await apply(undefined, directory);
    const applied = result['applied'] as { kind: string }[];

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
  });

  it('creates new slices at their plan position without an order move', async () => {
    const { fake, apply } = await setUp();

    const result = await apply();
    const applied = result['applied'] as { kind: string }[];
    const orders = ['ME-2', 'ME-3'].map((identifier) => fake.issues.get(identifier)!.sortOrder);

    expect(applied.map((step) => step.kind)).not.toContain('moveSlice');
    expect(result['orderInPlace']).toBe(true);
    expect(orders[0]).toBeLessThan(orders[1]!);
  });

  it('creates a slice between two existing slices without moving them', async () => {
    const { fake, directory, apply } = await appliedPlan();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { identifier: string | null; title: string; file: string; blockedBy: number[] }[];
    };

    plan.slices.splice(1, 0, {
      identifier: null,
      title: 'Middle',
      file: 'slice-3.md',
      blockedBy: [],
    });

    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'slice-3.md'), 'Slice three.\n');
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);

    const orders = ['ME-2', 'ME-4', 'ME-3'].map(
      (identifier) => fake.issues.get(identifier)!.sortOrder,
    );

    expect(result['applied']).toMatchObject([{ kind: 'createSlice', number: 2 }]);
    expect(fake.writes()).toHaveLength(writesBefore + 1);
    expect(orders).toEqual(orders.toSorted((left, right) => left - right));
  });

  it('names the route project of a new container in the confirm', async () => {
    const { root, apply } = await setUp();
    const confirm = vi.fn<(title: string, message: string) => Promise<boolean>>(async () => false);

    await apply(confirmContext(root, confirm));

    expect(confirm.mock.calls[0]?.[1]).toContain('in team ME and project Tau');
  });

  it('lists each order move in the confirm and makes only those moves', async () => {
    const { root, fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.sortOrder = 5;
    const writesBefore = fake.writes().length;
    const confirm = vi.fn<(title: string, message: string) => Promise<boolean>>(async () => true);

    const result = await apply(confirmContext(root, confirm), directory);
    const message = confirm.mock.calls[0]?.[1] ?? '';
    const moves = fake.writes().slice(writesBefore);

    expect(message).toBe('1. Move ME-3 into plan order');
    expect(moves).toHaveLength(1);
    expect(moves[0]?.commandArguments.at(-1)).toContain('"id":"ME-3"');
    expect(result['orderInPlace']).toBe(true);
  });

  it('reports each order move that ran before a later move failed', async () => {
    const { fake, directory, apply } = await setUp();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { identifier: null; title: string; file: string; blockedBy: number[] }[];
    };

    plan.slices.push({ identifier: null, title: 'Third', file: 'slice-3.md', blockedBy: [] });
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'slice-3.md'), 'Slice three.\n');

    const moved = (await apply()).directory;

    fake.issues.get('ME-2')!.sortOrder = 5;
    fake.issues.get('ME-3')!.sortOrder = 1;
    fake.issues.get('ME-4')!.sortOrder = 0;
    fake.failWrite(fake.writes().length + 2);

    await expect(apply(undefined, moved)).rejects.toMatchObject({
      applied: [{ kind: 'moveSlice', identifier: 'ME-3' }],
      notApplied: [{ kind: 'moveSlice', identifier: 'ME-4' }],
    });
  });

  it('stops the order moves when the call is aborted after a move', async () => {
    const { fake, context, directory, apply } = await setUp();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { identifier: null; title: string; file: string; blockedBy: number[] }[];
    };

    plan.slices.push({ identifier: null, title: 'Third', file: 'slice-3.md', blockedBy: [] });
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'slice-3.md'), 'Slice three.\n');

    const created = await apply();

    fake.issues.get('ME-2')!.sortOrder = 5;
    fake.issues.get('ME-3')!.sortOrder = 1;
    fake.issues.get('ME-4')!.sortOrder = 0;

    const read = await run(fake, context, { action: 'read', directory: created.directory });
    const writesBefore = fake.writes().length;
    const controller = new AbortController();

    // Aborts once the first order move reaches Linear.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);

      if (fake.writes().length > writesBefore) {
        controller.abort();
      }

      return result;
    });

    await expect(
      tool.execute(
        'call',
        { action: 'apply', directory: created.directory, stateToken: String(read.stateToken) },
        controller.signal,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({
      applied: [{ kind: 'moveSlice', identifier: 'ME-3' }],
      notApplied: [{ kind: 'moveSlice', identifier: 'ME-4' }],
    });

    expect(fake.writes()).toHaveLength(writesBefore + 1);
  });

  it('reports every order move as applied when the order read after the writes fails', async () => {
    const { fake, context, directory } = await appliedPlan();

    fake.issues.get('ME-2')!.sortOrder = 5;
    fake.issues.get('ME-3')!.sortOrder = 1;

    const writesBefore = fake.writes().length;
    const { stateToken } = await run(fake, context, { action: 'read', directory });

    // Fails each container read once a move has reached Linear.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const moved = fake.writes().length > writesBefore;

      if (moved && commandArguments[1]?.includes('children') === true) {
        return { code: 1, killed: false, stdout: '', stderr: 'network error' };
      }

      return fake.exec(command, commandArguments, options);
    });

    const failure = tool.execute(
      'call',
      { action: 'apply', directory, stateToken: String(stateToken) },
      undefined,
      undefined,
      context,
    );

    await expect(failure).rejects.toMatchObject({
      applied: [{ kind: 'moveSlice', identifier: 'ME-3' }],
      notApplied: [],
    });
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
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = confirmContext(root, async () => true);
    const { directory } = await run(fake, context, { action: 'prepare', id: 'me-77' });

    const outcome = await expectReadOnly(fake, directory, () =>
      run(fake, context, { action: 'read', directory, container: 'ME-77' }),
    );

    expect(outcome.error).toMatch(/no issue ME-77/);
  });

  it('refuses a container for a draft that records none', async () => {
    const { fake, directory, read } = await setUp();

    fake.addIssue({ identifier: 'ME-4', title: 'Existing' });
    const outcome = await expectReadOnly(fake, directory, () => read('ME-4'));

    expect(outcome.error).toMatch(/records no container identifier.*ME-4/);
  });

  it('names a linear call that was killed', async () => {
    const { fake, context, directory } = await appliedPlan();

    const tool = createSliceTool(async (command, commandArguments, options) => ({
      ...(await fake.exec(command, commandArguments, options)),
      killed: true,
    }));

    const outcome = await expectReadOnly(fake, directory, () =>
      tool.execute('call', { action: 'read', directory }, undefined, undefined, context),
    );

    expect(outcome.error).toMatch(/^linear api .* failed/);
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

  it('refuses a reused draft behind a linked .tau', async () => {
    const { root, fake, context } = await appliedPlan();
    const outside = await outsideDirectory();

    await cp(join(root, '.tau'), outside, { recursive: true });
    await rm(join(root, '.tau'), { recursive: true });
    await symlink(outside, join(root, '.tau'));
    const outsidePlan = join(outside, 'slices', 'me-1', 'plan.json');
    const planBefore = await readFile(outsidePlan, 'utf8');

    await expect(run(fake, context, { action: 'prepare', id: 'me-1' })).rejects.toThrow(
      /symlink: \.tau$/,
    );

    expect(await readFile(outsidePlan, 'utf8')).toBe(planBefore);
  });

  it.each(['malformed.json', 'newer.json'])(
    'prepares a new draft next to an unrelated %s draft',
    async (fixture) => {
      const { root, fake, context } = await setUp();
      const unrelated = join(root, '.tau', 'slices', 'unrelated');

      await mkdir(unrelated);
      await copyFile(join(fixtures, fixture), join(unrelated, 'plan.json'));

      const prepared = await run(fake, context, { action: 'prepare', id: 'other-design' });

      expect(prepared.directory).toBe(join(root, '.tau', 'slices', 'other-design'));
    },
  );

  it('refuses a draft named id that records another container', async () => {
    const { fake, context, directory } = await setUp();
    const plan = await savedPlan(directory);

    plan.container.identifier = 'ME-5';
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));

    await expect(run(fake, context, { action: 'prepare', id: 'planning' })).rejects.toThrow(
      /planning records container ME-5/,
    );
  });

  it('reuses a draft named id that records no container', async () => {
    const { fake, context, directory } = await setUp();

    const prepared = await run(fake, context, { action: 'prepare', id: 'planning' });

    expect(prepared.directory).toBe(directory);
  });

  it('refuses to prepare when it cannot list the drafts', async () => {
    const { root, fake, context } = await setUp();
    const slices = join(root, '.tau', 'slices');

    await chmod(slices, 0o300);

    const outcome = await run(fake, context, { action: 'prepare', id: 'other' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    await chmod(slices, 0o755);

    expect(outcome).toMatchObject({ code: 'EACCES' });
    expect(await exists(join(slices, 'other'))).toBe(false);
  });

  it('refuses a selected draft that it cannot read', async () => {
    const { fake, context, directory } = await setUp('malformed.json');

    await expect(run(fake, context, { action: 'prepare', id: 'planning' })).rejects.toThrow(
      new RegExp(`Malformed slice draft ${join(directory, 'plan.json')}`),
    );
  });
});

describe('slice tool draft directory', () => {
  it('reads a missing draft without creating anything', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = confirmContext(root, async () => true);

    await mkdir(join(root, '.tau'));
    await writeFile(join(root, '.tau', 'note.md'), 'Not ignored.\n');

    const result = await run(fake, context, {
      action: 'read',
      directory: '.tau/slices/missing',
    });

    expect(result['draft']).toBeNull();
    expect(await exists(join(root, '.tau', '.gitignore'))).toBe(false);
    expect(await exists(join(root, '.tau', 'slices'))).toBe(false);
  });

  it('refuses a draft directory nested with a backslash without creating anything', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = confirmContext(root, async () => true);

    await expect(
      run(fake, context, { action: 'read', directory: String.raw`.tau/slices/parent\child` }),
    ).rejects.toThrow(/must be \.tau\/slices\/<id>/);

    expect(await exists(join(root, '.tau'))).toBe(false);
  });

  it('refuses to apply a missing draft without creating anything', async () => {
    const root = await temporaryRepository();
    const fake = createLinearFake();
    const context = confirmContext(root, async () => true);

    await expect(
      run(fake, context, { action: 'apply', directory: '.tau/slices/missing', stateToken: 'any' }),
    ).rejects.toThrow(/does not exist/);

    expect(await exists(join(root, '.tau'))).toBe(false);
    expect(fake.writes()).toEqual([]);
  });

  it.each(
    (['prepare', 'read', 'apply'] as const).flatMap((action) =>
      ['plan.json', 'slice-1.md'].map((file) => [action, file] as const),
    ),
  )('refuses to %s a draft whose %s is a symlink', async (action, file) => {
    const { fake, context, directory } = await setUp();
    const outside = join(await outsideDirectory(), file);

    await copyFile(join(directory, file), outside);
    await rm(join(directory, file));
    await symlink(outside, join(directory, file));
    const before = await readFile(outside, 'utf8');

    const input =
      action === 'prepare'
        ? ({ action, id: 'planning' } as const)
        : ({ action, directory, stateToken: 'any' } as const);

    await expect(run(fake, context, input)).rejects.toThrow(new RegExp(`symlink: .*${file}$`));

    expect(await readFile(outside, 'utf8')).toBe(before);
    expect(fake.writes()).toEqual([]);
  });

  it.each(['read', 'apply'] as const)(
    'refuses to %s a draft behind a linked .tau/slices',
    async (action) => {
      const { root, fake, context, directory } = await setUp();
      const outside = await outsideDirectory();

      await cp(join(root, '.tau', 'slices'), outside, { recursive: true });
      await rm(join(root, '.tau', 'slices'), { recursive: true });
      await symlink(outside, join(root, '.tau', 'slices'));
      const planBefore = await readFile(join(outside, 'planning', 'plan.json'), 'utf8');

      await expect(run(fake, context, { action, directory, stateToken: 'any' })).rejects.toThrow(
        /symlink: \.tau\/slices$/,
      );

      expect(await readFile(join(outside, 'planning', 'plan.json'), 'utf8')).toBe(planBefore);
      expect(fake.writes()).toEqual([]);
    },
  );
});
