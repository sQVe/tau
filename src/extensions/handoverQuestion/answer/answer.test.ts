import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { failedResult } from '../../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import {
  advertiseInbox,
  savedFiles,
  startHandoverReceiver,
} from '../../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../../../hc/hc.js';
import type { MessageReply } from '../../../inbox/protocol.js';
import { inboxMessageType, messageText } from '../../../inbox/receiptDecision.js';
import { readMessage } from '../../../inbox/store.js';
import type { QuestionRecord } from '../question/questionRecord.js';
import { writeQuestionRecord } from '../question/questionRecord.js';
import { answerQuestion } from './answer.js';
import { handoverAnswerCheck } from './answerCheck.js';

const questionId = '11111111-1111-4111-8111-111111111111';
const otherQuestionId = '44444444-4444-4444-8444-444444444444';
const askerSession = '22222222-2222-4222-8222-222222222222';
const leadSession = '33333333-3333-4333-8333-333333333333';
const otherLeadSession = '55555555-5555-4555-8555-555555555555';
const askerTerminal = 'worker-1';
const answer = 'Use option A.';
const questionText = 'Which option should I use?';

const runtimeOf = (fake: ReturnType<typeof createHcFake>): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const questionEntry = (savedQuestionId = questionId): SessionEntry =>
  ({
    type: 'custom_message',
    customType: inboxMessageType,
    content: messageText({
      family: 'handover-question',
      payload: { questionId: savedQuestionId, text: questionText, askerTerminal, askerSession },
    }),
    display: true,
    details: {
      version: 4,
      messageId: savedQuestionId,
      sessionId: leadSession,
      family: 'handover-question',
      questionId: savedQuestionId,
    },
  }) as unknown as SessionEntry;

const recordFields = {
  version: 1 as const,
  questionId,
  askerTerminal,
  askerSession,
  senderTerminal: 'lead-1',
  text: questionText,
  askedAt: '2026-11-18T12:00:00.000Z',
};

const openRecord = (senderSession: string): QuestionRecord => ({
  ...recordFields,
  senderSession,
  state: 'open',
  answer: null,
});

const answeredRecord = (senderSession: string, savedAnswer: string): QuestionRecord => ({
  ...recordFields,
  senderSession,
  state: 'answered',
  answer: savedAnswer,
});

const startAsker = async (onFrame: () => void = () => undefined) => {
  const root = temporaryDirectory(onTestFinished, 'tau-handover-answer-');

  return startHandoverReceiver(onTestFinished, root, askerTerminal, {
    sessionId: askerSession,
    accepts: {
      'handover-answer': (_request, save) => {
        onFrame();

        return save();
      },
    },
  });
};

const startCheckingAsker = async (record: QuestionRecord) => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(root, record);

  const asker = await startHandoverReceiver(onTestFinished, root, askerTerminal, {
    sessionId: askerSession,
    accepts: { 'handover-answer': handoverAnswerCheck(() => root) },
  });

  const fake = createHcFake();

  advertiseInbox(fake, askerTerminal, asker.path);

  return { asker, fake };
};

const reasonOf = (result: Awaited<ReturnType<typeof answerQuestion>>): string =>
  result.details.status === 'refused' ? result.details.reason : '';

const noteOf = (result: Awaited<ReturnType<typeof answerQuestion>>): string =>
  result.details.status === 'unknown' ? result.details.note : '';

const advisesQuestionIdChange = (note: string): boolean => {
  const pattern = /(?:new|fresh|different|another)\s+question ID/giu;

  return [...note.matchAll(pattern)].some((match) => {
    const before = note.slice(Math.max(0, match.index - 40), match.index);

    return !/\b(?:not|never|no)\b/iu.test(before);
  });
};

// Gives a fire-and-forget retry time to reach the receiver without using elapsed time.
const yieldToIo = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const advanceRetryWindow = async (milliseconds: number): Promise<void> => {
  const stepMilliseconds = 1000;

  for (let elapsed = 0; elapsed < milliseconds; elapsed += stepMilliseconds) {
    await vi.advanceTimersByTimeAsync(stepMilliseconds);
    await yieldToIo();
  }
};

const settleFrames = async (frames: () => number): Promise<void> => {
  let quiet = 0;

  while (quiet < 3) {
    const before = frames();

    await yieldToIo();

    quiet = frames() === before ? quiet + 1 : 0;
  }
};

it('sends one answer frame to the asker', async () => {
  let frames = 0;

  const asker = await startAsker(() => {
    frames += 1;
  });

  const fake = createHcFake();

  advertiseInbox(fake, askerTerminal, asker.path);

  const result = await answerQuestion(
    { hc: runtimeOf(fake), entries: [questionEntry()], leadSession },
    { questionId, answer },
  );

  expect(result.isError).toBeUndefined();
  expect(result.details).toEqual({ status: 'queued', questionId });
  expect(frames).toBe(1);

  expect(await readMessage(asker.inbox, questionId)).toEqual({
    kind: 'record',
    record: {
      version: 4,
      messageId: questionId,
      family: 'handover-answer',
      payload: { questionId, senderSession: leadSession, answer },
    },
  });

  expect(savedFiles(asker)).toHaveLength(1);
});

