import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { withFileLock } from '../fileLock/fileLock.js';
import { inboxLock } from './endpoint.js';
import { currentInboxPath, startInbox } from './inbox.js';
import { formatInboxLabel, refusedReply } from './protocol.js';

const pathContender = (path: string, labelValue: () => string | undefined) => {
  const waited = Promise.withResolvers<undefined>();
  const acquired = Promise.withResolvers<undefined>();
  let waitedForLock = false;
  let sawPath: boolean | undefined;
  let seenLabel: string | undefined;
  let run: Promise<void> | undefined;

  const start = (): void => {
    run = withFileLock(
      {
        ...inboxLock(`${path}.lock`),
        onWaiting: () => {
          waitedForLock = true;
          waited.resolve(undefined);
        },
      },
      () => {
        sawPath = existsSync(path);
        seenLabel = labelValue();
        acquired.resolve(undefined);

        return Promise.resolve();
      },
    );
  };

  const settle = async (): Promise<void> => {
    if (run === undefined) {
      throw new Error('The socket path contender never started.');
    }

    await run;
  };

  return {
    start,
    whenContended: () => Promise.race([waited.promise, acquired.promise]),
    settle,
    outcome: () => ({ waitedForLock, sawPath, seenLabel }),
  };
};

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

it('lets a socket path contender in only after the label clear and the unlink', async ({
  onTestFinished: cleanup,
}) => {
  const directory = temporaryDirectory(cleanup, 'tau-path-contender-');
  const sessionId = 'session-path-contender';
  let labelValue: string | undefined;
  const contender = pathContender(join(directory, `${sessionId}.sock`), () => labelValue);

  const listener = await startInbox({
    sessionId,
    terminal: 't-path-contender',
    directory,
    accept: () => Promise.resolve(refusedReply('Not used.')),
    onQueued: () => undefined,
    advertise: (advertised) => {
      labelValue = formatInboxLabel(advertised);

      return Promise.resolve();
    },
    withdraw: async () => {
      labelValue = undefined;
      contender.start();
      await contender.whenContended();
    },
  });

  cleanup(() => listener.stop().catch(() => undefined));

  await listener.stop();
  await contender.settle();

  expect(contender.outcome()).toEqual({
    waitedForLock: true,
    sawPath: false,
    seenLabel: undefined,
  });
});

it('rolls back a failed advertise with the clear and the unlink in one path lock hold', async ({
  onTestFinished: cleanup,
}) => {
  const directory = temporaryDirectory(cleanup, 'tau-rollback-contender-');
  const sessionId = 'session-rollback-contender';
  let labelValue: string | undefined;
  const contender = pathContender(join(directory, `${sessionId}.sock`), () => labelValue);

  const started = startInbox({
    sessionId,
    terminal: 't-rollback-contender',
    directory,
    accept: () => Promise.resolve(refusedReply('Not used.')),
    onQueued: () => undefined,
    advertise: (advertised) => {
      labelValue = formatInboxLabel(advertised);

      return Promise.reject(new Error('label reply malformed'));
    },
    withdraw: async () => {
      labelValue = undefined;
      contender.start();
      await contender.whenContended();
    },
  });

  await expect(started).rejects.toThrow('label reply malformed');
  await contender.settle();

  expect(contender.outcome()).toEqual({
    waitedForLock: true,
    sawPath: false,
    seenLabel: undefined,
  });
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
