import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { argumentAfter } from '../../../tests/execFake.js';
import type { ExecFake } from '../../../tests/execFake.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import {
  commandArgumentsOf,
  createHerdrAppFake,
  spaceOrTabLaunchesOf,
} from '../../../tests/herdrAppFake.js';
import type { HerdrAppCommand } from '../../../tests/herdrAppFake.js';
import { readbackCall } from '../../../tests/piStartRequests.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { StartedTabError } from '../../piStart/piStart.js';
import { readbackFailureBudgetMilliseconds } from '../../piStart/startedModel/startedModelReadback.js';
import { tabName } from '../../tabName.js';
import type { SpaceChoice } from './placement.js';
import { startHandover } from './start.js';
import type { StartHandoverRequest } from './start.js';

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../tests/timerFake.js');

  return { ...original, setTimeout: globalTimerDelay };
});

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

// The hc fake answers `hc` and the app fake answers `herdr-app`.
const execAnsweringHc =
  (app: ExecFake<HerdrAppCommand>, hc: HcFake): ExecFake<HerdrAppCommand>['exec'] =>
  (command, commandArguments, options) =>
    command === 'hc'
      ? hc.exec(command, commandArguments, options)
      : app.exec(command, commandArguments, options);

const tabArguments = (root: string, argv: string, task: string, title: string): string[] => [
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
];

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
    model: 'default',
    spaceStatus: 'reused',
  });

  expect(commandArgumentsOf(spaceOrTabLaunchesOf(fake))).toEqual([
    tabArguments(root, '["pi"]', 'Next steps\n', 'Next steps'),
  ]);

  expect(fake.calls).toContainEqual(readbackCall('t-new'));
});

it('names the started space, tab, and terminal when the started model differs', async () => {
  const app = createHerdrAppFake();
  const hc = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  hc.replyGet(
    't-new',
    JSON.stringify({
      address: 't-new',
      state: 'live',
      foreground: { pid: 1, name: 'pi', argv: ['pi', '--model', 'other/model'], cwd: root },
    }),
  );

  const failure = await startHandover(
    { exec: execAnsweringHc(app, hc), cwd: root },
    {
      ...requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
      model: 'morph/morph-dsv41flash-1017',
    },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(StartedTabError);

  const started = failure as StartedTabError;

  expect(started.terminal).toBe('t-new');
  expect(started.space).toBe('space-1');
  expect(started.tab).toBe('tb-new');
  expect(started.message).toContain('morph/morph-dsv41flash-1017');
  expect(started.message).toContain('other/model');
  expect(started.message).toContain('hc kill t-new');
  expect(spaceOrTabLaunchesOf(app)).toHaveLength(1);
});

it('passes the lead as sender to the new tab', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await startHandover(runtimeOf(fake, root), {
    ...requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    sender: { terminal: 't7', sessionId: 'lead-id' },
  });

  expect(commandArgumentsOf(spaceOrTabLaunchesOf(fake))).toEqual([
    tabArguments(
      root,
      '["env","TAU_HANDOVER_SENDER_TERMINAL=t7","TAU_HANDOVER_SENDER_SESSION=lead-id","pi"]',
      'Handover sender: terminal t7, session lead-id.\n\nNext steps\n',
      'Next steps',
    ),
  ]);

  expect(fake.calls).toContainEqual(readbackCall('t-new'));
});

it('starts without a sender as today', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  await startHandover(runtimeOf(fake, root), {
    ...requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    sender: undefined,
  });

  expect(commandArgumentsOf(spaceOrTabLaunchesOf(fake))).toEqual([
    tabArguments(root, '["pi"]', 'Next steps\n', 'Next steps'),
  ]);

  expect(fake.calls).toContainEqual(readbackCall('t-new'));
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
    model: 'default',
    spaceStatus: 'created',
  });

  expect(commandArgumentsOf(spaceOrTabLaunchesOf(fake))).toEqual([
    [
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

  const [launch] = spaceOrTabLaunchesOf(fake);

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

  expect(commandArgumentsOf(fake.calls)).toEqual([['ls']]);
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

  const reply = '{"space":"sp-1","tab":"tb-1","terminal":"t-space","extra":"not declared"}';

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
    model: 'default',
    spaceStatus: 'created',
  });
});

it.each([
  { label: 'a missing terminal', reply: '{"space":"space-1","tab":"tb-new"}' },
  { label: 'an empty space', reply: '{"space":"","tab":"tb-new","terminal":"t-new"}' },
  { label: 'an empty tab', reply: '{"space":"space-1","tab":"","terminal":"t-new"}' },
  { label: 'an empty terminal', reply: '{"space":"space-1","tab":"tb-new","terminal":""}' },
])('rejects $label in the launch reply after exactly one launch', async ({ reply }) => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.overrideOutput('tab.new', reply);

  await expect(
    startHandover(
      runtimeOf(fake, root),
      requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    ),
  ).rejects.toThrow('herdr-app do printed unexpected output');

  expect(spaceOrTabLaunchesOf(fake)).toHaveLength(1);
});

it('refuses a listed space without a folder before any launch', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  fake.overrideOutput(
    'ls',
    JSON.stringify({
      spaces: [{ id: 'sp-1', name: 'platform', machine: null }],
    }),
  );

  await expect(
    startHandover(runtimeOf(fake, root), requestFor(root, file, { kind: 'decide' }, 'ticket-1')),
  ).rejects.toThrow('herdr-app ls printed unexpected output');

  expect(commandArgumentsOf(fake.calls)).toEqual([['ls']]);
});

it('returns the model the started terminal runs', async () => {
  const app = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  const result = await startHandover(runtimeOf(app, root), {
    ...requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    model: 'morph/morph-dsv41flash-1017',
  });

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
  expect(spaceOrTabLaunchesOf(app)).toHaveLength(1);
  expect(app.calls).toContainEqual(readbackCall('t-new'));
});

it('reports the started terminal when the model readback fails', async () => {
  const app = createHerdrAppFake();
  const hc = createHcFake();
  const root = await createTemporaryRepository(onTestFinished);
  const file = await writeHandover(root, 'Next steps\n');

  hc.failGet('t-new', 'hc get t-new failed');

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  try {
    const opening = startHandover(
      { exec: execAnsweringHc(app, hc), cwd: root },
      requestFor(root, file, { kind: 'reuse', space: 'space-1' }, 'Next steps'),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(hc.calls.length).toBeGreaterThan(0);
    });

    await vi.advanceTimersByTimeAsync(readbackFailureBudgetMilliseconds + 1_000);

    const failure = await opening;

    expect(failure).toBeInstanceOf(StartedTabError);

    const started = failure as StartedTabError;

    expect(started.terminal).toBe('t-new');
    expect(started.space).toBe('space-1');
    expect(started.tab).toBe('tb-new');
    expect(started.message).toContain('hc get t-new failed');
    expect(started.message).toContain('hc kill t-new');
    expect(spaceOrTabLaunchesOf(app)).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
