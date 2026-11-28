import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { argumentAfter, failedResult, succeededResult } from '../../../tests/execFake.js';
import {
  appCommands,
  architectArgv,
  open,
  openRequest,
  openTool,
  recordTerminal,
  recordTerminalV1,
  terminalState,
  writeAsk,
} from './fixtures/openHarness.js';
import { contextOf, holdLock, recordSession, releaseLock, setup } from './fixtures/toolHarness.js';
import { architectLockPath } from './lock.js';
import { writeArchitectRecord } from './record.js';

const lockReads = vi.hoisted(() => ({
  directory: undefined as string | undefined,
  count: 0,
  failFrom: Number.POSITIVE_INFINITY,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    readdir: (async (...parameters: Parameters<typeof original.readdir>) => {
      if (parameters[0] === lockReads.directory) {
        lockReads.count += 1;

        if (lockReads.count >= lockReads.failFrom) {
          throw new Error('EIO: the lock directory is unreadable');
        }
      }

      return original.readdir(...parameters);
    }) as typeof original.readdir,
  };
});

afterEach(() => {
  lockReads.directory = undefined;
  lockReads.count = 0;
  lockReads.failFrom = Number.POSITIVE_INFINITY;
});

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

  expect(result.details).toEqual({
    action: 'open',
    status: 'opened',
    sessionFile: null,
    model: 'a/architect',
  });

  const split = app.calls.find((call) => call.commandArguments[1] === 'pane.split');

  expect(argumentAfter(split?.commandArguments ?? [], '--pane')).toBe('p-lead');
  expect(app.calls).toHaveLength(2);
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

  expect(result.details).toEqual({
    action: 'open',
    status: 'resumed',
    sessionFile,
    model: 'a/architect',
  });

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
    version: 2,
    sessionFile: missingSession,
    leadTerminal: 't-lead',
    owner: null,
    updatedAt: new Date().toISOString(),
  });

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({
    action: 'open',
    status: 'opened',
    sessionFile: null,
    model: 'a/architect',
  });

  const argv = architectArgv(app);

  expect(argv).not.toContain('--session');
  expect(argv).not.toContain(missingSession);
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
  expect(appCommands(app)).toEqual(['ls']);
});

it('open refuses when the record names a terminal from a previous lock generation', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const afterTerminalLookup = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const { app, terminals, tool } = openTool(root, undefined, afterTerminalLookup);

  await holdLock(root, root);
  await recordTerminal(root, 't-architect', 'previous');
  terminals.set('t-architect', terminalState('live'));

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow('architect open again');

  expect(afterTerminalLookup).not.toHaveBeenCalled();
  expect(app.calls).toEqual([]);
});

it('open reports the terminal a version 1 record names while a live holder keeps the lock', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root);

  await holdLock(root, root);
  await recordTerminalV1(root, 't-architect');
  terminals.set('t-architect', terminalState('live'));

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({ action: 'open', status: 'running', terminal: 't-architect' });
  expect(appCommands(app)).toEqual(['ls']);
});

it('open refuses while a version 1 record names a terminal that carries the ask label', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root);

  await holdLock(root, '/other/checkout');
  await recordTerminalV1(root, 't-architect');
  await writeAsk(root, null, 'running');
  terminals.set('t-architect', terminalState('live', { 'tau.architect.ask': 'ask-1' }));

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    'The architect is already running in /other/checkout.',
  );

  expect(app.calls).toEqual([]);
});

const parkedLayout = JSON.stringify({
  spaces: [
    {
      tabs: [{ terminals: [{ terminal: 't-lead', pane: 'p-lead' }, { terminal: 't-architect' }] }],
    },
  ],
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
  expect(appCommands(app)).toEqual(['ls']);
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

  expect(result.details).toEqual({
    action: 'open',
    status: 'opened',
    sessionFile: null,
    model: 'a/architect',
  });

  expect(appCommands(app)).toContain('pane.split');
  expect(app.calls).toHaveLength(2);
});

it('open starts the architect beside the lead when the lock is released during the terminal lookup', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root, undefined, () => releaseLock(root));

  await holdLock(root, root);
  await recordTerminal(root, 't-architect');
  terminals.set('t-architect', terminalState('live'));

  const result = await open(tool, root, { request: openRequest });

  expect(result.details).toEqual({
    action: 'open',
    status: 'opened',
    sessionFile: null,
    model: 'a/architect',
  });

  expect(appCommands(app)).toContain('pane.split');
  expect(app.calls).toHaveLength(3);
});

