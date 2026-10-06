import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { TuiAltScreen, VStack } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { Value } from 'typebox/value';
import { expect, it, vi, onTestFinished as finishTest } from 'vitest';

import { appendedSystemPrompt, fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository, initializeRepository } from '../../../tests/gitRepository.js';
import { WorkerCapacityFullError, WorkerController } from './controller/controller.js';
import { EvidenceUnavailableError } from './controller/record.js';
import { fixtureModel } from './fixtures/controlledProvider.js';
import type { WorkerNotice } from './presentation.js';
import subagentsExtension, {
  createNoticeDelivery,
  delegationGuidelines,
  registerCapacityRefusal,
} from './subagents.js';
import type { WorkerWidgetRow } from './widget.js';

const emitEvent = async (
  handlers: ReturnType<typeof fakeExtensionApi>['handlers'],
  name: string,
  event: unknown = {},
  context = {} as ExtensionContext,
): Promise<void> => {
  await Promise.all((handlers.get(name) ?? []).map((handler) => handler(event as never, context)));
};

// These widget tests keep one handler per event, so a registered latch would be overwritten.
const inertCapacityRefusal = { refuse: () => undefined };

const emitToolCall = async (
  handlers: ReturnType<typeof fakeExtensionApi>['handlers'],
  event: unknown,
  context: ExtensionContext,
): Promise<ToolCallEventResult | undefined> => {
  let result: ToolCallEventResult | undefined;

  for (const handler of handlers.get('tool_call') ?? []) {
    const current = (await handler(event as never, context)) as ToolCallEventResult | undefined;

    if (current) {
      result = current;

      if (current.block === true) {
        return current;
      }
    }
  }

  return result;
};

const registerTools = () => {
  const fake = fakeExtensionApi();
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  return fake.tools;
};

const managerGuidelines = () => {
  const fake = fakeExtensionApi();
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  return appendedSystemPrompt(fake.handlers, ['subagent']);
};

const textContent = (result: unknown): Record<string, unknown> => {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  const text = content.find((part) => part.type === 'text')?.text ?? '';

  return JSON.parse(text) as Record<string, unknown>;
};

const fixtureModelReference = `${fixtureModel.provider}/${fixtureModel.id}`;

// Resolves every requested model to the fixture model, so a launch reaches the controller.
const launchContext = (directory: string) =>
  ({
    cwd: directory,
    isProjectTrusted: () => true,
    modelRegistry: { find: () => fixtureModel },
    scopedModels: [],
    sessionManager: {
      getSessionFile: () => join(directory, 'parent.jsonl'),
      getSessionId: () => 'parent',
    },
  }) as unknown as ExtensionToolContext;

// A session context's config fields, with an empty agent directory so no user config is read.
const emptyConfigContext = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-empty-agent-'));

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);

  finishTest(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  return { cwd: directory, isProjectTrusted: () => false };
};

const busyParent = { isIdle: () => false, signal: undefined };
const testTheme = { fg: (_color: string, text: string) => text };
const noOperation = (): void => undefined;

const fullWorkerStatus = {
  taskId: 'task-1',
  name: 'worker-ab',
  state: 'stopped',
  deadline: 1234,
  outcome: 'success',
  report: { taskId: 'task-1', outcome: 'success', summary: 'Done.', evidence: [] },
  directory: '/abs/records/task-1',
  usage: { available: false, reason: 'native' },
  nativeSessionId: 'native-1',
  nativeSessionFile: '/abs/records/task-1/session.jsonl',
};

it('appends delegation guidelines for a manager inside herdr', ({ onTestFinished }) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');

  const appended = managerGuidelines();

  for (const guideline of delegationGuidelines(undefined)) {
    expect(appended).toContain(guideline);
  }
});

const loginCommand = 'google-chrome-stable --profile-directory="Agent profile"';

const addOrigin = async (directory: string, originUrl: string) => {
  await promisify(execFile)('git', ['remote', 'add', 'origin', originUrl], { cwd: directory });
};

