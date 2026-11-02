import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { initializeRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { connect } from '../../hc/connect.js';
import { writeFakePackage } from './fixtures/packageCache.js';
import { answered, haiku, routedFixture, workerFixture } from './fixtures/routedLoadout.js';
import type { WorkerPackageManager } from './packageInstall.js';
import { piPackageManager } from './piPackageManager.js';
import subagentsExtension, { registerCapacityRefusal } from './subagents.js';

interface ToolFixture {
  directory: string;
  context: Record<string, unknown>;
}

vi.mock(import('../../hc/connect.js'), { spy: true });
vi.mock(import('./piPackageManager.js'), { spy: true });

// A local package stands in for the npm source, so the QA launch never reaches the network.
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

const registerTool = (fake: HcFake) => {
  vi.mocked(connect).mockImplementation(fake.connect);

  const pi = fakeExtensionApi({ exec: fake.exec });

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
});

it('defaults an editing profile to foreground and copies the manager herdr labels', async ({
  onTestFinished,
}) => {
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

it('defaults an investigation profile to background and keeps no herdr labels', async ({
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
