import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import type { HandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { startLeadInbox } from './fixtures/leadInbox.js';
import { contextOf, holdLock, recordSession, setup } from './fixtures/toolHarness.js';
import { blockFinalHandover } from './open/openLiveAsks.js';
import { askRecordPath, readAskRecord } from './record.js';
import { createArchitectTool } from './tool.js';

const recordFailure = vi.hoisted(() => ({ path: '', remaining: 0 }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    rename: async (...parameters: Parameters<typeof original.rename>) => {
      const destination = String(parameters[1]);
      const targetsRecord = recordFailure.path !== '' && destination === recordFailure.path;

      if (targetsRecord && recordFailure.remaining > 0) {
        recordFailure.remaining -= 1;
        throw new Error('record rename failed');
      }

      return original.rename(...parameters);
    },
  };
});

const replyTerminal = (hc: HcFake, address: string, path: string): void => {
  hc.replyGet(
    address,
    JSON.stringify({ address, name: null, state: 'live', labels: { 'tau.inbox': `rpc1:${path}` } }),
  );
};

const finalHandover = { toolName: 'handover', input: { action: 'send', final: true } } as never;

const setupRefusingArchitect = async (
  cleanup: typeof onTestFinished,
  renameFailures: number,
): Promise<{
  root: string;
  receiver: HandoverReceiver;
  state: { askId: string; deliveries: number };
  tool: ReturnType<typeof createArchitectTool>;
}> => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const state = { askId: '', deliveries: 0 };

  await startLeadInbox(cleanup, hc);

  const receiver = await startHandoverReceiver(
    cleanup,
    temporaryDirectory(cleanup, 'tau-refused-ask-'),
    't-architect',
    {
      sessionId: 'session-architect',
      outsideSlot: true,
      accepts: {
        'architect-ask': async (request) => {
          state.askId = request.messageId;
          state.deliveries += 1;
          recordFailure.path = askRecordPath(root, request.messageId);
          recordFailure.remaining = renameFailures;

          return 'The architect refused this question.';
        },
      },
    },
  );

  await recordSession(root, { terminal: 't-architect', sessionId: 'session-architect' });
  await holdLock(root, root);
  replyTerminal(hc, 't-architect', receiver.path);

  return { root, receiver, state, tool: createArchitectTool({ ...hc, cwd: root }) };
};

const askQuestion = (tool: ReturnType<typeof createArchitectTool>, root: string) =>
  tool
    .execute(
      'call',
      { action: 'ask', question: 'Which flag name?' },
      undefined,
      undefined,
      contextOf(root),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );

const repairAsk = (
  tool: ReturnType<typeof createArchitectTool>,
  root: string,
  askId: string,
  sessionId = 'session-lead',
) =>
  tool
    .execute('call', { action: 'ask', askId }, undefined, undefined, contextOf(root, {}, sessionId))
    .then(
      () => undefined,
      (error: unknown) => error,
    );

it('a refused live ask recovers after its first record update fails', async ({
  onTestFinished: cleanup,
}) => {
  const { root, receiver, state, tool } = await setupRefusingArchitect(cleanup, 1);

  const failure = await askQuestion(tool, root);
  const message = (failure as Error).message;

  expect(failure).toBeInstanceOf(Error);
  expect(message).toContain('The architect refused this question. Nothing was queued.');
  expect(message).toContain(`Ask ${state.askId} is failed.`);
  expect(message).toContain('Call architect ask again with the question.');

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'failed' });

  const sameId = await repairAsk(tool, root, state.askId);

  expect(sameId).toBeInstanceOf(Error);
  expect((sameId as Error).message).toMatch(/is failed\. Only an unknown ask can retry/);
  expect(state.deliveries).toBe(1);
  expect(receiver.savedRecords()).toEqual([]);

  const blocked = await blockFinalHandover(finalHandover, {
    root,
    sessionId: 'session-architect',
  });

  expect(blocked).toBeUndefined();
});

it('a refused live ask can finish record repair by ID without resending', async ({
  onTestFinished: cleanup,
}) => {
  const { root, receiver, state, tool } = await setupRefusingArchitect(cleanup, 3);

  const failure = await askQuestion(tool, root);
  const message = (failure as Error).message;

  expect(failure).toBeInstanceOf(Error);
  expect(message).toContain('The architect refused this question. Nothing was queued.');
  expect(message).toContain(`askId ${state.askId}`);
  expect(message).toContain('record rename failed');
  expect(message).toContain('Restore record access');
  expect(message).toContain('Do not reload Pi');

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });

  const otherSession = await repairAsk(tool, root, state.askId, 'session-other');

  expect(otherSession).toBeInstanceOf(Error);
  expect((otherSession as Error).message).toMatch(/belongs to lead session session-lead/);
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });

  const stillFailing = await repairAsk(tool, root, state.askId);

  expect(stillFailing).toBeInstanceOf(Error);
  expect((stillFailing as Error).message).toContain('record rename failed');
  expect((stillFailing as Error).message).toContain(`askId ${state.askId}`);
  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'sending' });
  expect(state.deliveries).toBe(1);

  const repaired = await repairAsk(tool, root, state.askId);

  expect(repaired).toBeInstanceOf(Error);

  expect((repaired as Error).message).toContain(
    'The architect refused this question. Nothing was queued.',
  );

  expect((repaired as Error).message).toContain(`Ask ${state.askId} is failed.`);
  expect((repaired as Error).message).toContain('Call architect ask again with the question.');

  expect(await readAskRecord(root, state.askId)).toMatchObject({ status: 'failed' });
  expect(state.deliveries).toBe(1);
  expect(receiver.savedRecords()).toEqual([]);

  const repeated = await repairAsk(tool, root, state.askId);

  expect(repeated).toBeInstanceOf(Error);
  expect((repeated as Error).message).toMatch(/is failed\. Only an unknown ask can retry/);
  expect((repeated as Error).message).not.toContain('Call architect ask again');
  expect((repeated as Error).message).not.toContain('The architect refused this question');
  expect(state.deliveries).toBe(1);

  const blocked = await blockFinalHandover(finalHandover, {
    root,
    sessionId: 'session-architect',
  });

  expect(blocked).toBeUndefined();
});
