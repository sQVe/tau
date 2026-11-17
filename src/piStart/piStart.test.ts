import { expect, it, onTestFinished } from 'vitest';

import { createExecFake, succeededResult } from '../../tests/execFake.js';
import type { ExecFake } from '../../tests/execFake.js';
import {
  createTemporaryBareRepository,
  createTemporaryRepository,
} from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { startPiSession } from './piStart.js';

const createAppFake = (): ExecFake<'app'> =>
  createExecFake<'app'>({
    keyOf: (command) => (command === 'herdr-app' ? 'app' : undefined),
    handlerFor: () => () => succeededResult('{"ok":true}'),
  });

it('a tab start passes the argv as JSON', async () => {
  const fake = createAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: { space: 'space-1' },
      task: 'Next steps\n',
      model: 'morph/morph-dsv41flash-1017',
      session: '/tmp/architect.jsonl',
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
  const fake = createAppFake();
  const root = await createTemporaryBareRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    {
      folder: root,
      target: { space: 'space-1' },
      task: 'Next steps\n',
      model: undefined,
      session: undefined,
      environment: undefined,
    },
  );

  expect(result).toEqual({ reply: '{"ok":true}' });
  expect(fake.calls).toHaveLength(1);
});

it('a folder that is not a Git checkout is refused', async () => {
  const fake = createAppFake();
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
        environment: undefined,
      },
    ),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});
