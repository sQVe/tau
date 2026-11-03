import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createExecFake, succeededResult } from '../../../tests/execFake.js';
import type { ExecFake } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { startHandover } from './start.js';
import type { StartHandoverRequest, StartHandoverTarget } from './start.js';

const createHerdrFake = (): ExecFake<'herdr'> =>
  createExecFake<'herdr'>({
    keyOf: (command) => (command === 'herdr-app' ? 'herdr' : undefined),
    handlerFor: () => () => succeededResult('{"ok":true}'),
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
): StartHandoverRequest => ({ cwd: root, file, folder: root, target });

const commandsOf = (fake: ExecFake<'herdr'>) =>
  fake.calls.map(({ command, commandArguments }) => ({ command, commandArguments }));

it('opens a Manager tab in the space with the file text as its task', async () => {
  const fake = createHerdrFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  const result = await startHandover(
    { exec: fake.exec, cwd: root },
    requestFor(root, file, { space: 'space-1' }),
  );

  expect(result).toEqual({ reply: '{"ok":true}' });

  expect(commandsOf(fake)).toEqual([
    {
      command: 'herdr-app',
      commandArguments: [
        'do',
        'tab.new',
        '--space',
        'space-1',
        '--name',
        'Manager',
        '--folder',
        root,
        '--argv',
        '["pi"]',
        '--task',
        'Next steps\n',
      ],
    },
  ]);
});

it('opens a new space with a Manager tab when no space is given', async () => {
  const fake = createHerdrFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await startHandover({ exec: fake.exec, cwd: root }, requestFor(root, file, { name: 'ticket-1' }));

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
        '--tab',
        'Manager',
        '--argv',
        '["pi"]',
        '--task',
        'Next steps\n',
      ],
    },
  ]);
});

it('refuses a file outside .tau/handovers before any herdr-app call', async () => {
  const fake = createHerdrFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = join(root, 'message.md');

  await writeFile(file, 'Next steps\n');

  await expect(
    startHandover({ exec: fake.exec, cwd: root }, requestFor(root, file, { name: 'ticket-1' })),
  ).rejects.toThrow(/outside the .tau\/handovers directory/);

  expect(fake.calls).toEqual([]);
});

it('refuses an empty file before any herdr-app call', async () => {
  const fake = createHerdrFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, '');

  await expect(
    startHandover({ exec: fake.exec, cwd: root }, requestFor(root, file, { name: 'ticket-1' })),
  ).rejects.toThrow(/handover file is empty/);

  expect(fake.calls).toEqual([]);
});

it('refuses a handover too large for one command argument before any herdr-app call', async () => {
  const fake = createHerdrFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'x'.repeat(102_401));

  await expect(
    startHandover({ exec: fake.exec, cwd: root }, requestFor(root, file, { name: 'ticket-1' })),
  ).rejects.toThrow(/handover file is larger than/);

  expect(fake.calls).toEqual([]);
});

it('refuses a folder that is not a Git checkout before any herdr-app call', async () => {
  const fake = createHerdrFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const folder = temporaryDirectory(onTestFinished, 'tau-start-');

  await expect(
    startHandover(
      { exec: fake.exec, cwd: root },
      { ...requestFor(root, file, { name: 'ticket-1' }), folder },
    ),
  ).rejects.toThrow(/start folder is not a Git checkout/);

  expect(fake.calls).toEqual([]);
});

it('runs nothing when the signal is already aborted', async () => {
  const fake = createHerdrFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const controller = new AbortController();

  controller.abort();

  await expect(
    startHandover(
      { exec: fake.exec, cwd: root, signal: controller.signal },
      requestFor(root, file, { space: 'space-1' }),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });

  expect(fake.calls).toEqual([]);
});
