import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { installCommandShim } from '../../../../tests/commandShimFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { launchPiSession } from '../../../piStart/piStart.js';
import { quoteShellArgument } from '../../../shell/shell.js';
import { appCommands, openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect } from './open.js';

vi.mock(import('../../../piStart/piStart.js'), { spy: true });

// The checkout probe is the only launch step that runs before the terminal starts, so it is where a
// cancellation can arrive without a terminal to report. The shim keeps the probe in flight until the
// test aborts, so the abort cannot land before or after it.
it('reports a launch failure that races with an abort instead of the cancellation', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime, app } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the checkout probe');
  const signalDirectory = temporaryDirectory(cleanup, 'tau-open-failure-');
  const started = join(signalDirectory, 'probe-started');
  const release = join(signalDirectory, 'probe-release');

  await installCommandShim('git', {
    otherCalls: 'real',
    overrides: [
      {
        match: ' rev-parse --git-dir',
        script: `touch ${quoteShellArgument(started)}\nwhile [ ! -e ${quoteShellArgument(release)} ]; do sleep 0.01; done\nexit 1`,
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

  controller.abort(cancellation);
  writeFileSync(release, '');

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('start folder is not a Git checkout');
  expect((failure as Error).message).not.toContain('cancelled');
  expect(appCommands(app)).not.toContain('pane.split');
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('reports a non-Error launch failure that races with an abort', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, { space: undefined }, undefined, { takeover: false });
  const controller = new AbortController();

  await recordSession(root);

  const thrown: unknown = 'herdr-app refused the launch';

  vi.mocked(launchPiSession).mockImplementationOnce(async () => {
    controller.abort(new Error('cancelled during the launch'));

    throw thrown;
  });

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('herdr-app refused the launch');
});

it('reports a launch result failure that races with an abort', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, { space: undefined }, undefined, { takeover: false });
  const controller = new AbortController();
  const launchError = new Error('herdr-app do failed: exit code 1');

  await recordSession(root);

  vi.mocked(launchPiSession).mockImplementationOnce(async () => {
    controller.abort(new Error('cancelled during the launch'));

    return {
      exitCode: 1,
      killed: false,
      timedOut: false,
      aborted: false,
      reply: undefined,
      terminal: undefined,
      model: undefined,
      error: launchError,
    };
  });

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBe(launchError);
});

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
