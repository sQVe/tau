import { expect, it, vi } from 'vitest';

import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { appCommands, open, openRequest, openTool } from '../fixtures/openHarness.js';
import { contextOf, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { readAskRecords } from '../record.js';
import { createArchitectTool } from '../tool.js';

const startingReason = 'The architect is starting. Ask again shortly.';

const runCalls = (calls: { commandArguments: string[] }[]): number =>
  calls.filter((call) => call.commandArguments[0] === 'run').length;

it('an open and an ask started together start one architect', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, hc, tool } = openTool(root);

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  const opening = open(tool, root, { request: openRequest });

  await vi.waitFor(() => {
    expect(appCommands(app)).toContain('pane.split');
  });

  const asked = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(asked.details).toMatchObject({
    action: 'ask',
    status: 'needsOpen',
    reason: startingReason,
  });

  expect(await readAskRecords(root)).toEqual({ records: [], gaps: [] });
  expect(runCalls(hc.calls)).toBe(0);

  const starts = appCommands(app).filter((name) => name !== 'ls');

  expect(starts).toEqual(['pane.split']);

  await expect(opening).resolves.toMatchObject({ details: { status: 'resumed' } });
});

it('an ask and an open started together start one architect', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, hc, tool } = openTool(root);
  const waitEntered = Promise.withResolvers<undefined>();
  const waitRelease = Promise.withResolvers<undefined>();

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({
      terminal: 't-ask',
      ended: true,
      reason: 'ended',
      turn: 1,
      children: [],
      exit_code: 0,
    }),
  );

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waitEntered.resolve(undefined);
      await waitRelease.promise;
    }

    return hc.exec(command, commandArguments, options);
  };

  const asking = createArchitectTool({ ...hc, exec, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  await waitEntered.promise;

  const failure = await open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toBe(
    `The architect in ${root} has not recorded its terminal yet. Call architect open again shortly.`,
  );

  expect(app.calls).toEqual([]);
  expect(runCalls(hc.calls)).toBe(1);
  expect((await readAskRecords(root)).records).toHaveLength(1);

  waitRelease.resolve(undefined);

  await expect(asking).resolves.toMatchObject({ details: { action: 'ask', status: 'needsOpen' } });
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
