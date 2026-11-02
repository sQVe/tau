import { cp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import {
  appliedPlan,
  outsideDirectory,
  run,
  savedPlan,
  setUp,
} from './fixtures/sliceToolHarness.js';
import { createSliceTool } from './tool.js';

const applyWithChangeDuringRead = async (
  change: (directory: string) => Promise<void>,
  setup: Awaited<ReturnType<typeof setUp>>,
) => {
  const { fake, context, directory } = setup;
  const { stateToken } = await run(fake, context, { action: 'read', directory });
  let changed = false;

  const tool = createSliceTool(async (command, commandArguments, options) => {
    const result = await fake.exec(command, commandArguments, options);

    if (!changed) {
      changed = true;
      await change(directory);
    }

    return result;
  });

  return tool.execute(
    'call',
    { action: 'apply', directory, stateToken: String(stateToken) },
    undefined,
    undefined,
    context,
  );
};

describe('slice tool apply', () => {
  it('creates the container and slices in order and records each identifier', async () => {
    const { root, fake, directory } = await appliedPlan();

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

  it('refuses when the draft changed since the read', async () => {
    const { fake, context, directory } = await setUp();
    const { stateToken } = await run(fake, context, { action: 'read', directory });

    await writeFile(join(directory, 'slice-1.md'), 'Changed after the read.\n');

    await expect(
      run(fake, context, { action: 'apply', directory, stateToken: String(stateToken) }),
    ).rejects.toThrow(/changed since the read/);

    expect(fake.writes()).toEqual([]);
  });

  it('refuses when the draft directory became a symlink since the read', async () => {
    const { fake, context, directory } = await setUp();
    const { stateToken } = await run(fake, context, { action: 'read', directory });
    const outside = await outsideDirectory();
    const originalPlan = await savedPlan(directory);

    await cp(directory, outside, { recursive: true });
    await rm(directory, { recursive: true });
    await symlink(outside, directory);

    await expect(
      run(fake, context, { action: 'apply', directory, stateToken: String(stateToken) }),
    ).rejects.toThrow(/symlink/u);

    expect(fake.writes()).toEqual([]);
    expect(await savedPlan(outside)).toEqual(originalPlan);
  });

  it('retries after a partial failure by creating only the missing slices', async () => {
    const { fake, directory, apply } = await setUp();

    // Writes: container, slice 1, slice 2.
    fake.failWrite(3);

    const moved = join(directory, '..', 'me-1');

    await expect(apply()).rejects.toBeInstanceOf(Error);

    expect([...fake.issues.keys()]).toEqual(['ME-1', 'ME-2']);
    expect(fake.issues.get('ME-2')).toMatchObject({ parent: 'ME-1', blockedBy: [] });

    expect(await savedPlan(moved)).toMatchObject({
      container: { identifier: 'ME-1' },
      slices: [{ identifier: 'ME-2' }, { identifier: null }],
    });

    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });

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
    ).rejects.toThrow(/timeout/u);

    expect(await savedPlan(directory)).toMatchObject({
      container: { identifier: null },
      slices: [{ identifier: null }, { identifier: null }],
    });

    await expect(stat(join(directory, '..', 'me-1'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(apply(undefined, directory)).rejects.toThrow(/no container identifier, but ME-1/);
    expect([...fake.issues.keys()]).toEqual(['ME-1']);
    expect(await savedPlan(directory)).toMatchObject({ container: { identifier: null } });
  });

  it('reports the new title and the body file of an applied update', async () => {
    const { fake, directory, apply } = await appliedPlan();

    const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')) as {
      slices: { title: string }[];
    };

    plan.slices[0]!.title = 'Record the renamed lifecycle';
    await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');

    const result = await apply(undefined, directory);
    const applied = result['applied'] as { text: string }[];
    const texts = applied.map((step) => step.text).join('\n');

    expect(texts).toContain('Record the renamed lifecycle');
    expect(texts).toContain('slice-2.md');
    expect(texts).not.toContain('Slice two, revised.');
    expect(fake.issues.get('ME-2')?.title).toBe('Record the renamed lifecycle');
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
    ).rejects.toThrow(/aborted/u);

    expect(fake.writes()).toHaveLength(1);

    expect(await savedPlan(directory)).toMatchObject({
      slices: [{ identifier: null }, { identifier: null }],
    });

    await expect(stat(join(directory, '..', 'me-1'))).rejects.toMatchObject({ code: 'ENOENT' });

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

  it('moves a slice back into plan order after Linear moves it during an update', async () => {
    const { fake, directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);

    const result = await apply(undefined, directory);
    const applied = result['applied'] as { kind: string }[];

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice', 'updateSlice', 'moveSlice']);
    expect(fake.issues.get('ME-2')!.sortOrder).toBeLessThan(fake.issues.get('ME-3')!.sortOrder);
    expect(result['orderInPlace']).toBe(true);
  });

  it('does not repair the order of a slice another person is assigned', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);
    const sortOrderBefore = fake.issues.get('ME-3')!.sortOrder;
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);
    const applied = result['applied'] as { kind: string }[];

    const writesToSlice = fake
      .writes()
      .slice(writesBefore)
      .filter((call) => call.commandArguments.join(' ').includes('ME-3'));

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
    expect(fake.issues.get('ME-3')!.sortOrder).toBe(sortOrderBefore);
    expect(result['orderInPlace']).toBe(false);
    expect(writesToSlice).toEqual([]);
  });

  it('repairs the order of a slice the viewer is assigned', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = 'user-viewer';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);

    const result = await apply(undefined, directory);
    const applied = result['applied'] as { kind: string }[];

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice', 'moveSlice']);
    expect(fake.issues.get('ME-2')!.sortOrder).toBeLessThan(fake.issues.get('ME-3')!.sortOrder);
    expect(result['orderInPlace']).toBe(true);
  });

  it('does not repair the order of a slice with no assignee that another person created', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = null;
    fake.issues.get('ME-3')!.creatorId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);
    const sortOrderBefore = fake.issues.get('ME-3')!.sortOrder;

    const result = await apply(undefined, directory);
    const applied = result['applied'] as { kind: string }[];

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
    expect(fake.issues.get('ME-3')!.sortOrder).toBe(sortOrderBefore);
    expect(result['orderInPlace']).toBe(false);
  });

  it('does not repair the order of a slice whose creator is unknown', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = null;
    fake.issues.get('ME-3')!.creatorId = null;
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);
    const sortOrderBefore = fake.issues.get('ME-3')!.sortOrder;

    const result = await apply(undefined, directory);
    const applied = result['applied'] as { kind: string }[];

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
    expect(fake.issues.get('ME-3')!.sortOrder).toBe(sortOrderBefore);
    expect(result['orderInPlace']).toBe(false);
  });

  it('stops before a repair move when the call is aborted', async () => {
    const { root, fake, directory } = await appliedPlan();

    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);
    const controller = new AbortController();

    const exec: typeof fake.exec = async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);

      if (fake.writes().length > 0 && commandArguments.join(' ').includes('issueUpdate')) {
        controller.abort();
      }

      return result;
    };

    const tool = createSliceTool(exec);
    const context = noUiContext(root);
    const input = { action: 'read', directory } as const;
    const read = await tool.execute('call', input, undefined, undefined, context);
    const { stateToken } = read.details as { stateToken: string };
    const writesBefore = fake.writes().length;

    const outcome = await tool
      .execute(
        'call',
        { action: 'apply', directory, stateToken },
        controller.signal,
        undefined,
        context,
      )
      .then(
        () => 'applied',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    expect(outcome).toContain('aborted');
    expect(outcome).toContain('Not applied:\n- Move ME-3 into plan order');
    expect(fake.writes()).toHaveLength(writesBefore + 1);
    expect(fake.issues.get('ME-3')!.sortOrder).toBeLessThan(1000);
  });

  it('makes no extra write when the updates leave the order in place', async () => {
    const { fake, directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);

    expect(fake.writes()).toHaveLength(writesBefore + 2);
    expect(result['orderInPlace']).toBe(true);
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

  it('names the route project of a new container in the applied steps', async () => {
    const { apply } = await setUp();

    const result = await apply();
    const applied = result['applied'] as { text: string }[];

    expect(applied[0]?.text).toContain('in team ME and project Tau');
  });

  it('reports each order move and makes only those moves', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.sortOrder = 5;
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);
    const applied = result['applied'] as { text: string }[];
    const moves = fake.writes().slice(writesBefore);

    expect(applied.map((step) => step.text)).toEqual(['Move ME-3 into plan order']);
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

    await expect(apply(undefined, moved)).rejects.toBeInstanceOf(Error);

    expect(fake.issues.get('ME-2')?.sortOrder).toBe(5);
    expect(fake.issues.get('ME-3')?.sortOrder).toBeGreaterThan(5);
    expect(fake.issues.get('ME-4')?.sortOrder).toBe(0);

    const retry = await apply(undefined, moved);

    expect(retry['applied']).toMatchObject([{ kind: 'moveSlice', identifier: 'ME-4' }]);
    expect(retry['orderInPlace']).toBe(true);
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
    ).rejects.toThrow(/aborted/u);

    expect(fake.issues.get('ME-2')?.sortOrder).toBe(5);
    expect(fake.issues.get('ME-3')?.sortOrder).toBeGreaterThan(5);
    expect(fake.issues.get('ME-4')?.sortOrder).toBe(0);

    expect(fake.writes()).toHaveLength(writesBefore + 1);
  });

  it('reports every order move as applied when the order read after the writes fails', async () => {
    const { fake, context, directory, apply } = await appliedPlan();

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

    await expect(failure).rejects.toThrow(/network error/u);

    expect(fake.issues.get('ME-2')?.sortOrder).toBe(5);
    expect(fake.issues.get('ME-3')?.sortOrder).toBeGreaterThan(5);
    expect(fake.writes()).toHaveLength(writesBefore + 1);

    const retry = await apply(undefined, directory);

    expect(retry).toMatchObject({ status: 'unchanged', applied: [], orderInPlace: true });
    expect(fake.writes()).toHaveLength(writesBefore + 1);
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

  it('keeps agent children out of dropped slices', async () => {
    const { fake, directory, read } = await setUp();

    fake.addIssue({ identifier: 'ME-1', title: 'Container' });
    fake.addIssue({ identifier: 'ME-2', title: 'Slice', parent: 'ME-1' });

    fake.addIssue({
      identifier: 'AI-1',
      title: 'Agent task',
      parent: 'ME-1',
      teamId: 'team-ai',
      projectId: null,
    });

    await writeFile(
      join(directory, 'plan.json'),
      JSON.stringify({
        version: 1,
        route: { team: 'ME', project: 'Tau' },
        container: { identifier: 'ME-1', title: 'Container', file: 'container.md' },
        slices: [{ identifier: 'ME-2', title: 'Slice', file: 'slice-1.md', blockedBy: [] }],
      }),
    );

    await expect(read()).resolves.toMatchObject({ dropped: [], problems: [] });
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

    await expect(apply()).rejects.toBeInstanceOf(Error);

    expect([...fake.issues.keys()]).toEqual(['ME-1']);
    expect(fake.writes()).toHaveLength(1);

    expect(await savedPlan(directory)).toMatchObject({
      container: { identifier: 'ME-1' },
      slices: [{ identifier: null }, { identifier: null }],
    });

    await expect(stat(join(target, 'plan.json'))).rejects.toMatchObject({ code: 'ENOENT' });

    await rm(target, { recursive: true });
    const result = await apply(undefined, directory);

    expect(result.directory).toBe(target);
    expect([...fake.issues.keys()]).toEqual(['ME-1', 'ME-2', 'ME-3']);
    expect(await savedPlan(target)).toMatchObject({ container: { identifier: 'ME-1' } });
  });

  it('refuses when the draft changes while apply reads Linear', async () => {
    const setup = await setUp();

    const failure = applyWithChangeDuringRead(
      (directory) => writeFile(join(directory, 'slice-1.md'), 'Changed during the read.\n'),
      setup,
    );

    await expect(failure).rejects.toThrow(/changed since the read/u);

    expect(setup.fake.writes()).toEqual([]);
  });

  it('refuses when the draft directory becomes a symlink while apply reads Linear', async () => {
    const setup = await setUp();
    const outside = await outsideDirectory();
    const originalPlan = await savedPlan(setup.directory);

    const failure = applyWithChangeDuringRead(async (directory) => {
      await cp(directory, outside, { recursive: true });
      await rm(directory, { recursive: true });
      await symlink(outside, directory);
    }, setup);

    await expect(failure).rejects.toThrow(/symlink/u);

    expect(setup.fake.writes()).toEqual([]);
    expect(await savedPlan(outside)).toEqual(originalPlan);
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

    const failureDetails = (await failure.catch((error: unknown) => error)) as Error;

    expect(failureDetails.message).toContain('ME-1');
    expect(failureDetails.message).toContain('https://linear.app/me/issue/ME-1');
    expect(fake.issues.get('ME-1')).toMatchObject({ parent: null, title: 'Add PR-sized planning' });
    expect(fake.writes()).toHaveLength(1);

    const planFileState = await stat(planFile);

    expect(planFileState.isDirectory()).toBe(true);
    await expect(stat(join(directory, '..', 'me-1'))).rejects.toMatchObject({ code: 'ENOENT' });

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

describe('slice tool Linear pages after writes', () => {
  it('reports the applied steps when the order check finds another page', async () => {
    const { fake, directory, apply } = await setUp();

    fake.addIssue({ identifier: 'ME-1', title: 'Container' });
    fake.addIssue({ identifier: 'ME-2', title: 'Slice one', parent: 'ME-1' });

    await writeFile(
      join(directory, 'plan.json'),
      JSON.stringify({
        version: 1,
        route: { team: 'ME', project: 'Tau' },
        container: { identifier: 'ME-1', title: 'Container', file: 'container.md' },
        slices: [
          { identifier: 'ME-2', title: 'Slice one', file: 'slice-1.md', blockedBy: [] },
          { identifier: null, title: 'Slice two', file: 'slice-2.md', blockedBy: [] },
        ],
      }),
    );

    fake.limitChildren(1);

    const message = await apply().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).toContain('more than one Linear page');
    expect(message).toContain('Applied:');
    expect(message).not.toContain('Nothing was written');
    expect(fake.writes()).not.toEqual([]);
  });
});
