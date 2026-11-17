import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { MessageRequest } from '../../inbox/inbox.js';
import { decodeRequest } from '../../inbox/protocol.js';
import type { MessageReply } from '../../inbox/protocol.js';
import { answerRequestCheck } from './answerRequest.js';
import { assignmentPath, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { assignmentFor } from './fixtures/workerExtensionHarness.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const manager = 't-manager';
const worker = 't-worker';
const managerSession = 'manager-session';
const questionId = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const earlierQuestionId = '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';

const runtimeOf = (fake: HcFake): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const socketRoot = (): string => {
  const root = mkdtempSync('/tmp/tau-answer-request-');

  chmodSync(root, 0o700);

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

const questionedAssignment = async (
  report: Assignment['report'] = null,
  questions: Assignment['questions'] = [{ questionId, text: 'Which value?', askedAt: 1 }],
): Promise<{ assignment: Assignment; agent: string }> => {
  const agent = temporaryDirectory(onTestFinished, 'tau-answer-request-agent-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const assignment: Assignment = {
    ...assignmentFor(agent),
    parentTerminal: manager,
    questions,
    report,
  };

  await writeAssignment(assignment);

  return { assignment, agent };
};

const workerTerminal = (assignmentId: string, labels: Record<string, string>) =>
  JSON.stringify({
    address: worker,
    state: 'live',
    parent: manager,
    labels: { 'tau.assignment': assignmentPath(assignmentId), ...labels },
  });

const listWorker = (fake: HcFake, terminal: string): void => {
  fake.reply('ls', JSON.stringify({ terminals: [JSON.parse(terminal)] }));
  fake.reply('get', terminal);
};

const decode = (frame: unknown): MessageRequest => {
  const decision = decodeRequest(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));

  if (decision.kind !== 'frame') {
    throw new Error(decision.reason);
  }

  return decision.value;
};

const answerRequestFor = (assignment: Assignment): MessageRequest =>
  decode({
    protocol: 'rpc1',
    kind: 'message',
    messageId: questionId,
    targetTerminal: manager,
    targetSessionId: managerSession,
    family: 'answer-request',
    payload: { assignmentId: assignment.assignmentId, questionId, answer: 'Use 42.' },
  });

const queuedReply = () => ({
  protocol: 'rpc1' as const,
  kind: 'queued' as const,
  messageId: questionId,
  terminal: manager,
  sessionId: managerSession,
});

const saveSpy = () => vi.fn<() => Promise<MessageReply>>(async () => queuedReply());

it('queues the answer on the worker socket and saves nothing in the manager inbox', async () => {
  const { assignment } = await questionedAssignment();

  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
    answer: (_request, save) => save(),
  });

  const fake = createHcFake();

  listWorker(
    fake,
    workerTerminal(assignment.assignmentId, { 'tau.inbox': `rpc1:${receiver.path}` }),
  );

  const save = saveSpy();

  const facts = {
    hc: runtimeOf(fake),
    parentSession: assignment.parentSession,
    terminal: manager,
    sessionId: managerSession,
  };

  const result = await answerRequestCheck(() => facts)(answerRequestFor(assignment), save);

  expect(result).toEqual({
    protocol: 'rpc1',
    kind: 'queued',
    messageId: questionId,
    terminal: manager,
    sessionId: managerSession,
  });

  expect(receiver.savedRecords()).toEqual([
    receiver.sessionId,
    join(receiver.sessionId, `${questionId}.json`),
  ]);

  expect(save).not.toHaveBeenCalled();
});

it('refuses an answer for a reported assignment and queues nothing', async () => {
  const { assignment } = await questionedAssignment({
    outcome: 'success',
    summary: 'Done.',
    evidence: [],
  });

  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
    answer: (_request, save) => save(),
  });

  const save = saveSpy();

  const facts = {
    hc: runtimeOf(createHcFake()),
    parentSession: assignment.parentSession,
    terminal: manager,
    sessionId: managerSession,
  };

  const result = await answerRequestCheck(() => facts)(answerRequestFor(assignment), save);

  expect(result).toEqual(expect.stringContaining('already has a report'));
  expect(receiver.savedRecords()).toEqual([]);
  expect(save).not.toHaveBeenCalled();
});

it('refuses an answer for an older question and queues nothing', async () => {
  const { assignment } = await questionedAssignment(null, [
    { questionId: earlierQuestionId, text: 'Which value?', askedAt: 1 },
  ]);

  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
    answer: (_request, save) => save(),
  });

  const save = saveSpy();

  const facts = {
    hc: runtimeOf(createHcFake()),
    parentSession: assignment.parentSession,
    terminal: manager,
    sessionId: managerSession,
  };

  const result = await answerRequestCheck(() => facts)(answerRequestFor(assignment), save);

  expect(result).toEqual(expect.stringContaining('is not the open question'));
  expect(receiver.savedRecords()).toEqual([]);
  expect(save).not.toHaveBeenCalled();
});

it('refuses when the manager has no saved session file', async () => {
  const { assignment } = await questionedAssignment();

  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
    answer: (_request, save) => save(),
  });

  const save = saveSpy();

  const facts = {
    hc: runtimeOf(createHcFake()),
    parentSession: undefined,
    terminal: manager,
    sessionId: managerSession,
  };

  const result = await answerRequestCheck(() => facts)(answerRequestFor(assignment), save);

  expect(result).toBe('This session has no saved Pi session file, so it cannot answer a worker.');
  expect(receiver.savedRecords()).toEqual([]);
  expect(save).not.toHaveBeenCalled();
});

it('refuses a handover family', async () => {
  const { assignment } = await questionedAssignment();

  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
    answer: (_request, save) => save(),
  });

  const request = decode({
    protocol: 'rpc1',
    kind: 'message',
    messageId: questionId,
    targetTerminal: manager,
    targetSessionId: managerSession,
    family: 'handover',
    payload: { text: 'handover text' },
  });

  const save = saveSpy();

  const facts = {
    hc: runtimeOf(createHcFake()),
    parentSession: assignment.parentSession,
    terminal: manager,
    sessionId: managerSession,
  };

  const result = await answerRequestCheck(() => facts)(request, save);

  expect(result).toBe('This check accepts answer requests, not handover messages.');
  expect(receiver.savedRecords()).toEqual([]);
  expect(save).not.toHaveBeenCalled();
});

it('reports an unknown result when the worker socket writes no reply', async () => {
  const { assignment } = await questionedAssignment();
  const path = join(socketRoot(), `${randomUUID()}.sock`);

  const server = createServer((socket) => {
    socket.on('data', () => socket.destroy());
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const fake = createHcFake();

  listWorker(fake, workerTerminal(assignment.assignmentId, { 'tau.inbox': `rpc1:${path}` }));

  const save = saveSpy();

  const facts = {
    hc: runtimeOf(fake),
    parentSession: assignment.parentSession,
    terminal: manager,
    sessionId: managerSession,
  };

  const result = await answerRequestCheck(() => facts)(answerRequestFor(assignment), save);

  expect(result).toMatchObject({
    protocol: 'rpc1',
    kind: 'unknown',
    messageId: questionId,
  });

  expect(save).not.toHaveBeenCalled();
});
