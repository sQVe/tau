import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { failedResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { initializeRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import type { Exec } from '../../command.js';
import { connect } from '../../hc/connect.js';
import { HcError } from '../../hc/hc.js';
import { skillTools } from '../../skillTools.js';
import { writeFakePackage } from './fixtures/packageCache.js';
import { answered, haiku, routedFixture, workerFixture } from './fixtures/routedLoadout.js';
import type { LaunchStatus } from './launch.js';
import { checkLaunchEnvironment } from './launchCheck.js';
import type { WorkerPackageManager } from './packageInstall.js';
import { piPackageManager } from './piPackageManager.js';
import subagentsExtension, { registerCapacityRefusal } from './subagents.js';

interface ToolFixture {
  directory: string;
  context: Record<string, unknown>;
}

vi.mock(import('../../hc/connect.js'), { spy: true });
vi.mock(import('./launchCheck.js'), { spy: true });
vi.mock(import('./piPackageManager.js'), { spy: true });

const offlinePackageManager = (agentDirectory: string): WorkerPackageManager => ({
  listConfiguredPackages: () => [],
  resolveExtensionSources: async ([source = '']) => {
    const packageRoot = writeFakePackage(agentDirectory, source);

    return {
      extensions: [
        {
          path: packageRoot,
          enabled: true,
          metadata: { source, scope: 'temporary', origin: 'package', packageRoot },
        },
      ],
      skills: [],
      prompts: [],
      themes: [],
    } as never;
  },
});

const manager = 'manager';

const loginCommand = 'google-chrome-stable --profile-directory="Agent profile"';

const helloResult = {
  generation: 1,
  version: 'test',
  core: { id: 'core', name: 'core' },
  framed: false,
  methods: [],
  features: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const hcSetup = (labels: Record<string, string> = {}): HcFake => {
  const fake = createHcFake();

  fake.reply('ls', JSON.stringify({ terminals: [] }));
  fake.reply('get', JSON.stringify({ address: manager, state: 'live', labels }));
  fake.replyConnect('hello', 1, helloResult);
  fake.replyConnect('terminal.run', 2, { address: 't-worker', state: 'live', parent: manager });

  return fake;
};

const terminalRun = (fake: HcFake) => {
  for (const call of fake.connectCalls) {
    const request = call.find((message) => message.method === 'terminal.run');

    if (request !== undefined) {
      return request.params as { argv: string[]; labels: Record<string, string> };
    }
  }

  return undefined;
};

const allSkillToolNames = [...new Set(Object.values(skillTools).flat())];

const registerTool = (
  fake: HcFake,
  registeredToolNames: string[] = allSkillToolNames,
  exec: Exec = fake.exec,
) => {
  vi.mocked(connect).mockImplementation(fake.connect);

  const pi = fakeExtensionApi({
    exec,
    getAllTools: () => registeredToolNames.map((name) => ({ name })) as never,
  });

  subagentsExtension(pi.pi, registerCapacityRefusal(pi.pi));

  const tool = pi.tools.get('subagent');

  if (tool === undefined) {
    throw new Error('The subagent tool was not registered.');
  }

  return { pi, tool };
};

const toolContext = (fixture: ToolFixture): ExtensionToolContext =>
  ({
    ...fixture.context,
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => join(fixture.directory, 'parent.jsonl'),
      getSessionId: () => 'parent',
    },
  }) as unknown as ExtensionToolContext;

const execute = (
  tool: ToolDefinition,
  parameters: Record<string, unknown>,
  context: ExtensionToolContext,
) => tool.execute('call', parameters, undefined, undefined, context);

const resultText = (result: Awaited<ReturnType<ToolDefinition['execute']>>): string => {
  const [first] = result.content;

  return first?.type === 'text' ? first.text : '';
};

it('launches the model the classifier routes to', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await routedFixture(onTestFinished);

  fixture.classify.mockResolvedValue(answered('narrow', 0.9));

  const fake = hcSetup();
  const { tool } = registerTool(fake);

  const result = await execute(
    tool,
    { profile: 'scout', task: 'Find the parser.' },
    toolContext(fixture),
  );

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)?.labels['tau.model']).toBe(haiku);
  const details = result.details as LaunchStatus;

  expect(details.model).toBe(haiku);
  expect(details.modelReason).toContain('narrow');
});

it('places an editing worker in the manager tab', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);

  const fake = hcSetup({ 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' });
  const { tool } = registerTool(fake);

  const result = await execute(
    tool,
    {
      profile: 'worker',
      model: fixture.request.model,
      acceptance: ['Done.'],
      task: 'Fix it.',
    },
    toolContext(fixture),
  );

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)?.labels['herdr.space']).toBe('space-1');
  expect(terminalRun(fake)?.labels['herdr.tab']).toBe('tab-2');
});

