import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { skillTools } from '../../skillTools.js';
import { answerPath, formatAnswerReference, publishAnswer } from './answerRecord.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment, SavedQuestion } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import workerExtension from './workerExtension.js';
import { workerStartMessage } from './workerStart.js';
import { workerTools } from './workerTools.js';

const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';
const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
const sessionId = '11111111-1111-4111-8111-111111111111';

const safetyPath = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

const setup = (branch: SessionEntry[] = []) => {
  const directory = realpathSync(temporaryDirectory(onTestFinished, 'tau-worker-answer-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  const tools = workerTools(fixtureLoadout(directory), skillTools);
  const fake = createHcFake();

  fake.reply(
    'get',
    JSON.stringify({
      address: workerTerminal,
      state: 'live',
      parent: parentTerminal,
      labels: { 'tau.assignment': join(assignmentDirectory(assignmentId), 'assignment.json') },
    }),
  );

  const pi = fakeExtensionApi({
    exec: fake.exec,
    getThinkingLevel: () => 'off',
    getCommands: () => [
      { name: 'cc-safety-net', source: 'extension', sourceInfo: { path: safetyPath } },
    ],
    getAllTools: () => tools.map((name) => ({ name })),
    setActiveTools: () => undefined,
  } as unknown as Partial<ExtensionAPI>);

  const shutdown = vi.fn<ExtensionContext['shutdown']>();

  const context = {
    sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
    shutdown,
    cwd: directory,
    model: { provider: 'faux', id: 'test' },
    isProjectTrusted: () => true,
    ui: { notify: vi.fn<ExtensionToolContext['ui']['notify']>() },
  } as unknown as ExtensionToolContext;

  workerExtension(pi.pi);

  return { context, directory, pi, shutdown };
};

type Harness = ReturnType<typeof setup>;

const assignmentFor = (directory: string, questions: SavedQuestion[] = []): Assignment => ({
  version: 3,
  assignmentId,
  task: 'Inspect the fixture.',
  acceptance: [],
  label: null,
  profile: 'worker',
  loadout: fixtureLoadout(directory),
  routing: null,
  packageSnapshot: null,
  session: {
    id: sessionId,
    file: join(assignmentDirectory(assignmentId), `${sessionId}.jsonl`),
  },
  parentSession: join(directory, 'parent.jsonl'),
  cwd: directory,
  parentTerminal,
  deadline: Date.now() + 60_000,
  createdAt: Date.now(),
  previousAssignmentId: null,
  extensionPackages: null,
  questions,
  report: null,
});

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
  await writeAssignment(assignmentFor(directory));
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
  const harness = setup();

  await askQuestion(harness);
  await runInboxWake(harness, inboxMessage('handover', 'Pick up the parser work.'));

  expect(harness.shutdown).not.toHaveBeenCalled();
});

it('keeps waiting when the answer message has no answer file', async () => {
  const harness = setup();
  const questionId = await askQuestion(harness);

  await runInboxWake(
    harness,
    inboxMessage('answer', formatAnswerReference(assignmentId, questionId)),
  );

  expect(harness.shutdown).not.toHaveBeenCalled();
});

it('ends the wait when the answer for the open question is delivered', async () => {
  const harness = setup();
  const questionId = await askQuestion(harness);

  answer(questionId);

  await runInboxWake(
    harness,
    inboxMessage('answer', formatAnswerReference(assignmentId, questionId)),
  );

  expect(harness.shutdown).toHaveBeenCalledOnce();
});

it('keeps the sent reminder when an answer arrives after a user ended the wait', async () => {
  const harness = setup();
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

  const { context, directory, pi } = setup(branch);

  await writeAssignment(assignmentFor(directory, [question]));
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
