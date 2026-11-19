import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { basename } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import type { AcceptCheck } from '../../../inbox/inbox.js';
import { decodeReply, encodeMessageFrame } from '../../../inbox/protocol.js';
import type { MessageReply } from '../../../inbox/protocol.js';
import { createAnswerTracker } from '../answer.js';
import { createHeldLockToken, endArchitectSession } from '../session.js';
import type { ArchitectSession } from '../session.js';
import { createAskAdmissions } from './askAcceptance.js';

type Cleanup = typeof onTestFinished;

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

const closingSetup = async (cleanup: Cleanup) => {
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

  held.set('T1');

  const accept: AcceptCheck = (request, save) =>
    admissions.check(request, async (guard) => {
      const reply = await save(guard);

      events.push('save settled');

      return reply;
    });

  const receiver = await startHandoverReceiver(
    cleanup,
    temporaryDirectory(cleanup, 'tau-admissions-'),
    't-architect',
    {
      sessionId,
      accepts: { 'architect-ask': accept },
      beforeCommit: async () => {
        admitted.resolve(undefined);
        await stall.promise;
      },
    },
  );

  const root = await createTemporaryRepository(cleanup);
  const hc = createHcFake();

  const session: ArchitectSession = {
    root,
    release: () => {
      events.push('released');

      return Promise.resolve();
    },
    ui: { notify: () => undefined },
    owner: {
      lockToken: 'T1',
      mode: 'visible',
      terminal: 't-architect',
      sessionId: 'session-architect',
    },
    held,
  };

  const frame = encodeMessageFrame({
    messageId,
    targetTerminal: 't-architect',
    targetSessionId: sessionId,
    body: { family: 'architect-ask', payload: { text: 'Which flag?', lockToken: 'T1' } },
  });

  const asking = exchange(receiver.path, frame);

  await admitted.promise;

  return {
    events,
    stall,
    asking,
    messageId,
    savedMessages: () => receiver.savedRecords().filter((name) => name.endsWith('.json')),
    end: () =>
      endArchitectSession(session, { ...hc, cwd: root }, createAnswerTracker(), admissions),
  };
};

it('an admitted question that stalls past the close deadline is not saved', async ({
  onTestFinished: cleanup,
}) => {
  const { events, stall, asking, savedMessages, end } = await closingSetup(cleanup);
  const ending = end();

  await vi.advanceTimersByTimeAsync(10_000);
  await ending;

  expect(events).toEqual(['released']);

  stall.resolve(undefined);

  await expect(asking).resolves.toMatchObject({ kind: 'refused', reason: lockRefusal('T1') });
  expect(savedMessages()).toEqual([]);
  expect(events).toEqual(['released', 'save settled']);
});

it('close waits for an admitted question before it releases the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { events, stall, asking, savedMessages, end } = await closingSetup(cleanup);
  const ending = end();

  await vi.advanceTimersByTimeAsync(9999);
  stall.resolve(undefined);
  await ending;

  await expect(asking).resolves.toMatchObject({ kind: 'refused', reason: lockRefusal('T1') });
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
