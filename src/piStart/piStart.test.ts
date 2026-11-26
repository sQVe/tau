import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createExecFake, succeededResult } from '../../tests/execFake.js';
import type { ExecFake } from '../../tests/execFake.js';
import {
  createTemporaryBareRepository,
  createTemporaryBareRoot,
  createTemporaryRepository,
  git,
} from '../../tests/gitRepository.js';
import { createHerdrAppFake, foregroundReaderFor } from '../../tests/herdrAppFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import {
  launchPiSession,
  launchPiSessionRightOf,
  launchTimeoutMilliseconds,
  startPiSession,
  startPiSessionRightOf,
} from './piStart.js';

type ForegroundReader = (terminal: string) => Promise<readonly string[] | undefined>;

const neverResolves = new Promise<readonly string[] | undefined>(() => {});
const neverReads = (): Promise<readonly string[] | undefined> => neverResolves;

const readerFor = <Key extends string>(fake: ExecFake<Key>, root: string): ForegroundReader =>
  foregroundReaderFor({ exec: fake.exec, cwd: root });

const startRequest = (
  root: string,
  readForegroundArgv: ForegroundReader,
  overrides: Partial<Parameters<typeof startPiSession>[1]> = {},
): Parameters<typeof startPiSession>[1] => ({
  folder: root,
  target: { space: 'space-1' },
  tabName: 'lead',
  task: 'Next steps\n',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
  readForegroundArgv,
  ...overrides,
});

it('a space start opens one tab with the argv as JSON', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), {
      model: 'morph/morph-dsv41flash-1017',
      session: '/tmp/architect.jsonl',
      environment: { TAU_ROLE: 'architect' },
    }),
  );

  expect(result).toEqual({
    reply: '{"space":"space-1","tab":"tb-new","terminal":"t-new"}',
    target: { space: 'space-1' },
    terminal: 't-new',
    model: 'morph/morph-dsv41flash-1017',
  });

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
        '--name',
        'lead',
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

it('a space start returns the terminal from its reply', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.overrideOutput('space.new', '{"space":"sp-1","tab":"tb-1","terminal":"t-space"}');

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), {
      target: { name: 'ticket-1' },
      tabName: 'architect',
    }),
  );

  expect(result).toEqual({
    reply: '{"space":"sp-1","tab":"tb-1","terminal":"t-space"}',
    target: { name: 'ticket-1' },
    terminal: 't-space',
    model: 'default',
  });
});

it('a space start without a terminal in its reply returns no terminal', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.overrideOutput('space.new', '{"ok":true}');

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), {
      target: { name: 'ticket-1' },
      tabName: 'architect',
    }),
  );

  expect(result).toEqual({ reply: '{"ok":true}', target: { name: 'ticket-1' } });
  expect(result.terminal).toBeUndefined();
  expect(fake.calls).toHaveLength(1);
});

it('a space start names its first tab', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), {
      target: { name: 'ticket-1' },
      tabName: 'architect',
    }),
  );

  expect(result).toEqual({
    reply: '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
    target: { name: 'ticket-1' },
    terminal: 't-new',
    model: 'default',
  });

  expect(fake.calls).toEqual([
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
        'architect',
        '--argv',
        '["pi"]',
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
    startRequest(root, readerFor(fake, root), { bareRoot: true }),
  );

  expect(result).toEqual({
    reply: '{"space":"space-1","tab":"tb-new","terminal":"t-new"}',
    target: { space: 'space-1' },
    terminal: 't-new',
    model: 'default',
  });

  expect(fake.calls).toHaveLength(1);
});

it('a bare repository starts a session without the caller naming it bare', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryBareRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { bareRoot: false }),
  );

  expect(result.terminal).toBe('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a bare root layout starts a session', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryBareRoot(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { bareRoot: false }),
  );

  expect(result.terminal).toBe('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a linked worktree starts a session', async () => {
  const fake = createHerdrAppFake();
  const repository = await createTemporaryRepository(onTestFinished);
  const worktree = temporaryDirectory(onTestFinished, 'tau-pi-start-worktree-');

  await git(repository, 'commit', '--quiet', '--allow-empty', '-m', 'one');
  await git(repository, 'worktree', 'add', '--quiet', worktree);

  const result = await startPiSession(
    { exec: fake.exec, cwd: repository },
    startRequest(worktree, readerFor(fake, repository)),
  );

  expect(result.terminal).toBe('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a resolver start runs the target it resolves', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), {
      target: async () => ({ space: 'resolved-space' }),
    }),
  );

  expect(result).toEqual({
    reply: '{"space":"resolved-space","tab":"tb-new","terminal":"t-new"}',
    target: { space: 'resolved-space' },
    terminal: 't-new',
    model: 'default',
  });

  expect(fake.calls).toEqual([
    {
      command: 'herdr-app',
      commandArguments: [
        'do',
        'tab.new',
        '--space',
        'resolved-space',
        '--folder',
        root,
        '--name',
        'lead',
        '--argv',
        '["pi"]',
        '--task',
        'Next steps\n',
        '--focus',
        'false',
      ],
      signal: undefined,
    },
  ]);
});