const sessionGuidelines = async (
  onTestFinished: typeof finishTest,
  config: {
    user?: unknown;
    repository?: unknown;
    originUrl?: string;
    herdr?: boolean;
    inheritedGitDirectory?: string;
  },
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-browser-guideline-'));
  const fake = fakeExtensionApi();
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  const herdr = config.herdr ?? true;

  vi.stubEnv('HERDR_ENV', herdr ? '1' : '0');
  vi.stubEnv('HERDR_PANE_ID', herdr ? 'parent' : '');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.spyOn(WorkerController.prototype, 'resume').mockResolvedValue(undefined);

  if (config.user !== undefined) {
    writeFileSync(join(directory, 'tau.json'), JSON.stringify(config.user));
  }

  if (config.originUrl !== undefined) {
    await initializeRepository(directory);
    await addOrigin(directory, config.originUrl);
  }

  if (config.inheritedGitDirectory !== undefined) {
    vi.stubEnv('GIT_DIR', config.inheritedGitDirectory);
  }

  if (config.repository !== undefined) {
    mkdirSync(join(directory, '.pi'));
    writeFileSync(join(directory, '.pi', 'tau.json'), JSON.stringify(config.repository));
  }

  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
    scopedModels: [],
    hasUI: false,
    ui: { notify },
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;

  onTestFinished(async () => {
    await fake.handler('session_shutdown')({ reason: 'quit' }, context);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  await emitEvent(fake.handlers, 'session_start', {}, context);

  return {
    appended: appendedSystemPrompt(fake.handlers, ['subagent']),
    appendedWithoutTools: appendedSystemPrompt(fake.handlers, []),
    notify,
  };
};

it('gives the manager the configured browser login command', async ({ onTestFinished }) => {
  const { appended, notify } = await sessionGuidelines(onTestFinished, {
    user: { browser: { loginCommand } },
  });

  expect(appended).toContain(loginCommand);

  for (const guideline of delegationGuidelines(loginCommand)) {
    expect(appended).toContain(guideline);
  }

  expect(notify).not.toHaveBeenCalled();
});

it('gives the manager the browser guideline without a command when none is configured', async ({
  onTestFinished,
}) => {
  const { appended, notify } = await sessionGuidelines(onTestFinished, {});

  for (const guideline of delegationGuidelines(undefined)) {
    expect(appended).toContain(guideline);
  }

  expect(notify).not.toHaveBeenCalled();
});

it.each([
  {
    condition: 'the user command is empty',
    config: { user: { browser: { loginCommand: '' } } },
    commands: [loginCommand],
  },
  {
    condition: 'a repository file sets the command',
    config: {
      user: { browser: { loginCommand } },
      repository: { browser: { loginCommand: 'open-project-browser' } },
    },
    commands: [loginCommand, 'open-project-browser'],
  },
])(
  'reports the error and leaves the login command out when $condition',
  async ({ config, commands }) => {
    const { appended, notify } = await sessionGuidelines(finishTest, config);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('browser'), 'error');

    for (const guideline of delegationGuidelines(undefined)) {
      expect(appended).toContain(guideline);
    }

    for (const command of commands) {
      expect(appended).not.toContain(command);
    }
  },
);

it('names the agent team and the repository team and project in the manager prompt', async ({
  onTestFinished,
}) => {
  const { appended } = await sessionGuidelines(onTestFinished, {
    user: {
      tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 'ME', project: 'Tau' } } },
    },
    originUrl: 'git@github.com:sQVe/tau.git',
  });

  expect(appended).toContain('Tracker agent team: `AI`.');
  expect(appended).toContain('Tracker repository: `sQVe/tau` uses team `ME` and project `Tau`.');
});

it('names the tracker route outside herdr and without the subagent tool', async ({
  onTestFinished,
}) => {
  const { appendedWithoutTools } = await sessionGuidelines(onTestFinished, {
    user: { tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 'ME' } } } },
    originUrl: 'https://github.com/sQVe/tau.git',
    herdr: false,
  });

  expect(appendedWithoutTools).toContain('Tracker agent team: `AI`.');
  expect(appendedWithoutTools).toContain('Tracker repository: `sQVe/tau` uses team `ME`');

  for (const guideline of delegationGuidelines(undefined)) {
    expect(appendedWithoutTools).not.toContain(guideline);
  }
});

it('reads the origin of the session directory when Pi inherits GIT_DIR for another repository', async ({
  onTestFinished,
}) => {
  const other = await createTemporaryRepository((cleanup) => {
    onTestFinished(cleanup);
  });

  await addOrigin(other, 'git@github.com:sQVe/other.git');

  const { appended } = await sessionGuidelines(onTestFinished, {
    user: { tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 'ME' } } } },
    originUrl: 'git@github.com:sQVe/tau.git',
    inheritedGitDirectory: join(other, '.git'),
  });

  expect(appended).toContain('Tracker repository: `sQVe/tau` uses team `ME`');
});

it('states a missing origin remote in the manager prompt', async ({ onTestFinished }) => {
  const { appended } = await sessionGuidelines(onTestFinished, {
    user: { tracker: { agentTeam: 'AI', repositories: { 'sQVe/tau': { team: 'ME' } } } },
  });

  expect(appended).toContain('Tracker setup needed: this checkout has no origin remote');
  expect(appended).not.toContain('Tracker repository:');
});

it('states an invalid tracker config in the manager prompt instead of dropping it', async ({
  onTestFinished,
}) => {
  const { appended } = await sessionGuidelines(onTestFinished, {
    user: { slice: { agentTeam: 'AI' } },
    originUrl: 'git@github.com:sQVe/tau.git',
  });

  expect(appended).toContain('Tracker setup needed:');
  expect(appended).toContain('tracker.agentTeam');

  for (const guideline of delegationGuidelines(undefined)) {
    expect(appended).toContain(guideline);
  }
});

it('leaves delegation guidelines out when a manager runs outside herdr', ({ onTestFinished }) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('HERDR_ENV', '0');
  vi.stubEnv('HERDR_PANE_ID', '');

  expect(registerTools().get('subagent')).toBeDefined();
  expect(managerGuidelines()).toBe('');
});

