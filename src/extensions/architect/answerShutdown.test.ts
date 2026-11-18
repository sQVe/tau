import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { createAnswerTracker } from './answer.js';
import { startCapturingInbox } from './fixtures/capturingInbox.js';
import { contextOf, setup } from './fixtures/toolHarness.js';
import { askRecordDirectory, askRecordPath, readAskRecord, writeAskRecord } from './record.js';
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

const answerText = (askId: string): string => `Answer to ask ${askId}:\n\nUse --dry-run.\n`;

const breakAnswerRecordWrite = (getRoot: () => string): ((askId: string) => Promise<void>) => {
  let broken = false;

  return async (askId) => {
    if (broken) {
      return;
    }

    broken = true;
    await rm(askRecordPath(getRoot(), askId), { force: true });
    await mkdir(askRecordPath(getRoot(), askId));
  };
};

const restoreRecord = async (root: string, record: LiveAskRecord): Promise<void> => {
  await rm(askRecordPath(root, record.askId), { recursive: true, force: true });
  await writeAskRecord(root, record);
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

  const notify = vi.fn<(message: string, level?: string) => void>();

  const session: ArchitectSession = {
    root,
    release: () => Promise.resolve(),
    ui: { notify },
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
    notify,
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

it('shutdown settles a delivered answer whose record write failed as answered and sends no close note', async ({
  onTestFinished: cleanup,
}) => {
  let root = '';

  const closing = await closingArchitect(
    cleanup,
    'reply',
    breakAnswerRecordWrite(() => root),
  );

  const { lead, record, answer, end, notify } = closing;

  root = closing.root;

  const result = await answer();

  expect(result.details).toMatchObject({ status: 'queued', askId: record.askId });
  expect((result.details as { note: string }).note).toContain('could not be updated');

  await restoreRecord(root, record);
  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'answered',
    answer: answerText(record.askId),
  });

  expect(lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(notify).not.toHaveBeenCalled();
});

it('shutdown reports a delivered answer it cannot settle and still sends no close note', async ({
  onTestFinished: cleanup,
}) => {
  let root = '';

  const closing = await closingArchitect(
    cleanup,
    'reply',
    breakAnswerRecordWrite(() => root),
  );

  const { lead, record, answer, end, notify } = closing;

  root = closing.root;

  await answer();
  await restoreRecord(root, record);
  await chmod(askRecordDirectory(root), 0o500);

  cleanup(async () => {
    await chmod(askRecordDirectory(root), 0o700);
  });

  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'queued' });
  expect(lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0]).toContain(`Ask ${record.askId} was answered`);
});

it('shutdown still fails an open ask that was never answered', async ({
  onTestFinished: cleanup,
}) => {
  let root = '';

  const closing = await closingArchitect(
    cleanup,
    'reply',
    breakAnswerRecordWrite(() => root),
  );

  const { lead, record, answer, end, notify } = closing;

  root = closing.root;

  const unanswered = { ...liveRecord(), createdAt: '2026-11-18T10:01:00.000Z' };

  await writeAskRecord(root, unanswered);
  await answer();
  await restoreRecord(root, record);
  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({ status: 'answered' });
  expect(await readAskRecord(root, unanswered.askId)).toMatchObject({ status: 'failed' });

  const expectedTexts = [answerText(record.askId), closeNote(unanswered.askId)].toSorted();

  const savedTexts = lead.savedTexts().toSorted();

  expect(savedTexts).toEqual(expectedTexts);

  expect(notify).not.toHaveBeenCalled();
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
