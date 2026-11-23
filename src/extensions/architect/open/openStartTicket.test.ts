import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { expect, it, vi } from 'vitest';

import { argumentAfter, succeededResult } from '../../../../tests/execFake.js';
import {
  fakeStartProcessId,
  runLaunchArgv,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { holdFileLock, readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { appCommands, openRequest, openTool } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { createStartTicket } from '../startTicket/startTicket.js';
import { openArchitect } from './open.js';
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

const endedWait = (terminal: string): string =>
  JSON.stringify({
    terminal,
    ended: true,
    reason: 'ended',
    turn: 1,
    children: [],
    exit_code: 0,
  });

const claimTerminal = (address: string, token: string, state = 'live'): string =>
  JSON.stringify({
    address,
    state,
    argv: ['env', `TAU_ARCHITECT_CLAIM=${token}`, 'pi'],
  });

const startedMarker = async (root: string, token: string, processId: number): Promise<string> => {
  const ticket = await createStartTicket(root, token);
  const marker = `${ticket}.started.${processId}`;

  await writeFile(marker, '');

  return marker;
};

it('never runs Pi when the server creates the terminal after the caller gave up', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const lateArgv = Promise.withResolvers<string[]>();
  let splits = 0;

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split' && splits === 0) {
      splits += 1;

      lateArgv.resolve(JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[]);

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    return runtime.exec(command, commandArguments, options);
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'ls')).toEqual([]);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();

  const late = await lateArgv.promise;
  const exitCode = await runLaunchArgv(late, root);

  expect(exitCode).toBe(75);

  const retry = openTool(root);
  const result = await openArchitect(requestFor(root, config.location, retry.runtime));

  expect(result).toMatchObject({ status: 'resumed' });
  const retrySplits = appCommands(retry.app).filter((name) => name === 'pane.split');

  expect(retrySplits).toHaveLength(1);
});

it('cancels a gone claim ticket and then starts', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);
  const gone = await createStartTicket(root, 'gone');

  await recordSession(root);

  const result = await openArchitect(requestFor(root, config.location, runtime));

  expect(result).toMatchObject({ status: 'resumed' });
  expect(existsSync(gone)).toBe(false);
});

it('refuses while a started marker names a running process and releases its claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);
  const marker = await startedMarker(root, 'gone', fakeStartProcessId);

  const failure = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(String(fakeStartProcessId));
  expect(existsSync(marker)).toBe(true);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('deletes a started marker whose process is gone and then starts', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);

  useFakeStartProcess(cleanup, 'gone');
  await recordSession(root);
  const marker = await startedMarker(root, 'gone', fakeStartProcessId);

  const result = await openArchitect(requestFor(root, config.location, runtime));

  expect(result).toMatchObject({ status: 'resumed' });
  expect(existsSync(marker)).toBe(false);
});

it('refuses a malformed marker name and names its path', async ({ onTestFinished: cleanup }) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);
  const ticket = await createStartTicket(root, 'gone');
  const marker = `${ticket}.started`;

  await writeFile(marker, '');
  await recordSession(root);

  const failure = await openArchitect(requestFor(root, config.location, runtime)).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(marker);
  expect(existsSync(marker)).toBe(true);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('rejects a cancel in the recovered path after the child took over and does not kill it', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { hc, runtime, terminals } = openTool(root, undefined, undefined, { takeover: false });
  const controller = new AbortController();
  const cancellation = new Error('cancelled after the child took over');
  const adopted = Promise.withResolvers<string>();

  await recordSession(root);

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const holder = await readLiveLockHolder(architectLockPath(root));
      const token = holder?.token ?? '';
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      const adoptedToken = randomUUID();

      const held = await holdFileLock({
        lockPath: architectLockPath(root),
        checkout: root,
        terminal: 't-architect',
        token: adoptedToken,
        adopt: token,
      });

      if (held.kind === 'held') {
        cleanup(held.release);
        adopted.resolve(adoptedToken);
      }

      hc.reply('ls', JSON.stringify({ terminals: [{ address: 't-architect', state: 'live' }] }));
      terminals.set('t-architect', succeededResult(claimTerminal('t-architect', token)));

      controller.abort(cancellation);

      return { code: 0, killed: true, truncated: false, stdout: '', stderr: '' };
    }

    return runtime.exec(command, commandArguments, options);
  };

  const failure = await openArchitect(
    requestFor(root, config.location, { ...runtime, exec, signal: controller.signal }),
  ).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);

  const holder = await readLiveLockHolder(architectLockPath(root));

  expect(holder?.token).toBe(await adopted.promise);
});

it('keeps a successful result when a split adopts the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { hc, runtime } = openTool(root, undefined, undefined, { takeover: false });
  const sessionFile = await recordSession(root);

  hc.reply('kill', JSON.stringify({ address: 't-architect', state: 'finished' }));
  hc.reply('wait', endedWait('t-architect'));

  const exec: typeof runtime.exec = async (command, commandArguments, options) => {
    if (command === 'herdr-app' && commandArguments[1] === 'pane.split') {
      const holder = await readLiveLockHolder(architectLockPath(root));
      const argv = JSON.parse(argumentAfter(commandArguments, '--argv') ?? '[]') as string[];

      await takeStartTicket(argv);

      const held = await holdFileLock({
        lockPath: architectLockPath(root),
        checkout: root,
        terminal: 't-architect',
        token: randomUUID(),
        adopt: holder?.token ?? '',
      });

      if (held.kind === 'held') {
        cleanup(held.release);
      }

      return succeededResult('{"pane":"p-architect","terminal":"t-architect"}');
    }

    return runtime.exec(command, commandArguments, options);
  };

  const result = await openArchitect(requestFor(root, config.location, { ...runtime, exec }));

  expect(result).toEqual({ status: 'resumed', sessionFile });
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'kill')).toEqual([]);
});
