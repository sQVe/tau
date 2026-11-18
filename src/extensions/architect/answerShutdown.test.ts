import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { createAnswerTracker } from './answer.js';
import { startCapturingInbox } from './fixtures/capturingInbox.js';
import { contextOf, setup } from './fixtures/toolHarness.js';
import { askRecordPath, readAskRecord, writeAskRecord } from './record.js';
import type { LiveAskRecord } from './record.js';
import { createHeldLockToken, endArchitectSession } from './session.js';
import type { ArchitectSession } from './session.js';
import { createArchitectAnswerTool } from './tool.js';

type Cleanup = typeof onTestFinished;
type FirstSend = Parameters<typeof startCapturingInbox>[2];
type AnswerHc = Pick<HcFake, 'exec' | 'connect'>;

const closeNote = (askId: string): string =>
  `Ask ${askId} got no answer: the architect closed. Call architect ask again.`;

const liveRecord = (): LiveAskRecord => ({
  version: 2,
  route: 'live',
  askId: randomUUID(),
  createdAt: '2026-11-18T10:00:00.000Z',
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  architectLockToken: 'live',
  status: 'queued',
  detail: null,
  answer: null,
});

const replyLead = (hc: HcFake, path: string): void => {
  hc.replyGet(
    't-lead',
    JSON.stringify({
      address: 't-lead',
      name: null,
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${path}` },
    }),
  );
};

const closingArchitect = async (
  cleanup: Cleanup,
  first: FirstSend,
  beforeReply?: (messageId: string) => Promise<void>,
) => {
  const { root } = await setup(cleanup);

  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const hc = createHcFake();
  const lead = await startCapturingInbox(cleanup, 'session-lead', first, beforeReply, 't-lead');
  const answers = createAnswerTracker();
  const record = liveRecord();

  replyLead(hc, lead.path);
  await writeFile(join(root, 'answer.md'), 'Use --dry-run.\n');
  await writeAskRecord(root, record);

  const session: ArchitectSession = {
    root,
    release: () => Promise.resolve(),
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    owner: {
      lockToken: 'live',
      mode: 'visible',
      terminal: 't-architect',
      sessionId: 'session-architect',
    },
    held: createHeldLockToken(),
  };

  const answerWith = (answerHc: AnswerHc) =>
    createArchitectAnswerTool({ ...answerHc, cwd: root }, answers).execute(
      'call',
      { action: 'answer', askId: record.askId, file: 'answer.md' },
      undefined,
      undefined,
      contextOf(root, {}, 'session-architect'),
    );

  return {
    root,
    lead,
    record,
    answers,
    hc,
    answer: () => answerWith(hc),
    answerWith,
    end: () => endArchitectSession(session, { ...hc, cwd: root }, answers),
  };
};

it('shutdown waits for an answer in flight and sends the lead no close note', async ({
  onTestFinished: cleanup,
}) => {
  const sendHeld = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const { root, lead, record, answer, end } = await closingArchitect(cleanup, 'reply', async () => {
    sendHeld.resolve(undefined);
    await release.promise;
  });

  let answerSettled = false;

  const answering = answer().finally(() => {
    answerSettled = true;
  });

  await sendHeld.promise;

  const ending = end();

  release.resolve(undefined);
  await ending;

  expect(answerSettled).toBe(true);

  expect((await answering).details).toEqual({
    action: 'answer',
    status: 'queued',
    askId: record.askId,
  });

  expect(lead.savedTexts()).toEqual([`Answer to ask ${record.askId}:\n\nUse --dry-run.\n`]);
  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'answered' });
});

it('shutdown fails an ask whose answer send ended unknown and sends the close note', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, answer, end } = await closingArchitect(cleanup, 'hold');
  const answering = answer();

  await vi.waitFor(() => {
    expect(lead.frames).toHaveLength(1);
  });

  const ending = end();

  lead.releaseFirst();

  expect((await answering).details).toMatchObject({ status: 'unknown', askId: record.askId });
  await ending;

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'failed' });
  expect(lead.savedTexts()).toEqual([closeNote(record.askId)]);
});

it('an answer after shutdown started throws, sends nothing, and leaves the record unchanged', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, hc, answers, answer } = await closingArchitect(cleanup, 'reply');
  const path = askRecordPath(root, record.askId);
  const before = await readFile(path, 'utf8');

  await answers.close();

  await expect(answer()).rejects.toThrow('The architect is closing. Nothing was sent.');

  expect(await readFile(path, 'utf8')).toBe(before);
  expect(lead.frames).toEqual([]);
  expect(hc.calls).toEqual([]);
});

it('an answer that never settles holds shutdown for 10 seconds, then the ask fails', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, hc, answerWith, end } = await closingArchitect(cleanup, 'reply');
  const reached = Promise.withResolvers<undefined>();

  const hangingHc: AnswerHc = {
    ...hc,
    exec: async () => {
      reached.resolve(undefined);
      await Promise.withResolvers<undefined>().promise;

      return failedResult('unreachable');
    },
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  cleanup(() => {
    vi.useRealTimers();
  });

  answerWith(hangingHc).catch(() => undefined);
  await reached.promise;

  let ended = false;

  const ending = (async () => {
    await end();
    ended = true;
  })();

  await vi.advanceTimersByTimeAsync(9999);
  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'queued' });
  expect(ended).toBe(false);
  expect(lead.frames).toEqual([]);

  await vi.advanceTimersByTimeAsync(1);
  await ending;

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'failed' });
  expect(lead.savedTexts()).toEqual([closeNote(record.askId)]);
});

it('closing the tracker waits for a run that never settles for exactly 10 seconds', async ({
  onTestFinished: cleanup,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  cleanup(() => {
    vi.useRealTimers();
  });

  const answers = createAnswerTracker();

  answers.run(() => Promise.withResolvers<undefined>().promise).catch(() => undefined);

  let closed = false;

  const closing = (async () => {
    await answers.close();
    closed = true;
  })();

  await vi.advanceTimersByTimeAsync(9999);
  expect(closed).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(closed).toBe(true);
});