it('open refuses and starts nothing when a different holder takes the lock during the terminal lookup', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);

  const swapHolder = async (): Promise<void> => {
    await releaseLock(root);
    await holdLock(root, '/other/checkout');
  };

  const { app, terminals, tool } = openTool(root, undefined, swapHolder);

  await holdLock(root, '/first/checkout');
  await recordTerminal(root, 't-architect');
  terminals.set('t-architect', terminalState('live'));

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    'The architect is already running in /other/checkout.',
  );

  expect(appCommands(app)).toEqual(['ls']);
});

it.each([
  {
    name: 'a finished terminal',
    state: 'finished',
    layout: undefined,
    message: 'The architect is already running in /other/checkout.',
  },
  {
    name: 'a parked terminal',
    state: 'live',
    layout: parkedLayout,
    message:
      'The architect terminal t-architect is parked: it still runs but has no pane. Give it a pane with herdr-app do terminal.keep --terminal t-architect, then call architect open again.',
  },
])('open refuses $name without reading the lock again', async ({ state, layout, message }) => {
  const { root } = await setup((cleanup) => {
    onTestFinished(cleanup);
  });

  const { app, terminals, tool } = openTool(root);

  await holdLock(root, '/other/checkout');
  await recordTerminal(root, 't-architect');
  terminals.set('t-architect', terminalState(state));

  if (layout !== undefined) {
    app.overrideOutput('ls', layout);
  }

  lockReads.directory = dirname(architectLockPath(root));
  lockReads.failFrom = 2;

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(message);

  expect(lockReads.count).toBe(1);
  expect(app.calls.every((call) => call.commandArguments[0] === 'ls')).toBe(true);
});

it('open refuses and starts nothing when the pane of a live architect terminal cannot be read', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, terminals, tool } = openTool(root);

  await holdLock(root, root);
  await recordTerminal(root, 't-architect');
  terminals.set('t-architect', terminalState('live'));
  app.failCommand('ls', 'herdr-app is unavailable');

  const failure = await open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('The architect terminal t-architect is live');
  expect((failure as Error).message).toContain('pane could not be read');
  expect((failure as Error).message).toContain('herdr-app is unavailable');
  expect((failure as Error).cause).toBeInstanceOf(Error);
  expect(appCommands(app)).toEqual(['ls']);
});

it('open treats a recorded terminal that hc does not know as not live', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const afterTerminalLookup = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const { app, tool } = openTool(root, undefined, afterTerminalLookup);

  await holdLock(root, '/other/checkout');
  await recordTerminal(root, 't-architect');

  await expect(open(tool, root, { request: openRequest })).rejects.toThrow(
    'The architect is already running in /other/checkout.',
  );

  expect(afterTerminalLookup).not.toHaveBeenCalled();
  expect(app.calls).toEqual([]);
});

it.each([
  { name: 'no', space: undefined },
  { name: 'an empty', space: '' },
])(
  'open starts a new space when the lead terminal has $name herdr.space label',
  async ({ space }) => {
    const { root } = await setup((cleanup) => {
      onTestFinished(cleanup);
    });

    const { app, tool } = openTool(root, { space });

    const result = await open(tool, root, { request: openRequest });

    expect(result.details).toEqual({
      action: 'open',
      status: 'opened',
      sessionFile: null,
      model: 'a/architect',
    });

    expect(appCommands(app)).toEqual(['space.new']);
    expect(app.calls).toHaveLength(1);

    const args = app.calls[0]?.commandArguments ?? [];

    expect(argumentAfter(args, '--name')).toBe(`architect-${basename(root)}`);
    expect(argumentAfter(args, '--tab')).toBe('architect');
    expect(argumentAfter(args, '--task')).toContain(openRequest);
  },
);

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

it.each([
  { input: { action: 'open', request: 'Start', question: 'Why?' }, rejected: 'question' },
  { input: { action: 'open', request: 'Start', restatement: 'Do it' }, rejected: 'restatement' },
  { input: { action: 'ask', question: 'Why?', request: 'Start' }, rejected: 'request' },
])('$input.action rejects $rejected and runs no herdr command', async ({ input, rejected }) => {
  const { root } = await setup((cleanup) => {
    onTestFinished(cleanup);
  });

  const { app, tool } = openTool(root);

  await expect(
    tool.execute('call', input as never, undefined, undefined, contextOf(root)),
  ).rejects.toThrow(`does not take ${rejected}.`);

  expect(app.calls).toEqual([]);
});
