import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { LiveOwnerError, openEndpoint } from './endpoint.js';
import type { Endpoint } from './endpoint.js';
import { currentInboxPath, startInbox } from './inbox.js';
import { encodeFrame, formatInboxLabel, refusedReply } from './protocol.js';

const respondRefused = (): Promise<string> =>
  Promise.resolve(encodeFrame(refusedReply('Not used.')));

const connects = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection(path);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });

it('a stopped inbox reports no current path', async ({ onTestFinished: cleanup }) => {
  const directory = temporaryDirectory(cleanup, 'tau-current-inbox-');

  const listener = await startInbox({
    sessionId: 'session-current',
    terminal: 't-current',
    directory,
    accept: () => Promise.resolve(refusedReply('Not used.')),
    onQueued: () => undefined,
    advertise: () => Promise.resolve(),
    withdraw: () => Promise.resolve(),
  });

  cleanup(() => listener.stop());

  expect(currentInboxPath()).toBe(`${directory}/session-current.sock`);

  await listener.stop();

  expect(currentInboxPath()).toBeUndefined();
});

it('keeps the label of a same-path replacement that binds after the stopped inbox closes', async ({
  onTestFinished: cleanup,
}) => {
  const directory = temporaryDirectory(cleanup, 'tau-same-path-');
  const sessionId = 'session-same-path';
  const path = join(directory, `${sessionId}.sock`);
  const labelOfPath = formatInboxLabel(path);
  const attempts: ('bound' | 'refused')[] = [];
  let labelValue: string | undefined;
  let replacement: Endpoint | undefined;

  const replace = async (): Promise<void> => {
    try {
      replacement = await openEndpoint({ path, respond: respondRefused });

      attempts.push('bound');
      labelValue = labelOfPath;
    } catch (error) {
      if (!(error instanceof LiveOwnerError)) {
        throw error;
      }

      attempts.push('refused');
    }
  };

  const listener = await startInbox({
    sessionId,
    terminal: 't-same-path',
    directory,
    accept: () => Promise.resolve(refusedReply('Not used.')),
    onQueued: () => undefined,
    advertise: () => {
      labelValue = labelOfPath;

      return Promise.resolve();
    },
    withdraw: async () => {
      await replace();

      if (labelValue === labelOfPath) {
        labelValue = undefined;
      }
    },
  });

  cleanup(async () => {
    await listener.stop();
    await replacement?.close();
  });

  await listener.stop();

  if (replacement === undefined) {
    await replace();
  }

  expect(labelValue).toBe(labelOfPath);
  await expect(connects(path)).resolves.toBe(true);
  expect(attempts).toEqual(['refused', 'bound']);
});

it('closes the socket when the label clear fails at stop', async ({ onTestFinished: cleanup }) => {
  const directory = temporaryDirectory(cleanup, 'tau-failed-clear-');
  const sessionId = 'session-failed-clear';
  const path = join(directory, `${sessionId}.sock`);

  const listener = await startInbox({
    sessionId,
    terminal: 't-failed-clear',
    directory,
    accept: () => Promise.resolve(refusedReply('Not used.')),
    onQueued: () => undefined,
    advertise: () => Promise.resolve(),
    withdraw: () => Promise.reject(new Error('label clear failed')),
  });

  cleanup(() => listener.stop().catch(() => undefined));

  expect(existsSync(path)).toBe(true);

  await expect(listener.stop()).rejects.toThrow('label clear failed');
  expect(existsSync(path)).toBe(false);
});
