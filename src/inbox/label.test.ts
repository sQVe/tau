import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../command.js';
import { withFileLock } from '../fileLock/fileLock.js';
import { inboxLock } from './endpoint.js';
import { advertiseLabel, withdrawLabel } from './label.js';
import type { LabelOptions } from './label.js';
import { formatInboxLabel } from './protocol.js';

const labelCalls = (hc: HcFake): number =>
  hc.calls.filter((call) => call.commandArguments[0] === 'label').length;

const labelOptions = (hc: HcFake, directory: string, terminal: string, path: string) => ({
  hc: { exec: hc.exec, connect: hc.connect, cwd: directory },
  terminal,
  directory,
  path,
});

const table: {
  name: string;
  gateOn: string;
  write: (options: LabelOptions) => Promise<void>;
  expectedCalls: string[];
}[] = [
  {
    name: 'advertiseLabel',
    gateOn: 'label',
    write: (options) => advertiseLabel(options),
    expectedCalls: ['label'],
  },
  {
    name: 'withdrawLabel',
    gateOn: 'get',
    write: (options) => withdrawLabel(options),
    expectedCalls: ['get', 'label'],
  },
];

it('holds the terminal label lock across its hc calls', async ({ onTestFinished: cleanup }) => {
  const directory = temporaryDirectory(cleanup, 'tau-label-hold-');
  const terminal = 't-label-hold';
  const path = join(directory, 'session-label-hold.sock');
  const lockPath = join(directory, `${encodeURIComponent(terminal)}.label.lock`);

  const snapshot = JSON.stringify({
    address: terminal,
    state: 'live',
    labels: { 'tau.inbox': formatInboxLabel(path) },
  });

  for (const row of table) {
    const hc = createHcFake();

    hc.replyGet(terminal, snapshot);
    hc.reply('label', JSON.stringify({ address: terminal, state: 'live' }));

    const entered = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const waited = Promise.withResolvers<undefined>();
    const seen: string[] = [];
    let waitedForLock = false;
    let contenderSaw: string[] | undefined;

    const exec: Exec = async (command, commandArguments, options) => {
      const subcommand = commandArguments[0];

      if (subcommand !== undefined) {
        seen.push(subcommand);
      }

      if (subcommand === row.gateOn) {
        entered.resolve(undefined);
        await gate.promise;
      }

      return hc.exec(command, commandArguments, options);
    };

    const write = row.write(labelOptions({ ...hc, exec }, directory, terminal, path));

    await entered.promise;

    const contender = withFileLock(
      {
        ...inboxLock(lockPath),
        onWaiting: () => {
          waitedForLock = true;
          waited.resolve(undefined);
        },
      },
      () => {
        contenderSaw = [...seen];

        return Promise.resolve();
      },
    );

    await waited.promise;
    gate.resolve(undefined);
    await Promise.all([write, contender]);

    expect(waitedForLock, row.name).toBe(true);
    expect(contenderSaw, row.name).toEqual(row.expectedCalls);
  }
});

it('leaves the terminal unchanged when its snapshot has no labels', async ({
  onTestFinished: cleanup,
}) => {
  const directory = temporaryDirectory(cleanup, 'tau-label-snapshot-');
  const terminal = 't-label-snapshot';
  const hc = createHcFake();

  hc.replyGet(terminal, JSON.stringify({ address: terminal, state: 'live' }));

  await withdrawLabel(
    labelOptions(hc, directory, terminal, join(directory, 'session-label-snapshot.sock')),
  );

  expect(labelCalls(hc)).toBe(0);
});
