import { expect, it, onTestFinished } from 'vitest';

import type { ExecFake } from '../../tests/execFake.js';
import {
  createTemporaryBareRepository,
  createTemporaryRepository,
} from '../../tests/gitRepository.js';
import { createHerdrAppFake } from '../../tests/herdrAppFake.js';
import type { HerdrAppCommand } from '../../tests/herdrAppFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { startPiSession, startPiSessionLeftOf } from './piStart.js';

const emptyLayout = JSON.stringify({ spaces: [] });

const shellLayout = (space: string): string =>
  JSON.stringify({
    spaces: [
      {
        id: space,
        tabs: [{ terminals: [{ terminal: 't-shell', pane: 'p-shell', app: null }] }],
      },
    ],
  });

const appCommands = (fake: ExecFake<HerdrAppCommand>): string[] =>
  fake.calls.map((call) => call.commandArguments[1] ?? call.commandArguments[0] ?? '');

it('a tab start passes the argv as JSON', async () => {
  const fake = createHerdrAppFake({ layout: emptyLayout });
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: { space: 'space-1', readForeground: () => Promise.resolve(null) },
      task: 'Next steps\n',
      model: 'morph/morph-dsv41flash-1017',
      session: '/tmp/architect.jsonl',
      bareRoot: false,
      environment: { TAU_ROLE: 'architect' },
    },
  );

  expect(result).toEqual({ reply: '{"ok":true}' });

  expect(fake.calls).toEqual([
    {
      command: 'herdr-app',
      commandArguments: ['ls'],
      signal: undefined,
    },
    {
      command: 'herdr-app',
      commandArguments: [
        'do',
        'tab.new',
        '--space',
        'space-1',
        '--folder',
        root,
        '--argv',
        '["env","TAU_ROLE=architect","pi","--session","/tmp/architect.jsonl","--provider","morph","--model","morph-dsv41flash-1017"]',
        '--task',
        'Next steps\n',
        '--focus',
        'false',
      ],
      signal: undefined,
    },
  ]);
});

it('a space with one idle shell tab gets Pi by split and close', async () => {
  const fake = createHerdrAppFake({ layout: shellLayout('space-1') });
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: {
        space: 'space-1',
        readForeground: () => Promise.resolve({ name: 'zsh', cwd: root }),
      },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      environment: undefined,
    },
  );

  expect(result).toEqual({ reply: '{"pane":"p-new","terminal":"t-new"}' });

  expect(fake.calls.map((call) => call.commandArguments)).toEqual([
    ['ls'],
    [
      'do',
      'pane.split',
      '--direction',
      'right',
      '--pane',
      'p-shell',
      '--argv',
      JSON.stringify(['env', '-C', root, 'pi', 'Next steps\n']),
    ],
    ['do', 'pane.close', '--pane', 'p-shell'],
  ]);
});

it('a shell running another program keeps its tab', async () => {
  const fake = createHerdrAppFake({ layout: shellLayout('space-1') });
  const root = await createTemporaryRepository(onTestFinished);

  await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: {
        space: 'space-1',
        readForeground: () => Promise.resolve({ name: 'vim', cwd: root }),
      },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      environment: undefined,
    },
  );

  expect(appCommands(fake)).toEqual(['ls', 'tab.new']);
  expect(appCommands(fake)).not.toContain('pane.close');
});

it('a space id that matches no listed space starts a tab', async () => {
  const fake = createHerdrAppFake({ layout: shellLayout('space-other') });
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: {
        space: 'space-1',
        readForeground: () => Promise.resolve({ name: 'zsh', cwd: root }),
      },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      environment: undefined,
    },
  );

  expect(result).toEqual({ reply: '{"ok":true}' });
  expect(appCommands(fake)).toEqual(['ls', 'tab.new']);
});

it('a shell that turns busy during the split stays open', async () => {
  const fake = createHerdrAppFake({ layout: shellLayout('space-1') });
  const root = await createTemporaryRepository(onTestFinished);

  const foregrounds = [
    { name: 'zsh', cwd: root },
    { name: 'vim', cwd: root },
  ];

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: {
        space: 'space-1',
        readForeground: () => Promise.resolve(foregrounds.shift()),
      },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      environment: undefined,
    },
  );

  expect(result).toEqual({ reply: '{"pane":"p-new","terminal":"t-new"}' });
  expect(appCommands(fake)).toEqual(['ls', 'pane.split']);
});

it('a failed shell close names the new pane', async () => {
  const fake = createHerdrAppFake({ layout: shellLayout('space-1') });
  const root = await createTemporaryRepository(onTestFinished);

  fake.failCommand('pane.close', 'pane is gone');

  const failure = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: {
        space: 'space-1',
        readForeground: () => Promise.resolve({ name: 'zsh', cwd: root }),
      },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      environment: undefined,
    },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const { message, cause } = failure as Error;

  expect(message).toContain('pane p-new (terminal t-new)');
  expect(message).toContain('the shell pane p-shell did not close');
  expect(message).toContain('pane is gone');
  expect(cause).toBeInstanceOf(Error);
  expect(appCommands(fake)).toEqual(['ls', 'pane.split', 'pane.close']);
});

