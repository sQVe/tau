import { expect, it } from 'vitest';

import { createHcFake } from '../../../../tests/hcFake.js';
import type { HcFake } from '../../../../tests/hcFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { contextOf, recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { readAskRecords } from '../record.js';
import { createArchitectTool } from '../tool.js';

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

it('releases its claim when the ask terminal cannot start', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);
  hc.fail('run', 'hc run failed', 1);

  await expect(ask(hc, root)).rejects.toThrow(/failed/u);

  expect(await statuses(root)).toEqual(['failed']);
  expect(await details(root)).toEqual(['The ask terminal could not be started.']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('releases its claim when the wait is cancelled', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      throw new Error('The operation was cancelled.');
    }

    return hc.exec(command, commandArguments, options);
  };

  await expect(ask({ ...hc, exec }, root)).rejects.toThrow(/cancelled/u);

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('releases its claim when the architect ends before it takes the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

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

  await expect(ask(hc, root)).resolves.toMatchObject({ details: { status: 'needsOpen' } });

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('releases its claim when the ask reaches its deadline', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({ terminal: 't-ask', ended: false, reason: 'timeout', turn: 0, children: [] }),
  );

  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'finished' }));

  await expect(ask(hc, root)).resolves.toMatchObject({ details: { status: 'needsOpen' } });

  expect(await statuses(root)).toEqual(['timeout']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
