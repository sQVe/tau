import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { argumentAfter } from '../../../tests/execFake.js';
import type { ExecFake } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import {
  commandArgumentsOf,
  createHerdrAppFake,
  spaceOrTabLaunchesOf,
} from '../../../tests/herdrAppFake.js';
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

  expect(failure.message).toContain('sp-1 "platform"');
  expect(commandArgumentsOf(app.calls)).toEqual([['ls']]);
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

  expect(failure.message).toContain('sp-1 "platform"');
  expect(commandArgumentsOf(app.calls)).toEqual([['ls']]);
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
  expect(commandArgumentsOf(app.calls)).toEqual([['ls']]);
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
  expect(commandArgumentsOf(app.calls)).toEqual([['ls']]);
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
    reply: '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
    space: 'sp-new',
    tab: 'tb-new',
    terminal: 't-new',
    model: 'default',
    spaceStatus: 'created',
  });

  const launchKinds = spaceOrTabLaunchesOf(app).map((call) => call.commandArguments[1]);

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
    model: 'default',
    spaceStatus: 'created',
  });

  const launches = spaceOrTabLaunchesOf(app);

  expect(launches).toHaveLength(1);

  const [launch] = launches;

  expect(launch?.commandArguments[1]).toBe('space.new');
  expect(argumentAfter(launch?.commandArguments ?? [], '--name')).toBe('next step');

  expect(argumentAfter(launch?.commandArguments ?? [], '--tab')).toBe(tabName('lead', 'next step'));
});

it('creates a space when a listed space folder cannot be resolved', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const loop = join(root, 'loop');

  await symlink(loop, loop, 'dir');

  const app = createHerdrAppFake({ spaces: [{ id: 'sp-1', name: 'platform', folder: loop }] });

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
    model: 'default',
    spaceStatus: 'created',
  });

  const launchKinds = spaceOrTabLaunchesOf(app).map((call) => call.commandArguments[1]);

  expect(launchKinds).toEqual(['space.new']);
});

it('refuses a start with newSpace false when the folder already has a space', async () => {
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

  await expect(execution).rejects.toThrow(/folder already has a space: sp-1/);

  expect(commandArgumentsOf(app.calls)).toEqual([['ls']]);
});

it('creates a space without listing the spaces when the caller asks for one', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root);
  const app = createHerdrAppFake();

  app.failCommand('ls', 'ls failed');

  const result = await startTool(app).execute(
    'call',
    startRequest(root, file, { newSpace: true }),
    undefined,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toEqual({
    reply: '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
    space: 'sp-new',
    tab: 'tb-new',
    terminal: 't-new',
    model: 'default',
    spaceStatus: 'created',
  });

  expect(app.calls.map((call) => call.commandArguments[0])).toEqual(['do', 'get']);
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
    model: 'default',
    spaceStatus: 'reused',
  });

  const commands = app.calls.map((call) => call.commandArguments[0]);

  expect(commands).toEqual(['do', 'get']);

  const launches = spaceOrTabLaunchesOf(app);

  expect(launches.map((call) => call.commandArguments[1])).toEqual(['tab.new']);

  const [launch] = launches;

  expect(argumentAfter(launch?.commandArguments ?? [], '--space')).toBe('space-1');
  expect(argumentAfter(launch?.commandArguments ?? [], '--folder')).toBe(root);

  expect(argumentAfter(launch?.commandArguments ?? [], '--name')).toBe(
    tabName('lead', 'next step'),
  );
});