it('a failed second foreground read names the new pane and terminal', async () => {
  const fake = createHerdrAppFake({ layout: shellLayout('space-1') });
  const root = await createTemporaryRepository(onTestFinished);

  let reads = 0;

  const readForeground = () => {
    reads += 1;

    if (reads === 1) {
      return Promise.resolve({ name: 'zsh', cwd: root });
    }

    return Promise.reject(new Error('terminal t-shell is gone'));
  };

  const failure = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: { space: 'space-1', readForeground },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      environment: undefined,
    },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const { message, cause } = failure as Error;

  expect(message).toContain('pane p-new (terminal t-new)');
  expect(message).toContain('terminal t-shell is gone');
  expect(cause).toBeInstanceOf(Error);
  expect(appCommands(fake)).toEqual(['ls', 'pane.split']);
});

it('a true bare repository root starts a session', async () => {
  const fake = createHerdrAppFake({ layout: emptyLayout });
  const root = await createTemporaryBareRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: { space: 'space-1', readForeground: () => Promise.resolve(null) },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      bareRoot: true,
      environment: undefined,
    },
  );

  expect(result).toEqual({ reply: '{"ok":true}' });

  expect(fake.calls.map((call) => call.commandArguments[1] ?? call.commandArguments[0])).toEqual([
    'ls',
    'tab.new',
  ]);
});

it('a folder that is not a Git checkout is refused', async () => {
  const fake = createHerdrAppFake({ layout: emptyLayout });
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-');

  await expect(
    startPiSession(
      { exec: fake.exec, cwd: root },
      {
        folder,
        target: { name: 'ticket-1' },
        task: 'Next steps\n',
        model: undefined,
        session: undefined,
        bareRoot: false,
        environment: undefined,
      },
    ),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a left-of start splits right with the task in the argv, then swaps the new pane left', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSessionLeftOf(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      pane: 'p-lead',
      task: 'Design this',
      model: undefined,
      session: undefined,
      bareRoot: false,
      environment: { TAU_ROLE: 'architect' },
    },
  );

  expect(result).toEqual({ reply: '{"pane":"p-new","terminal":"t-new"}' });

  expect(fake.calls.map((call) => call.commandArguments)).toEqual([
    [
      'do',
      'pane.split',
      '--direction',
      'right',
      '--pane',
      'p-lead',
      '--argv',
      JSON.stringify(['env', '-C', root, 'env', 'TAU_ROLE=architect', 'pi', 'Design this']),
    ],
    ['do', 'pane.swap', '--pane', 'p-new', '--target', 'p-lead'],
  ]);
});

it('a pane split reply without a pane ends the start before the swap', async () => {
  const fake = createHerdrAppFake({ split: '{"terminal":"t-new"}' });
  const root = await createTemporaryRepository(onTestFinished);

  await expect(
    startPiSessionLeftOf(
      { exec: fake.exec, cwd: root },
      {
        folder: root,
        pane: 'p-lead',
        task: 'Design this',
        model: undefined,
        session: undefined,
        bareRoot: false,
        environment: undefined,
      },
    ),
  ).rejects.toThrow('herdr-app do pane.split printed unexpected output');

  expect(fake.calls).toHaveLength(1);
});

const failingSwapFake = (): ExecFake<HerdrAppCommand> => {
  const fake = createHerdrAppFake();

  fake.failCommand('pane.swap', 'no such pane');

  return fake;
};

const paneRequest = (root: string) => ({
  folder: root,
  pane: 'p-lead',
  task: 'Design this',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
});

it('a failed swap names the created pane and terminal and where the architect runs', async () => {
  const fake = failingSwapFake();
  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSessionLeftOf(
    { exec: fake.exec, cwd: root },
    paneRequest(root),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  const { message, cause } = failure as Error;

  expect(message).toContain('pane p-new (terminal t-new)');
  expect(message).toContain('but the swap did not finish');
  expect(message).toContain('no such pane');
  expect(message).not.toContain('p-lead');
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toContain('no such pane');
  expect(fake.calls).toHaveLength(2);
});

it('a cancel after the split skips the swap and names the created pane', async () => {
  const controller = new AbortController();

  const fake = createHerdrAppFake({
    beforeReply: () => {
      controller.abort();
    },
  });

  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSessionLeftOf(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    paneRequest(root),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('p-new');
  expect((failure as Error).message).toContain('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a left-of start in a folder that is not a Git checkout runs no command', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-');

  await expect(
    startPiSessionLeftOf({ exec: fake.exec, cwd: root }, { ...paneRequest(root), folder }),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a left-of start with an aborted signal runs no command', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  controller.abort(new Error('cancelled before start'));

  await expect(
    startPiSessionLeftOf(
      { exec: fake.exec, cwd: root, signal: controller.signal },
      paneRequest(root),
    ),
  ).rejects.toThrow('cancelled before start');

  expect(fake.calls).toEqual([]);
});
