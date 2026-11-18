import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import {
  argumentAfter,
  createExecFake,
  failedResult,
  succeededResult,
} from '../../../tests/execFake.js';
import type { ExecFake, ExecResult } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryTauConfig } from '../../../tests/tauConfigHarness.js';
import type { Exec } from '../../command.js';
import { askDeadlineSeconds } from './ask.js';
import { gateClassifier } from './gate.js';
import { architectLockPath } from './lock.js';
import {
  askRecordDirectory,
  gateRecordDirectory,
  readAskRecords,
  readArchitectRecord,
  readGateRecord,
  writeArchitectRecord,
  writeAskRecord,
} from './record.js';
import { createArchitectTool } from './tool.js';

type AppKey = 'ls' | 'pane.split' | 'pane.swap' | 'space.new';

const classifyAsSpecified = async () => ({
  stopReason: 'stop',
  answers: { choice: { type: 'choice', choice: 'specified', confidence: 0.9 } },
});

const appFake = () =>
  createExecFake<AppKey>({
    keyOf: (command, commandArguments) => {
      if (command !== 'herdr-app') {
        return undefined;
      }

      return commandArguments[0] === 'ls' ? 'ls' : (commandArguments[1] as AppKey);
    },
    handlerFor: (key) => () => {
      if (key === 'ls') {
        return succeededResult(
          JSON.stringify({
            spaces: [{ tabs: [{ terminals: [{ terminal: 't-lead', pane: 'p-lead' }] }] }],
          }),
        );
      }

      if (key === 'pane.split') {
        return succeededResult('{"pane":"p-architect","terminal":"t-architect"}');
      }

      return succeededResult('{"ok":true}');
    },
  });

// The tool runs hc and herdr-app through one exec, so the test routes each command to its fake.
const routedExec =
  (hc: HcFake, app: ExecFake<AppKey>, terminals: Map<string, ExecResult>): Exec =>
  (command, commandArguments, options) => {
    if (command === 'herdr-app') {
      return app.exec(command, commandArguments, options);
    }

    const terminalReply = terminals.get(commandArguments.at(-1) ?? '');

    if (commandArguments[0] === 'get' && terminalReply !== undefined) {
      return Promise.resolve(terminalReply);
    }

    return hc.exec(command, commandArguments, options);
  };

const leadInSpace = (hc: HcFake, space: string | undefined): void => {
  hc.reply(
    'get',
    JSON.stringify({
      address: 't-lead',
      state: 'live',
      ...(space === undefined ? {} : { labels: { 'herdr.space': space } }),
    }),
  );
};

const openRequest = 'Start ME-1540';

const contextOf = (root: string, modelRegistry: unknown = {}): ExtensionToolContext =>
  ({
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    isProjectTrusted: () => true,
    modelRegistry,
  }) as unknown as ExtensionToolContext;

const stubEnvironment = (cleanup: (cleanup: () => void) => void, agentDirectory: string): void => {
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  cleanup(() => {
    vi.unstubAllEnvs();
  });
};

const setup = async (cleanup: (cleanup: () => void) => void) => {
  const root = await createTemporaryRepository(cleanup);
  const config = temporaryTauConfig(cleanup, 'tau-architect-tool-');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  stubEnvironment(cleanup, config.location.agentDirectory);

  return { root, config };
};

const holdLock = async (root: string, checkout: string): Promise<void> => {
  const path = `${architectLockPath(root)}.1`;

  await mkdir(dirname(path), { recursive: true });

  await writeFile(
    path,
    JSON.stringify({
      pid: process.pid,
      checkout,
      startedAt: new Date().toISOString(),
      token: 'live',
    }),
  );
};

const recordSession = async (root: string): Promise<string> => {
  const sessionFile = join(root, 'architect-session.jsonl');

  await writeFile(sessionFile, '');

  await writeArchitectRecord(root, {
    version: 1,
    sessionFile,
    terminal: null,
    leadTerminal: 't-lead',
    updatedAt: new Date().toISOString(),
  });

  return sessionFile;
};

