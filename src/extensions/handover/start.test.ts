import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createExecFake, succeededResult } from '../../../tests/execFake.js';
import type { ExecFake } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { Exec } from '../../command.js';
import { startHandover } from './start.js';
import type { StartHandoverRequest, StartHandoverTarget } from './start.js';

type AppKey = 'ls' | 'app';

const emptyLayout = JSON.stringify({ spaces: [] });

const createAppFake = (): ExecFake<AppKey> =>
  createExecFake<AppKey>({
    keyOf: (command, commandArguments) => {
      if (command !== 'herdr-app') {
        return undefined;
      }

      return commandArguments[0] === 'ls' ? 'ls' : 'app';
    },
    handlerFor: (key) => () => {
      const reply = key === 'ls' ? emptyLayout : '{"ok":true}';

      return succeededResult(reply);
    },
  });

const runtimeOf = (fake: ExecFake<AppKey>, cwd: string) => ({
  exec: fake.exec,
  connect: createHcFake().connect,
  cwd,
});

const writeHandover = async (root: string, content: string): Promise<string> => {
  const directory = join(root, '.tau', 'handovers');
  const file = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(file, content);

  return file;
};

const requestFor = (
  root: string,
  file: string,
  target: StartHandoverTarget,
): StartHandoverRequest => ({
  cwd: root,
  file,
  folder: root,
  target,
  model: undefined,
  bareRoot: false,
});

const commandsOf = (fake: ExecFake<AppKey>) =>
  fake.calls.map(({ command, commandArguments }) => ({ command, commandArguments }));

it('opens a tab in the space with the file text as its task', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  const result = await startHandover(
    runtimeOf(fake, root),
    requestFor(root, file, { space: 'space-1' }),
  );

  expect(result).toEqual({ reply: '{"ok":true}' });

  expect(commandsOf(fake)).toEqual([
    {
      command: 'herdr-app',
      commandArguments: ['ls'],
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
        '["pi"]',
        '--task',
        'Next steps\n',
        '--focus',
        'false',
      ],
    },
  ]);
});

it('opens a new space with a tab when no space is given', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await startHandover(runtimeOf(fake, root), requestFor(root, file, { name: 'ticket-1' }));

  expect(commandsOf(fake)).toEqual([
    {
      command: 'herdr-app',
      commandArguments: [
        'do',
        'space.new',
        '--name',
        'ticket-1',
        '--folder',
        root,
        '--argv',
        '["pi"]',
        '--task',
        'Next steps\n',
        '--focus',
        'false',
      ],
    },
  ]);
});

const shellLayout = JSON.stringify({
  spaces: [
    {
      id: 'space-1',
      tabs: [{ terminals: [{ terminal: 't-shell', pane: 'p-shell', app: null }] }],
    },
  ],
});

const shellAppFake = (): ExecFake<'ls' | 'pane.split' | 'pane.close'> =>
  createExecFake<'ls' | 'pane.split' | 'pane.close'>({
    keyOf: (command, commandArguments) => {
      if (command !== 'herdr-app') {
        return undefined;
      }

      if (commandArguments[0] === 'ls') {
        return 'ls';
      }

      const [, name] = commandArguments;

      return name === 'pane.split' || name === 'pane.close' ? name : undefined;
    },
    handlerFor: (key) => () => {
      if (key === 'ls') {
        return succeededResult(shellLayout);
      }

      if (key === 'pane.split') {
        return succeededResult('{"pane":"p-new","terminal":"t-new"}');
      }

      return succeededResult('{"ok":true}');
    },
  });

const routedExec =
  (app: ExecFake<'ls' | 'pane.split' | 'pane.close'>, hc: HcFake): Exec =>
  (command, commandArguments, options) =>
    command === 'herdr-app'
      ? app.exec(command, commandArguments, options)
      : hc.exec(command, commandArguments, options);

it('a space start reads the shell foreground with hc get and takes over the tab', async () => {
  const app = shellAppFake();
  const hc = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  hc.replyGet(
    't-shell',
    JSON.stringify({
      address: 't-shell',
      state: 'live',
      foreground: { pid: 1, name: 'zsh', argv: ['zsh'], cwd: root },
    }),
  );

  const result = await startHandover(
    { exec: routedExec(app, hc), connect: hc.connect, cwd: root },
    requestFor(root, file, { space: 'space-1' }),
  );

  expect(result).toEqual({ reply: '{"pane":"p-new","terminal":"t-new"}' });

  expect(app.calls.map((call) => call.commandArguments[1] ?? call.commandArguments[0])).toEqual([
    'ls',
    'pane.split',
    'pane.close',
  ]);

  expect(hc.calls.map((call) => call.commandArguments)).toEqual([
    ['get', '--json', '--', 't-shell'],
    ['get', '--json', '--', 't-shell'],
  ]);
});

it('refuses a file outside .tau/handovers before any herdr-app call', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = join(root, 'message.md');

  await writeFile(file, 'Next steps\n');

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { name: 'ticket-1' })),
  ).rejects.toThrow(/outside the .tau\/handovers directory/);

  expect(fake.calls).toEqual([]);
});

it('refuses an empty file before any herdr-app call', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, '');

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { name: 'ticket-1' })),
  ).rejects.toThrow(/handover file is empty/);

  expect(fake.calls).toEqual([]);
});

it('refuses a handover too large for one command argument before any herdr-app call', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'x'.repeat(102_401));

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { name: 'ticket-1' })),
  ).rejects.toThrow(/handover file is larger than/);

  expect(fake.calls).toEqual([]);
});

it('refuses a folder that is not a Git checkout before any herdr-app call', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const folder = temporaryDirectory(onTestFinished, 'tau-start-');

  await expect(
    startHandover(runtimeOf(fake, root), {
      ...requestFor(root, file, { name: 'ticket-1' }),
      folder,
    }),
  ).rejects.toThrow(/start folder is not a Git checkout/);

  expect(fake.calls).toEqual([]);
});

it('runs nothing when the signal is already aborted', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const controller = new AbortController();

  controller.abort();

  await expect(
    startHandover(
      { ...runtimeOf(fake, root), signal: controller.signal },
      requestFor(root, file, { space: 'space-1' }),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });

  expect(fake.calls).toEqual([]);
});
