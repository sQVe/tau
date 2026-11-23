import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { onTestFinished } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { advertiseInbox } from '../../../tests/inboxReceiverHarness.js';
import { createAnswerTracker } from './answer.js';
import { createAskAdmissions } from './ask/askAcceptance.js';
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

const isRoot = process.getuid?.() === 0;

const closeNote = (askId: string): string =>
  `Ask ${askId} got no answer: the architect closed. Call architect ask again.`;

const uncheckedDetail =
  'The architect closed and could not check whether its answer reached the lead.';

const uncheckedNote = (askId: string): string =>
  `Ask ${askId}: the architect closed and could not check whether its answer reached you. If no "Answer to ask ${askId}" arrived, call architect ask again.`;

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

  advertiseInbox(hc, 't-lead', lead.path);
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

  const send = (answerHc: AnswerHc, file: string | undefined) =>
    createArchitectAnswerTool({ ...answerHc, cwd: root }, answers).execute(
      'call',
      { action: 'answer', askId: record.askId, ...(file === undefined ? {} : { file }) },
      undefined,
      undefined,
      contextOf(root, {}, 'session-architect'),
    );

  const answerWith = (answerHc: AnswerHc, file = 'answer.md') => send(answerHc, file);

  return {
    root,
    lead,
    record,
    answers,
    hc,
    notify,
    answer: (file?: string) => answerWith(hc, file),
    answerWithoutFile: () => send(hc, undefined),
    answerWith,
    end: () =>
      endArchitectSession(
        session,
        { ...hc, cwd: root },
        {
          answers,
          admissions: createAskAdmissions(() => undefined),
          sendEndNote: true,
        },
      ),
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

  expect(await lead.savedTexts()).toEqual([`Answer to ask ${record.askId}:\n\nUse --dry-run.\n`]);
  expect(lead.savedRecords()).toHaveLength(1);
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

  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
  expect(notify).not.toHaveBeenCalled();
});

it.skipIf(isRoot)(
  'shutdown reports a delivered answer it cannot settle and still sends no close note',
  async ({ onTestFinished: cleanup }) => {
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
    expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
    expect(lead.savedRecords()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain(`Ask ${record.askId} was answered`);
  },
);

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

  const savedTexts = (await lead.savedTexts()).toSorted();

  expect(savedTexts).toEqual(expectedTexts);

  expect(notify).not.toHaveBeenCalled();
  expect(lead.savedRecords()).toHaveLength(2);
});

it('shutdown resends an answer whose send was dropped before the lead saved it', async ({
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

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'answered',
    answer: answerText(record.askId),
  });

  expect(lead.saved()).toEqual([`${record.askId}.json`]);
  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
});

it('an answer saved before its reply was lost is settled at close', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, answer, end, notify } = await closingArchitect(
    cleanup,
    'save-then-drop',
  );

  expect((await answer()).details).toMatchObject({ status: 'unknown', askId: record.askId });
  expect(lead.saved()).toEqual([`${record.askId}.json`]);

  expect(lead.savedRecords()).toHaveLength(1);
  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'answered',
    answer: answerText(record.askId),
  });

  expect(lead.saved()).toEqual([`${record.askId}.json`]);
  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
  expect(notify).not.toHaveBeenCalled();
});

it('a refused answer resend after an unknown send is settled at close', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, hc, answer, end } = await closingArchitect(cleanup, 'save-then-drop');

  expect((await answer()).details).toMatchObject({ status: 'unknown', askId: record.askId });

  const before = await readFile(askRecordPath(root, record.askId), 'utf8');

  hc.fail('get', 'transient', 1);

  await expect(answer()).rejects.toThrow(Error);

  expect(await readFile(askRecordPath(root, record.askId), 'utf8')).toBe(before);
  expect(lead.frames).toHaveLength(1);

  hc.recover('get');
  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'answered',
    answer: answerText(record.askId),
  });

  expect(lead.saved()).toEqual([`${record.askId}.json`]);
  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
});