const openTool = (root: string, lead?: { space: string | undefined }) => {
  const hc = createHcFake();
  const app = appFake();

  const terminals = new Map<string, ExecResult>();

  leadInSpace(hc, lead === undefined ? 'space-1' : lead.space);

  const tool = createArchitectTool({ ...hc, exec: routedExec(hc, app, terminals), cwd: root });

  return { hc, app, terminals, tool };
};

const open = (
  tool: ReturnType<typeof openTool>['tool'],
  root: string,
  input: { request?: string },
) => tool.execute('call', { action: 'open', ...input }, undefined, undefined, contextOf(root));

const appCommands = (app: ExecFake<AppKey>): string[] =>
  app.calls.map((call) => call.commandArguments[1] ?? call.commandArguments[0] ?? '');

const architectArgv = (app: ExecFake<AppKey>): string[] => {
  const split = app.calls.find((call) => call.commandArguments[1] === 'pane.split');

  return JSON.parse(argumentAfter(split?.commandArguments ?? [], '--argv') ?? '[]') as string[];
};

it('open refuses while a live holder holds the lock', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);

  await holdLock(root, '/other/checkout');

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    'The architect is already running in /other/checkout.',
  );

  expect(app.calls).toEqual([]);
});

it('open without a request is refused and starts nothing', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);

  await expect(open(tool, root, {})).rejects.toThrow('request is required.');

  expect(app.calls).toEqual([]);
});

it('open splits the lead pane right and swaps the architect to its left', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);
  const design = join(root, '.tau', 'slices', basename(root), 'design.md');

  await mkdir(dirname(design), { recursive: true });
  await writeFile(design, '# Design\n');

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'opened', sessionFile: null });
  expect(appCommands(app)).toEqual(['ls', 'pane.split', 'pane.swap']);

  const [, split, swap] = app.calls.map((call) => call.commandArguments);

  expect(argumentAfter(split ?? [], '--direction')).toBe('right');
  expect(argumentAfter(split ?? [], '--pane')).toBe('p-lead');
  expect(argumentAfter(swap ?? [], '--pane')).toBe('p-architect');
  expect(argumentAfter(swap ?? [], '--target')).toBe('p-lead');
});

it('open passes the task as the pi message in the split argv, with no task flag', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);
  const design = join(root, '.tau', 'slices', basename(root), 'design.md');

  await mkdir(dirname(design), { recursive: true });
  await writeFile(design, '# Design\n');
  await open(tool, root, { request: openRequest });

  const argv = architectArgv(app);
  const task = argv.at(-1) ?? '';
  const split = app.calls.find((call) => call.commandArguments[1] === 'pane.split');

  expect(split?.commandArguments).not.toContain('--task');
  expect(argv.slice(0, 3)).toEqual(['env', '-C', root]);
  expect(argv).toContain('TAU_ROLE=architect');
  expect(argv).toContain('TAU_LEAD_TERMINAL=t-lead');
  expect(argv).toContain('--provider');
  expect(argv).toContain('--model');
  expect(task).toContain(design);
  expect(task).toContain('t-lead');
  expect(task).toContain(openRequest);
});

it('open seeds a fresh architect with AGENTS.md when the root has no own slice design', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);
  const otherDesign = join(root, '.tau', 'slices', 'me-1', 'design.md');

  await mkdir(dirname(otherDesign), { recursive: true });
  await writeFile(otherDesign, '# Design\n');
  await open(tool, root, { request: openRequest });

  const task = architectArgv(app).at(-1) ?? '';

  expect(task).toContain('AGENTS.md');
  expect(task).not.toContain(otherDesign);
});

it('open resumes the recorded architect session with the request in its task', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);
  const sessionFile = await recordSession(root);

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'resumed', sessionFile });

  const argv = architectArgv(app);

  expect(argv).toContain('--session');
  expect(argv).toContain(sessionFile);
  expect(argv.at(-1)).toContain('t-lead');
  expect(argv.at(-1)).toContain(openRequest);
});

it('open starts a fresh session when the recorded session file is gone', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);
  const missingSession = join(root, 'missing-session.jsonl');

  await writeArchitectRecord(root, {
    version: 1,
    sessionFile: missingSession,
    terminal: null,
    leadTerminal: 't-lead',
    updatedAt: new Date().toISOString(),
  });

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'opened', sessionFile: null });

  const argv = architectArgv(app);

  expect(argv).not.toContain('--session');
  expect(argv).not.toContain(missingSession);
});

