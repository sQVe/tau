import type { AgentToolResult, SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { answerPath, formatAnswerReference, publishAnswer } from './answerRecord.js';
import { writeAssignment } from './assignment.js';
import type { SavedQuestion } from './assignment.js';
import {
  assignmentId,
  sessionId,
  setupWorkerExtension,
  workerAssignment,
} from './fixtures/workerExtension.js';
import { workerStartMessage } from './workerStart.js';

type Harness = ReturnType<typeof setupWorkerExtension>;

const answer = (questionId: string): void => {
  publishAnswer({
    version: 1,
    assignmentId,
    questionId,
    answeredAt: Date.now(),
    answer: 'Use A.',
  });
};

const askQuestion = async ({ context, directory, pi }: Harness): Promise<string> => {
  await writeAssignment(workerAssignment(directory));
  await pi.handler('session_start')({}, context);

  const tool = pi.tools.get('subagent_question');

  if (tool === undefined) {
    throw new Error('The question tool was not registered.');
  }

  const result = (await tool.execute(
    'call',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  )) as AgentToolResult<SavedQuestion>;

  return result.details.questionId;
};

const inboxMessage = (family: string, content: string) => ({
  type: 'message_start',
  message: {
    role: 'custom',
    customType: 'tau-inbox-message',
    content,
    display: true,
    details: { version: 2, messageId: 'message-1', sessionId, family },
    timestamp: Date.now(),
  },
});

const runInboxWake = async (
  { context, pi }: Harness,
  message: ReturnType<typeof inboxMessage>,
): Promise<void> => {
  for (const handler of pi.handlers.get('agent_start') ?? []) {
    handler({} as never, context);
  }

  await pi.handler('message_start')(message, context);
  pi.handler('agent_settled')({}, context);
};

it('keeps waiting for the answer across a handover wake', async () => {
  const harness = setupWorkerExtension();

  await askQuestion(harness);
  await runInboxWake(harness, inboxMessage('handover', 'Pick up the parser work.'));

  expect(harness.shutdown).not.toHaveBeenCalled();
});

it('keeps waiting when the answer message has no answer file', async () => {
  const harness = setupWorkerExtension();
  const questionId = await askQuestion(harness);

  await runInboxWake(
    harness,
    inboxMessage('answer', formatAnswerReference(assignmentId, questionId)),
  );

  expect(harness.shutdown).not.toHaveBeenCalled();
});

it('ends the wait when the answer for the open question is delivered', async () => {
  const harness = setupWorkerExtension();
  const questionId = await askQuestion(harness);

  answer(questionId);

  await runInboxWake(
    harness,
    inboxMessage('answer', formatAnswerReference(assignmentId, questionId)),
  );

  expect(harness.shutdown).toHaveBeenCalledOnce();
});

it('keeps the sent reminder when an answer arrives after a user ended the wait', async () => {
  const harness = setupWorkerExtension();
  const { context, pi } = harness;
  const questionId = await askQuestion(harness);

  await pi.handler('message_start')(
    { type: 'message_start', message: { role: 'user', content: 'Use A.' } },
    context,
  );

  const reminder = pi.handler('agent_before_settle')({ entries: [] }, context);

  answer(questionId);

  await pi.handler('message_start')(
    inboxMessage('answer', formatAnswerReference(assignmentId, questionId)),
    context,
  );

  expect(reminder).toMatchObject({ continue: true });
  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toBeUndefined();
});

it('tells a resumed worker where its saved answer is', async () => {
  const question: SavedQuestion = {
    questionId: '7c1e4b2a-9d3f-4e5a-8b6c-1d2e3f4a5b6c',
    text: 'Which config file wins?',
    askedAt: Date.now() - 1000,
  };

  const branch = [
    { type: 'message', message: { role: 'user', content: 'Task' } },
    { type: 'message', message: { role: 'toolResult', toolName: 'subagent_question' } },
  ] as unknown as SessionEntry[];

  const { context, directory, pi } = setupWorkerExtension({ branch });

  await writeAssignment(workerAssignment(directory, [question]));
  answer(question.questionId);
  await pi.handler('session_start')({}, context);

  const result = await pi.handler('input')(
    { type: 'input', text: workerStartMessage, source: 'interactive' },
    context,
  );

  expect(result).toMatchObject({ action: 'transform' });

  expect((result as { text: string }).text).toContain(
    answerPath(assignmentId, question.questionId),
  );
});
