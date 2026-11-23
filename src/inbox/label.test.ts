import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { holdFileLock } from '../fileLock/fileLock.js';
import { advertiseLabel, withdrawLabel } from './label.js';
import type { LabelOptions } from './label.js';
import { formatInboxLabel } from './protocol.js';

const lockWaitMilliseconds = 50;

const labelCalls = (hc: HcFake): number =>
  hc.calls.filter((call) => call.commandArguments[0] === 'label').length;

const labelOptions = (hc: HcFake, directory: string, terminal: string, path: string) => ({
  hc: { exec: hc.exec, connect: hc.connect, cwd: directory },
  terminal,
  directory,
  path,
});

const table: { name: string; write: (options: LabelOptions) => Promise<void> }[] = [
  { name: 'advertiseLabel', write: (options) => advertiseLabel(options) },
  { name: 'withdrawLabel', write: (options) => withdrawLabel(options) },
];

it('waits for another holder of the terminal label lock before it writes', async ({
  onTestFinished: cleanup,
}) => {
  const directory = temporaryDirectory(cleanup, 'tau-label-lock-');
  const terminal = 't-label-lock';
  const path = join(directory, 'session-label-lock.sock');
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

    const held = await holdFileLock({ lockPath, checkout: lockPath, terminal });

    if (held.kind !== 'held') {
      throw new Error('The test did not hold the terminal label lock.');
    }

    const call = row.write(labelOptions(hc, directory, terminal, path));

    try {
      await new Promise((resolve) => {
        setTimeout(resolve, lockWaitMilliseconds);
      });

      expect(labelCalls(hc), row.name).toBe(0);
    } finally {
      await held.release();
    }

    await call;

    expect(labelCalls(hc), row.name).toBe(1);
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
