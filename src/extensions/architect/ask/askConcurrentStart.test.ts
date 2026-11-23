import { readdir } from 'node:fs/promises';

import { expect, it } from 'vitest';

import { createHcFake } from '../../../../tests/hcFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { contextOf, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { askRecordDirectory } from '../record.js';
import { createArchitectTool } from '../tool.js';

const startingReason = 'The architect is starting. Ask again shortly.';

it('two asks started together start one hidden architect', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const waitEntered = Promise.withResolvers<undefined>();
  const waitRelease = Promise.withResolvers<undefined>();
  let waits = 0;

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

  // The first ask terminal is not visible yet, so the running-ask check cannot see it.
  hc.failGet('t-ask', 'no such terminal');

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        waitEntered.resolve(undefined);
        await waitRelease.promise;
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  const tool = createArchitectTool({ ...hc, exec, cwd: root });
  const context = contextOf(root);

  const first = tool.execute(
    'call',
    { action: 'ask', question: 'First question?' },
    undefined,
    undefined,
    context,
  );

  await waitEntered.promise;

  const second = await tool.execute(
    'call',
    { action: 'ask', question: 'Second question?' },
    undefined,
    undefined,
    context,
  );

  const runCalls = hc.calls.filter((call) => call.commandArguments[0] === 'run');

  expect(runCalls).toHaveLength(1);

  expect(second.details).toMatchObject({
    action: 'ask',
    status: 'needsOpen',
    reason: startingReason,
  });

  const askFiles = await readdir(askRecordDirectory(root));

  expect(askFiles).toHaveLength(1);

  waitRelease.resolve(undefined);

  await expect(first).resolves.toMatchObject({ details: { action: 'ask', status: 'needsOpen' } });
});

it('the hidden ask passes its claim to the started Pi', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const claimToken = Promise.withResolvers<string>();

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
    if (command === 'hc' && commandArguments[0] === 'run') {
      const holder = await readLiveLockHolder(architectLockPath(root));

      claimToken.resolve(holder?.token ?? '');
    }

    return hc.exec(command, commandArguments, options);
  };

  const tool = createArchitectTool({ ...hc, exec, cwd: root });

  await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  const token = await claimToken.promise;
  const run = hc.calls.find((call) => call.commandArguments[0] === 'run');
  const argv = run?.commandArguments ?? [];

  expect(token).toMatch(/^[0-9a-f-]{36}$/u);
  expect(argv).toContain('--bg');
  expect(argv).toContain('--no-parent');
  expect(argv).toContain('--no-notify');
  expect(argv).toContain('TAU_ROLE=architect');
  expect(argv).toContain('TAU_LEAD_TERMINAL=t-lead');
  expect(argv).toContain(`TAU_ARCHITECT_CLAIM=${token}`);
  expect(argv.some((entry) => entry.startsWith('TAU_ARCHITECT_ASK='))).toBe(true);
  expect(argv.some((entry) => entry.startsWith('tau.architect.ask='))).toBe(true);
  expect(argv).toContain('--session');
});
