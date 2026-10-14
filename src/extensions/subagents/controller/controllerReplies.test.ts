import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import * as questions from '../questionRecords.js';
import { readTask, recordEvent } from '../records.js';
import * as records from '../records.js';
import { WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';

vi.mock(import('node:fs'), { spy: true });

it('saves a clarification once without sending pane input', async ({ onTestFinished }) => {
  vi.useFakeTimers();

  const { controller, input, calls, notifications, directory } = setup(onTestFinished);

  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');

  const question = {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  };

  questions.acceptQuestion(launched.directory, task.taskId, question);

  expect(controller).toHaveProperty('reply');
  expect(controller.status(task.taskId, 'parent-id').pendingQuestion).toEqual(question);

  const answer = {
    questionId: question.questionId,
    replyId: 'reply-one',
    reply: 'source.txt',
  };

  expect(() => controller.reply(task.taskId, 'wrong-parent', answer)).toThrow('another parent');

  expect(() =>
    controller.reply(task.taskId, 'parent-id', { ...answer, questionId: 'wrong' }),
  ).toThrow('pending question');

  const result = controller.reply(task.taskId, 'parent-id', answer);
  expect(result).toMatchObject({ replyAccepted: true });
  expect(result).toMatchObject({ workerAcknowledged: false });
  expect(result).toMatchObject({ name: task.name });
  controller.reply(task.taskId, 'parent-id', answer);
  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
  expect(records.readTask(launched.directory)).toEqual(task);

  expect(
    questions.readAcknowledgement(launched.directory, task.taskId, question.questionId),
  ).toBeUndefined();

  expect(notifications).toEqual([]);

  controller.close();
  const recovered = new WorkerController(directory);

  expect(recovered.status(task.taskId, 'parent-id').pendingQuestion).toEqual({
    ...question,
    replySaved: true,
  });

  expect(() => recovered.reply(task.taskId, 'parent-id', answer)).toThrow('active');
  recovered.close();
});

it('treats an unreadable acknowledgement as unacknowledged on a repeated reply', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);

  const launched = await controller.launch(input);
  const task = readTask(launched.directory);
  recordEvent(launched.directory, task.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, task.taskId, {
    version: 1,
    taskId: task.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const answer = {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
  };

  controller.reply(task.taskId, 'parent-id', answer);
  writeFileSync(join(launched.directory, 'acknowledgement-question-one.json'), '{}');

  const repeated = controller.reply(task.taskId, 'parent-id', answer);

  expect(repeated).toMatchObject({ replyAccepted: true, workerAcknowledged: false });
});

it('refuses a conflicting reply to an answered question', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const answer = {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
  };

  controller.reply(launched.taskId, 'parent-id', answer);

  expect(controller.questionReceipt(launched.taskId, 'parent-id', 'question-one')).toMatchObject({
    reply: { replyId: 'reply-one' },
    acknowledgement: undefined,
  });

  expect(() =>
    controller.reply(launched.taskId, 'parent-id', { ...answer, reply: 'changed' }),
  ).toThrow('Conflicting');
});

it('saves a reply through a restarted parent that reattached the worker', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(
    recovered.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
    }),
  ).toMatchObject({ replyAccepted: true, workerAcknowledged: false });

  expect(questions.readReply(launched.directory, launched.taskId, 'question-one')?.replyId).toBe(
    'reply-one',
  );

  expect(fixture.calls.some((call) => call[1] === 'prompt')).toBe(false);
});

it('notifies the parent once while waiting and refuses replies after the original deadline', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const { controller, input, notifications, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);
  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  await vi.advanceTimersByTimeAsync(500);
  expect(notifications).toHaveLength(1);

  expect(notifications[0]?.content).toMatchObject({
    state: 'awaitingReply',
    pendingQuestion: { questionId: 'question-one', question: 'Which file?' },
  });

  expect(notifications[0]?.question).toBe(true);
  expect(controller.status(launched.taskId, 'parent-id').deadline).toBe(launched.deadline);
  await vi.advanceTimersByTimeAsync(7500);

  expect(() =>
    controller.reply(launched.taskId, 'parent-id', {
      questionId: 'question-one',
      replyId: 'reply-one',
      reply: 'source.txt',
    }),
  ).toThrow('active');

  expect(calls.some((call) => call[1] === 'prompt')).toBe(false);
  expect(questions.readReply(launched.directory, launched.taskId, 'question-one')).toBeUndefined();
});