it('keeps parent tools, delegation guidelines, and handlers unavailable when a test chooses a worker environment', ({
  onTestFinished,
}) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_WORKER_RECORD', '/fixture/worker');
  const fake = fakeExtensionApi();

  const capacityRefusal = registerCapacityRefusal(fake.pi);

  subagentsExtension(fake.pi, capacityRefusal);
  capacityRefusal.refuse();

  expect(fake.tools.size).toBe(0);
  expect(fake.handlers.size).toBe(0);
});

const launchDescription = async (
  onTestFinished: typeof finishTest,
  setup: (directory: string) => void,
  scopedModels: string[] = [],
) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-launch-profiles-'));
  const fake = fakeExtensionApi();

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.spyOn(WorkerController.prototype, 'resume').mockResolvedValue(undefined);
  setup(directory);
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  const context = {
    cwd: directory,
    isProjectTrusted: () => false,
    scopedModels: scopedModels.map((reference) => {
      const [provider, ...id] = reference.split('/');

      return { model: { provider, id: id.join('/') } };
    }),
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;

  onTestFinished(async () => {
    await emitEvent(fake.handlers, 'session_shutdown', { reason: 'quit' }, context);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  await emitEvent(fake.handlers, 'session_start', {}, context);

  return fake.tools.get('subagent')?.description ?? '';
};

it('lists user profiles in the launch description after session start', async ({
  onTestFinished,
}) => {
  const description = await launchDescription(onTestFinished, (directory) => {
    mkdirSync(join(directory, 'agents'));

    writeFileSync(
      join(directory, 'agents', 'triage.md'),
      '---\nname: triage\ndescription: Sorts bug reports\nrole: investigation\n---\nTriage.',
    );
  });

  expect(description).toContain('triage');
  expect(description).toContain('Sorts bug reports');
});

it('lists allowed scoped models and each profile default in the launch description', async ({
  onTestFinished,
}) => {
  const description = await launchDescription(
    onTestFinished,
    (directory) => {
      writeFileSync(
        join(directory, 'tau.json'),
        JSON.stringify({
          allowedModels: ['a/one', 'a/two', 'openrouter/meta/llama'],
          profiles: { scout: { model: 'a/two' }, default: { model: 'a/one' } },
        }),
      );
    },
    ['a/one', 'a/hidden', 'a/two'],
  );

  expect(description).toContain('a/one (browser, qa, reviewer, worker), a/two (scout).');
  expect(description).not.toContain('a/hidden');
});

it('leaves the model line out of the launch description when the config is broken', async ({
  onTestFinished,
}) => {
  const description = await launchDescription(
    onTestFinished,
    (directory) => {
      writeFileSync(join(directory, 'tau.json'), JSON.stringify({ profiles: { scout: 'a/two' } }));
    },
    ['a/one'],
  );

  expect(description).toContain('Profiles: browser');
  expect(description).not.toContain('a/one');
});

it('returns from session start while worker reattachment is still pending', async ({
  onTestFinished,
}) => {
  const fake = fakeExtensionApi();
  const released = Promise.withResolvers<undefined>();
  vi.spyOn(WorkerController.prototype, 'resume').mockReturnValue(released.promise);
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  const context = {
    ...emptyConfigContext(),
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionContext;

  onTestFinished(async () => {
    released.resolve(undefined);
    await released.promise;
    await emitEvent(fake.handlers, 'session_shutdown', { reason: 'quit' }, context);
    vi.restoreAllMocks();
  });

  await expect(emitEvent(fake.handlers, 'session_start', {}, context)).resolves.toBeUndefined();
});

it('reports a failed worker reattachment in the UI', async ({ onTestFinished }) => {
  const fake = fakeExtensionApi();
  const failed = Promise.withResolvers<undefined>();
  const notices: string[] = [];
  vi.spyOn(WorkerController.prototype, 'resume').mockReturnValue(failed.promise);
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  const context = {
    ...emptyConfigContext(),
    sessionManager: { getSessionId: () => 'parent' },
    ui: {
      notify: (message: string) => {
        notices.push(message);
      },
    },
  } as unknown as ExtensionContext;

  onTestFinished(async () => {
    await fake.handler('session_shutdown')({ reason: 'quit' }, context);
    vi.restoreAllMocks();
  });

  await emitEvent(fake.handlers, 'session_start', {}, context);
  failed.reject(new Error('Injected records failure.'));

  await vi.waitFor(() => {
    expect(notices).toHaveLength(1);
  });

  expect(notices[0]).toContain('Injected records failure.');
});

it('waits for bounded worker cleanup during session shutdown', async ({ onTestFinished }) => {
  const fake = fakeExtensionApi();
  const released = Promise.withResolvers<undefined>();
  let cleanupFinished = false;
  let shutdownReason: string | undefined;

  vi.spyOn(WorkerController.prototype, 'status').mockReturnValue(
    fullWorkerStatus as unknown as ReturnType<WorkerController['status']>,
  );

  vi.spyOn(WorkerController.prototype, 'stopAll').mockImplementation(async (reason) => {
    await released.promise;
    shutdownReason = reason;
    cleanupFinished = true;
  });

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));
  const tools = fake.tools;

  const context = {
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionToolContext;

  await tools
    .get('subagent_status')!
    .execute('status', { taskId: 'task-1' }, undefined, undefined, context);

  let shutdownFinished = false;

  const finishShutdown = async () => {
    await emitEvent(fake.handlers, 'session_shutdown', { reason: 'reload' }, context);
    shutdownFinished = true;
  };

  const shutdown = finishShutdown();

  await Promise.resolve();

  expect(shutdownFinished).toBe(false);
  released.resolve(undefined);
  await shutdown;
  expect(cleanupFinished).toBe(true);
  expect(shutdownReason).toBe('reload');
});

it('blocks long parent sleeps only while this session has an active worker', async ({
  onTestFinished,
}) => {
  const fake = fakeExtensionApi();
  let state = 'running';

  vi.spyOn(WorkerController.prototype, 'status').mockReturnValue(
    fullWorkerStatus as unknown as ReturnType<WorkerController['status']>,
  );

  vi.spyOn(WorkerController.prototype, 'widgetRows').mockImplementation(
    () => [{ state }] as unknown as WorkerWidgetRow[],
  );

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  const context = {
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionToolContext;

  const bash = (command: string) =>
    emitToolCall(fake.handlers, { toolName: 'bash', input: { command } }, context);

  expect(await bash('sleep 900; git status --short')).toBeUndefined();

  await fake.tools
    .get('subagent_status')!
    .execute('status', { taskId: 'task-1' }, undefined, undefined, context);

  expect(await bash('sleep 900; git status --short')).toMatchObject({ block: true });
  expect(await bash('sleep 2m')).toMatchObject({ block: true });
  expect(await bash('sleep 20 20')).toMatchObject({ block: true });
  expect(await bash('sleep 20; sleep 20')).toMatchObject({ block: true });
  expect(await bash('sleep 5 && ls')).toBeUndefined();
  state = 'stopped';
  expect(await bash('sleep 900')).toBeUndefined();
});

it('updates the parent widget from live worker rows without a model turn', () => {
  vi.useFakeTimers();
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
  const setWidget = vi.fn<ExtensionContext['ui']['setWidget']>();
  const sendMessage = vi.fn<ExtensionAPI['sendMessage']>();
  const sendUserMessage = vi.fn<ExtensionAPI['sendUserMessage']>();

  const extension = {
    events: createEventBus(),
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) =>
      handlers.set(name, handler),
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage,
    sendUserMessage,
  } as unknown as ExtensionAPI;

  vi.spyOn(WorkerController.prototype, 'widgetRows').mockReturnValue([
    {
      name: 'scout-ab',
      taskId: 'task-a',
      state: 'running',
      createdAt: 1,
      deadline: Date.now() + 10_000,
      activity: 'tool: read',
      usage: { available: false, reason: 'Pi session usage was not recorded' },
    },
  ]);

  subagentsExtension(extension, inertCapacityRefusal);

  const context = {
    ...emptyConfigContext(),
    mode: 'tui',
    hasUI: true,
    ui: { setWidget },
    sessionManager: { getSessionId: () => 'parent-session' },
  } as unknown as ExtensionContext;

  handlers.get('session_start')?.({}, context);

  finishTest(() => {
    handlers.get('session_shutdown')?.({}, context);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const widgetFactory = setWidget.mock.calls[0]?.[1];

  if (typeof widgetFactory !== 'function') {
    throw new TypeError('Parent worker widget was not installed.');
  }

  const component = widgetFactory({} as never, testTheme as never);

  expect(component.render(80).join('\n')).toContain('scout-ab');
  expect(component.render(80).join('\n')).not.toContain('/subagents');
  expect(component.handleMouse).toBeUndefined();
  expect(component.handleInput).toBeUndefined();
  vi.advanceTimersByTime(1000);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(sendUserMessage).not.toHaveBeenCalled();
  expect(WorkerController.prototype.widgetRows).toHaveBeenCalledWith('parent-session');
});

it('refreshes history while open, then stops polling after close without a model turn', async () => {
  vi.useFakeTimers();
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const setWidget = vi.fn<ExtensionContext['ui']['setWidget']>();
  const sendMessage = vi.fn<ExtensionAPI['sendMessage']>();
  const sendUserMessage = vi.fn<ExtensionAPI['sendUserMessage']>();
  let finishOverlay: () => void = noOperation;

  const custom = vi.fn<(factory: unknown, options: unknown) => Promise<void>>(
    () =>
      new Promise((resolve) => {
        finishOverlay = resolve;
      }),
  );

  const extension = {
    events: createEventBus(),
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) =>
      handlers.set(name, handler),
    registerTool: () => undefined,
    registerMessageRenderer: () => undefined,
    registerCommand: (
      name: Parameters<ExtensionAPI['registerCommand']>[0],
      command: Parameters<ExtensionAPI['registerCommand']>[1],
    ) => commands.set(name, command),
    sendMessage,
    sendUserMessage,
  } as unknown as ExtensionAPI;

  let historyRows: WorkerWidgetRow[] = [
    {
      name: 'worker-c2',
      taskId: 'task-full-id',
      state: 'cleanupUnconfirmed',
      createdAt: 1,
      deadline: 10_000,
      details: 'Pi trusted tools + verified safety · manual cleanup pane-7',
      detailPath: '/records/task-full-id/task.json',
      issue: 'inspect recovery',
      model: 'requested faux/test · observed unavailable',
      usage: { available: false, reason: 'Pi session usage was not recorded' },
      report: { summary: 'Partial handover', evidence: ['output.log'] },
    },
  ];

  const readHistoryRows = vi
    .spyOn(WorkerController.prototype, 'widgetRows')
    .mockImplementation(() => historyRows);

  subagentsExtension(extension, inertCapacityRefusal);

  const context = {
    ...emptyConfigContext(),
    mode: 'tui',
    hasUI: true,
    ui: { setWidget, custom },
    sessionManager: { getSessionId: () => 'parent-session' },
  } as unknown as ExtensionContext;

  handlers.get('session_start')?.({}, context);

  finishTest(() => {
    handlers.get('session_shutdown')?.({}, context);
    finishOverlay();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const command = commands.get('subagents');
  expect(command).toBeDefined();

  if (!command) {
    return;
  }

  const commandPromise = command.handler('', context as never);

  expect(custom).toHaveBeenCalledOnce();
  expect(custom.mock.calls[0]?.[1]).toBeUndefined();
  expect(setWidget).toHaveBeenLastCalledWith('tau-subagents', undefined);
  expect(readHistoryRows).toHaveBeenCalledWith('parent-session');
  const pollsBeforeRefresh = readHistoryRows.mock.calls.length;

  historyRows = [
    { ...historyRows[0]!, state: 'stopped', stoppedAt: Date.now(), cleanupConfirmed: true },
  ];

  vi.advanceTimersByTime(1000);

  expect(readHistoryRows.mock.calls.length).toBeGreaterThan(pollsBeforeRefresh);
  expect(setWidget).toHaveBeenLastCalledWith('tau-subagents', undefined);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(sendUserMessage).not.toHaveBeenCalled();

  finishOverlay();
  await commandPromise;
  const restoredWidget = setWidget.mock.calls.at(-1)?.[1];

  if (typeof restoredWidget !== 'function') {
    throw new TypeError('Parent worker widget was not restored.');
  }

  expect(
    restoredWidget({} as never, testTheme as never)
      .render(160)
      .join('\n'),
  ).toContain('1 stopped');

  const pollsAfterClose = readHistoryRows.mock.calls.length;
  vi.advanceTimersByTime(1000);

  expect(readHistoryRows.mock.calls.length).toBe(pollsAfterClose);

  custom.mockRejectedValueOnce(new Error('overlay failed'));
  await expect(command.handler('', context as never)).rejects.toThrow('overlay failed');
  expect(typeof setWidget.mock.calls.at(-1)?.[1]).toBe('function');
});

it('keeps editor focus and typing after a click on the passive fullscreen widget', () => {
  const deliverInput = vi.fn<(input: string) => void>();

  const terminal = {
    start: (onInput: (input: string) => void) => {
      deliverInput.mockImplementation(onInput);
    },
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  } as Terminal;

  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => void>();
  const setWidget = vi.fn<ExtensionContext['ui']['setWidget']>();

  const extension = {
    events: createEventBus(),
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => void) =>
      handlers.set(name, handler),
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
  } as unknown as ExtensionAPI;

  vi.spyOn(WorkerController.prototype, 'widgetRows').mockReturnValue([
    {
      name: 'worker-ab',
      taskId: 'task-ab',
      state: 'running',
      createdAt: 1,
      deadline: Date.now() + 60_000,
      usage: { available: false, reason: 'Pi session usage was not recorded' },
    },
  ]);

  subagentsExtension(extension, inertCapacityRefusal);

  const context = {
    ...emptyConfigContext(),
    mode: 'tui',
    hasUI: true,
    ui: { setWidget },
    sessionManager: { getSessionId: () => 'parent-session' },
  } as unknown as ExtensionContext;

  handlers.get('session_start')?.({}, context);
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });

  finishTest(() => {
    tui.stop();
    handlers.get('session_shutdown')?.({}, context);
    vi.restoreAllMocks();
  });

  const widgetFactory = setWidget.mock.calls[0]?.[1];

  if (typeof widgetFactory !== 'function') {
    throw new TypeError('Worker widget component is missing.');
  }

  const widget = widgetFactory({} as never, testTheme as never);
  const typedInput: string[] = [];

  const editor = {
    render: () => ['Editor:'],
    invalidate: () => undefined,
    handleInput: (input: string) => typedInput.push(input),
  };

  tui.setLayoutRoot(new VStack([widget, editor]));
  tui.setFocus(editor);
  tui.start();
  tui.renderNow();
  const originalFocus = tui.getFocusedComponent();

  deliverInput('\u001b[<0;2;1M');
  deliverInput('\u001b[<32;7;1M');
  deliverInput('\u001b[<0;7;1m');
  deliverInput('x');

  expect(originalFocus).toBe(editor);
  expect(tui.getFocusedComponent()).toBe(editor);
  expect(tui.hasActiveSelection()).toBe(true);
  expect(typedInput).toEqual(['x']);
});

it('places follow-ups with explicit visibility and the current parent terminal', async ({
  onTestFinished,
}) => {
  const fake = fakeExtensionApi();
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));
  const tools = fake.tools;
  const tool = tools.get('subagent_follow_up');

  if (!tool) {
    throw new Error('Missing follow-up tool.');
  }

  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'stale-pane-before-movement');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');

  const followUp = vi
    .spyOn(WorkerController.prototype, 'followUp')
    .mockResolvedValue({} as Awaited<ReturnType<WorkerController['followUp']>>);

  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const context = {
    sessionManager: { getSessionFile: () => '/fixture/parent.jsonl', getSessionId: () => 'parent' },
  } as unknown as ExtensionToolContext;

  await tool.execute(
    'call',
    {
      sourceTaskId: 'source',
      task: 'Follow up.',
      timeoutSeconds: 10,
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

it('refuses launch and status arguments that only non-Pi workers used', () => {
  const tools = registerTools();
  const launch = tools.get('subagent');
  const status = tools.get('subagent_status');

  if (!launch || !status) {
    throw new Error('Worker tools missing.');
  }

  const input = { profile: 'worker', task: 'Inspect fixture.' };

  expect(Value.Check(launch.parameters, input)).toBe(true);

  for (const removed of [
    { harness: 'claude' },
    { permissions: 'native-controls' },
    { nativeArguments: ['--model', 'other'] },
  ]) {
    expect(Value.Check(launch.parameters, { ...input, ...removed })).toBe(false);
  }

  expect(Value.Check(status.parameters, { taskId: 'task' })).toBe(true);
  expect(Value.Check(status.parameters, { taskId: 'task', submissionId: 'reply' })).toBe(false);
  expect(Value.Check(status.parameters, { taskId: 'task', readOutput: true })).toBe(false);
});

it('launches a Pi worker through the tool and refuses a launch outside herdr', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-launch-tool-'));

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
  const fake = fakeExtensionApi();
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));
  const tools = fake.tools;

  const launch = vi
    .spyOn(WorkerController.prototype, 'launch')
    .mockResolvedValue({} as Awaited<ReturnType<WorkerController['launch']>>);

  const context = launchContext(directory);

  const input = {
    profile: 'worker',
    model: fixtureModelReference,
    task: 'Inspect fixture.',
    timeoutSeconds: 10,
  };

  const tool = tools.get('subagent');
  const reply = tools.get('subagent_reply');

  if (!tool || !reply) {
    throw new Error('Worker tools missing.');
  }

  expect(Value.Check(tool.parameters, input)).toBe(true);

  const answer = { taskId: 'task', replyId: 'reply', reply: 'Scoped text.' };

  expect(Value.Check(reply.parameters, answer)).toBe(false);
  expect(Value.Check(reply.parameters, { ...answer, questionId: 'question' })).toBe(true);

  const result = await tool.execute('pi-call', input, undefined, undefined, context);

  expect(result).not.toHaveProperty('terminate');

  expect(launch.mock.calls[0]?.[0].loadout).toMatchObject({
    harness: 'pi',
    model: fixtureModelReference,
    permissions: 'trusted-full-tools',
  });

  vi.stubEnv('HERDR_ENV', '0');

  await expect(tool.execute('outside-herdr', input, undefined, undefined, context)).rejects.toThrow(
    'inside local herdr',
  );

  expect(launch).toHaveBeenCalledTimes(1);
});

