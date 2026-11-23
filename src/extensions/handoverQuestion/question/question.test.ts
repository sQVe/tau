import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import {
  advertiseInbox,
  savedFiles,
  startHandoverReceiver,
} from '../../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../../command.js';
import type { HcRuntime } from '../../../hc/hc.js';
import { askSender } from './question.js';
import type { QuestionTarget } from './question.js';
import { questionRecordDirectory, readQuestionRecord } from './questionRecord.js';

const askerSession = '11111111-1111-4111-8111-111111111111';
const askerTerminal = 'worker-1';
const senderTerminal = 'lead-1';
const questionText = 'Should this test expect two calls?';
const otherSession = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.unstubAllEnvs();
});

const runtimeOf = (fake: ReturnType<typeof createHcFake>): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const startAskerInbox = async (
  fake: ReturnType<typeof createHcFake>,
  sessionId = askerSession,
): Promise<void> => {
  const root = temporaryDirectory(onTestFinished, 'tau-asker-inbox-');

  const inbox = await startHandoverReceiver(onTestFinished, root, askerTerminal, { sessionId });

  advertiseInbox(fake, askerTerminal, inbox.path);
};

const targetOf = (
  fake: ReturnType<typeof createHcFake>,
  root: string,
  senderSession: string,
): QuestionTarget => ({
  hc: runtimeOf(fake),
  cwd: root,
  askerTerminal,
  askerSession,
  sender: { terminal: senderTerminal, sessionId: senderSession },
});

const askerRecords = async (root: string): Promise<string[]> => {
  try {
    const names = await readdir(questionRecordDirectory(root));

    return names.filter((name) => name.endsWith('.json')).toSorted();
  } catch {
    return [];
  }
};

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');

it('saves one open record, sends one frame, and ends the turn', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': (_request, save) => {
        frames += 1;

        return save();
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const result = await askSender(targetOf(fake, root, receiver.sessionId), {
    question: questionText,
  });

  const questionId = result.details.questionId;

  expect(result.terminate).toBe(true);
  expect(result.details).toEqual({ status: 'sent', questionId });

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: {
      version: 1,
      questionId,
      askerTerminal,
      askerSession,
      senderTerminal,
      senderSession: receiver.sessionId,
      text: questionText,
      askedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/u) as unknown,
      state: 'open',
      answer: null,
    },
  });

  const saved: unknown = JSON.parse(
    await readFile(join(receiver.inbox, `${questionId}.json`), 'utf8'),
  );

  expect(saved).toMatchObject({
    version: 4,
    messageId: questionId,
    family: 'handover-question',
    payload: {
      questionId,
      text: questionText,
      askerTerminal,
      askerSession,
    },
  });

  expect(frames).toBe(1);
  expect(await askerRecords(root)).toEqual([`${questionId}.json`]);
  expect(savedFiles(receiver)).toHaveLength(1);
});

it('refuses when the asker has no listening inbox', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': (_request, save) => {
        frames += 1;

        return save();
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);

  const result = await askSender(targetOf(fake, root, receiver.sessionId), {
    question: questionText,
  });

  expect(result.details.status).toBe('refused');
  expect(result.isError).toBe(true);
  expect(result.terminate).toBeUndefined();
  expect(textOf(result)).toContain('ask_user_question');
  expect(frames).toBe(0);
  expect(await askerRecords(root)).toEqual([]);
  expect(fake.calls).toHaveLength(0);
});

it('sends nothing and saves nothing when the call is already cancelled', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': (_request, save) => {
        frames += 1;

        return save();
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const controller = new AbortController();

  controller.abort();

  const target: QuestionTarget = {
    ...targetOf(fake, root, receiver.sessionId),
    hc: { ...runtimeOf(fake), signal: controller.signal },
  };

  await expect(askSender(target, { question: questionText })).rejects.toMatchObject({
    name: 'AbortError',
  });

  expect(await askerRecords(root)).toEqual([]);
  expect(frames).toBe(0);
  expect(fake.calls).toHaveLength(0);
});

