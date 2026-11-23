import { expect, it, vi } from 'vitest';

import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { appCommands, openRequest, openTool } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { openArchitect, openKeptClaimMessage } from './open.js';
import type { OpenRequest } from './open.js';

const requestFor = (
  root: string,
  location: OpenRequest['location'],
  hc: OpenRequest['hc'],
): OpenRequest => ({
  root,
  leadTerminal: 't-lead',
  request: openRequest,
  location,
  ui: { notify: vi.fn<() => void>() },
  hc,
});

const endedWait = (terminal: string, ended: boolean): string => {
  const reason = ended ? 'ended' : 'timeout';
  const exitCode = ended ? 0 : null;

  return JSON.stringify({ terminal, ended, reason, turn: 1, children: [], exit_code: exitCode });
};

it('an abort during the poll stops the terminal, releases the claim, and rejects', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the poll');

  await recordSession(root);
  hc.reply('kill', JSON.stringify({ address: 't-architect', state: 'finished' }));
  hc.reply('wait', endedWait('t-architect', true));

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(appCommands(app)).toContain('pane.split');
  });

  controller.abort(cancellation);

  const failure = await opening;

  expect(failure).toBe(cancellation);

  const kills = hc.calls
    .filter((call) => call.commandArguments[0] === 'kill')
    .map((call) => call.commandArguments);

  expect(kills).toEqual([['kill', '--json', '--', 't-architect']]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an abort during the poll keeps the claim and throws the kept-claim message when the terminal does not end', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();

  await recordSession(root);
  hc.reply('kill', JSON.stringify({ address: 't-architect', state: 'finished' }));
  hc.reply('wait', endedWait('t-architect', false));

  const opening = openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(appCommands(app)).toContain('pane.split');
  });

  controller.abort(new Error('cancelled during the poll'));

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(openKeptClaimMessage(root));
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('an abort after the takeover rejects and leaves the architect running', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const controller = new AbortController();

  const { app, hc, runtime } = openTool(root, undefined, undefined, {
    afterTakeover: () => {
      controller.abort(new Error('cancelled after the takeover'));
    },
  });

  await recordSession(root);

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(appCommands(app)).toContain('pane.split');
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);

  expect(await readLiveLockHolder(architectLockPath(root))).toMatchObject({
    terminal: 't-architect',
  });
});

it('an abort after preparation starts no launch and releases the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled before dispatch');

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    const result = await runtime.exec(command, commandArguments, options);

    if (command === 'herdr-app' && commandArguments[0] === 'ls') {
      controller.abort(cancellation);
    }

    return result;
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(appCommands(app)).toEqual(['ls']);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