it('places an investigation worker in the workers tab of the manager', async ({
  onTestFinished,
}) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);

  const fake = hcSetup({ 'herdr.space': 'space-1', 'herdr.tab': 'tab-2' });
  const { tool } = registerTool(fake);

  const result = await execute(
    tool,
    { profile: 'scout', model: fixture.request.model, task: 'Look.' },
    toolContext(fixture),
  );

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)?.labels['herdr.space']).toBe('space-1');
  expect(terminalRun(fake)?.labels['herdr.tab']).toBe('tab-2-workers');
});

it('gives a worker no herdr labels when the manager has no space and tab labels', async ({
  onTestFinished,
}) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);

  const fake = hcSetup();
  const { tool } = registerTool(fake);

  const result = await execute(
    tool,
    {
      profile: 'worker',
      model: fixture.request.model,
      acceptance: ['Done.'],
      task: 'Fix it.',
    },
    toolContext(fixture),
  );

  expect(result.isError).not.toBe(true);
  expect(terminalRun(fake)?.labels['herdr.space']).toBeUndefined();
  expect(terminalRun(fake)?.labels['herdr.tab']).toBeUndefined();
});

it('applies the repository QA settings and brief to a qa launch', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const worktree = join(fixture.directory, 'tree');

  mkdirSync(worktree, { recursive: true });
  await initializeRepository(worktree);

  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:sQVe/cape.git'], {
    cwd: worktree,
  });

  writeFileSync(
    join(fixture.directory, 'tau.json'),
    JSON.stringify({
      qa: {
        repositories: {
          'sQVe/cape': { testAccountCommand: 'op read login', dataWrites: false },
        },
      },
    }),
  );

  vi.mocked(piPackageManager).mockImplementation((loadout) =>
    offlinePackageManager(loadout.agentDirectory),
  );

  const fake = hcSetup();
  const { tool } = registerTool(fake);

  const result = await execute(
    tool,
    { profile: 'qa', model: fixture.request.model, task: 'Test the form.' },
    { ...toolContext(fixture), cwd: worktree },
  );

  expect(result.isError).not.toBe(true);

  const assignmentPath = terminalRun(fake)?.labels['tau.assignment'];

  if (assignmentPath === undefined) {
    throw new Error('The launch returned no assignment label.');
  }

  const assignment = JSON.parse(readFileSync(assignmentPath, 'utf8')) as { task: string };

  expect(assignment.task).toContain('Test account: run `op read login` to read it.');
  expect(assignment.task).toContain('Data writes: not allowed in the dev database.');
});

it('refuses a launch without a saved parent session', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const fake = hcSetup();
  const { tool } = registerTool(fake);

  const context = {
    ...toolContext(fixture),
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionToolContext;

  await expect(
    execute(tool, { profile: 'scout', model: fixture.request.model, task: 'Look.' }, context),
  ).rejects.toThrow('saved parent Pi session');
});

it('refuses a follow-up without a saved parent session', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const fake = hcSetup();
  const { pi } = registerTool(fake);
  const tool = pi.tools.get('subagent_follow_up');

  if (tool === undefined) {
    throw new Error('The subagent_follow_up tool was not registered.');
  }

  const context = {
    ...toolContext(fixture),
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionToolContext;

  await expect(
    execute(
      tool,
      { sourceAssignmentId: '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f', task: 'Continue.' },
      context,
    ),
  ).rejects.toThrow('saved parent Pi session');

  expect(fake.connectCalls).toEqual([]);
});

it('refuses an answer without a saved parent session', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const fake = hcSetup();
  const { pi } = registerTool(fake);
  const tool = pi.tools.get('subagent_answer');

  if (tool === undefined) {
    throw new Error('The subagent_answer tool was not registered.');
  }

  const context = {
    ...toolContext(fixture),
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionToolContext;

  await expect(
    execute(
      tool,
      {
        assignmentId: '3f9a2c1d-6b7e-4c2a-9d1f-0a1b2c3d4e5f',
        questionId: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
        answer: 'Use 42.',
      },
      context,
    ),
  ).rejects.toThrow('saved parent Pi session');

  expect(fake.calls).toEqual([]);
});

it('refuses a launch when a listed skill tool is not registered', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const fake = hcSetup();
  const { tool } = registerTool(fake, []);

  const result = await execute(
    tool,
    { profile: 'scout', model: fixture.request.model, task: 'Look.' },
    toolContext(fixture),
  );

  expect(result).toMatchObject({ isError: true });
  expect(resultText(result)).toContain('Run /reload');
  expect(terminalRun(fake)).toBeUndefined();
});

it('starts the deadline before the pre-launch environment checks', async ({ onTestFinished }) => {
  vi.useFakeTimers();

  onTestFinished(() => {
    vi.useRealTimers();
  });

  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const fake = hcSetup();
  const { tool } = registerTool(fake);
  const start = 1_000_000;

  vi.setSystemTime(start);

  vi.mocked(checkLaunchEnvironment).mockImplementationOnce(async (parameters) => {
    vi.setSystemTime(start + 5000);

    return parameters;
  });

  const result = await execute(
    tool,
    { profile: 'scout', model: fixture.request.model, task: 'Look.' },
    toolContext(fixture),
  );

  expect(result.isError).not.toBe(true);

  const assignmentPath = terminalRun(fake)?.labels['tau.assignment'];

  if (assignmentPath === undefined) {
    throw new Error('The launch returned no assignment label.');
  }

  const assignment = JSON.parse(readFileSync(assignmentPath, 'utf8')) as { deadline: number };

  expect(assignment.deadline).toBe(start + 1800 * 1000);
});

