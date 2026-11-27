import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { installCommandShim } from '../../../../tests/commandShimFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { quoteShellArgument } from '../../../shell/shell.js';
import { appCommands, openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect } from './open.js';

// The checkout probe is the only launch step that runs before the terminal starts, so it is where a
// cancellation can arrive without a terminal to report. The shim keeps the probe in flight until the
// test aborts, so the abort cannot land before or after it.
it('reports the caller cancellation when an abort lands during the launch checkout probe', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime, app } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const reason = 'cancelled during the checkout probe';
  const signalDirectory = temporaryDirectory(cleanup, 'tau-open-cancel-');
  const started = join(signalDirectory, 'probe-started');
  const release = join(signalDirectory, 'probe-release');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [
      {
        match: ' rev-parse --git-dir',
        script: `touch ${quoteShellArgument(started)}\nwhile [ ! -e ${quoteShellArgument(release)} ]; do sleep 0.01; done`,
      },
    ],
  });

  await recordSession(root);

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  try {
    await vi.waitFor(
      () => {
        expect(existsSync(started)).toBe(true);
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    writeFileSync(release, '');

    throw error;
  }

  controller.abort(reason);
  writeFileSync(release, '');

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('The open was cancelled.');
  expect((failure as Error).cause).toBe(reason);
  expect(appCommands(app)).not.toContain('pane.split');
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
