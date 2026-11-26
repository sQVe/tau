import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { handoverAnswerCheck } from '../src/extensions/handoverQuestion/answer/answerCheck.js';
import { writeQuestionRecord } from '../src/extensions/handoverQuestion/question/questionRecord.js';
import type { AcceptCheck } from '../src/inbox/inbox.js';
import { decodeRequest } from '../src/inbox/protocol.js';
import { createTemporaryRepository } from './gitRepository.js';

type Save = Parameters<AcceptCheck>[1];

const fixture: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'handoverAnswer', 'request.json'), 'utf8'),
);

it('accepts the pinned wire frame through the real check', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const decoded = decodeRequest(new TextEncoder().encode(`${JSON.stringify(fixture)}\n`));

  if (decoded.kind !== 'frame' || decoded.value.family !== 'handover-answer') {
    throw new Error('The pinned fixture is not a handover-answer frame.');
  }

  const request = decoded.value;

  await writeQuestionRecord(root, {
    version: 1,
    questionId: request.payload.questionId,
    askerTerminal: request.targetTerminal,
    askerSession: request.targetSessionId,
    senderTerminal: 'lead-1',
    senderSession: request.payload.senderSession,
    text: 'Which option should I use?',
    askedAt: '2026-11-18T12:00:00.000Z',
    state: 'open',
    answer: null,
  });

  const save = vi.fn<Save>().mockResolvedValue({
    protocol: 'rpc1',
    kind: 'queued',
    messageId: request.messageId,
    terminal: request.targetTerminal,
    sessionId: request.targetSessionId,
  });

  const reply = await handoverAnswerCheck(() => root)(request, save);

  expect(save).toHaveBeenCalledOnce();
  expect(reply).toMatchObject({ kind: 'queued', messageId: request.messageId });
});
