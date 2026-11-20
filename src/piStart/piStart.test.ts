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

it('a space start opens one tab with the argv as JSON', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: { space: 'space-1' },
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

it('a true bare repository root starts a session', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryBareRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: { space: 'space-1' },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      bareRoot: true,
      environment: undefined,
    },
  );

  expect(result).toEqual({ reply: '{"ok":true}' });
  expect(fake.calls).toHaveLength(1);
});

it('a folder that is not a Git checkout is refused', async () => {
  const fake = createHerdrAppFake();
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
  const fake = createHerdrAppFake();

  fake.overrideOutput('pane.split', '{"terminal":"t-new"}');

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
