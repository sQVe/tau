import { expect, it } from 'vitest';

import { succeededResult } from '../../../../tests/execFake.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { contextOf, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { readAskRecords } from '../record.js';
import { createArchitectTool } from '../tool.js';
import { askKeptClaimMessage } from './ask.js';

const ask = (hc: HcFake, root: string) =>
  createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

const statuses = async (root: string): Promise<string[]> => {
  const { records } = await readAskRecords(root);

  return records.map((record) => record.status);
};

const details = async (root: string): Promise<(string | null)[]> => {
  const { records } = await readAskRecords(root);

  return records.map((record) => record.detail);
};

const endedWait = (terminal: string, ended: boolean): string => {
  const reason = ended ? 'ended' : 'timeout';
  const exitCode = ended ? 0 : null;

  return JSON.stringify({ terminal, ended, reason, turn: 1, children: [], exit_code: exitCode });
};

const startFake = (): HcFake => {
  const hc = createHcFake();

  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));
  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'finished' }));

  return hc;
};

const failFirstWait = (hc: HcFake, error: Error): HcFake => {
  let waits = 0;

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        throw error;
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  return { ...hc, exec };
};

it('releases its claim when the ask terminal cannot start', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);
  hc.fail('run', 'hc run failed', 1);

  await expect(ask(hc, root)).rejects.toThrow(/failed/u);

  expect(await statuses(root)).toEqual(['failed']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a cancelled wait stops the hidden terminal and fails its record before releasing', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  const cancelled = failFirstWait(hc, new Error('The operation was cancelled.'));

  await expect(ask(cancelled, root)).rejects.toThrow(/cancelled/u);

  const kills = hc.calls
    .filter((call) => call.commandArguments[0] === 'kill')
    .map((call) => call.commandArguments);

  expect(kills).toEqual([['kill', '--json', '--', 't-ask']]);
  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toMatch(/cancel/u);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a rejected wait stops the hidden terminal and fails its record before releasing', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  const rejected = failFirstWait(hc, new Error('The wait failed.'));

  await expect(ask(rejected, root)).rejects.toThrow(/failed/u);

  expect(await statuses(root)).toEqual(['failed']);
  expect((await details(root))[0]).toMatch(/failed/u);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps the record running and the claim live when a rejected wait terminal does not end', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', false));

  const rejected = failFirstWait(hc, new Error('The wait failed.'));

  await expect(ask(rejected, root)).rejects.toThrow(askKeptClaimMessage(root));

  expect(await statuses(root)).toEqual(['running']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('a timeout whose terminal does not end returns the kept-claim message and keeps the record running', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let waits = 0;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      return succeededResult(endedWait('t-ask', false));
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).resolves.toMatchObject({
    details: { status: 'needsOpen', reason: askKeptClaimMessage(root) },
  });

  expect(waits).toBe(2);
  expect(await statuses(root)).toEqual(['running']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('releases its claim when the architect ends before it takes the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();

  await recordSession(root);
  hc.reply('wait', endedWait('t-ask', true));

  await expect(ask(hc, root)).resolves.toMatchObject({ details: { status: 'needsOpen' } });

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('stops the hidden terminal at its deadline and releases after it ends', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let waits = 0;

  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      return succeededResult(endedWait('t-ask', waits > 1));
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).resolves.toMatchObject({
    details: { status: 'needsOpen' },
  });

  expect(waits).toBe(2);
  expect(await statuses(root)).toEqual(['timeout']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