it('saves nothing and sends nothing when cancellation arrives during the readiness lookup', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': (_request, save) => {
        frames += 1;

        return save();
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const controller = new AbortController();
  let gets = 0;

  const exec: Exec = (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'get') {
      gets += 1;
      controller.abort();
    }

    return fake.exec(command, commandArguments, options);
  };

  const target: QuestionTarget = {
    ...targetOf(fake, root, receiver.sessionId),
    hc: { exec, connect: fake.connect, cwd: '/repository', signal: controller.signal },
  };

  await expect(askSender(target, { question: questionText })).rejects.toMatchObject({
    name: 'AbortError',
  });

  expect(gets).toBe(1);
  expect(fake.calls).toHaveLength(1);
  expect(existsSync(questionRecordDirectory(root))).toBe(false);
  expect(await askerRecords(root)).toEqual([]);
  expect(frames).toBe(0);
});

it('deletes the record when cancellation stops the send before delivery', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': (_request, save) => {
        frames += 1;

        return save();
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const controller = new AbortController();
  let gets = 0;

  const exec: Exec = (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'get') {
      gets += 1;

      if (gets === 2) {
        controller.abort();
      }
    }

    return fake.exec(command, commandArguments, options);
  };

  const target: QuestionTarget = {
    ...targetOf(fake, root, receiver.sessionId),
    hc: { exec, connect: fake.connect, cwd: '/repository', signal: controller.signal },
  };

  await expect(askSender(target, { question: questionText })).rejects.toMatchObject({
    name: 'AbortError',
  });

  const signals = fake.calls.map((call) => call.signal);

  expect(gets).toBe(2);
  expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  expect(await askerRecords(root)).toEqual([]);
  expect(frames).toBe(0);
});

it('reports an unknown send with the receiver note and keeps the record', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  const reason = 'The receiver could not confirm the save.';
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': (request) => {
        frames += 1;

        return Promise.resolve({
          protocol: 'rpc1',
          kind: 'unknown',
          messageId: request.messageId,
          reason,
        });
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const result = await askSender(targetOf(fake, root, receiver.sessionId), {
    question: questionText,
  });

  const details = result.details;

  if (details.status !== 'unknown') {
    throw new Error(`Expected an unknown outcome, got ${details.status}.`);
  }

  expect(details.questionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(details.note).toContain(reason);
  expect(details.note).toMatch(/uncertain/iu);
  expect(details.note).toMatch(/another question/iu);
  expect(details.note).not.toContain('reuse this message ID');
  expect(textOf(result)).toBe(details.note);
  expect(result.terminate).toBe(true);
  expect(result.isError).toBeUndefined();

  expect(frames).toBe(1);
  expect(await askerRecords(root)).toEqual([`${details.questionId}.json`]);
  expect(await readQuestionRecord(root, details.questionId)).toMatchObject({ kind: 'record' });
});

it('refuses an ended sender even when the receiver accepts questions', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': (_request, save) => {
        frames += 1;

        return save();
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const result = await askSender(targetOf(fake, root, otherSession), { question: questionText });

  expect(result.details.status).toBe('refused');
  expect(result.isError).toBe(true);
  expect(result.terminate).toBeUndefined();
  expect(textOf(result)).toContain('ask_user_question');
  expect(frames).toBe(0);
  expect(await askerRecords(root)).toEqual([]);
  expect(savedFiles(receiver)).toHaveLength(0);
});

it('refuses when the receiver declines questions', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');
  let frames = 0;

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': () => {
        frames += 1;

        return Promise.resolve('This receiver declines questions.');
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const result = await askSender(targetOf(fake, root, receiver.sessionId), {
    question: questionText,
  });

  expect(result.details.status).toBe('refused');
  expect(result.isError).toBe(true);
  expect(result.terminate).toBeUndefined();
  expect(textOf(result)).toContain('ask_user_question');
  expect(frames).toBe(1);
  expect(await askerRecords(root)).toEqual([]);
  expect(savedFiles(receiver)).toHaveLength(0);
});

it('does not repeat the ask_user_question note in a refusal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: {
      'handover-question': () => Promise.resolve('This receiver declines questions.'),
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);
  await startAskerInbox(fake);

  const result = await askSender(targetOf(fake, root, receiver.sessionId), {
    question: questionText,
  });

  const mentions = textOf(result).match(/ask_user_question/gu) ?? [];

  expect(result.details.status).toBe('refused');
  expect(mentions).toHaveLength(1);
});
