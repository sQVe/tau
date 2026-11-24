import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { fakeStartProcessId, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { launchTimeoutMilliseconds } from '../../../piStart/piStart.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { readAskRecords } from '../record.js';
import { createStartTicket } from '../startTicket/startTicket.js';
import { askArchitect } from './ask.js';
import type { AskRequest } from './ask.js';
import { ask, endedWait, startFake } from './fixtures/askHarness.js';

const leadPid = 9000;

it('an abort before dispatch cancels its ticket and releases the claim', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const hc = startFake();
  const controller = new AbortController();
  const cancellation = new Error('cancelled before dispatch');

  await recordSession(root);

  const request: AskRequest = {
    root,
    question: 'Which flag name?',
    gateRecord: null,
    leadTerminal: 't-lead',
    leadSessionId: 'session-lead',
    listenerPath: undefined,
    location: config.location,
    ui: { notify: vi.fn<() => void>() },
    hc: { ...hc, cwd: root, signal: controller.signal },
    liveAsk: () => Promise.reject(new Error('unexpected live ask')),
  };

  const failure = await askArchitect(request, {
    beforeDispatch: () => {
      controller.abort(cancellation);

      return Promise.resolve();
    },
  }).catch((error: unknown) => error);

  expect(failure).toBe(cancellation);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await readdir(join(root, '.tau', 'architect', 'start'))).toEqual([]);
});

it('deletes an orphaned marker whose process is gone and starts', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const ticket = await createStartTicket(root, 'gone', leadPid);
  const marker = `${ticket}.started.${fakeStartProcessId}`;

  useFakeStartProcess(cleanup, 'gone');
  hc.reply('wait', endedWait('t-ask', true));
  await writeFile(marker, '');
  await recordSession(root);

  const result = await ask(hc, root);

  expect(result).toMatchObject({ details: { status: 'needsOpen' } });
  expect(existsSync(marker)).toBe(false);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toHaveLength(1);
});

it('refuses an orphaned marker whose process runs and names the process id', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const ticket = await createStartTicket(root, 'gone', leadPid);
  const marker = `${ticket}.started.${fakeStartProcessId}`;

  useFakeStartProcess(cleanup, 'running');
  await writeFile(marker, '');
  await recordSession(root);

  const result = await ask(hc, root);

  expect(result).toMatchObject({ details: { status: 'needsOpen' } });
  expect((result.details as { reason: string }).reason).toContain(String(fakeStartProcessId));
  expect(existsSync(marker)).toBe(true);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('refuses an adopted marker whose child runs and whose lead is gone', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const ticket = await createStartTicket(root, 'gone', leadPid);
  const marker = `${ticket}.adopted.${fakeStartProcessId}`;

  useFakeStartProcess(cleanup, 'running');
  await writeFile(marker, '');
  await recordSession(root);

  const result = await ask(hc, root);

  expect(result).toMatchObject({ details: { status: 'needsOpen' } });
  expect((result.details as { reason: string }).reason).toContain(String(fakeStartProcessId));
  expect(existsSync(marker)).toBe(true);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect((await readAskRecords(root)).records).toEqual([]);
});

it('refuses a malformed orphaned marker and names the path', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  const ticket = await createStartTicket(root, 'gone', leadPid);
  const marker = `${ticket}.started`;

  await writeFile(marker, '');
  await recordSession(root);

  const result = await ask(hc, root);

  expect(result).toMatchObject({ details: { status: 'needsOpen' } });
  expect((result.details as { reason: string }).reason).toContain(marker);
  expect(existsSync(marker)).toBe(true);
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('bounds the hidden launch with the launch timeout', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = startFake();
  let timeout: number | undefined;

  hc.reply('wait', endedWait('t-ask', true));
  await recordSession(root);

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'run') {
      timeout = options?.timeout;
    }

    return hc.exec(command, commandArguments, options);
  };

  await ask({ ...hc, exec }, root);

  expect(timeout).toBe(launchTimeoutMilliseconds);
});