it('defaults the launch timeout by profile role and keeps an explicit timeout', async ({
  onTestFinished,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-timeout-tool-'));

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
  const tool = registerTools().get('subagent');

  const launch = vi
    .spyOn(WorkerController.prototype, 'launch')
    .mockResolvedValue({} as Awaited<ReturnType<WorkerController['launch']>>);

  if (!tool) {
    throw new Error('Missing launch tool.');
  }

  const context = launchContext(directory);
  const input = { model: fixtureModelReference, task: 'Inspect fixture.' };

  expect(Value.Check(tool.parameters, { ...input, profile: 'scout' })).toBe(true);

  for (const launchInput of [
    { ...input, profile: 'scout' },
    { ...input, profile: 'reviewer' },
    { ...input, profile: 'qa' },
    { ...input, profile: 'worker' },
    { ...input, profile: 'worker', timeoutSeconds: 10 },
  ]) {
    await tool.execute('call', launchInput, undefined, undefined, context);
  }

  expect(launch.mock.calls.map(([launchInput]) => launchInput.timeout)).toEqual([
    1_800_000, 1_800_000, 1_800_000, 3_600_000, 10_000,
  ]);
});

// A parent with a running turn: Pi is busy and a run has started.
const runningDelivery = async (pi: ExtensionAPI, handlers: Parameters<typeof emitEvent>[0]) => {
  const deliver = createNoticeDelivery(pi);

  await emitEvent(handlers, 'agent_start');

  return deliver;
};

it('steers a question notice into a busy parent', async () => {
  const fake = fakeExtensionApi();

  const content = {
    taskId: 'task-1',
    state: 'awaitingReply',
    deadline: 1,
    pendingQuestion: { questionId: 'question-1', question: 'Which file?' },
  };

  const notice: WorkerNotice = { content, details: { full: true }, question: true };

  (await runningDelivery(fake.pi, fake.handlers))(busyParent, notice);

  expect(fake.sendMessage).toHaveBeenCalledWith(
    {
      customType: 'tau-worker',
      content: JSON.stringify(content),
      display: true,
      details: { full: true },
    },
    { deliverAs: 'steer', triggerTurn: true },
  );
});

it.each(['success', 'incomplete', 'failure'])(
  '%s report notices steer to a busy parent',
  async (outcome) => {
    const fake = fakeExtensionApi();
    const content = { taskId: 'task-1', state: 'stopped', deadline: 1, outcome };

    (await runningDelivery(fake.pi, fake.handlers))(busyParent, {
      content,
      details: {},
      question: false,
    });

    expect(fake.sendMessage).toHaveBeenCalledWith(expect.anything(), {
      deliverAs: 'steer',
      triggerTurn: true,
    });
  },
);

const stoppedNotice = (taskId: string): WorkerNotice => ({
  content: { taskId, state: 'stopped', deadline: 1, outcome: 'success' },
  details: { taskId },
  question: false,
});

const noticeMessage = (taskId: string) => ({
  customType: 'tau-worker',
  content: JSON.stringify(stoppedNotice(taskId).content),
  display: true,
  details: { taskId },
});

// Pi is busy without a run while it compacts manually. A triggerTurn notice would start a turn beside
// the summary.
it('queues a notice for the next prompt while Pi is busy without a run', async () => {
  const fake = fakeExtensionApi();
  const deliver = createNoticeDelivery(fake.pi);

  await emitEvent(fake.handlers, 'agent_start');
  await emitEvent(fake.handlers, 'agent_settled');
  deliver(busyParent, stoppedNotice('task-1'));

  expect(fake.sendMessage.mock.calls).toEqual([
    [noticeMessage('task-1'), { deliverAs: 'nextTurn' }],
  ]);

  expect(fake.sendUserMessage).not.toHaveBeenCalled();
});

const compactionRow = (taskId: string, state: WorkerWidgetRow['state'], questionId?: string) =>
  ({ name: taskId, taskId, state, questionId }) as WorkerWidgetRow;

it('queues active workers and pending questions for the next prompt after a compaction', async () => {
  const fake = fakeExtensionApi();
  let rows = [compactionRow('task-stopped', 'stopped')];

  vi.spyOn(WorkerController.prototype, 'widgetRows').mockImplementation(() => rows);

  finishTest(() => {
    vi.restoreAllMocks();
  });

  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  const context = {
    sessionManager: { getSessionId: () => 'parent-session' },
  } as unknown as ExtensionContext;

  await emitEvent(fake.handlers, 'session_compact', { reason: 'manual' }, context);

  expect(fake.sendMessage).not.toHaveBeenCalled();

  rows = [compactionRow('task-asking', 'awaitingReply', 'question-1')];
  await emitEvent(fake.handlers, 'session_compact', { reason: 'manual' }, context);

  expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  expect(fake.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: 'nextTurn' });
  expect(fake.sendMessage.mock.calls[0]?.[0].content).toContain('task-asking');
  expect(fake.sendMessage.mock.calls[0]?.[0].content).toContain('question-1');
  expect(fake.sendUserMessage).not.toHaveBeenCalled();
});