const recordTerminal = (root: string, terminal: string): Promise<void> =>
  writeArchitectRecord(root, {
    version: 1,
    sessionFile: null,
    terminal,
    leadTerminal: 't-lead',
    updatedAt: new Date().toISOString(),
  });

const terminalState = (state: string): ExecResult =>
  succeededResult(JSON.stringify({ address: 't-architect', state }));

const writeRunningAsk = (root: string, terminal: string): Promise<void> =>
  writeAskRecord(root, {
    version: 1,
    askId: 'ask-1',
    createdAt: new Date().toISOString(),
    question: 'Which flag name?',
    sessionFile: join(root, 'architect-session.jsonl'),
    terminal,
    leadTerminal: 't-lead',
    deadline: Date.now() + 1000,
    status: 'running',
    detail: null,
    answer: null,
  });

it('open reports a live architect terminal while a live holder keeps the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root);

  await holdLock(root, root);
  await recordTerminal(root, 't-architect');
  terminals.set('t-architect', terminalState('live'));

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'running', terminal: 't-architect' });
  expect(app.calls).toEqual([]);
});

it('open refuses while a running ask names the live recorded terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root);

  await holdLock(root, '/other/checkout');
  await recordTerminal(root, 't-architect');
  await writeRunningAsk(root, 't-architect');
  terminals.set('t-architect', terminalState('live'));

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    'The architect is already running in /other/checkout.',
  );

  expect(app.calls).toEqual([]);
});

it.each([
  { name: 'a finished terminal', reply: terminalState('finished') },
  { name: 'a failed lookup', reply: failedResult('no such terminal') },
  { name: 'a malformed lookup', reply: succeededResult('not json') },
  { name: 'a lookup of the wrong shape', reply: succeededResult('{"state":"live"}') },
])(
  'open refuses while a live holder keeps the lock and the terminal is $name',
  async ({ reply }) => {
    const { root } = await setup((cleanup) => {
      onTestFinished(cleanup);
    });

    const { app, terminals, tool } = openTool(root);

    await holdLock(root, '/other/checkout');
    await recordTerminal(root, 't-architect');
    terminals.set('t-architect', reply);

    await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
      'The architect is already running in /other/checkout.',
    );

    expect(app.calls).toEqual([]);
  },
);

it('open splits when no live holder keeps the lock, even if the recorded terminal is live', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root);

  await recordTerminal(root, 't-architect');
  terminals.set('t-architect', terminalState('live'));

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'opened', sessionFile: null });
  expect(appCommands(app)).toEqual(['ls', 'pane.split', 'pane.swap']);
});

it('open starts a new space only when the lead terminal has no herdr.space label', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root, { space: undefined });

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'opened', sessionFile: null });
  expect(appCommands(app)).toEqual(['space.new']);

  const args = app.calls[0]?.commandArguments ?? [];

  expect(argumentAfter(args, '--name')).toBe(`architect-${basename(root)}`);
  expect(argumentAfter(args, '--task')).toContain(openRequest);
});

it('open refuses when herdr-app shows no pane for the lead terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);

  app.overrideOutput('ls', '{"spaces":[]}');

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    'shows no pane for the lead terminal t-lead',
  );

  expect(appCommands(app)).toEqual(['ls']);
});

it('ask refuses without a recorded session file', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('architect open');
});

it('ask refuses while the lock is held', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);
  await holdLock(root, '/other/checkout');

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('/other/checkout');
});

it('a second ask while one runs is refused', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);
  await mkdir(askRecordDirectory(root), { recursive: true });

  await writeFile(
    join(askRecordDirectory(root), 'ask-1.json'),
    JSON.stringify({
      version: 1,
      askId: 'ask-1',
      createdAt: new Date().toISOString(),
      question: 'Earlier question',
      sessionFile: join(root, 'architect-session.jsonl'),
      terminal: 't-ask',
      leadTerminal: 't-lead',
      deadline: Date.now() + 1000,
      status: 'running',
      detail: null,
      answer: null,
    }),
  );

  hc.reply('get', JSON.stringify({ address: 't-ask', state: 'live' }));

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect((result.details as { reason: string }).reason).toContain('ask-1');
  expect(hc.calls.filter((call) => call.commandArguments[0] === 'run')).toEqual([]);
});

