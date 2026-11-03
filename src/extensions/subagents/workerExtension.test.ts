import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { nestedChangeCallReason, nestedControlCallReason } from '../../codemode/controlTools.js';
import { skillTools } from '../../skillTools.js';
import { assignmentDirectory, writeAssignment } from './assignment.js';
import type { Assignment } from './assignment.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import workerExtension from './workerExtension.js';
import { workerTools } from './workerTools.js';

const workerTerminal = 'worker-1';
const parentTerminal = 'manager-1';
const assignmentId = '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f';
const sessionId = '11111111-1111-1111-1111-111111111111';

const safetyPath = join(
  dirname(fileURLToPath(import.meta.resolve('cc-safety-net/package.json'))),
  'dist',
  'pi',
  'index.js',
);

const setup = (assignmentPath?: string) => {
  const directory = realpathSync(temporaryDirectory(onTestFinished, 'tau-worker-extension-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  vi.stubEnv('TAU_ROLE', 'worker');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('HC_TERMINAL_ID', workerTerminal);

  const loadout = fixtureLoadout(directory);
  const tools = workerTools(loadout, skillTools);
  const fake = createHcFake();
  const path = assignmentPath ?? join(assignmentDirectory(assignmentId), 'assignment.json');

  fake.reply(
    'get',
    JSON.stringify({
      address: workerTerminal,
      state: 'live',
      parent: parentTerminal,
      labels: { 'tau.assignment': path },
    }),
  );

  const activeTools = vi.fn<(names: string[]) => void>();

  const pi = fakeExtensionApi({
    exec: fake.exec,
    getThinkingLevel: () => 'off',
    getCommands: () => [
      { name: 'cc-safety-net', source: 'extension', sourceInfo: { path: safetyPath } },
    ],
    getAllTools: () => tools.map((name) => ({ name })),
    setActiveTools: activeTools,
  } as unknown as Partial<ExtensionAPI>);

  const shutdown = vi.fn<ExtensionContext['shutdown']>();

  const context = {
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => sessionId,
      getSessionFile: () => join(directory, `${sessionId}.jsonl`),
    },
    shutdown,
    cwd: directory,
    model: { provider: 'faux', id: 'test' },
    isProjectTrusted: () => true,
    ui: { notify: vi.fn<ExtensionToolContext['ui']['notify']>() },
  } as unknown as ExtensionToolContext;

  workerExtension(pi.pi);

  return { activeTools, assignmentPath: path, context, directory, loadout, pi, shutdown, tools };
};

const assignmentFor = (directory: string): Assignment => ({
  version: 2,
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
  questions: [],
  report: null,
});

it('stops the worker with a visible error when the assignment file is missing', async () => {
  const { context, pi, shutdown } = setup(join('/nonexistent', 'assignment.json'));

  await pi.handler('session_start')({}, context);

  expect(context.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Missing assignment file'),
    'error',
  );

  expect(shutdown).toHaveBeenCalledOnce();
});

it('stops the worker with a visible error when the assignment file is malformed', async () => {
  const { assignmentPath, context, pi, shutdown } = setup();

  mkdirSync(dirname(assignmentPath), { recursive: true });
  writeFileSync(assignmentPath, '{ not json');

  await pi.handler('session_start')({}, context);

  expect(context.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining('Malformed assignment'),
    'error',
  );

  expect(shutdown).toHaveBeenCalledOnce();
});

it('reads the assignment, activates its tools, and sends the first task prompt', async () => {
  const { activeTools, context, directory, loadout, pi, shutdown, tools } = setup();

  await writeAssignment(assignmentFor(directory));

  await pi.handler('session_start')({}, context);

  expect(context.ui.notify).not.toHaveBeenCalled();
  expect(shutdown).not.toHaveBeenCalled();
  expect(activeTools).toHaveBeenCalledWith(tools);

  expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('Inspect the fixture.'));
  expect(loadout.model).toBe('faux/test');
});

it('keeps a reloaded worker waiting without a second task prompt', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));

  Object.assign(context.sessionManager, {
    getBranch: () => [
      { type: 'message', message: { role: 'user', content: 'Task' } },
      { type: 'message', message: { role: 'toolResult', toolName: 'subagent_question' } },
    ],
  });

  await pi.handler('session_start')({}, context);

  expect(pi.sendUserMessage).not.toHaveBeenCalled();
  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toBeUndefined();

  pi.handler('agent_settled')({}, context);

  expect(shutdown).not.toHaveBeenCalled();
});

it('shuts a reloaded worker down without a message when its assignment already has a report', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment({
    ...assignmentFor(directory),
    report: {
      outcome: 'success',
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    },
  });

  Object.assign(context.sessionManager, {
    getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Task' } }],
  });

  await pi.handler('session_start')({}, context);

  expect(pi.sendUserMessage).not.toHaveBeenCalled();
  expect(shutdown).toHaveBeenCalledOnce();
});

