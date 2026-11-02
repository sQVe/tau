import { cp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  failureDetails,
  outsideDirectory,
  readDetails,
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
  const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));
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
    { action: 'apply', directory, stateToken: stateToken },
    undefined,
    undefined,
    context,
  );
};

describe('slice tool apply', () => {
  it('retries after a partial failure by creating only the missing slices', async () => {
    const { fake, directory, apply } = await setUp();

    // Writes: container, slice 1, slice 2.
    fake.failWrite(3);

    const moved = join(directory, '..', 'me-1');

    expect((await apply())['status']).toBe('failed');

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

  it('refuses to create a container again after a create whose output was lost', async () => {
    const { fake, context, directory, apply } = await setUp();
    const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));

    // Linear creates the container, but the call fails as if the output were lost.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);
      const created = commandArguments[1]?.includes('issueCreate') === true;

      return created ? { code: 1, killed: false, stdout: '', stderr: 'timeout' } : result;
    });

    const failure = await tool.execute(
      'call',
      { action: 'apply', directory, stateToken: stateToken },
      undefined,
      undefined,
      context,
    );

    expect(failure.isError).toBe(true);
    expect(failureDetails(failure.details).error).toContain('timeout');

    expect(await savedPlan(directory)).toMatchObject({
      container: { identifier: null },
      slices: [{ identifier: null }, { identifier: null }],
    });

    await expect(stat(join(directory, '..', 'me-1'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(apply(undefined, directory)).rejects.toThrow(/no container identifier, but ME-1/);
    expect([...fake.issues.keys()]).toEqual(['ME-1']);
    expect(await savedPlan(directory)).toMatchObject({ container: { identifier: null } });
  });

  it('stops before the next step when the call is aborted', async () => {
    const { fake, context, directory } = await setUp();
    const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));
    const controller = new AbortController();

    // Aborts once Linear creates the container.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);

      if (commandArguments[1]?.includes('issueCreate') === true) {
        controller.abort();
      }

      return result;
    });

    const aborted = await tool.execute(
      'call',
      { action: 'apply', directory, stateToken: stateToken },
      controller.signal,
      undefined,
      context,
    );

    expect(aborted.isError).toBe(true);
    expect(JSON.stringify(aborted.details)).toContain('aborted');

    expect(fake.writes()).toHaveLength(1);

    expect(await savedPlan(directory)).toMatchObject({
      slices: [{ identifier: null }, { identifier: null }],
    });

    await expect(stat(join(directory, '..', 'me-1'))).rejects.toMatchObject({ code: 'ENOENT' });

    expect([...fake.issues.keys()]).toEqual(['ME-1']);
    expect(await savedPlan(directory)).toMatchObject({ container: { identifier: 'ME-1' } });
  });

  it('finishes the draft move on a retry after the move fails', async () => {
    const { fake, directory, apply } = await setUp();
    const target = join(directory, '..', 'me-1');

    await mkdir(target);
    await writeFile(join(target, 'blocker.txt'), 'in the way\n');

    expect((await apply())['status']).toBe('failed');

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
    const { stateToken } = readDetails(await run(fake, context, { action: 'read', directory }));

    // Replaces plan.json with a directory once Linear creates the container, so the save fails.
    const tool = createSliceTool(async (command, commandArguments, options) => {
      const result = await fake.exec(command, commandArguments, options);

      if (commandArguments[1]?.includes('issueCreate') === true) {
        await rm(planFile);
        await mkdir(planFile);
      }

      return result;
    });

    const result = await tool.execute(
      'call',
      { action: 'apply', directory, stateToken: stateToken },
      undefined,
      undefined,
      context,
    );

    expect(result.isError).toBe(true);

    const details = failureDetails(result.details);

    expect(details.directory).toBe(directory);

    expect(details.created).toEqual({
      identifier: 'ME-1',
      url: 'https://linear.app/me/issue/ME-1',
    });

    expect(details.notApplied[0]?.text).toContain('ME-1');
    expect(fake.issues.get('ME-1')).toMatchObject({ parent: null, title: 'Add PR-sized planning' });
    expect(fake.writes()).toHaveLength(1);

    const planFileState = await stat(planFile);

    expect(planFileState.isDirectory()).toBe(true);
    await expect(stat(join(directory, '..', 'me-1'))).rejects.toMatchObject({ code: 'ENOENT' });

    expect([...fake.issues.keys()]).toEqual(['ME-1']);
  });
});
