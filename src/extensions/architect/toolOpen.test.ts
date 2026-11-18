import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { contextOf, holdLock, recordSession, setup } from '../../../tests/architectToolHarness.js';
import {
  argumentAfter,
  createExecFake,
  failedResult,
  succeededResult,
} from '../../../tests/execFake.js';
import type { ExecFake, ExecResult } from '../../../tests/execFake.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import type { Exec } from '../../command.js';
import { writeArchitectRecord, writeAskRecord } from './record.js';
import { createArchitectTool } from './tool.js';

type AppKey = 'ls' | 'pane.split' | 'pane.swap' | 'space.new';

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

it('open starts the architect in the pane of the lead terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root);
  const design = join(root, '.tau', 'slices', basename(root), 'design.md');

  await mkdir(dirname(design), { recursive: true });
  await writeFile(design, '# Design\n');

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'opened', sessionFile: null });

  const split = app.calls.find((call) => call.commandArguments[1] === 'pane.split');

  expect(argumentAfter(split?.commandArguments ?? [], '--pane')).toBe('p-lead');
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

const terminalState = (state: string, labels?: Record<string, string>): ExecResult =>
  succeededResult(
    JSON.stringify({ address: 't-architect', state, ...(labels === undefined ? {} : { labels }) }),
  );

const writeAsk = (
  root: string,
  terminal: string | null,
  status: 'running' | 'sent',
): Promise<void> =>
  writeAskRecord(root, {
    version: 1,
    askId: 'ask-1',
    createdAt: new Date().toISOString(),
    question: 'Which flag name?',
    sessionFile: join(root, 'architect-session.jsonl'),
    terminal,
    leadTerminal: 't-lead',
    deadline: Date.now() + 1000,
    status,
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
  await writeAsk(root, 't-architect', 'running');
  terminals.set('t-architect', terminalState('live'));

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    'The architect is already running in /other/checkout.',
  );

  expect(app.calls).toEqual([]);
});

it('open reuses the recorded terminal while a running ask names a different terminal', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root);

  await holdLock(root, root);
  await recordTerminal(root, 't-architect');
  await writeAsk(root, 't-ask', 'running');
  terminals.set('t-architect', terminalState('live'));

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'running', terminal: 't-architect' });
  expect(app.calls).toEqual([]);
});

it.each([
  { name: 'has no terminal yet', terminal: null, status: 'running' },
  { name: 'is sent', terminal: 't-architect', status: 'sent' },
] as const)(
  'open refuses while the recorded terminal carries the ask label and its ask record $name',
  async ({ terminal, status }) => {
    const { root } = await setup((cleanup) => {
      onTestFinished(cleanup);
    });

    const { app, terminals, tool } = openTool(root);

    await holdLock(root, '/other/checkout');
    await recordTerminal(root, 't-architect');
    await writeAsk(root, terminal, status);
    terminals.set('t-architect', terminalState('live', { 'tau.architect.ask': 'ask-1' }));

    await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
      'The architect is already running in /other/checkout.',
    );

    expect(app.calls).toEqual([]);
  },
);

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
  expect(appCommands(app)).toContain('pane.split');
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
