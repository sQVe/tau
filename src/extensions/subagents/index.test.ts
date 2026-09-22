import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { expect, it, vi } from 'vitest';

import { WorkerController, EvidenceUnavailableError } from './controller.js';
import subagentsExtension, { deliverWorkerNotice } from './index.js';
import type { WorkerNotice } from './presentation.js';

const registerTools = () => {
  const tools = new Map<string, ToolDefinition>();
  subagentsExtension({
    events: createEventBus(),
    on: () => undefined,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI);

  return tools;
};

const textContent = (result: unknown): Record<string, unknown> => {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  const text = content.find((part) => part.type === 'text')?.text ?? '';

  return JSON.parse(text) as Record<string, unknown>;
};

const fullWorkerStatus = {
  taskId: 'task-1',
  name: 'worker-ab',
  state: 'stopped',
  deadline: 1234,
  outcome: 'success',
  report: { taskId: 'task-1', outcome: 'success', summary: 'Done.', evidence: [] },
  directory: '/abs/records/task-1',
  reservationDirectory: '/abs/admission',
  usage: { available: false, reason: 'native' },
  nativeSessionId: 'native-1',
  nativeSessionFile: '/abs/records/task-1/session.jsonl',
  capacityHeld: false,
  harness: 'pi',
};

it('places follow-ups with explicit visibility and the current parent terminal', async ({
  onTestFinished,
}) => {
  const tools = new Map<string, ToolDefinition>();
  subagentsExtension({
    events: createEventBus(),
    on: () => undefined,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI);
  const tool = tools.get('subagent_follow_up');

  if (!tool) {
    throw new Error('Missing follow-up tool.');
  }

  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'stale-pane-before-movement');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.spyOn(WorkerController.prototype, 'parentAuthority').mockResolvedValue({
    tree: {
      rootSession: '/fixture/parent.jsonl',
      rootSessionId: 'parent',
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
    },
  });
  const followUp = vi
    .spyOn(WorkerController.prototype, 'followUp')
    .mockResolvedValue({} as Awaited<ReturnType<WorkerController['followUp']>>);
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const context = {
    sessionManager: { getSessionFile: () => '/fixture/parent.jsonl', getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;

  await tool.execute(
    'call',
    {
      sourceTaskId: 'source',
      task: 'Follow up.',
      timeoutSeconds: 10,
      settingsUnchanged: true,
      visibility: 'background',
    },
    undefined,
    undefined,
    context,
  );

  expect(tool.parameters).toHaveProperty('properties.visibility');
  expect(followUp).toHaveBeenCalledWith(
    expect.objectContaining({ visibility: 'background' }),
    context,
    undefined,
  );
  expect(followUp.mock.calls[0]?.[0]).not.toHaveProperty('parentPane');
});

it('routes approved native tool arguments through the generic resolver without Pi guarantees', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-native-tool-'));
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  const tools = new Map<string, ToolDefinition>();
  subagentsExtension({
    events: createEventBus(),
    on: () => undefined,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI);
  const launch = vi
    .spyOn(WorkerController.prototype, 'launch')
    .mockResolvedValue({} as Awaited<ReturnType<WorkerController['launch']>>);
  vi.spyOn(WorkerController.prototype, 'parentAuthority').mockResolvedValue({
    tree: {
      rootSession: join(directory, 'parent.jsonl'),
      rootSessionId: 'parent',
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
    },
  });
  const confirm = vi.fn<ExtensionContext['ui']['confirm']>().mockResolvedValue(true);
  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { confirm },
    sessionManager: {
      getSessionFile: () => join(directory, 'parent.jsonl'),
      getSessionId: () => 'parent',
    },
  } as unknown as ExtensionContext;
  const input = {
    profile: 'worker',
    harness: 'gemini',
    permissions: 'native-controls',
    nativeArguments: ['--native-setting', 'literal value'],
    reportDirectory: directory,
    task: 'Inspect fixture.',
    timeoutSeconds: 10,
  };
  const tool = tools.get('subagent');
  const reply = tools.get('subagent_reply');

  if (!tool || !reply) {
    throw new Error('Worker tools missing.');
  }

  expect(Value.Check(tool.parameters, input)).toBe(true);
  expect(
    Value.Check(reply.parameters, {
      taskId: 'task',
      replyId: 'reply',
      reply: 'Scoped text.',
      scopeUnchanged: true,
    }),
  ).toBe(true);
  await tool.execute('native-call', input, undefined, undefined, context);

  expect(confirm).toHaveBeenCalledTimes(1);
  expect(launch.mock.calls[0]?.[0].loadout).toMatchObject({
    harness: 'generic',
    kind: 'gemini',
    permissions: 'native-controls',
    arguments: input.nativeArguments,
    reportDirectory: directory,
    configurationApproved: true,
  });
  expect(launch.mock.calls[0]?.[0].loadout).not.toHaveProperty('safetyExtension');
  await expect(
    tool.execute(
      'unsupported-guarantee',
      { ...input, permissions: 'trusted-full-tools' },
      undefined,
      undefined,
      context,
    ),
  ).rejects.toThrow('native-controls');
  await expect(
    tool.execute('unattended', input, undefined, undefined, { ...context, hasUI: false }),
  ).rejects.toThrow('No unattended approval');
  vi.stubEnv('HERDR_ENV', '0');
  await expect(tool.execute('outside-herdr', input, undefined, undefined, context)).rejects.toThrow(
    'inside local herdr',
  );
  expect(launch).toHaveBeenCalledTimes(1);
});

it('delivers question notices as a steer and other notices next turn', () => {
  const sendMessage = vi.fn<() => void>();
  const emit = vi.fn<() => void>();
  const pi = { sendMessage, events: { emit } } as unknown as ExtensionAPI;
  const content = {
    taskId: 'task-1',
    state: 'awaitingReply',
    deadline: 1,
    pendingQuestion: { questionId: 'question-1', question: 'Which file?' },
  };
  const notice: WorkerNotice = { content, details: { full: true }, question: true };

  deliverWorkerNotice(pi, notice, false);

  expect(sendMessage).toHaveBeenCalledWith(
    {
      customType: 'tau-worker',
      content: JSON.stringify(content),
      display: true,
      details: { full: true },
    },
    { deliverAs: 'steer', triggerTurn: true },
  );
  sendMessage.mockClear();
  deliverWorkerNotice(pi, { ...notice, question: false }, false);
  expect(sendMessage).toHaveBeenCalledWith(expect.anything(), { deliverAs: 'nextTurn' });

  deliverWorkerNotice(pi, { ...notice, question: false }, true);
  expect(emit).toHaveBeenCalledWith('tau:child-notification', {
    message: JSON.stringify(content),
    details: { full: true },
    question: false,
  });
});

it('returns allowlisted model content for a follow-up successor and keeps full details', async ({
  onTestFinished,
}) => {
  const tools = new Map<string, ToolDefinition>();
  subagentsExtension({
    events: createEventBus(),
    on: () => undefined,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI);
  const tool = tools.get('subagent_follow_up');

  if (!tool) {
    throw new Error('Missing follow-up tool.');
  }

  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent-pane');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.spyOn(WorkerController.prototype, 'parentAuthority').mockResolvedValue({
    tree: {
      rootSession: '/fixture/parent.jsonl',
      rootSessionId: 'parent',
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
    },
  });
  vi.spyOn(WorkerController.prototype, 'followUp').mockResolvedValue({
    taskId: 'successor-1',
    name: 'worker-ab',
    state: 'starting',
    deadline: 1234,
    predecessorTaskId: 'source-1',
    directory: '/abs/records/successor-1',
    reservationDirectory: '/abs/admission',
    usage: { available: false },
    nativeSessionId: 'native-1',
    nativeSessionFile: '/abs/records/successor-1/session.jsonl',
  } as unknown as Awaited<ReturnType<WorkerController['followUp']>>);
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const context = {
    sessionManager: { getSessionFile: () => '/fixture/parent.jsonl', getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;

  const result = (await tool.execute(
    'call',
    {
      sourceTaskId: 'source-1',
      task: 'Follow up.',
      timeoutSeconds: 10,
      settingsUnchanged: true,
    },
    undefined,
    undefined,
    context,
  )) as unknown as { content: { type: string; text?: string }[]; details: unknown };
  const text = result.content.find((part) => part.type === 'text')?.text ?? '';

  expect(JSON.parse(text)).toEqual({
    taskId: 'successor-1',
    name: 'worker-ab',
    state: 'starting',
    deadline: 1234,
    predecessorTaskId: 'source-1',
  });
  expect(result.details).toMatchObject({
    directory: '/abs/records/successor-1',
    reservationDirectory: '/abs/admission',
    usage: { available: false },
  });
});

it('returns allowlisted content for the status, reply, and cancel tools', async ({
  onTestFinished,
}) => {
  const tools = registerTools();
  const status = vi
    .spyOn(WorkerController.prototype, 'status')
    .mockReturnValue(fullWorkerStatus as never);
  const reply = vi.spyOn(WorkerController.prototype, 'reply').mockResolvedValue({
    replyAccepted: true,
    name: 'worker-ab',
    workerAcknowledged: false,
    delivery: 'sent',
  });
  const cancel = vi
    .spyOn(WorkerController.prototype, 'cancel')
    .mockResolvedValue(fullWorkerStatus as never);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const context = {
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;
  const statusTool = tools.get('subagent_status');
  const replyTool = tools.get('subagent_reply');
  const cancelTool = tools.get('subagent_cancel');

  if (!statusTool || !replyTool || !cancelTool) {
    throw new Error('Worker tools missing.');
  }

  const statusResult = await statusTool.execute(
    'call',
    { taskId: 'task-1' },
    undefined,
    undefined,
    context,
  );
  const statusContent = textContent(statusResult);
  expect(statusContent).toMatchObject({ taskId: 'task-1', state: 'stopped' });

  for (const key of ['directory', 'reservationDirectory', 'usage', 'nativeSessionFile']) {
    expect(statusContent).not.toHaveProperty(key);
    expect((statusResult as { details: Record<string, unknown> }).details).toHaveProperty(key);
  }

  const replyResult = await replyTool.execute(
    'call',
    {
      taskId: 'task-1',
      questionId: 'question-1',
      replyId: 'reply-1',
      reply: 'Scoped text.',
      scopeUnchanged: true,
    },
    undefined,
    undefined,
    context,
  );
  expect(textContent(replyResult)).toEqual({
    taskId: 'task-1',
    questionId: 'question-1',
    replyAccepted: true,
    workerAcknowledged: false,
    delivery: 'sent',
  });
  expect((replyResult as { details: Record<string, unknown> }).details).toHaveProperty(
    'taskId',
    'task-1',
  );

  const cancelResult = await cancelTool.execute(
    'call',
    { taskId: 'task-1' },
    undefined,
    undefined,
    context,
  );
  expect(textContent(cancelResult)).not.toHaveProperty('directory');
  expect((cancelResult as { details: Record<string, unknown> }).details).toHaveProperty(
    'directory',
  );
  expect(status).toHaveBeenCalled();
  expect(reply).toHaveBeenCalled();
  expect(cancel).toHaveBeenCalled();
});

it('returns the unreadable-evidence object when status records fail', async ({
  onTestFinished,
}) => {
  const tools = registerTools();
  vi.spyOn(WorkerController.prototype, 'status').mockImplementation(() => {
    throw new EvidenceUnavailableError({
      taskId: 'task-1',
      name: 'worker-ab',
      evidenceError: 'Invalid worker lifecycle record.',
      recovery: {
        directory: '/abs/records/task-1',
        nativeSessionFile: '/abs/records/task-1/session.jsonl',
      },
    });
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const context = {
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;
  const tool = tools.get('subagent_status');

  if (!tool) {
    throw new Error('Missing status tool.');
  }

  const result = await tool.execute('call', { taskId: 'task-1' }, undefined, undefined, context);

  expect(textContent(result)).toEqual({
    taskId: 'task-1',
    name: 'worker-ab',
    evidenceError: 'Invalid worker lifecycle record.',
    recovery: {
      directory: '/abs/records/task-1',
      nativeSessionFile: '/abs/records/task-1/session.jsonl',
    },
  });
});

const evidenceError = (taskId: string) =>
  new EvidenceUnavailableError({
    taskId,
    name: 'worker-ab',
    evidenceError: 'Invalid worker lifecycle record.',
    recovery: { directory: `/abs/records/${taskId}` },
  });

const evidenceContent = (taskId: string) => ({
  taskId,
  name: 'worker-ab',
  evidenceError: 'Invalid worker lifecycle record.',
  recovery: { directory: `/abs/records/${taskId}` },
});

it('returns the unreadable-evidence object when cancel records fail', async ({
  onTestFinished,
}) => {
  const tools = registerTools();
  vi.spyOn(WorkerController.prototype, 'cancel').mockImplementation(() => {
    throw evidenceError('task-1');
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const tool = tools.get('subagent_cancel');

  if (!tool) {
    throw new Error('Missing cancel tool.');
  }

  const context = {
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;
  const result = await tool.execute('call', { taskId: 'task-1' }, undefined, undefined, context);
  const content = textContent(result);

  expect(content).toEqual(evidenceContent('task-1'));
  expect(content).not.toHaveProperty('state');
});

it('returns the unreadable-evidence object when follow-up records fail', async ({
  onTestFinished,
}) => {
  const tools = registerTools();
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.spyOn(WorkerController.prototype, 'parentAuthority').mockResolvedValue({
    tree: {
      rootSession: '/fixture/parent.jsonl',
      rootSessionId: 'parent',
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
    },
  });
  vi.spyOn(WorkerController.prototype, 'followUp').mockImplementation(() => {
    throw evidenceError('task-1');
  });
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  const tool = tools.get('subagent_follow_up');

  if (!tool) {
    throw new Error('Missing follow-up tool.');
  }

  const context = {
    sessionManager: { getSessionFile: () => '/fixture/parent.jsonl', getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;
  const result = await tool.execute(
    'call',
    { sourceTaskId: 'source', task: 'Continue.', timeoutSeconds: 10, settingsUnchanged: true },
    undefined,
    undefined,
    context,
  );
  const content = textContent(result);

  expect(content).toEqual(evidenceContent('task-1'));
  expect(content).not.toHaveProperty('state');
});

it('returns the unreadable-evidence object when launch records fail', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-evidence-launch-'));
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  const tools = registerTools();
  vi.spyOn(WorkerController.prototype, 'parentAuthority').mockResolvedValue({
    tree: {
      rootSession: join(directory, 'parent.jsonl'),
      rootSessionId: 'parent',
      monotonicDeadline: Number.MAX_SAFE_INTEGER,
    },
  });
  vi.spyOn(WorkerController.prototype, 'launch').mockImplementation(() => {
    throw evidenceError('task-1');
  });
  const tool = tools.get('subagent');

  if (!tool) {
    throw new Error('Missing launch tool.');
  }

  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
    hasUI: true,
    ui: { confirm: vi.fn<ExtensionContext['ui']['confirm']>().mockResolvedValue(true) },
    sessionManager: {
      getSessionFile: () => join(directory, 'parent.jsonl'),
      getSessionId: () => 'parent',
    },
  } as unknown as ExtensionContext;
  const result = await tool.execute(
    'call',
    {
      profile: 'worker',
      harness: 'gemini',
      permissions: 'native-controls',
      nativeArguments: ['--native-setting'],
      reportDirectory: directory,
      task: 'Inspect fixture.',
      timeoutSeconds: 10,
    },
    undefined,
    undefined,
    context,
  );
  const content = textContent(result);

  expect(content).toEqual(evidenceContent('task-1'));
  expect(content).not.toHaveProperty('state');
});
