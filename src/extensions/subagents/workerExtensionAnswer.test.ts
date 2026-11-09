import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { acceptChecks, createReceiptStore, createReceiver } from '../../inbox/inbox.js';
import type { MessageRequest } from '../../inbox/inbox.js';
import { writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { assignmentFor, dispatch, setup } from './fixtures/workerExtensionHarness.js';

const questionId = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const sessionId = '11111111-1111-1111-1111-111111111111';

const startWorker = async () => {
  const worker = setup();

  const assignment: Assignment = {
    ...assignmentFor(worker.directory),
    questions: [{ questionId, text: 'Which value?', askedAt: 1 }],
  };

  await writeAssignment(assignment);

  Object.assign(worker.context.sessionManager, {
    getBranch: () => [
      { type: 'message', message: { role: 'toolResult', toolName: 'subagent_question' } },
    ],
  });

  await worker.pi.handler('session_start')({}, worker.context);

  const records = join(temporaryDirectory(onTestFinished, 'tau-worker-inbox-'), sessionId);
  const check = acceptChecks().answer;

  if (check === undefined) {
    throw new Error('The worker set no answer check.');
  }

  const receiver = createReceiver({
    directory: records,
    terminal: 'worker-1',
    sessionId,
    accepts: { answer: check },
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: () => true,
    notify: () => undefined,
  });

  const savedRecords = (): string[] => {
    try {
      return readdirSync(records);
    } catch {
      return [];
    }
  };

  return { ...worker, assignment, receiver, records, savedRecords };
};

const answerTo = (assignment: Assignment, answer: string, id = questionId): MessageRequest => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId: id,
  targetTerminal: 'worker-1',
  targetSessionId: sessionId,
  family: 'answer',
  payload: {
    assignmentId: assignment.assignmentId,
    questionId: id,
    parentSession: assignment.parentSession,
    answer,
  },
});

it('refuses an answer to the earlier question while a new question is being saved', async () => {
  const { assignment, context, pi, receiver, savedRecords } = await startWorker();
  const question = pi.tools.get('subagent_question');

  if (question === undefined) {
    throw new Error('The question tool was not registered.');
  }

  const asking = question.execute('call', { question: 'And now?' }, undefined, undefined, context);
  const reply = await receiver.accept(answerTo(assignment, 'Use 42.'));

  await asking;

  expect(reply).toMatchObject({
    kind: 'refused',
    reason: `Question ${questionId} is not the open question of assignment ${assignment.assignmentId}.`,
  });

  expect(savedRecords()).toEqual([]);
});

it('refuses an answer after the report is saved', async () => {
  const { assignment, context, pi, receiver, savedRecords } = await startWorker();
  const report = pi.tools.get('subagent_report');

  if (report === undefined) {
    throw new Error('The report tool was not registered.');
  }

  const reporting = report.execute(
    'call',
    {
      outcome: 'success',
      summary:
        'Done.\n\n## Changes\nNone\n## Evidence\nNone\n## Decisions\nNone\n## Concerns\nNone',
      evidence: [],
    },
    undefined,
    undefined,
    context,
  );

  const reply = await receiver.accept(answerTo(assignment, 'Use 42.'));

  await reporting;

  expect(reply).toMatchObject({
    kind: 'refused',
    reason: `Assignment ${assignment.assignmentId} already has a report.`,
  });

  expect(savedRecords()).toEqual([]);
});

it('stores a repeated answer once and refuses a different second answer', async () => {
  const { assignment, receiver, records, savedRecords } = await startWorker();

  await expect(receiver.accept(answerTo(assignment, 'Use 42.'))).resolves.toMatchObject({
    kind: 'queued',
  });

  await expect(receiver.accept(answerTo(assignment, 'Use 42.'))).resolves.toMatchObject({
    kind: 'queued',
  });

  await expect(receiver.accept(answerTo(assignment, 'Use 7.'))).resolves.toMatchObject({
    kind: 'refused',
  });

  expect(savedRecords()).toEqual([`${questionId}.json`]);
  expect(readFileSync(join(records, `${questionId}.json`), 'utf8')).toContain('Use 42.');
});

const inboxMessage = (details: Record<string, unknown>) => ({
  type: 'message_start',
  message: {
    role: 'custom',
    customType: 'tau-inbox-message',
    content: 'Use 42.',
    display: true,
    details: { version: 2, messageId: questionId, sessionId, ...details },
    timestamp: 1,
  },
});

it('ends the question wait when the answer to the open question is shown', async () => {
  const { context, pi, shutdown } = await startWorker();

  pi.handler('message_start')(inboxMessage({ family: 'answer', questionId }), context);
  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});

it('keeps waiting for the answer when a handover is shown', async () => {
  const { context, pi, shutdown } = await startWorker();

  pi.handler('message_start')(inboxMessage({ family: 'handover' }), context);
  dispatch(pi, 'agent_settled', {}, context);

  expect(shutdown).not.toHaveBeenCalled();
});
