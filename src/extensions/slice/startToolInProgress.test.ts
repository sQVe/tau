import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { confirmContext, noUiContext } from '../../../tests/toolContext.js';
import { readStartSlice } from './startLinear.js';
import { createStartSliceTool } from './startTool.js';
import { createSliceTool } from './tool.js';

const setUp = async (foreign = false) => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createLinearFake();

  const slice = fake.addIssue({
    identifier: 'ME-700',
    title: 'Slice',
    state: { name: 'Todo', type: 'unstarted' },
    creatorId: foreign ? 'other' : 'user-viewer',
  });

  const context = noUiContext(root);

  const prepared = await createSliceTool(fake.exec).execute(
    'prepare',
    { action: 'prepare', id: 'me-700' },
    undefined,
    undefined,
    context,
  );

  const { directory } = prepared.details;

  await writeFile(
    join(directory, 'start.json'),
    JSON.stringify({
      version: 1,
      slice: 'ME-700',
      branch: 'me-700',
      base: 'origin/main',
      tickets: [],
    }),
  );

  const tool = createStartSliceTool(fake.exec);

  const read = async () => {
    const result = await tool.execute(
      'read',
      { action: 'read', directory, agentTeam: 'AI' },
      undefined,
      undefined,
      context,
    );

    if (!('stateToken' in result.details)) {
      throw new Error('Expected read');
    }

    return result.details;
  };

  const apply = async (stateToken: string, useContext = context) =>
    tool.execute(
      'apply',
      { action: 'apply', directory, agentTeam: 'AI', stateToken },
      undefined,
      undefined,
      useContext,
    );

  return { root, fake, slice, read, apply };
};

it('moves Todo to In Progress and omits the move on the next read', async () => {
  const { root, fake, read, apply } = await setUp();
  const before = await read();
  expect(before.writes).toMatchObject([{ kind: 'moveToInProgress', identifier: 'ME-700' }]);
  expect(fake.writes()).toEqual([]);
  expect((await apply(before.stateToken)).details).toMatchObject({ status: 'applied' });
  expect(await readStartSlice(fake.exec, root, 'ME-700')).toMatchObject({ state: 'In Progress' });
  expect((await read()).writes).toEqual([]);
  expect(fake.writes()).toHaveLength(1);
});

it.each([true, false])('confirms a foreign slice move with answer %s', async (answer) => {
  const { root, fake, slice, read, apply } = await setUp(true);
  const messages: string[] = [];

  const context = confirmContext(root, async (_title, message) => {
    messages.push(message);

    return answer;
  });

  const result = await apply((await read()).stateToken, context);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('Todo');
  expect(messages[0]).toContain('In Progress');
  expect(result.details).toMatchObject({ status: answer ? 'applied' : 'declined' });
  expect(slice.state.name).toBe(answer ? 'In Progress' : 'Todo');
  expect(fake.writes()).toHaveLength(answer ? 1 : 0);
});

it.each(['no UI', 'worker'])('refuses a foreign move with %s', async (mode) => {
  const { root, fake, slice, read, apply } = await setUp(true);
  const context = mode === 'no UI' ? noUiContext(root) : confirmContext(root, async () => true);

  if (mode === 'worker') {
    vi.stubEnv('TAU_ROLE', 'worker');

    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
  }

  await expect(apply((await read()).stateToken, context)).rejects.toThrow('Nothing was written');
  expect(slice.state.name).toBe('Todo');
  expect(fake.writes()).toEqual([]);
});

it('rejects a state change while the user answers', async () => {
  const { root, fake, slice, read, apply } = await setUp(true);

  const context = confirmContext(root, async () => {
    slice.state = { name: 'In Review', type: 'started' };

    return true;
  });

  await expect(apply((await read()).stateToken, context)).rejects.toThrow(
    'changed while you answered',
  );

  expect(slice.state.name).toBe('In Review');
  expect(fake.writes()).toEqual([]);
});

it('reports a failed move without applying later writes', async () => {
  const { fake, slice, read, apply } = await setUp();
  fake.failCall('issue update', 'Team has no In Progress state');
  const result = await apply((await read()).stateToken);
  expect(result.isError).toBe(true);

  expect(result.details).toMatchObject({
    applied: [],
    notApplied: [expect.stringContaining('In Progress')],
  });

  expect(JSON.stringify(result)).toContain('Team has no In Progress state');
  expect(slice.state.name).toBe('Todo');
});
