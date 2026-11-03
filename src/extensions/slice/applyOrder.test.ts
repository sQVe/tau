import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import {
  appliedPlan,
  failureDetails,
  readDetails,
  run,
  setUp,
} from './fixtures/sliceToolHarness.js';
import { createSliceTool } from './tool.js';

describe('slice tool apply', () => {
  it('lists no order move when the order is in place', async () => {
    const { directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    const result = await apply(undefined, directory);
    const applied = result.applied;

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
  });

  it('moves a slice back into plan order after Linear moves it during an update', async () => {
    const { fake, directory, apply } = await appliedPlan();

    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    await writeFile(join(directory, 'slice-2.md'), 'Slice two, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);

    const result = await apply(undefined, directory);
    const applied = result.applied;

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice', 'updateSlice', 'moveSlice']);
    expect(fake.issues.get('ME-2')!.sortOrder).toBeLessThan(fake.issues.get('ME-3')!.sortOrder);
    expect(result).toMatchObject({ orderInPlace: true });
  });

  it('does not repair the order of a slice another person is assigned', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);
    const sortOrderBefore = fake.issues.get('ME-3')!.sortOrder;
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);
    const applied = result.applied;

    const writesToSlice = fake
      .writes()
      .slice(writesBefore)
      .filter((call) => call.commandArguments.join(' ').includes('ME-3'));

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
    expect(fake.issues.get('ME-3')!.sortOrder).toBe(sortOrderBefore);
    expect(result).toMatchObject({ orderInPlace: false });
    expect(writesToSlice).toEqual([]);
  });

  it('repairs the order of a slice the viewer is assigned', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = 'user-viewer';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);

    const result = await apply(undefined, directory);
    const applied = result.applied;

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice', 'moveSlice']);
    expect(fake.issues.get('ME-2')!.sortOrder).toBeLessThan(fake.issues.get('ME-3')!.sortOrder);
    expect(result).toMatchObject({ orderInPlace: true });
  });

  it('does not repair the order of a slice with no assignee that another person created', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = null;
    fake.issues.get('ME-3')!.creatorId = 'user-other';
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);
    const sortOrderBefore = fake.issues.get('ME-3')!.sortOrder;

    const result = await apply(undefined, directory);
    const applied = result.applied;

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
    expect(fake.issues.get('ME-3')!.sortOrder).toBe(sortOrderBefore);
    expect(result).toMatchObject({ orderInPlace: false });
  });

  it('does not repair the order of a slice whose creator is unknown', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-3')!.assigneeId = null;
    fake.issues.get('ME-3')!.creatorId = null;
    await writeFile(join(directory, 'slice-1.md'), 'Slice one, revised.\n');
    fake.moveOnUpdate('ME-2', 1000);
    const sortOrderBefore = fake.issues.get('ME-3')!.sortOrder;

    const result = await apply(undefined, directory);
    const applied = result.applied;

    expect(applied.map((step) => step.kind)).toEqual(['updateSlice']);
    expect(fake.issues.get('ME-3')!.sortOrder).toBe(sortOrderBefore);
    expect(result).toMatchObject({ orderInPlace: false });
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
    const { stateToken } = readDetails(read.details);
    const writesBefore = fake.writes().length;

    const aborted = await tool.execute(
      'call',
      { action: 'apply', directory, stateToken },
      controller.signal,
      undefined,
      context,
    );

    expect(aborted.isError).toBe(true);

    const { notApplied } = failureDetails(aborted.details);

    expect(notApplied[0]?.text).toBe('Move ME-3 into plan order');
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
    expect(result).toMatchObject({ orderInPlace: true });
  });

  it('creates new slices at their plan position without an order move', async () => {
    const { fake, apply } = await setUp();

    const result = await apply();
    const applied = result.applied;
    const orders = ['ME-2', 'ME-3'].map((identifier) => fake.issues.get(identifier)!.sortOrder);

    expect(applied.map((step) => step.kind)).not.toContain('moveSlice');
    expect(result).toMatchObject({ orderInPlace: true });
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

  it('reports each order move and makes only those moves', async () => {
    const { fake, directory, apply } = await appliedPlan();

    fake.issues.get('ME-2')!.sortOrder = 5;
    const writesBefore = fake.writes().length;

    const result = await apply(undefined, directory);
    const applied = result.applied;
    const moves = fake.writes().slice(writesBefore);

    expect(applied.map((step) => step.text)).toEqual(['Move ME-3 into plan order']);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.commandArguments.at(-1)).toContain('"id":"ME-3"');
    expect(result).toMatchObject({ orderInPlace: true });
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

    expect((await apply(undefined, moved))['status']).toBe('failed');

    expect(fake.issues.get('ME-2')?.sortOrder).toBe(5);
    expect(fake.issues.get('ME-3')?.sortOrder).toBeGreaterThan(5);
    expect(fake.issues.get('ME-4')?.sortOrder).toBe(0);

    const retry = await apply(undefined, moved);

    expect(retry['applied']).toMatchObject([{ kind: 'moveSlice', identifier: 'ME-4' }]);
    expect(retry).toMatchObject({ orderInPlace: true });
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

    const read = readDetails(
      await run(fake, context, { action: 'read', directory: created.directory }),
    );

    const writesBefore = fake.writes().length;
    const controller = new AbortController();

    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);

      if (fake.writes().length > writesBefore) {
        controller.abort();
      }

      return result;
    });

    const aborted = await tool.execute(
      'call',
      { action: 'apply', directory: created.directory, stateToken: read.stateToken },
      controller.signal,
      undefined,
      context,
    );

    expect(aborted.isError).toBe(true);
    expect(JSON.stringify(aborted.details)).toContain('aborted');

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
    const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));

    const tool = createSliceTool(async (command, commandArguments, options) => {
      const moved = fake.writes().length > writesBefore;

      if (moved && commandArguments[1]?.includes('children') === true) {
        return { code: 1, killed: false, stdout: '', stderr: 'network error' };
      }

      return fake.exec(command, commandArguments, options);
    });

    const failure = await tool.execute(
      'call',
      { action: 'apply', directory, stateToken: stateToken },
      undefined,
      undefined,
      context,
    );

    expect(failure.isError).toBe(true);

    const details = failureDetails(failure.details);

    expect(details.error).toContain('network error');
    expect(details.applied).toMatchObject([{ kind: 'moveSlice', identifier: 'ME-3' }]);
    expect(details.notApplied).toEqual([]);

    expect(fake.issues.get('ME-2')?.sortOrder).toBe(5);
    expect(fake.issues.get('ME-3')?.sortOrder).toBeGreaterThan(5);
    expect(fake.writes()).toHaveLength(writesBefore + 1);

    const retry = await apply(undefined, directory);

    expect(retry).toMatchObject({ status: 'unchanged', applied: [], orderInPlace: true });
    expect(fake.writes()).toHaveLength(writesBefore + 1);
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

    expect(result).toMatchObject({ orderInPlace: false });
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

    const failure = await apply();
    const message = failureDetails(failure).error;

    expect(message).toContain('more than one Linear page');
    expect(message).toContain('Applied:');
    expect(message).not.toContain('Nothing was written');
    expect(fake.writes()).not.toEqual([]);
  });
});