it('an ask deadline returns needsOpen and kills the terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({ terminal: 't-ask', ended: false, reason: 'timeout', turn: 0, children: [] }),
  );

  hc.reply('kill', JSON.stringify({ address: 't-ask', state: 'finished' }));
  const startedAt = Date.now();

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect(hc.calls.some((call) => call.commandArguments[0] === 'kill')).toBe(true);
  const [record] = await readAskRecords(root);

  expect(record).toMatchObject({ status: 'timeout', terminal: 't-ask' });
  expect(record?.deadline).toBeGreaterThanOrEqual(startedAt + askDeadlineSeconds * 1000);
});

it('ask returns the answer the architect saved', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const answer = 'Use --quick.';

  await recordSession(root);
  hc.reply('run', JSON.stringify({ address: 't-ask', state: 'live' }));

  hc.reply(
    'wait',
    JSON.stringify({ terminal: 't-ask', ended: true, reason: 'ended', turn: 1, children: [] }),
  );

  const exec: typeof hc.exec = async (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'wait') {
      const [record] = await readAskRecords(root);

      if (record !== undefined) {
        await writeAskRecord(root, { ...record, status: 'sent', answer });
      }
    }

    return hc.exec(command, commandArguments, options);
  };

  const tool = createArchitectTool({ ...hc, exec, cwd: root });

  const result = await tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    contextOf(root),
  );

  expect(result.details).toMatchObject({ action: 'ask', status: 'ended', answer });
});

it('gate writes one record per call', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const classifierCalls: unknown[][] = [];

  const context = contextOf(root, {
    findOfType: (...args: unknown[]) => {
      classifierCalls.push(args);

      return {};
    },
    classify: classifyAsSpecified,
  });

  const first = await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  const second = await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  expect(first.details).toMatchObject({ decision: 'specified', label: 'specified' });
  expect(second.details).toMatchObject({ decision: 'specified', label: 'specified' });
  expect(classifierCalls[0]).toEqual(['classifier', ...gateClassifier.split('/')]);

  const names = await readdir(gateRecordDirectory(root));
  const records = await Promise.all(names.map((name) => readGateRecord(root, name)));

  expect(records.map((record) => record?.decision)).toEqual(['specified', 'specified']);
  expect(await readArchitectRecord(root)).toBeUndefined();
});

it('gate records an uncertain decision below the cutoff', async ({ onTestFinished: cleanup }) => {
  const { root } = await setup(cleanup);
  const hc = createHcFake();
  const tool = createArchitectTool({ ...hc, cwd: root });

  const context = contextOf(root, {
    findOfType: () => ({}),
    classify: async () => ({
      stopReason: 'stop',
      answers: { choice: { type: 'choice', choice: 'specified', confidence: 0.69 } },
    }),
  });

  await tool.execute(
    'call',
    { action: 'gate', request: 'Rename --fast.', restatement: 'Rename --fast to --quick.' },
    undefined,
    undefined,
    context,
  );

  const [name] = await readdir(gateRecordDirectory(root));
  const record = name === undefined ? undefined : await readGateRecord(root, name);

  expect(record?.decision).toBe('uncertain');
});

it.each([
  { input: { action: 'open', request: 'Start', question: 'Why?' }, rejected: 'question' },
  { input: { action: 'open', request: 'Start', restatement: 'Do it' }, rejected: 'restatement' },
  { input: { action: 'ask', question: 'Why?', request: 'Start' }, rejected: 'request' },
])('$input.action rejects $rejected', async ({ input, rejected }) => {
  const { root } = await setup((cleanup) => {
    onTestFinished(cleanup);
  });

  const { app, tool } = openTool(root);

  await expect(
    tool.execute('call', input as never, undefined, undefined, contextOf(root)),
  ).rejects.toThrow(`does not take ${rejected}.`);

  expect(app.calls).toEqual([]);
});
