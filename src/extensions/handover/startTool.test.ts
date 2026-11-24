import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { argumentAfter } from '../../../tests/execFake.js';
import type { ExecFake } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { createHerdrAppFake } from '../../../tests/herdrAppFake.js';
import type { HerdrAppCommand, HerdrAppFakeOptions } from '../../../tests/herdrAppFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { tabName } from '../../tabName.js';
import { createHandoverTool } from './tool.js';

type StartTool = ReturnType<typeof createHandoverTool>;
type StartToolInput = Parameters<StartTool['execute']>[1];

const startTool = (app: ExecFake<HerdrAppCommand>): StartTool =>
  createHandoverTool({ exec: app.exec, connect: createHcFake().connect, cwd: '/repository' });

const writeHandover = async (root: string): Promise<string> => {
  const directory = join(root, '.tau', 'handovers');
  const file = join(directory, 'message.md');

  await mkdir(directory, { recursive: true });
  await writeFile(file, 'Next steps\n');

  return file;
};

const launchCommands = (app: ExecFake<HerdrAppCommand>) =>
  app.calls.filter((call) => call.commandArguments[0] === 'do');

const failureOf = async (execution: Promise<unknown>): Promise<Error> => {
  const failure = await execution.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  return failure as Error;
};

const startRequest = (
  root: string,
  file: string,
  extras: { space?: string; newSpace?: boolean },
): StartToolInput => ({
  action: 'start',
  file,
  folder: root,
  name: 'next step',
  ...extras,
});

it('refuses a start without space when the folder already has a space', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: root }] });

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, { newSpace: false }),
    undefined,
    undefined,
    noUiContext(root),
  );

  const failure = await failureOf(execution);

  expect(failure.message).toContain('sp-1');
  expect(launchCommands(app)).toEqual([]);
});

it('refuses a start without space when the folder has two spaces and names both', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);

  const app = createHerdrAppFake({
    spaces: [
      { id: 'sp-1', name: 'platform', folder: root },
      { id: 'sp-2', name: 'second', folder: root },
    ],
  });

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, {}),
    undefined,
    undefined,
    noUiContext(root),
  );

  const failure = await failureOf(execution);

  expect(failure.message).toContain('sp-1 "platform", sp-2 "second"');
  expect(launchCommands(app)).toEqual([]);
});

it('refuses a start without space when the listed folder has a trailing slash', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);

  const app = createHerdrAppFake({
    spaces: [{ id: 'sp-1', name: 'platform', folder: `${root}/` }],
  });

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, {}),
    undefined,
    undefined,
    noUiContext(root),
  );

  const failure = await failureOf(execution);

  expect(failure.message).toContain('sp-1');
  expect(launchCommands(app)).toEqual([]);
});

it('refuses a start without space when the request folder has a trailing slash', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: root }] });

  const execution = startTool(app).execute(
    'call',
    { ...startRequest(root, file, {}), folder: `${root}/` },
    undefined,
    undefined,
    noUiContext(root),
  );

  const failure = await failureOf(execution);

  expect(failure.message).toContain('sp-1');
  expect(launchCommands(app)).toEqual([]);
});

it('refuses a start when the folder has a space listed through a symlink', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const alias = join(root, 'alias');

  await symlink(root, alias, 'dir');

  const app = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: alias }] });

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, {}),
    undefined,
    undefined,
    noUiContext(root),
  );

  const failure = await failureOf(execution);

  expect(failure.message).toContain('sp-1 "platform"');
  expect(launchCommands(app)).toEqual([]);
});

it('refuses a start when a listed space path crosses a symlink with ..', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const base = join(root, 'base');
  const child = join(root, 'child');

  await mkdir(base);
  await mkdir(child);
  await symlink(child, join(base, 'link'), 'dir');

  const listed = `${join(base, 'link')}/..`;
  const app = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: listed }] });

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, {}),
    undefined,
    undefined,
    noUiContext(root),
  );

  const failure = await failureOf(execution);

  expect(failure.message).toContain('sp-1 "platform"');
  expect(launchCommands(app)).toEqual([]);
});

it('creates a space when a listed space folder no longer exists', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const gone = join(root, 'gone');
  const app = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: gone }] });

  const result = await startTool(app).execute(
    'call',
    startRequest(root, file, {}),
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toEqual({
    space: 'sp-new',
    tab: 'tb-new',
    terminal: 't-new',
    spaceStatus: 'created',
  });

  const launchKinds = launchCommands(app).map((call) => call.commandArguments[1]);

  expect(launchKinds).toEqual(['space.new']);
});

it('creates a space when only another machine has one for the folder', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);

  const app = createHerdrAppFake({
    spaces: [{ id: 'sp-1', name: 'platform', folder: root, machine: 'build-2' }],
  });

  const result = await startTool(app).execute(
    'call',
    startRequest(root, file, {}),
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toEqual({
    reply: '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
    space: 'sp-new',
    tab: 'tb-new',
    terminal: 't-new',
    spaceStatus: 'created',
  });

  const launchKinds = launchCommands(app).map((call) => call.commandArguments[1]);

  expect(launchKinds).toEqual(['space.new']);
});