it('a resolver that aborts the signal runs no command', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  await expect(
    startPiSession(
      { exec: fake.exec, cwd: root, signal: controller.signal },
      startRequest(root, readerFor(fake, root), {
        target: async () => {
          controller.abort(new Error('cancelled during resolution'));

          return { space: 'resolved-space' };
        },
      }),
    ),
  ).rejects.toThrow('cancelled during resolution');

  expect(fake.calls).toEqual([]);
});

it('a folder that is not a Git checkout is refused', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-');

  await expect(
    startPiSession(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), { folder }),
    ),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a folder whose Git pointer names a missing path is refused', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-stale-');

  writeFileSync(join(folder, '.git'), 'gitdir: absent\n');

  await expect(
    startPiSession(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), { folder }),
    ),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a folder inside a checkout starts a session', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const folder = join(root, 'src');

  mkdirSync(folder);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { folder }),
  );

  expect(result.terminal).toBe('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a start whose Git cannot run runs no command', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const emptyPath = temporaryDirectory(onTestFinished, 'tau-pi-start-no-git-');

  vi.stubEnv('PATH', emptyPath);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await expect(
    startPiSession({ exec: fake.exec, cwd: root }, startRequest(root, readerFor(fake, root))),
  ).rejects.toThrow(/^git rev-parse --git-dir failed:/u);

  expect(fake.calls).toEqual([]);
});

it('a folder that is not a Git checkout refuses before the resolver runs', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-');
  const calls: string[] = [];

  await expect(
    startPiSession(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), {
        folder,
        target: async () => {
          calls.push('resolved');

          return { name: 'ticket-1' };
        },
      }),
    ),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(calls).toEqual([]);
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

  expect(result).toEqual({
    reply: '{"pane":"p-new","terminal":"t-new"}',
    terminal: 't-new',
  });

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

const paneRequest = (root: string, readForegroundArgv: ForegroundReader) => ({
  folder: root,
  pane: 'p-lead',
  task: 'Design this',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
  readForegroundArgv,
});

it('a refused split rejects with the command context and no second command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);

  fake.failCommand('split', 'pane p-lead is gone');

  const failure = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root },
    paneRequest(root, readerFor(fake, root)),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('herdr-app do pane.split failed');
  expect((failure as Error).message).toContain('pane p-lead is gone');
  expect(fake.calls).toHaveLength(1);
});

it('a killed split rejects even with a valid reply and issues one command', async () => {
  const controller = new AbortController();

  const fake = createExecFake<'split'>({
    keyOf: (command) => (command === 'herdr-app' ? 'split' : undefined),
    handlerFor: () => (_commandArguments, options) => {
      controller.abort(new Error('cancelled during the split'));

      return {
        code: 0,
        killed: options?.signal?.aborted === true,
        truncated: false,
        stdout: '{"pane":"p-new","terminal":"t-new"}',
        stderr: '',
      };
    },
  });

  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    paneRequest(root, readerFor(fake, root)),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('herdr-app do pane.split failed');
  expect((failure as Error).message).toContain('p-new');
  expect(fake.calls).toHaveLength(1);
});

it('a split reply that is not JSON rejects with the command context and no second command', async () => {
  const fake = paneAppFake('not json');
  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root },
    paneRequest(root, readerFor(fake, root)),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('herdr-app do pane.split');
  expect((failure as Error).message).toContain('is not JSON');
  expect(fake.calls).toHaveLength(1);
});

it('a split Herdr reports successful stays successful when the signal aborts during the call', async () => {
  const controller = new AbortController();

  const fake = createExecFake<'split'>({
    keyOf: (command) => (command === 'herdr-app' ? 'split' : undefined),
    handlerFor: () => () => {
      controller.abort(new Error('cancelled during the split'));

      return succeededResult('{"pane":"p-new","terminal":"t-new"}');
    },
  });

  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    paneRequest(root, readerFor(fake, root)),
  );

  expect(result).toEqual({
    reply: '{"pane":"p-new","terminal":"t-new"}',
    terminal: 't-new',
  });

  expect(fake.calls).toHaveLength(1);
});

it('a right-of start in a folder that is not a Git checkout runs no command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-');

  await expect(
    startPiSessionRightOf(
      { exec: fake.exec, cwd: root },
      { ...paneRequest(root, readerFor(fake, root)), folder },
    ),
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
      paneRequest(root, readerFor(fake, root)),
    ),
  ).rejects.toThrow('cancelled before start');

  expect(fake.calls).toEqual([]);
});

