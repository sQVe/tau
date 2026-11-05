import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { readAnswer, parseAnswerReference } from '../src/extensions/subagents/answerRecord.js';
import {
  assignmentDirectory,
  assignmentPath,
  writeAssignment,
} from '../src/extensions/subagents/assignment.js';
import { fixtureLoadout } from '../src/extensions/subagents/fixtures/loadout.js';
import subagentsExtension, {
  registerCapacityRefusal,
} from '../src/extensions/subagents/subagents.js';
import { readEnvelope } from '../src/inbox/envelope.js';
import { fakeExtensionApi } from './extensionApi.js';
import { createTemporaryRepository } from './gitRepository.js';
import { createHcFake } from './hcFake.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const manager = 't-manager';

const worker = 't-worker';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('queues one answer envelope and label for the worker that asked', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-answer-agent-');
  const root = await createTemporaryRepository(onTestFinished);
  const parentSession = join(root, 'parent.jsonl');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const assignmentId = randomUUID();
  const sessionId = randomUUID();
  const questionId = randomUUID();

  await writeAssignment({
    version: 3,
    assignmentId,
    task: 'Inspect the counters.',
    acceptance: [],
    label: null,
    profile: 'scout',
    loadout: fixtureLoadout(root),
    routing: null,
    packageSnapshot: null,
    session: { id: sessionId, file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`) },
    parentSession,
    cwd: root,
    parentTerminal: manager,
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    previousAssignmentId: null,
    extensionPackages: [],
    questions: [{ questionId, text: 'Which counter?', askedAt: Date.now() }],
    report: null,
  });

  const terminal = {
    address: worker,
    state: 'live',
    parent: manager,
    labels: {
      'tau.assignment': assignmentPath(assignmentId),
      'tau.inbox': `${sessionId}:${Date.now() + 60_000}`,
    },
  };

  const fake = createHcFake();

  fake.reply('ls', JSON.stringify({ terminals: [terminal] }));
  fake.reply('get', JSON.stringify(terminal));
  fake.reply('label', JSON.stringify(terminal));

  const pi = fakeExtensionApi({ exec: fake.exec });

  subagentsExtension(pi.pi, registerCapacityRefusal(pi.pi));

  const tool = pi.tools.get('subagent_answer');

  if (tool === undefined) {
    throw new Error('The subagent_answer tool was not registered.');
  }

  const context = {
    cwd: root,
    sessionManager: { getSessionFile: () => parentSession },
  } as unknown as ExtensionToolContext;

  await tool.execute(
    'call',
    { assignmentId, questionId, answer: 'Use the second counter.' },
    undefined,
    undefined,
    context,
  );

  const labels = fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments);

  expect(labels).toHaveLength(1);
  expect(labels[0]).toContain(worker);

  const [, messageId, envelopePath] =
    /^tau\.inbox\.([^=]+)=(.+)$/.exec(labels[0]?.at(-1) ?? '') ?? [];

  const envelope = await readEnvelope(envelopePath ?? '', {
    messageId: messageId ?? '',
    terminal: worker,
  });

  if (envelope.kind !== 'valid') {
    throw new Error(`The answer envelope is not valid: ${JSON.stringify(envelope)}`);
  }

  expect(envelope.envelope).toMatchObject({ family: 'answer', targetSessionId: sessionId });

  const reference = parseAnswerReference(envelope.envelope.text);

  expect(reference).toMatchObject({ assignmentId, questionId });

  await expect(readAnswer(assignmentId, questionId)).resolves.toMatchObject({
    kind: 'answered',
    record: { answer: 'Use the second counter.' },
  });
});