it('returns allowlisted model content for a follow-up successor and keeps full details', async ({
  onTestFinished,
}) => {
  const fake = fakeExtensionApi();
  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));
  const tools = fake.tools;
  const tool = tools.get('subagent_follow_up');

  if (!tool) {
    throw new Error('Missing follow-up tool.');
  }

  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent-pane');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');

  vi.spyOn(WorkerController.prototype, 'followUp').mockResolvedValue({
    taskId: 'successor-1',
    name: 'worker-ab',
    state: 'starting',
    deadline: 1234,
    predecessorTaskId: 'source-1',
    directory: '/abs/records/successor-1',
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
  } as unknown as ExtensionToolContext;

  const result = (await tool.execute(
    'call',
    {
      sourceTaskId: 'source-1',
      task: 'Follow up.',
      timeoutSeconds: 10,
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
    usage: { available: false },
  });
});

it('returns allowlisted content for the status, reply, and cancel tools', async ({
  onTestFinished,
}) => {
  const tools = registerTools();

  vi.spyOn(WorkerController.prototype, 'status').mockReturnValue({
    ...fullWorkerStatus,
    successorTaskId: 'successor-1',
  } as never);

  vi.spyOn(WorkerController.prototype, 'reply').mockReturnValue({
    replyAccepted: true,
    name: 'worker-ab',
    workerAcknowledged: false,
  });

  vi.spyOn(WorkerController.prototype, 'cancel').mockResolvedValue(fullWorkerStatus as never);

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  const context = {
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionToolContext;

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

  expect(statusContent).toMatchObject({
    taskId: 'task-1',
    state: 'stopped',
    successorTaskId: 'successor-1',
  });

  for (const key of ['directory', 'usage', 'nativeSessionFile']) {
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
  });

  expect((replyResult as { details: Record<string, unknown> }).details).toHaveProperty(
    'taskId',
    'task-1',
  );

  expect((replyResult as { details: Record<string, unknown> }).details).toHaveProperty(
    'questionId',
    'question-1',
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
  } as unknown as ExtensionToolContext;

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

it.each([
  { name: 'subagent', method: 'launch' },
  { name: 'subagent_follow_up', method: 'followUp' },
] as const)('ends the turn when $name refuses a full worker cap', async ({ name, method }) => {
  const { cwd } = emptyConfigContext();

  finishTest(() => {
    vi.restoreAllMocks();
  });

  vi.stubEnv('TAU_WORKER_RECORD', '');
  vi.stubEnv('HERDR_ENV', '1');
  vi.stubEnv('HERDR_PANE_ID', 'parent');
  vi.stubEnv('HERDR_SOCKET_PATH', '/fixture/herdr.sock');

  const refusal = new WorkerCapacityFullError('Worker capacity full');
  const launch = vi.spyOn(WorkerController.prototype, method).mockRejectedValue(refusal);
  const fake = fakeExtensionApi();

  subagentsExtension(fake.pi, registerCapacityRefusal(fake.pi));

  const tool = fake.tools.get(name);

  if (!tool) {
    throw new Error('Missing worker tool.');
  }

  const input = {
    profile: 'worker',
    model: fixtureModelReference,
    sourceTaskId: 'source',
    task: 'Inspect fixture.',
    timeoutSeconds: 10,
  };

  const context = launchContext(cwd);

  const toolCall = (toolName: string) =>
    emitToolCall(fake.handlers, { toolName, input: { command: 'pwd' } }, context);

  expect(await toolCall('bash')).toBeUndefined();

  const result = await tool.execute('call', input, undefined, undefined, context);

  expect(result).toMatchObject({
    content: [{ type: 'text', text: refusal.message }],
    isError: true,
    terminate: true,
  });

  for (const toolName of ['bash', 'read', 'subagent', 'subagent_follow_up']) {
    expect(await toolCall(toolName)).toMatchObject({ block: true, terminate: true });
  }

  for (const message of [
    { role: 'assistant' },
    { role: 'toolResult' },
    { role: 'custom', customType: 'unrelated' },
  ]) {
    await emitEvent(fake.handlers, 'message_start', { message }, context);
    expect(await toolCall('bash')).toMatchObject({ block: true, terminate: true });
  }

  for (const message of [{ role: 'custom', customType: 'tau-worker' }, { role: 'user' }]) {
    await emitEvent(fake.handlers, 'message_start', { message }, context);
    expect(await toolCall('bash')).toBeUndefined();

    await tool.execute('call', input, undefined, undefined, context);
    expect(await toolCall('bash')).toMatchObject({ block: true, terminate: true });
  }

  await emitEvent(fake.handlers, 'message_start', { message: { role: 'user' } }, context);

  const otherError = new Error('Another launch failure');

  launch.mockRejectedValue(otherError);

  await expect(tool.execute('call', input, undefined, undefined, context)).rejects.toBe(otherError);
  expect(await toolCall('bash')).toBeUndefined();
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

it('returns the unreadable-evidence object before reading an unknown question receipt', async ({
  onTestFinished,
}) => {
  const tools = registerTools();

  vi.spyOn(WorkerController.prototype, 'status').mockImplementation(() => {
    throw evidenceError('task-1');
  });

  vi.spyOn(WorkerController.prototype, 'questionReceipt').mockImplementation(() => {
    throw new Error('Unknown worker question.');
  });

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  const tool = tools.get('subagent_status');

  if (!tool) {
    throw new Error('Missing status tool.');
  }

  const context = {
    sessionManager: { getSessionId: () => 'parent' },
  } as unknown as ExtensionToolContext;

  const result = await tool.execute(
    'call',
    { taskId: 'task-1', questionId: 'missing' },
    undefined,
    undefined,
    context,
  );

  expect(textContent(result)).toEqual(evidenceContent('task-1'));
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
  } as unknown as ExtensionToolContext;

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
  } as unknown as ExtensionToolContext;

  const result = await tool.execute(
    'call',
    { sourceTaskId: 'source', task: 'Continue.', timeoutSeconds: 10 },
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

  vi.spyOn(WorkerController.prototype, 'launch').mockImplementation(() => {
    throw evidenceError('task-1');
  });

  const tool = tools.get('subagent');

  if (!tool) {
    throw new Error('Missing launch tool.');
  }

  const context = launchContext(directory);

  const result = await tool.execute(
    'call',
    {
      profile: 'worker',
      model: fixtureModelReference,
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