const launchRequest = (
  root: string,
  readForegroundArgv: ForegroundReader,
): Parameters<typeof launchPiSession>[1] => ({
  folder: root,
  target: { name: 'ticket-1' },
  tabName: 'architect',
  task: 'Next steps\n',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
  readForegroundArgv,
});

it('bounds the launch call with the launch timeout', async () => {
  let launchTimeout: number | undefined;

  const fake = createExecFake<'start' | 'get'>({
    keyOf: (command, commandArguments) => {
      if (command === 'herdr-app') {
        return 'start';
      }

      return command === 'hc' && commandArguments[0] === 'get' ? 'get' : undefined;
    },
    handlerFor: (key) => (_commandArguments, options) => {
      if (key === 'get') {
        return succeededResult(
          JSON.stringify({
            address: 't-space',
            state: 'live',
            foreground: { pid: 1, name: 'pi', argv: ['pi'], cwd: root },
          }),
        );
      }

      launchTimeout = options?.timeout;

      return succeededResult('{"space":"sp-1","tab":"tb-1","terminal":"t-space"}');
    },
  });

  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSession(
    { exec: fake.exec, cwd: root },
    launchRequest(root, readerFor(fake, root)),
  );

  expect(result.terminal).toBe('t-space');
  expect(result.error).toBeUndefined();
  expect(launchTimeout).toBe(30_000);
});