const creationRows: {
  label: string;
  spacesFor: (root: string) => NonNullable<HerdrAppFakeOptions['spaces']>;
  extras: { newSpace?: boolean };
}[] = [
  {
    label: 'an empty folder',
    spacesFor: () => [],
    extras: {},
  },
  {
    label: 'a folder that already has a space',
    spacesFor: (root) => [{ id: 'sp-1', name: 'platform', folder: root }],
    extras: { newSpace: true },
  },
];

it.each(creationRows)('creates a space in $label', async ({ spacesFor, extras }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake({ spaces: spacesFor(root) });

  const result = await startTool(app).execute(
    'call',
    startRequest(root, file, extras),
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toEqual({
    reply: '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
    space: 'sp-new',
    tab: 'tb-new',
    terminal: 't-new',
    spaceStatus: 'created',
  });

  const launches = launchCommands(app);

  expect(launches).toHaveLength(1);

  const [launch] = launches;

  expect(launch?.commandArguments[1]).toBe('space.new');
  expect(argumentAfter(launch?.commandArguments ?? [], '--name')).toBe('next step');

  expect(argumentAfter(launch?.commandArguments ?? [], '--tab')).toBe(tabName('lead', 'next step'));
});

it('opens a tab in the space the caller names without listing the spaces', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: root }] });

  const result = await startTool(app).execute(
    'call',
    startRequest(root, file, { space: 'space-1' }),
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toEqual({
    reply: '{"space":"space-1","tab":"tb-new","terminal":"t-new"}',
    space: 'space-1',
    tab: 'tb-new',
    terminal: 't-new',
    spaceStatus: 'reused',
  });

  const commands = app.calls.map((call) => call.commandArguments[0]);

  expect(commands).toEqual(['do']);

  const launches = launchCommands(app);

  expect(launches.map((call) => call.commandArguments[1])).toEqual(['tab.new']);

  const [launch] = launches;

  expect(argumentAfter(launch?.commandArguments ?? [], '--space')).toBe('space-1');
  expect(argumentAfter(launch?.commandArguments ?? [], '--folder')).toBe(root);

  expect(argumentAfter(launch?.commandArguments ?? [], '--name')).toBe(
    tabName('lead', 'next step'),
  );
});

it('returns the declared fields and the reply from a launch reply', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake();

  app.overrideOutput(
    'tab.new',
    JSON.stringify({
      space: 'sp-reply',
      tab: 'tb-reply',
      terminal: 't-reply',
      extra: 'not declared',
    }),
  );

  const result = await startTool(app).execute(
    'call',
    startRequest(root, file, { space: 'space-1' }),
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toEqual({
    reply: JSON.stringify({
      space: 'sp-reply',
      tab: 'tb-reply',
      terminal: 't-reply',
      extra: 'not declared',
    }),
    space: 'sp-reply',
    tab: 'tb-reply',
    terminal: 't-reply',
    spaceStatus: 'reused',
  });
});

it('rejects malformed launch output after exactly one launch', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake();

  app.overrideOutput('tab.new', JSON.stringify({ space: 'space-1', tab: 'tb-new' }));

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, { space: 'space-1' }),
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('herdr-app do printed unexpected output');

  expect(launchCommands(app)).toHaveLength(1);
});

it('refuses newSpace together with space before any herdr-app call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake();

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, { space: 'space-1', newSpace: true }),
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(/space and newSpace/);

  expect(app.calls).toEqual([]);
});

it('refuses a listed space without a folder before any launch', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake();

  app.overrideOutput(
    'ls',
    JSON.stringify({ spaces: [{ id: 'sp-1', name: 'platform', machine: null }] }),
  );

  const execution = startTool(app).execute(
    'call',
    startRequest(root, file, {}),
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow('herdr-app ls printed unexpected output');

  expect(launchCommands(app)).toEqual([]);
});

it('refuses newSpace with prepare and creates no directory', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const tool = startTool(createHerdrAppFake());

  const execution = tool.execute(
    'call',
    { action: 'prepare', newSpace: true },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(/newSpace is only for action start/);

  expect(existsSync(join(root, '.tau'))).toBe(false);
});

it('refuses newSpace with send before any hc call', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();
  const tool = createHandoverTool({ exec: hc.exec, connect: hc.connect, cwd: '/repository' });

  const execution = tool.execute(
    'call',
    { action: 'send', terminal: 't7', file: join(root, 'message.md'), newSpace: true },
    undefined,
    undefined,
    noUiContext(root),
  );

  await expect(execution).rejects.toThrow(/newSpace is only for action start/);

  expect(hc.calls).toEqual([]);
});