it('scans the children after a launch whose reconciliation failed', async ({ onTestFinished }) => {
  vi.useFakeTimers();

  onTestFinished(() => {
    vi.useRealTimers();
  });

  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const fake = hcSetup();
  let listCalls = 0;

  const exec: Exec = (command, commandArguments, options) => {
    if (commandArguments[0] === 'ls') {
      listCalls += 1;

      if (listCalls === 2) {
        return Promise.resolve(failedResult('temporary lookup failure'));
      }
    }

    return fake.exec(command, commandArguments, options);
  };

  const { tool } = registerTool(fake, allSkillToolNames, exec);

  vi.mocked(connect).mockImplementation((lines) => {
    const request = JSON.parse(lines[1] ?? '') as { params: { labels: Record<string, string> } };

    const worker = {
      address: 't-worker',
      name: 'worker',
      state: 'live',
      parent: manager,
      labels: request.params.labels,
    };

    fake.reply('ls', JSON.stringify({ terminals: [worker] }));
    fake.reply('get', JSON.stringify(worker));

    return Promise.reject(new HcError('read_failed', 'lost launch reply'));
  });

  const result = await execute(
    tool,
    { profile: 'scout', model: fixture.request.model, task: 'Look.' },
    toolContext(fixture),
  );

  expect(result.isError).toBe(true);
  expect(resultText(result)).toContain('unclear');

  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBe(1);
  });
});

it('fails closed and reports an invalid worker capacity', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);

  writeFileSync(
    join(fixture.directory, 'tau.json'),
    JSON.stringify({ subagents: { capacity: 0 } }),
  );

  const fake = hcSetup();

  vi.mocked(connect).mockImplementation(fake.connect);

  const pi = fakeExtensionApi({
    exec: fake.exec,
    getAllTools: () => allSkillToolNames.map((name) => ({ name })) as never,
  });

  subagentsExtension(pi.pi, registerCapacityRefusal(pi.pi));

  const context = toolContext(fixture);

  for (const handler of pi.handlers.get('session_start') ?? []) {
    await handler({} as never, context);
  }

  expect(fixture.notify).toHaveBeenCalledWith(
    expect.stringContaining('subagents.capacity must be an integer'),
    'error',
  );

  const tool = pi.tools.get('subagent');

  if (tool === undefined) {
    throw new Error('The subagent tool was not registered.');
  }

  const result = await execute(
    tool,
    { profile: 'scout', model: fixture.request.model, task: 'Look.' },
    context,
  );

  expect(result).toMatchObject({ isError: true, terminate: true });
  expect(resultText(result)).toContain('Worker capacity full (0/0)');
});

it('gives the manager the configured browser login command', async ({ onTestFinished }) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);

  writeFileSync(join(fixture.directory, 'tau.json'), JSON.stringify({ browser: { loginCommand } }));

  const fake = hcSetup();

  vi.mocked(connect).mockImplementation(fake.connect);

  const pi = fakeExtensionApi({ exec: fake.exec });

  subagentsExtension(pi.pi, registerCapacityRefusal(pi.pi));

  const context = {
    ...toolContext(fixture),
    sessionManager: { getEntries: () => [], getSessionId: () => 'parent' },
  };

  for (const handler of pi.handlers.get('session_start') ?? []) {
    await handler({} as never, context as unknown as ExtensionContext);
  }

  const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: ['subagent'] } };

  pi.handler('before_agent_start')(event, context as unknown as ExtensionContext);

  expect(event.systemPromptOptions.appendSystemPrompt).toContain(loginCommand);
});

it('reports a broken browser login command and leaves it out of the prompt', async ({
  onTestFinished,
}) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);

  writeFileSync(
    join(fixture.directory, 'tau.json'),
    JSON.stringify({ browser: { loginCommand: 1 } }),
  );

  const fake = hcSetup();

  vi.mocked(connect).mockImplementation(fake.connect);

  const pi = fakeExtensionApi({ exec: fake.exec });

  subagentsExtension(pi.pi, registerCapacityRefusal(pi.pi));

  const context = {
    ...toolContext(fixture),
    sessionManager: { getEntries: () => [], getSessionId: () => 'parent' },
  };

  for (const handler of pi.handlers.get('session_start') ?? []) {
    await handler({} as never, context as unknown as ExtensionContext);
  }

  expect(fixture.notify).toHaveBeenCalledWith(
    expect.stringContaining('browser.loginCommand must be a string'),
    'error',
  );

  const event = { systemPromptOptions: { appendSystemPrompt: '', selectedTools: ['subagent'] } };

  pi.handler('before_agent_start')(event, context as unknown as ExtensionContext);

  expect(event.systemPromptOptions.appendSystemPrompt).not.toContain(loginCommand);
});