it('refuses a question this session never received', async () => {
  let frames = 0;

  const asker = await startAsker(() => {
    frames += 1;
  });

  const fake = createHcFake();

  advertiseInbox(fake, askerTerminal, asker.path);

  const result = await answerQuestion(
    { hc: runtimeOf(fake), entries: [questionEntry(otherQuestionId)], leadSession },
    { questionId, answer },
  );

  const reason = `This session never received handover question ${questionId}.`;

  expect(result.isError).toBe(true);
  expect(result.details).toEqual({ status: 'refused', questionId, reason });
  expect(frames).toBe(0);
  expect(savedFiles(asker)).toEqual([]);
});

it('reports a cancellation that arrives before the question lookup', async () => {
  let frames = 0;

  const asker = await startAsker(() => {
    frames += 1;
  });

  const fake = createHcFake();

  advertiseInbox(fake, askerTerminal, asker.path);

  const controller = new AbortController();

  controller.abort(new Error('The user cancelled the answer.'));

  await expect(
    answerQuestion(
      {
        hc: { ...runtimeOf(fake), signal: controller.signal },
        entries: [questionEntry(otherQuestionId)],
        leadSession,
      },
      { questionId, answer },
    ),
  ).rejects.toThrow('The user cancelled the answer.');

  expect(frames).toBe(0);
  expect(savedFiles(asker)).toEqual([]);
});

it('reports a cancellation that arrives where a refusal would otherwise return', async () => {
  let frames = 0;

  const asker = await startAsker(() => {
    frames += 1;
  });

  const fake = createHcFake();

  advertiseInbox(fake, askerTerminal, asker.path);

  const controller = new AbortController();

  const hc: HcRuntime = {
    exec: () => {
      controller.abort(new Error('The user cancelled the answer.'));

      return Promise.resolve(failedResult('hc get failed'));
    },
    connect: () => Promise.reject(new Error('no connect')),
    cwd: '/repository',
    signal: controller.signal,
  };

  await expect(
    answerQuestion({ hc, entries: [questionEntry()], leadSession }, { questionId, answer }),
  ).rejects.toThrow('The user cancelled the answer.');

  expect(frames).toBe(0);
  expect(savedFiles(asker)).toEqual([]);
});

it('reports an unknown send once without retrying', async () => {
  let frames = 0;
  const root = temporaryDirectory(onTestFinished, 'tau-handover-answer-');

  const asker = await startHandoverReceiver(onTestFinished, root, askerTerminal, {
    sessionId: askerSession,
    accepts: {
      'handover-answer': async (request) => {
        frames += 1;

        const reply: MessageReply = {
          protocol: 'rpc1',
          kind: 'unknown',
          messageId: request.messageId,
          reason: 'The reply was lost.',
        };

        return reply;
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, askerTerminal, asker.path);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const result = await answerQuestion(
    { hc: runtimeOf(fake), entries: [questionEntry()], leadSession },
    { questionId, answer },
  );

  const note = noteOf(result);

  expect(result.isError).toBeUndefined();
  expect(result.details).toMatchObject({ status: 'unknown', questionId });
  expect(note).toContain('The reply was lost.');
  expect(note).toMatch(/deliver[^.]*uncertain|uncertain[^.]*deliver/iu);
  expect(note).toMatch(/retr/u);
  expect(note).toContain('same answer');
  expect(note).toContain('question ID');
  expect(advisesQuestionIdChange(note)).toBe(false);
  expect(note).not.toContain('delivered');
  expect(frames).toBe(1);

  await advanceRetryWindow(5 * 60_000);
  await settleFrames(() => frames);

  expect(frames).toBe(1);
  expect(savedFiles(asker)).toEqual([]);
});

it('refuses an answer the asker sent to another lead session', async () => {
  const { asker, fake } = await startCheckingAsker(openRecord(otherLeadSession));

  const result = await answerQuestion(
    { hc: runtimeOf(fake), entries: [questionEntry()], leadSession },
    { questionId, answer },
  );

  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ status: 'refused', questionId });
  expect(reasonOf(result)).toContain('another lead session');
  expect(savedFiles(asker)).toEqual([]);
});

it('refuses an answer the asker already has', async () => {
  const { asker, fake } = await startCheckingAsker(answeredRecord(leadSession, 'Use option B.'));

  const result = await answerQuestion(
    { hc: runtimeOf(fake), entries: [questionEntry()], leadSession },
    { questionId, answer },
  );

  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ status: 'refused', questionId });
  expect(reasonOf(result)).toContain('a different answer');
  expect(savedFiles(asker)).toEqual([]);
});