it('a changed file after an unknown answer is refused before the send', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, answer, answerWithoutFile, end, notify } = await closingArchitect(
    cleanup,
    'suppress',
  );

  expect((await answer()).details).toMatchObject({ status: 'unknown', askId: record.askId });
  expect(lead.saved()).toEqual([]);

  expect(lead.savedRecords()).toEqual([]);
  await writeFile(join(root, 'answer.md'), 'Use --force.\n');

  const before = await readFile(askRecordPath(root, record.askId), 'utf8');

  await expect(answer()).rejects.toThrow(Error);

  expect(lead.frames).toHaveLength(1);
  expect(await readFile(askRecordPath(root, record.askId), 'utf8')).toBe(before);

  lead.replyLater('reply');

  expect((await answerWithoutFile()).details).toEqual({
    action: 'answer',
    status: 'queued',
    askId: record.askId,
  });

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'answered',
    answer: answerText(record.askId),
  });

  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);

  await end();

  expect(lead.frames).toHaveLength(2);
  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
  expect(notify).not.toHaveBeenCalled();
});

it('the close resend sends the first uncertain answer when a different file is refused', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, answer, end } = await closingArchitect(cleanup, 'save-then-drop');

  await writeFile(join(root, 'other.md'), 'Use --force.\n');

  expect((await answer()).details).toMatchObject({ status: 'unknown', askId: record.askId });

  const before = await readFile(askRecordPath(root, record.askId), 'utf8');

  await expect(answer('other.md')).rejects.toThrow(Error);

  expect(lead.frames).toHaveLength(1);
  expect(await readFile(askRecordPath(root, record.askId), 'utf8')).toBe(before);

  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'answered',
    answer: answerText(record.askId),
  });

  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
});

it('an answer resend without a file keeps the close resend on the same bytes', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, answer, answerWithoutFile, end, notify } = await closingArchitect(
    cleanup,
    'suppress',
  );

  expect((await answer()).details).toMatchObject({ status: 'unknown', askId: record.askId });

  lead.replyLater('save-then-drop');

  expect((await answerWithoutFile()).details).toMatchObject({
    status: 'unknown',
    askId: record.askId,
  });

  lead.replyLater('reply');
  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'answered',
    answer: answerText(record.askId),
  });

  expect(lead.saved()).toEqual([`${record.askId}.json`]);
  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);

  const savedText = (await lead.savedTexts()).join('\n');

  expect(savedText).not.toContain('could not check');
  expect(savedText).not.toContain('got no answer');
  expect(notify).not.toHaveBeenCalled();
});

it('answer without a file and nothing kept needs a file', async ({ onTestFinished: cleanup }) => {
  const { root, lead, record, answerWithoutFile } = await closingArchitect(cleanup, 'reply');
  const before = await readFile(askRecordPath(root, record.askId), 'utf8');

  await expect(answerWithoutFile()).rejects.toThrow(Error);

  expect(lead.frames).toEqual([]);
  expect(await readFile(askRecordPath(root, record.askId), 'utf8')).toBe(before);
});

it('an answer whose outcome stays unknown at close gets the could-not-check note', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, answer, end } = await closingArchitect(cleanup, 'save-then-drop');

  await answer();
  lead.replyLater('save-then-drop');
  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'failed',
    detail: uncheckedDetail,
  });

  const expectedTexts = [answerText(record.askId), uncheckedNote(record.askId)].toSorted();
  const savedTexts = (await lead.savedTexts()).toSorted();

  expect(savedTexts).toEqual(expectedTexts);
  expect(lead.savedRecords()).toHaveLength(2);
});

it('an answer that cannot be sent again at close gets the could-not-check detail', async ({
  onTestFinished: cleanup,
}) => {
  const { root, lead, record, hc, notify, answer, end } = await closingArchitect(
    cleanup,
    'save-then-drop',
  );

  await answer();

  hc.replyGet(
    't-lead',
    JSON.stringify({ address: 't-lead', name: null, state: 'live', labels: {} }),
  );

  await end();

  expect(await readAskRecord(root, record.askId)).toMatchObject({
    status: 'failed',
    detail: uncheckedDetail,
  });

  expect(await lead.savedTexts()).toEqual([answerText(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0]).toContain(`no close note for ask ${record.askId}`);
});

it('closing the tracker reports delivered and uncertain answers apart', async () => {
  const answers = createAnswerTracker();

  answers.recordUncertain('ask-1', 'first');
  answers.recordUncertain('ask-2', 'second');
  answers.recordDelivered('ask-2', 'second');

  await expect(answers.close()).resolves.toEqual({
    delivered: new Map([['ask-2', 'second']]),
    uncertain: new Map([['ask-1', 'first']]),
  });
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

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

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
  expect(await lead.savedTexts()).toEqual([closeNote(record.askId)]);
  expect(lead.savedRecords()).toHaveLength(1);
});

it('closing the tracker waits for a run that never settles for exactly 10 seconds', async ({
  onTestFinished: cleanup,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

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
