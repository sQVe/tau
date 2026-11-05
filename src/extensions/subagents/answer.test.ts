import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import { readEnvelope } from '../../inbox/envelope.js';
import { executeAnswer } from './answer.js';
import { answerPath } from './answerRecord.js';
import { assignmentDirectory, assignmentPath, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';

interface Fixture {
  root: string;
  fake: HcFake;
  assignment: Assignment;
  questionId: string;
}

const publishFailure = vi.hoisted(() => ({ step: undefined as 'link' | 'cleanup' | undefined }));

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    linkSync: (...parameters: Parameters<typeof actual.linkSync>) => {
      if (publishFailure.step === 'link') {
        throw new Error('link failed');
      }

      actual.linkSync(...parameters);
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      const isTemporary = String(path).includes('.receipt-');

      if (publishFailure.step === 'cleanup' && isTemporary) {
        throw new Error('cleanup failed');
      }

      actual.unlinkSync(path);
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  publishFailure.step = undefined;
});

const manager = 't-manager';

const worker = 't-worker';

const parentSession = '/work/parent.jsonl';

const savedAssignment = (directory: string, questionId: string): Assignment => {
  const assignmentId = randomUUID();
  const sessionId = randomUUID();

  return {
    version: 3,
    assignmentId,
    task: 'Inspect the counters.',
    acceptance: ['The counters are inspected.'],
    label: null,
    profile: 'worker',
    loadout: fixtureLoadout(directory),
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`) },
    parentSession,
    cwd: directory,
    parentTerminal: manager,
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: [],
    questions: [{ questionId, text: 'Which counter?', askedAt: Date.now() }],
    report: null,
  };
};

const liveLease = (sessionId: string): string => `${sessionId}:${Date.now() + 60_000}`;

const workerTerminal = (assignment: Assignment) => ({
  address: worker,
  state: 'live',
  parent: manager,
  labels: {
    'tau.assignment': assignmentPath(assignment.assignmentId),
    'tau.inbox': liveLease(assignment.session.id),
  },
});

const setup = async (): Promise<Fixture> => {
  const directory = temporaryDirectory(onTestFinished, 'tau-answer-');
  const root = await createTemporaryRepository(onTestFinished);

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const questionId = randomUUID();
  const assignment = savedAssignment(directory, questionId);

  await writeAssignment(assignment);

  const fake = createHcFake();
  const terminal = workerTerminal(assignment);

  fake.reply('ls', JSON.stringify({ terminals: [terminal] }));
  fake.reply('get', JSON.stringify(terminal));
  fake.reply('label', JSON.stringify(terminal));

  return { root, fake, assignment, questionId };
};

const answer = (
  fixture: Fixture,
  overrides: Record<string, string> = {},
  exec: Exec = fixture.fake.exec,
  signal?: AbortSignal,
) =>
  executeAnswer(
    { hc: { exec, connect: fixture.fake.connect, cwd: fixture.root } },
    {
      parameters: {
        assignmentId: fixture.assignment.assignmentId,
        questionId: fixture.questionId,
        answer: 'Use the second counter.',
        ...overrides,
      },
      parentSession,
      cwd: fixture.root,
    },
    signal,
  );

const messageLabels = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments);

const inboxFiles = (root: string): string[] => {
  const directory = join(root, '.tau', 'inbox');

  return existsSync(directory) ? readdirSync(directory) : [];
};

const resultText = (result: Awaited<ReturnType<typeof executeAnswer>>): string =>
  result.content.map((part) => part.text).join('\n');

it('saves the answer, leaves the assignment unchanged, and queues one message', async () => {
  const fixture = await setup();
  const path = assignmentPath(fixture.assignment.assignmentId);
  const before = readFileSync(path);

  const result = await answer(fixture);

  const saved = answerPath(fixture.assignment.assignmentId, fixture.questionId);

  expect(result.isError).toBeUndefined();

  expect(result.details).toMatchObject({
    status: 'queued',
    assignmentId: fixture.assignment.assignmentId,
    questionId: fixture.questionId,
    answerPath: saved,
    terminal: worker,
  });

  expect(existsSync(saved)).toBe(true);
  expect(readFileSync(path)).toEqual(before);
  expect(messageLabels(fixture.fake)).toHaveLength(1);
  expect(inboxFiles(fixture.root)).toHaveLength(1);
  expect(resultText(result)).toContain(saved);

  const messageId = result.details?.messageId ?? '';

  await expect(
    readEnvelope(join(fixture.root, '.tau', 'inbox', `${messageId}.json`), {
      messageId,
      terminal: worker,
    }),
  ).resolves.toMatchObject({
    kind: 'valid',
    envelope: { family: 'answer', targetSessionId: fixture.assignment.session.id },
  });
});

const replyWorker = (fixture: Fixture, changes: Record<string, unknown>) => {
  fixture.fake.reply('get', JSON.stringify({ ...workerTerminal(fixture.assignment), ...changes }));
};

const expectNothingWritten = (fixture: Fixture) => {
  expect(existsSync(answerPath(fixture.assignment.assignmentId, fixture.questionId))).toBe(false);
  expect(inboxFiles(fixture.root)).toEqual([]);
  expect(messageLabels(fixture.fake)).toEqual([]);
};

it('refuses a worker without an inbox lease and writes nothing', async () => {
  const fixture = await setup();
  const { 'tau.inbox': _lease, ...labels } = workerTerminal(fixture.assignment).labels;

  replyWorker(fixture, { labels });

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain(`${worker} has no inbox lease`);
  expect(resultText(result)).toContain('restart the worker');
  expectNothingWritten(fixture);
});

it('refuses a lease that names another session and writes nothing', async () => {
  const fixture = await setup();

  replyWorker(fixture, {
    labels: {
      'tau.assignment': assignmentPath(fixture.assignment.assignmentId),
      'tau.inbox': liveLease(randomUUID()),
    },
  });

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain(`not worker session ${fixture.assignment.session.id}`);
  expectNothingWritten(fixture);
});

it('refuses a malformed assignment file and writes nothing', async () => {
  const fixture = await setup();
  const path = assignmentPath(fixture.assignment.assignmentId);

  writeFileSync(path, '{"version":3}\n');

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain(path);
  expectNothingWritten(fixture);
});

it.each([
  { case: 'parent', parent: 't-other-manager', label: undefined },
  { case: 'assignment label', parent: manager, label: '/elsewhere/assignment.json' },
])('refuses a terminal whose $case changed before publishing', async ({ parent, label }) => {
  const fixture = await setup();
  const exec = fixture.fake.exec;
  let reads = 0;

  const changingExec: Exec = async (command, commandArguments, options) => {
    const result = await exec(command, commandArguments, options);

    if (commandArguments[0] === 'get') {
      reads += 1;
    }

    if (reads === 2) {
      const { labels } = workerTerminal(fixture.assignment);

      replyWorker(fixture, {
        parent,
        labels: { ...labels, 'tau.assignment': label ?? labels['tau.assignment'] },
      });
    }

    return result;
  };

  const result = await answer(fixture, {}, changingExec);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain(`${worker} changed before the answer was saved`);
  expectNothingWritten(fixture);
});

it('refuses a second answer to the same question and keeps the first', async () => {
  const fixture = await setup();
  const saved = answerPath(fixture.assignment.assignmentId, fixture.questionId);

  await answer(fixture);

  const first = readFileSync(saved);

  const result = await answer(fixture, { answer: 'Use the first counter.' });

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain('already has an answer');
  expect(readFileSync(saved)).toEqual(first);
  expect(messageLabels(fixture.fake)).toHaveLength(1);
});

it('reports the saved answer path and does not retry when queueing fails', async () => {
  const fixture = await setup();
  const saved = answerPath(fixture.assignment.assignmentId, fixture.questionId);

  fixture.fake.fail('label', 'label failed', 1);

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain(`Answer saved at ${saved}, queueing not confirmed`);
  expect(existsSync(saved)).toBe(true);
  expect(messageLabels(fixture.fake)).toHaveLength(1);
});

it('refuses a missing assignment and writes nothing', async () => {
  const fixture = await setup();
  const path = assignmentPath(fixture.assignment.assignmentId);

  unlinkSync(path);

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain(`Missing assignment ${path}`);
  expectNothingWritten(fixture);
});

it('refuses when no live child of this manager carries the assignment', async () => {
  const fixture = await setup();

  fixture.fake.reply('ls', JSON.stringify({ terminals: [] }));

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain('No live worker terminal');
  expectNothingWritten(fixture);
});

it('refuses outside an hc terminal and writes nothing', async () => {
  const fixture = await setup();

  vi.stubEnv('HC_TERMINAL_ID', undefined);

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain('HC_TERMINAL_ID');
  expectNothingWritten(fixture);
});

it('answers when a terminal of another manager cannot be read', async () => {
  const fixture = await setup();
  const exec = fixture.fake.exec;

  fixture.fake.reply(
    'ls',
    JSON.stringify({
      terminals: [
        { address: 't-stranger', state: 'live', parent: 't-other-manager' },
        workerTerminal(fixture.assignment),
      ],
    }),
  );

  const strangerFails: Exec = async (command, commandArguments, options) =>
    commandArguments.includes('t-stranger')
      ? { code: 1, killed: false, truncated: false, stdout: '', stderr: 'gone' }
      : exec(command, commandArguments, options);

  const result = await answer(fixture, {}, strangerFails);

  expect(result.details?.status).toBe('queued');
});

it('reports a saved answer and queues nothing when publication fails after the link', async () => {
  const fixture = await setup();
  const saved = answerPath(fixture.assignment.assignmentId, fixture.questionId);

  publishFailure.step = 'cleanup';

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain(`Answer saved at ${saved}, queueing not confirmed`);
  expect(existsSync(saved)).toBe(true);
  expect(inboxFiles(fixture.root)).toEqual([]);
  expect(messageLabels(fixture.fake)).toEqual([]);
});

it('reports a plain failure when publication fails before the link', async () => {
  const fixture = await setup();

  publishFailure.step = 'link';

  const result = await answer(fixture);

  expect(result.isError).toBe(true);
  expect(resultText(result)).toBe('link failed');
  expectNothingWritten(fixture);
});

it('saves nothing when the call is aborted during the final terminal read', async () => {
  const fixture = await setup();
  const path = assignmentPath(fixture.assignment.assignmentId);
  const before = readFileSync(path);
  const controller = new AbortController();
  const exec = fixture.fake.exec;
  let reads = 0;

  const abortingExec: Exec = async (command, commandArguments, options) => {
    const result = await exec(command, commandArguments, options);

    if (commandArguments[0] === 'get') {
      reads += 1;
    }

    if (reads === 3) {
      controller.abort();
    }

    return result;
  };

  const result = await answer(fixture, {}, abortingExec, controller.signal);

  expect(reads).toBe(3);
  expect(result.isError).toBe(true);
  expectNothingWritten(fixture);
  expect(readFileSync(path)).toEqual(before);
});