it('sends one continuation message to a reloaded worker with a sent task and no pending question', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));

  Object.assign(context.sessionManager, {
    getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Task' } }],
  });

  await pi.handler('session_start')({}, context);

  expect(pi.sendUserMessage).toHaveBeenCalledOnce();
  expect(shutdown).not.toHaveBeenCalled();
});

it('reminds again for a report after the parent answers a question the reminded worker asked', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });

  const question = pi.tools.get('subagent_question');

  if (question === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await question.execute(
    'question',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'user', content: 'Use A.' } },
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });
});

it('does not restart the report reminder when a non-user message starts', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toBeUndefined();
});

it('shuts the worker down after a settled report', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const tool = pi.tools.get('subagent_report');

  if (tool === undefined) {
    throw new Error('The report tool was not registered.');
  }

  Object.assign(context.sessionManager, {
    getBranch: () => [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall' }],
        },
      },
    ],
  });

  await tool.execute(
    'call',
    {
      outcome: 'success',
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    },
    undefined,
    undefined,
    context,
  );

  pi.handler('agent_settled')({}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});

it('keeps the worker running and skips the report reminder when its turn ends on a question', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const tool = pi.tools.get('subagent_question');

  if (tool === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await tool.execute(
    'call',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toBeUndefined();

  pi.handler('agent_settled')({}, context);

  expect(shutdown).not.toHaveBeenCalled();
});

it('shuts the worker down when a report is saved after a question in the same run', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const question = pi.tools.get('subagent_question');
  const report = pi.tools.get('subagent_report');

  if (question === undefined || report === undefined) {
    throw new Error('The question and report tools must be registered.');
  }

  await question.execute(
    'question',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  await report.execute(
    'report',
    {
      outcome: 'success',
      summary: 'Changes: None\nEvidence: None\nDecisions: None\nConcerns: None',
      evidence: [],
    },
    undefined,
    undefined,
    context,
  );

  pi.handler('agent_settled')({}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});

it('reminds for a report after a reply is consumed while the turn streams', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const question = pi.tools.get('subagent_question');

  if (question === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await question.execute(
    'question',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  pi.handler('message_start')(
    { type: 'message_start', message: { role: 'user', content: 'Use A.' } },
    context,
  );

  expect(pi.handler('agent_before_settle')({ entries: [] }, context)).toMatchObject({
    continue: true,
  });
});

it('shuts the worker down when the turn that answers its question settles', async () => {
  const { context, directory, pi, shutdown } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const tool = pi.tools.get('subagent_question');

  if (tool === undefined) {
    throw new Error('The question tool was not registered.');
  }

  await tool.execute(
    'call',
    { question: 'Which config file wins?' },
    undefined,
    undefined,
    context,
  );

  pi.handler('agent_start')({}, context);
  pi.handler('agent_settled')({}, context);

  expect(shutdown).toHaveBeenCalledOnce();
});

it('reminds once for a report and shares that state', async () => {
  const { context, directory, pi } = setup();

  await writeAssignment(assignmentFor(directory));
  await pi.handler('session_start')({}, context);

  const first = pi.handler('agent_before_settle')({ entries: [] }, context);
  const second = pi.handler('agent_before_settle')({ entries: [] }, context);

  expect(first).toMatchObject({ continue: true });
  expect(second).toBeUndefined();
});

it('blocks a control tool called from a codemode script', () => {
  const { context, pi } = setup();

  const result = pi.handler('tool_call')(
    { toolName: 'subagent_report', toolCallId: 'call', parentToolCallId: 'script' },
    context,
  );

  expect(result).toEqual({ block: true, reason: nestedControlCallReason });
});

it('blocks a change tool called from a codemode script', () => {
  const { context, pi } = setup();

  const result = pi.handler('tool_call')(
    { toolName: 'edit', toolCallId: 'call', parentToolCallId: 'script', input: {} },
    context,
  );

  expect(result).toEqual({ block: true, reason: nestedChangeCallReason });
});

it('blocks a direct worker questionnaire', () => {
  const { context, pi } = setup();

  const result = pi.handler('tool_call')(
    { toolName: 'ask_user_question', toolCallId: 'call', input: {} },
    context,
  );

  expect(result).toMatchObject({ block: true });
});

it.each(['subagent_report', 'subagent_question'])(
  'blocks %s when it shares its turn with another tool call',
  (toolName) => {
    const { context, pi } = setup();

    Object.assign(context.sessionManager, {
      getBranch: () => [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall' }, { type: 'toolCall' }],
          },
        },
      ],
    });

    const result = pi.handler('tool_call')({ toolName, toolCallId: 'call', input: {} }, context);

    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain('alone');
  },
);
