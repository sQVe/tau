import { afterEach, expect, it, vi } from 'vitest';

import type { AcceptCheck, MessageRequest } from '../../inbox/inbox.js';
import { handoverQuestionCheck } from './acceptCheck.js';

type Save = Parameters<AcceptCheck>[1];

type Reply = Awaited<ReturnType<Save>>;

const questionId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';

const request: MessageRequest = {
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 'lead-1',
  targetSessionId: '33333333-3333-4333-8333-333333333333',
  family: 'handover-question',
  payload: {
    questionId,
    text: 'Should this test expect two calls?',
    askerTerminal: 'worker-1',
    askerSession: '44444444-4444-4444-8444-444444444444',
  },
};

const queued: Reply = {
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: 'lead-1',
  sessionId: '33333333-3333-4333-8333-333333333333',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it('a lead saves the frame', async () => {
  vi.stubEnv('TAU_ROLE', '');
  const save = vi.fn<Save>().mockResolvedValue(queued);

  expect(await handoverQuestionCheck(request, save)).toEqual(queued);
  expect(save).toHaveBeenCalledTimes(1);
});

it('refuses an architect role with a reason', async () => {
  vi.stubEnv('TAU_ROLE', 'architect');
  const save = vi.fn<Save>().mockResolvedValue(queued);

  const reply = await handoverQuestionCheck(request, save);

  expect(save).not.toHaveBeenCalled();
  expect(typeof reply).toBe('string');
  expect(reply).toContain('architect');
});

it('refuses another family with a reason', async () => {
  vi.stubEnv('TAU_ROLE', '');
  const save = vi.fn<Save>().mockResolvedValue(queued);
  const other = { ...request, family: 'handover' as const, payload: { text: 'Hello.' } };

  const reply = await handoverQuestionCheck(other, save);

  expect(save).not.toHaveBeenCalled();
  expect(typeof reply).toBe('string');
  expect(reply).toContain('handover');
});
