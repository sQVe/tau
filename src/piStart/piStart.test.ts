import { expect, it, onTestFinished } from 'vitest';

import { createExecFake, succeededResult } from '../../tests/execFake.js';
import type { ExecFake } from '../../tests/execFake.js';
import {
  createTemporaryBareRepository,
  createTemporaryRepository,
} from '../../tests/gitRepository.js';
import { createHerdrAppFake } from '../../tests/herdrAppFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { startPiSession, startPiSessionRightOf } from './piStart.js';

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

const paneAppFake = (splitReply: string): ExecFake<'split'> =>
  createExecFake<'split'>({
    keyOf: (command) => (command === 'herdr-app' ? 'split' : undefined),
    handlerFor: () => () => succeededResult(splitReply),
  });

it('a pane start splits to the right of the requested pane once', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSessionRightOf(
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

  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]?.command).toBe('herdr-app');

  expect(fake.calls[0]?.commandArguments).toEqual([
    'do',
    'pane.split',
    '--direction',
    'right',
    '--pane',
    'p-lead',
    '--argv',
    JSON.stringify(['env', '-C', root, 'env', 'TAU_ROLE=architect', 'pi', 'Design this']),
  ]);
});

it('a pane split reply without a pane ends the start', async () => {
  const fake = createHerdrAppFake();

  fake.overrideOutput('pane.split', '{"terminal":"t-new"}');

  const root = await createTemporaryRepository(onTestFinished);

  await expect(
    startPiSessionRightOf(
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

const paneRequest = (root: string) => ({
  folder: root,
  pane: 'p-lead',
  task: 'Design this',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
});

it('a right-of start in a folder that is not a Git checkout runs no command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-');

  await expect(
    startPiSessionRightOf({ exec: fake.exec, cwd: root }, { ...paneRequest(root), folder }),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a right-of start with an aborted signal runs no command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  controller.abort(new Error('cancelled before start'));

  await expect(
    startPiSessionRightOf(
      { exec: fake.exec, cwd: root, signal: controller.signal },
      paneRequest(root),
    ),
  ).rejects.toThrow('cancelled before start');

  expect(fake.calls).toEqual([]);
});
