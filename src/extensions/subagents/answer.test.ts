import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import { executeAnswer } from './answer.js';
import { assignmentPath, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { assignmentFor } from './fixtures/workerExtensionHarness.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const manager = 't-manager';
const worker = 't-worker';
const questionId = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

const runtimeOf = (fake: HcFake): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const socketRoot = (): string => {
  const root = mkdtempSync('/tmp/tau-answer-');

  chmodSync(root, 0o700);

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

const listFiles = (directory: string): string[] =>
  readdirSync(directory, { recursive: true }).map(String).toSorted();

const questionedAssignment = async (
  report: Assignment['report'] = null,
): Promise<{ assignment: Assignment; agent: string }> => {
  const agent = temporaryDirectory(onTestFinished, 'tau-answer-agent-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agent);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const assignment: Assignment = {
    ...assignmentFor(agent),
    parentTerminal: manager,
    questions: [{ questionId, text: 'Which value?', askedAt: 1 }],
    report,
  };

  await writeAssignment(assignment);

  return { assignment, agent };
};

const workerTerminal = (assignmentId: string, labels: Record<string, string>, state = 'live') =>
  JSON.stringify({
    address: worker,
    state,
    parent: manager,
    labels: { 'tau.assignment': assignmentPath(assignmentId), ...labels },
  });

const listWorker = (fake: HcFake, terminal: string): void => {
  fake.reply('ls', JSON.stringify({ terminals: [JSON.parse(terminal)] }));
  fake.reply('get', terminal);
};

it('sends one answer message to the live worker inbox and changes no assignment file', async () => {
  const { assignment, agent } = await questionedAssignment();

  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
    answer: (_request, save) => save(),
  });

  const fake = createHcFake();

  listWorker(
    fake,
    workerTerminal(assignment.assignmentId, { 'tau.inbox': `rpc1:${receiver.path}` }),
  );

  const path = assignmentPath(assignment.assignmentId);
  const before = readFileSync(path);
  const filesBefore = listFiles(agent);

  const result = await executeAnswer(runtimeOf(fake), {
    parameters: { assignmentId: assignment.assignmentId, questionId, answer: 'Use 42.' },
    parentSession: assignment.parentSession,
  });

  expect(result.details).toMatchObject({ status: 'queued', terminal: worker });
  expect(result.content[0]?.text).toContain(questionId);

  expect(receiver.savedRecords()).toEqual([
    receiver.sessionId,
    join(receiver.sessionId, `${questionId}.json`),
  ]);

  expect(readFileSync(path)).toEqual(before);
  expect(listFiles(agent)).toEqual(filesBefore);
});

it('refuses a worker without a live inbox with a restart recovery and stores nothing', async () => {
  const { assignment } = await questionedAssignment();

  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
    answer: (_request, save) => save(),
  });

  const fake = createHcFake();

  listWorker(fake, workerTerminal(assignment.assignmentId, {}));

  const result = await executeAnswer(runtimeOf(fake), {
    parameters: { assignmentId: assignment.assignmentId, questionId, answer: 'Use 42.' },
    parentSession: assignment.parentSession,
  });

  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('advertises no Tau inbox');
  expect(result.content[0]?.text).toContain('needs a restart');
  expect(receiver.savedRecords()).toEqual([]);
});

const report = { outcome: 'success' as const, summary: 'Done.', evidence: [] };

const earlierQuestionId = '7d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';
const missingAssignmentId = '8e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b';

it.each([
  ['another manager', {}, '/other/parent.jsonl', null],
  ['a reported assignment', {}, undefined, report],
  ['an earlier question', { questionId: earlierQuestionId }, undefined, null],
  ['a missing assignment', { assignmentId: missingAssignmentId }, undefined, null],
] as const)(
  'refuses an answer for %s and sends nothing',
  async (_name, changes, parentSession, saved) => {
    const { assignment } = await questionedAssignment(saved);
    const fake = createHcFake();

    const result = await executeAnswer(runtimeOf(fake), {
      parameters: {
        assignmentId: assignment.assignmentId,
        questionId,
        answer: 'Use 42.',
        ...changes,
      },
      parentSession: parentSession ?? assignment.parentSession,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Nothing was queued.');
    expect(fake.calls).toEqual([]);
  },
);

const otherAssignmentId = '9f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c';

it.each([
  ['a finished worker terminal', 'finished', undefined],
  ['a terminal of another assignment', 'live', otherAssignmentId],
] as const)(
  'refuses %s with a restart recovery and stores nothing',
  async (_name, state, labelledAssignmentId) => {
    const { assignment } = await questionedAssignment();

    await writeAssignment({
      ...assignment,
      assignmentId: otherAssignmentId,
      session: {
        ...assignment.session,
        file: join(dirname(assignmentPath(otherAssignmentId)), `${assignment.session.id}.jsonl`),
      },
    });

    const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), worker, {
      answer: (_request, save) => save(),
    });

    const fake = createHcFake();
    const labelled = labelledAssignmentId ?? assignment.assignmentId;

    listWorker(fake, workerTerminal(labelled, { 'tau.inbox': `rpc1:${receiver.path}` }, state));

    const result = await executeAnswer(runtimeOf(fake), {
      parameters: { assignmentId: assignment.assignmentId, questionId, answer: 'Use 42.' },
      parentSession: assignment.parentSession,
    });

    expect(result.content[0]?.text).toBe(
      `No live worker terminal carries assignment ${assignment.assignmentId}. Nothing was queued. A worker without a live inbox needs a restart on a current Tau before it can get an answer.`,
    );

    expect(receiver.savedRecords()).toEqual([]);
  },
);
