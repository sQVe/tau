import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { createHcFake } from '../../../../tests/hcFake.js';
import { advertiseInbox, startHandoverReceiver } from '../../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
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

it('saves one open record, sends one frame, and ends the turn', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
    accepts: { 'handover-question': (_request, save) => save() },
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);

  const target: QuestionTarget = {
    hc: runtimeOf(fake),
    cwd: root,
    askerTerminal,
    askerSession,
    sender: { terminal: senderTerminal, sessionId: receiver.sessionId },
  };

  const result = await askSender(target, { question: questionText });
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
    version: 3,
    messageId: questionId,
    family: 'handover-question',
    payload: {
      questionId,
      text: questionText,
      askerTerminal,
      askerSession,
    },
  });

  const savedJson = receiver.savedRecords().filter((name) => name.endsWith('.json'));

  expect(savedJson).toHaveLength(1);
});

it('refuses an ended sender', async () => {
  vi.stubEnv('HC_TERMINAL_ID', askerTerminal);

  const root = await createTemporaryRepository(onTestFinished);
  const sockets = temporaryDirectory(onTestFinished, 'tau-handover-question-');

  const receiver = await startHandoverReceiver(onTestFinished, sockets, senderTerminal, {
    outsideSlot: true,
  });

  const fake = createHcFake();

  advertiseInbox(fake, senderTerminal, receiver.path);

  const target: QuestionTarget = {
    hc: runtimeOf(fake),
    cwd: root,
    askerTerminal,
    askerSession,
    sender: { terminal: senderTerminal, sessionId: otherSession },
  };

  const result = await askSender(target, { question: questionText });
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

  expect(text).toContain('ask_user_question');
  expect(result.isError).toBe(true);
  expect(result.terminate).toBeUndefined();

  expect(existsSync(join(questionRecordDirectory(root), `${result.details.questionId}.json`))).toBe(
    false,
  );
});
