import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import type { AcceptCheck } from '../../../inbox/inbox.js';
import { decodeReply, encodeMessageFrame } from '../../../inbox/protocol.js';
import type { MessageReply } from '../../../inbox/protocol.js';
import { pendingMessages } from '../../../inbox/store.js';
import { createAnswerTracker } from '../answer.js';
import { createFinalHandoverTracker } from '../endNoteSend.js';
import { architectLockPath, holdArchitectLock } from '../lock.js';
import { createHeldLockToken, endArchitectSession } from '../session.js';
import type { ArchitectSession } from '../session.js';
import { createAskAdmissions } from './askAcceptance.js';

type Cleanup = typeof onTestFinished;

type StallPoint = 'commit' | 'publish';

const lockRefusal = (token: string): string =>
  `This architect does not hold lock ${token} now. It restarted or closed. Call architect ask again.`;

const exchange = (path: string, frame: string): Promise<MessageReply> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection(path);

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    socket.on('error', reject);

    socket.on('end', () => {
      const decision = decodeReply(Buffer.concat(chunks));

      if (decision.kind === 'frame') {
        resolve(decision.value);
      } else {
        reject(new Error(decision.reason));
      }
    });

    socket.end(frame);
  });

const closingSetup = async (cleanup: Cleanup, stallPoint: StallPoint = 'commit') => {
  const root = await createTemporaryRepository(cleanup);
  const lock = await holdArchitectLock(root);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  cleanup(() => {
    vi.useRealTimers();
  });

  const events: string[] = [];
  const held = createHeldLockToken();
  const admissions = createAskAdmissions(held.current);
  const admitted = Promise.withResolvers<undefined>();
  const stall = Promise.withResolvers<undefined>();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  held.set(lock.token);

  const accept: AcceptCheck = (request, save) =>
    admissions.check(request, async (guard) => {
      const reply = await save(guard);

      events.push('save settled');

      return reply;
    });

  const stalling = async () => {
    admitted.resolve(undefined);
    await stall.promise;
  };

  const stallOption =
    stallPoint === 'commit' ? { beforeCommit: stalling } : { beforePublish: stalling };

  const receiver = await startHandoverReceiver(
    cleanup,
    temporaryDirectory(cleanup, 'tau-admissions-'),
    't-architect',
    {
      sessionId,
      accepts: { 'architect-ask': accept },
      ...stallOption,
    },
  );

  const hc = createHcFake();

  const session: ArchitectSession = {
    root,
    release: async () => {
      await lock.release();
      events.push('released');
    },
    ui: { notify: () => undefined },
    owner: {
      lockToken: lock.token,
      mode: 'visible',
      terminal: 't-architect',
      sessionId: 'session-architect',
    },
    held,
    leadTerminal: null,
    finalHandover: createFinalHandoverTracker(),
  };

  const frame = encodeMessageFrame({
    messageId,
    targetTerminal: 't-architect',
    targetSessionId: sessionId,
    body: { family: 'architect-ask', payload: { text: 'Which flag?', lockToken: lock.token } },
  });

  const asking = exchange(receiver.path, frame);

  await admitted.promise;

  return {
    events,
    stall,
    asking,
    messageId,
    token: lock.token,
    root,
    pending: () => pendingMessages(receiver.inbox),
    folderNames: () => readdirSync(receiver.inbox),
    savedMessages: () => receiver.savedRecords().filter((name) => name.endsWith('.json')),
    end: () =>
      endArchitectSession(session, { ...hc, cwd: root }, createAnswerTracker(), admissions),
  };
};

it('an admitted question that stalls past the close deadline is not saved', async ({
  onTestFinished: cleanup,
}) => {
  const { events, stall, asking, savedMessages, end, token } = await closingSetup(cleanup);
  const ending = end();

  await vi.advanceTimersByTimeAsync(10_000);
  await ending;

  expect(events).toEqual(['released']);

  stall.resolve(undefined);

  await expect(asking).resolves.toMatchObject({ kind: 'refused', reason: lockRefusal(token) });
  expect(savedMessages()).toEqual([]);
  expect(events).toEqual(['released', 'save settled']);
});

it('a question whose write stalls past the close deadline is not published', async ({
  onTestFinished: cleanup,
}) => {
  const { stall, asking, pending, folderNames, end, token, root } = await closingSetup(
    cleanup,
    'publish',
  );

  const ending = end();

  await vi.advanceTimersByTimeAsync(10_000);
  await ending;

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();

  stall.resolve(undefined);

  await expect(asking).resolves.toMatchObject({ kind: 'refused', reason: lockRefusal(token) });
  await expect(pending()).resolves.toEqual([]);
  const temporaryNames = folderNames().filter((name) => name.startsWith('.'));

  expect(temporaryNames).toEqual([]);
});

it('close waits for an admitted question before it releases the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { events, stall, asking, savedMessages, end, token } = await closingSetup(cleanup);
  const ending = end();

  await vi.advanceTimersByTimeAsync(9999);
  stall.resolve(undefined);
  await ending;

  await expect(asking).resolves.toMatchObject({ kind: 'refused', reason: lockRefusal(token) });
  expect(savedMessages()).toEqual([]);
  expect(events).toEqual(['save settled', 'released']);
  expect(vi.getTimerCount()).toBe(0);
});

it('an admitted question that finishes while the lock is held is saved', async ({
  onTestFinished: cleanup,
}) => {
  const { stall, asking, savedMessages, messageId } = await closingSetup(cleanup);

  stall.resolve(undefined);

  await expect(asking).resolves.toMatchObject({ kind: 'queued', messageId });
  const fileNames = savedMessages().map((name) => basename(name));

  expect(fileNames).toEqual([`${messageId}.json`]);
});