it('a launch in a folder that is not a Git checkout runs no command', async () => {
  const fake = createExecFake<'start'>({
    keyOf: (command) => (command === 'herdr-app' ? 'start' : undefined),
    handlerFor: () => () => succeededResult('{"space":"sp-1","tab":"tb-1","terminal":"t-space"}'),
  });

  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-launch-');

  await expect(
    launchPiSession(
      { exec: fake.exec, cwd: root },
      { ...launchRequest(root, readerFor(fake, root)), folder },
    ),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a right-of launch in a folder that is not a Git checkout runs no command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-launch-');

  await expect(
    launchPiSessionRightOf(
      { exec: fake.exec, cwd: root },
      { ...paneRequest(root, readerFor(fake, root)), folder },
    ),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a nonzero launch exit returns no terminal and the launcher error', async () => {
  const fake = createExecFake<'start'>({
    keyOf: (command) => (command === 'herdr-app' ? 'start' : undefined),
    handlerFor: () => () => ({
      code: 1,
      killed: false,
      truncated: false,
      stdout: '',
      stderr: '  the command exited 1  ',
    }),
  });

  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSession(
    { exec: fake.exec, cwd: root },
    launchRequest(root, readerFor(fake, root)),
  );

  expect(result.terminal).toBeUndefined();
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toBe('herdr-app do failed: the command exited 1');
});

it('a killed launch returns no terminal and the launcher error', async () => {
  const fake = createExecFake<'start'>({
    keyOf: (command) => (command === 'herdr-app' ? 'start' : undefined),
    handlerFor: () => () => ({
      code: 1,
      killed: true,
      truncated: false,
      stdout: '',
      stderr: 'the launch was killed',
    }),
  });

  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSession(
    { exec: fake.exec, cwd: root },
    launchRequest(root, readerFor(fake, root)),
  );

  expect(result.terminal).toBeUndefined();
  expect(result.killed).toBe(true);
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toContain('herdr-app do failed');
  expect((result.error as Error).message).toContain('the launch was killed');
});

const launchWithForeground = (
  argv: string[],
  reply = '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
): ExecFake<'launch' | 'get'> => {
  const getReply = JSON.stringify({
    address: 't-new',
    state: 'live',
    foreground: { pid: 1, name: 'pi', argv, cwd: '/tmp' },
  });

  return createExecFake<'launch' | 'get'>({
    keyOf: (command, commandArguments) => {
      if (command === 'herdr-app') {
        return 'launch';
      }

      return command === 'hc' && commandArguments[0] === 'get' ? 'get' : undefined;
    },
    handlerFor: (key) =>
      key === 'launch' ? () => succeededResult(reply) : () => succeededResult(getReply),
  });
};

it('a start returns the model its terminal runs', async () => {
  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
});

it.each([
  {
    name: 'a pi path',
    argv: ['/usr/bin/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a node pi path',
    argv: ['node', '/usr/local/bin/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a node pi path with a leading flag',
    argv: [
      'node',
      '--experimental-strip-types',
      '/path/pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a node pi path with a value-taking flag before the script',
    argv: [
      'node',
      '--loader',
      'tsx',
      '/path/pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a node pi path after a value-taking flag',
    argv: [
      'node',
      '--stack-size',
      '2000',
      '/path/pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a node pi.js script after a value-taking flag',
    argv: [
      'node',
      '--stack-size',
      '2000',
      'pi.js',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a bare pi script after the runtime',
    argv: ['node', 'pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a bare pi after a loader flag',
    argv: [
      'node',
      '--loader',
      'tsx',
      'pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a bare pi after a memory flag',
    argv: [
      'node',
      '--max-old-space-size',
      '4096',
      'pi',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
  {
    name: 'a bun pi path',
    argv: ['bun', '/path/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a bun.exe pi path',
    argv: ['bun.exe', '/path/pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'],
  },
  {
    name: 'a node.exe pi.cmd path',
    argv: [
      'node.exe',
      '/usr/local/bin/pi.cmd',
      '--provider',
      'morph',
      '--model',
      'morph-dsv41flash-1017',
    ],
  },
])('a start reads the model from $name', async ({ argv }) => {
  const fake = launchWithForeground(argv);
  const root = await createTemporaryRepository(onTestFinished);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const opening = startPiSession(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), { model: 'morph/morph-dsv41flash-1017' }),
    );

    await vi.waitFor(() => {
      expect(fake.calls.length).toBeGreaterThanOrEqual(1);
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    const result = await opening;

    expect(result.model).toBe('morph/morph-dsv41flash-1017');
  } finally {
    vi.useRealTimers();
  }
});

it.each<[string, readonly string[] | undefined]>([
  ['undefined', undefined],
  ['a non-Pi argv', ['bash']],
  ['a node command with a trailing pi argument', ['node', '/path/tool.js', 'pi']],
  ['a node command with a flag value of pi', ['node', '--title', 'pi', '/path/tool.js']],
  ['a node command with a Pi-named flag value', ['node', '--require', './pi.js', 'main.js']],
  ['a bare pi argument after an unknown value-taking flag', ['node', '--stack-size', '2000', 'pi']],
])('a start retries a model read that first returns %s', async (_shape, firstRead) => {
  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);
  let reads = 0;

  const reader = async (): Promise<readonly string[] | undefined> => {
    reads += 1;

    return reads === 1
      ? firstRead
      : ['pi', '--provider', 'morph', '--model', 'morph-dsv41flash-1017'];
  };

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, reader, { model: 'morph/morph-dsv41flash-1017' }),
  );

  expect(result.model).toBe('morph/morph-dsv41flash-1017');
  expect(reads).toBe(2);
});

it('a start fails when the terminal runs another model', async () => {
  const fake = launchWithForeground([
    'pi',
    '--provider',
    'morph',
    '--model',
    'morph-dsv41flash-1017',
  ]);

  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { model: 'claude-bridge/claude-opus-5-5' }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);

  const message = (failure as Error).message;

  expect(message).toContain('claude-bridge/claude-opus-5-5');
  expect(message).toContain('morph/morph-dsv41flash-1017');
  expect(message).toContain('t-new');
  expect(message).toContain('hc get t-new');
});

it('a start fails when the terminal never shows a foreground before the deadline', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const opening = startPiSession(
      { exec: fake.exec, cwd: root },
      startRequest(root, neverReads),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    const failure = await opening;

    expect(failure).toBeInstanceOf(Error);

    const message = (failure as Error).message;

    expect(message).toContain('t-new');
    expect(message).toContain('hc get t-new');
    expect(message).toContain('It may still be running');
  } finally {
    vi.useRealTimers();
  }
});

it('an abort during the model readback ends the call', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const cancellation = new Error('cancelled during the readback');

  const opening = startPiSession(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    startRequest(root, neverReads),
  ).catch((error: unknown) => error);

  await vi.waitFor(() => {
    expect(fake.calls).toHaveLength(1);
  });

  controller.abort(cancellation);

  expect(await opening).toBe(cancellation);
});

it('a model read that times out removes its abort listener', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

  try {
    const opening = startPiSession(
      { exec: fake.exec, cwd: root, signal: controller.signal },
      startRequest(root, neverReads),
    ).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(fake.calls).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(launchTimeoutMilliseconds);

    expect(await opening).toBeInstanceOf(Error);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally {
    removeListener.mockRestore();
    vi.useRealTimers();
  }
});

it('a launch returns the model its terminal runs', async () => {
  const fake = launchWithForeground(['pi', '--provider', 'a', '--model', 'architect']);
  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSession(
    { exec: fake.exec, cwd: root },
    { ...launchRequest(root, readerFor(fake, root)), model: 'a/architect' },
  );

  expect(result.model).toBe('a/architect');
});

it('a right-of launch returns the model its terminal runs', async () => {
  const fake = launchWithForeground(
    ['pi', '--provider', 'a', '--model', 'architect'],
    '{"pane":"p-new","terminal":"t-new"}',
  );

  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSessionRightOf(
    { exec: fake.exec, cwd: root },
    { ...paneRequest(root, readerFor(fake, root)), model: 'a/architect' },
  );

  expect(result.model).toBe('a/architect');
});
