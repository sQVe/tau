import { expect, it, vi } from 'vitest';

import { appCommands, openRequest, openTool } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { openArchitect, startingError } from '../open/open.js';
import type { OpenRequest } from '../open/open.js';
import { readAskRecords } from '../record.js';
import { askArchitect, askStartingReason } from './ask.js';
import type { AskRequest } from './ask.js';

const barrier = (): (() => Promise<void>) => {
  let arrivals = 0;
  const bothArrived = Promise.withResolvers<undefined>();

  return async () => {
    arrivals += 1;

    if (arrivals === 2) {
      bothArrived.resolve(undefined);
    }

    await bothArrived.promise;
  };
};

const askRequest = (
  root: string,
  location: AskRequest['location'],
  hc: AskRequest['hc'],
): AskRequest => ({
  root,
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  listenerPath: undefined,
  location,
  ui: { notify: vi.fn<() => void>() },
  hc,
  liveAsk: () => Promise.reject(new Error('unexpected live ask')),
});

const openRequestFor = (
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

const launches = (calls: { commandArguments: string[] }[]): number =>
  calls.filter((call) => ['run', 'pane.split'].includes(call.commandArguments[0] ?? '')).length;

const runCalls = (calls: { commandArguments: string[] }[]): number =>
  calls.filter((call) => call.commandArguments[0] === 'run').length;

it('two asks started together start one hidden architect', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const { hc, runtime } = openTool(root);

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

  const shared = barrier();
  const waitEntered = Promise.withResolvers<undefined>();
  const waitRelease = Promise.withResolvers<undefined>();
  let waits = 0;

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

  const request = askRequest(root, config.location, { ...runtime, exec });
  const first = askArchitect(request, { beforeLink: shared });
  const second = askArchitect(request, { beforeLink: shared });

  const loser = await Promise.race([
    first.then((result) => result),
    second.then((result) => result),
  ]);

  await waitEntered.promise;
  waitRelease.resolve(undefined);

  const results = await Promise.all([first, second]);

  expect(loser).toMatchObject({ status: 'needsOpen', reason: askStartingReason });

  expect(runCalls(hc.calls)).toBe(1);
  expect(launches(hc.calls)).toBe(1);
  expect(results.filter((result) => result.status === 'needsOpen')).toHaveLength(2);

  expect(
    results.filter(
      (result) => result.status === 'needsOpen' && result.reason === askStartingReason,
    ),
  ).toHaveLength(1);

  expect((await readAskRecords(root)).records).toHaveLength(1);
});

it('an ask and an open started together start one architect', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { app, hc, runtime } = openTool(root);

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

  const shared = barrier();
  const askArrived = Promise.withResolvers<undefined>();
  const askLaunched = Promise.withResolvers<undefined>();
  const waitRelease = Promise.withResolvers<undefined>();
  let waits = 0;

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      waits += 1;

      if (waits === 1) {
        await waitRelease.promise;
      }
    }

    if (command === 'hc' && commandArguments[0] === 'run') {
      askLaunched.resolve(undefined);
    }

    return hc.exec(command, commandArguments, options);
  };

  const ask = askRequest(root, config.location, { ...runtime, exec });
  const open = openRequestFor(root, config.location, runtime);

  const askRun = askArchitect(ask, {
    beforeLink: async () => {
      askArrived.resolve(undefined);
      await shared();
    },
  });

  await askArrived.promise;

  const openRun = openArchitect(open, {
    beforeLink: async () => {
      await shared();
      await askLaunched.promise;
    },
  });

  const openFailure = await openRun.catch((error: unknown) => error);

  expect(openFailure).toBeInstanceOf(Error);
  expect((openFailure as Error).message).toBe(startingError(root).message);

  waitRelease.resolve(undefined);

  await expect(askRun).resolves.toMatchObject({ status: 'needsOpen' });

  const splits = appCommands(app).filter((name) => name === 'pane.split');

  expect(runCalls(hc.calls)).toBe(1);
  expect(splits).toHaveLength(0);
  expect((await readAskRecords(root)).records).toHaveLength(1);
});
