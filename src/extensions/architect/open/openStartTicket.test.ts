import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import { expect, it, vi } from 'vitest';

import { argumentAfter } from '../../../../tests/execFake.js';
import {
  fakeStartProcessId,
  runLaunchArgv,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
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

const startedMarker = async (root: string, token: string, processId: number): Promise<string> => {
  const ticket = await createStartTicket(root, token);
  const marker = `${ticket}.started.${processId}`;

  await writeFile(marker, '');

  return marker;
};

const adoptedMarker = async (root: string, token: string, processId: number): Promise<string> => {
  const ticket = await createStartTicket(root, token);
  const marker = `${ticket}.adopted.${processId}`;

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

it('starts and leaves an adopted marker whose process runs', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);

  useFakeStartProcess(cleanup, 'running');
  await recordSession(root);
  const marker = await adoptedMarker(root, 'gone', fakeStartProcessId);

  const result = await openArchitect(requestFor(root, config.location, runtime));

  expect(result).toMatchObject({ status: 'resumed' });
  expect(existsSync(marker)).toBe(true);
});

it('deletes an adopted marker whose process is gone and then starts', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root);

  useFakeStartProcess(cleanup, 'gone');
  await recordSession(root);
  const marker = await adoptedMarker(root, 'gone', fakeStartProcessId);

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
