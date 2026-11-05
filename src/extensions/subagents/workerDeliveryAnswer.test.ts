import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { manager, reportDelivery, savedQuestion } from './fixtures/workerDelivery.js';

beforeEach(() => {
  vi.stubEnv('HC_TERMINAL_ID', manager);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it('gives the manager the assignment ID and question ID in the question content', async () => {
  const question = savedQuestion();
  const { managerState, deliver, assignmentId } = await reportDelivery(null, [question]);

  await deliver(managerState.context);

  expect(managerState.messages).toHaveLength(1);

  const content = String(managerState.messages[0]?.content);

  expect(content).toContain(question.text);
  expect(content).toContain(assignmentId);
  expect(content).toContain(question.questionId);
});
