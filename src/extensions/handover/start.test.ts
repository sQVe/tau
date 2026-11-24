import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { argumentAfter } from '../../../tests/execFake.js';
import type { ExecFake } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHerdrAppFake } from '../../../tests/herdrAppFake.js';
import type { HerdrAppCommand } from '../../../tests/herdrAppFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { tabName } from '../../tabName.js';
import type { SpaceChoice } from './placement.js';
import { startHandover } from './start.js';
import type { StartHandoverRequest } from './start.js';

const runtimeOf = (fake: ExecFake<HerdrAppCommand>, cwd: string) => ({
  exec: fake.exec,
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
  spaceChoice: SpaceChoice,
  title: string,
): StartHandoverRequest => ({
  cwd: root,
  file,
  folder: root,
  spaceChoice,
  title,
  model: undefined,
  bareRoot: false,
  sender: undefined,
});

const commandsOf = (fake: ExecFake<HerdrAppCommand>) =>
  fake.calls.map(({ command, commandArguments }) => ({ command, commandArguments }));

const launchesOf = (fake: ExecFake<HerdrAppCommand>) =>
  commandsOf(fake).filter(({ commandArguments }) => commandArguments[0] === 'do');

const tabCommand = (root: string, argv: string, task: string, title: string) => ({
  command: 'herdr-app',
  commandArguments: [
    'do',
    'tab.new',
    '--space',
    'space-1',
    '--folder',
    root,
    '--name',
    tabName('lead', title),
    '--argv',
    argv,
    '--task',
    task,
    '--focus',
    'false',
  ],
});

it('names the tab after the handover title in an existing space', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await startHandover(
    runtimeOf(fake, root),
    requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Engine moves to src/core'),
  );

  const [launch] = fake.calls;

  expect(argumentAfter(launch?.commandArguments ?? [], '--name')).toBe(
    tabName('lead', 'Engine moves to src/core'),
  );
});

it('opens a tab in the space with the file text as its task', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  const result = await startHandover(
    runtimeOf(fake, root),
    requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
  );

  expect(result).toEqual({
    reply: '{"space":"space-1","tab":"tb-new","terminal":"t-new"}',
    space: 'space-1',
    tab: 'tb-new',
    terminal: 't-new',
    spaceStatus: 'reused',
  });

  expect(commandsOf(fake)).toEqual([tabCommand(root, '["pi"]', 'Next steps\n', 'Next steps')]);
});

it('passes the lead as sender to the new tab', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await startHandover(runtimeOf(fake, root), {
    ...requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    sender: { terminal: 't7', sessionId: 'lead-id' },
  });

  expect(commandsOf(fake)).toEqual([
    tabCommand(
      root,
      '["env","TAU_HANDOVER_SENDER_TERMINAL=t7","TAU_HANDOVER_SENDER_SESSION=lead-id","pi"]',
      'Handover sender: terminal t7, session lead-id.\n\nNext steps\n',
      'Next steps',
    ),
  ]);
});

it('starts without a sender as today', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await startHandover(runtimeOf(fake, root), {
    ...requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    sender: undefined,
  });

  expect(commandsOf(fake)).toEqual([tabCommand(root, '["pi"]', 'Next steps\n', 'Next steps')]);
});

it('opens a new space with Pi in its only tab', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  const result = await startHandover(
    runtimeOf(fake, root),
    requestFor(root, file, { kind: 'decide' }, 'ticket-1'),
  );

  expect(result).toEqual({
    reply: '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
    space: 'sp-new',
    tab: 'tb-new',
    terminal: 't-new',
    spaceStatus: 'created',
  });

  expect(launchesOf(fake)).toEqual([
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
        tabName('lead', 'ticket-1'),
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

it.each([
  { label: 'a task that begins with ---', task: '---\nlead: task\n' },
  { label: 'a task that begins with --help', task: '--help\n' },
  { label: 'a task that begins with @', task: '@file\n' },
  { label: 'a task at the handover byte limit', task: 'x'.repeat(102_400) },
])('passes $label after --task unchanged', async ({ task }) => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, task);

  await startHandover(
    runtimeOf(fake, root),
    requestFor(root, file, { kind: 'decide' }, 'ticket-1'),
  );

  const [launch] = launchesOf(fake);

  expect(argumentAfter(launch?.commandArguments ?? [], '--argv')).toBe('["pi"]');
  expect(argumentAfter(launch?.commandArguments ?? [], '--task')).toBe(task);
});

it('refuses a file outside .tau/handovers before any herdr-app call', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = join(root, 'message.md');

  await writeFile(file, 'Next steps\n');

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { kind: 'decide' }, 'ticket-1')),
  ).rejects.toThrow(/outside the \.tau\/handovers directory/);

  expect(fake.calls).toEqual([]);
});

it('refuses an empty file before any herdr-app call', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, '');

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { kind: 'decide' }, 'ticket-1')),
  ).rejects.toThrow(/handover file is empty/);

  expect(fake.calls).toEqual([]);
});

it('refuses a handover too large for one command argument before any herdr-app call', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'x'.repeat(102_401));

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { kind: 'decide' }, 'ticket-1')),
  ).rejects.toThrow(/handover file is larger than/);

  expect(fake.calls).toEqual([]);
});

it('refuses a folder that already has a space before any herdr-app launch', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: root }] });
  const file = await writeHandover(root, 'Next steps\n');

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { kind: 'decide' }, 'ticket-1')),
  ).rejects.toThrow(/folder already has a space: sp-1/);

  expect(launchesOf(fake)).toEqual([]);
});

it('refuses a folder that is not a Git checkout before any herdr-app call', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const folder = temporaryDirectory(onTestFinished, 'tau-start-');

  await expect(
    startHandover(runtimeOf(fake, root), {
      ...requestFor(root, file, { kind: 'decide' }, 'ticket-1'),
      folder,
    }),
  ).rejects.toThrow(/start folder is not a Git checkout/);

  expect(fake.calls).toEqual([]);
});

it('runs nothing when the signal is already aborted', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const controller = new AbortController();

  controller.abort();

  await expect(
    startHandover(
      { ...runtimeOf(fake, root), signal: controller.signal },
      requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });

  expect(fake.calls).toEqual([]);
});

it('returns the reply and the parsed launch fields', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');
  const reply = '{"space":"sp-1","tab":"tb-1","terminal":"t-space"}';

  fake.overrideOutput('space.new', reply);

  const result = await startHandover(
    runtimeOf(fake, root),
    requestFor(root, file, { kind: 'create' }, 'ticket-1'),
  );

  expect(result).toEqual({
    reply,
    space: 'sp-1',
    tab: 'tb-1',
    terminal: 't-space',
    spaceStatus: 'created',
  });
});
