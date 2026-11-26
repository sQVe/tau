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
import { createHerdrAppFake } from '../../tests/herdrAppFake.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import {
  launchPiSession,
  launchPiSessionRightOf,
  startPiSession,
  startPiSessionRightOf,
} from './piStart.js';

const startRequest = (
  root: string,
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
  ...overrides,
});

it('a space start opens one tab with the argv as JSON', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, {
      model: 'morph/morph-dsv41flash-1017',
      session: '/tmp/architect.jsonl',
      environment: { TAU_ROLE: 'architect' },
    }),
  );

  expect(result).toEqual({
    reply: '{"space":"space-1","tab":"tb-new","terminal":"t-new"}',
    target: { space: 'space-1' },
    terminal: 't-new',
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
    startRequest(root, { target: { name: 'ticket-1' }, tabName: 'architect' }),
  );

  expect(result).toEqual({
    reply: '{"space":"sp-1","tab":"tb-1","terminal":"t-space"}',
    target: { name: 'ticket-1' },
    terminal: 't-space',
  });
});

it('a space start without a terminal in its reply returns no terminal', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.overrideOutput('space.new', '{"ok":true}');

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, { target: { name: 'ticket-1' }, tabName: 'architect' }),
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
    startRequest(root, { target: { name: 'ticket-1' }, tabName: 'architect' }),
  );

  expect(result).toEqual({
    reply: '{"space":"sp-new","tab":"tb-new","terminal":"t-new"}',
    target: { name: 'ticket-1' },
    terminal: 't-new',
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
    startRequest(root, { bareRoot: true }),
  );

  expect(result).toEqual({
    reply: '{"space":"space-1","tab":"tb-new","terminal":"t-new"}',
    target: { space: 'space-1' },
    terminal: 't-new',
  });

  expect(fake.calls).toHaveLength(1);
});

it('a bare repository starts a session without the caller naming it bare', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryBareRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, { bareRoot: false }),
  );

  expect(result.terminal).toBe('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a bare root layout starts a session', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryBareRoot(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, { bareRoot: false }),
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

  const result = await startPiSession({ exec: fake.exec, cwd: repository }, startRequest(worktree));

  expect(result.terminal).toBe('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a resolver start runs the target it resolves', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, { target: async () => ({ space: 'resolved-space' }) }),
  );

  expect(result).toEqual({
    reply: '{"space":"resolved-space","tab":"tb-new","terminal":"t-new"}',
    target: { space: 'resolved-space' },
    terminal: 't-new',
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
      startRequest(root, {
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
    startPiSession({ exec: fake.exec, cwd: root }, startRequest(root, { folder })),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a folder whose Git pointer names a missing path is refused', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-start-stale-');

  writeFileSync(join(folder, '.git'), 'gitdir: absent\n');

  await expect(
    startPiSession({ exec: fake.exec, cwd: root }, startRequest(root, { folder })),
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
    startRequest(root, { folder }),
  );

  expect(result.terminal).toBe('t-new');
  expect(fake.calls).toHaveLength(1);
});

it('a start whose Git cannot run reports the Git failure', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const emptyPath = temporaryDirectory(onTestFinished, 'tau-pi-start-no-git-');

  vi.stubEnv('PATH', emptyPath);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await expect(startPiSession({ exec: fake.exec, cwd: root }, startRequest(root))).rejects.toThrow(
    /^git rev-parse --git-dir failed: /u,
  );

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
      startRequest(root, {
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

const paneRequest = (root: string) => ({
  folder: root,
  pane: 'p-lead',
  task: 'Design this',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
});

it('a refused split rejects with the command context and no second command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);

  fake.failCommand('split', 'pane p-lead is gone');

  const failure = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root },
    paneRequest(root),
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
    paneRequest(root),
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
    paneRequest(root),
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
    paneRequest(root),
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

const launchRequest = (root: string): Parameters<typeof launchPiSession>[1] => ({
  folder: root,
  target: { name: 'ticket-1' },
  tabName: 'architect',
  task: 'Next steps\n',
  model: undefined,
  session: undefined,
  bareRoot: false,
  environment: undefined,
});

it('bounds the launch call with the launch timeout', async () => {
  let launchTimeout: number | undefined;

  const fake = createExecFake<'start'>({
    keyOf: (command) => (command === 'herdr-app' ? 'start' : undefined),
    handlerFor: () => (_commandArguments, options) => {
      launchTimeout = options?.timeout;

      return succeededResult('{"space":"sp-1","tab":"tb-1","terminal":"t-space"}');
    },
  });

  const root = await createTemporaryRepository(onTestFinished);

  const result = await launchPiSession({ exec: fake.exec, cwd: root }, launchRequest(root));

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
    launchPiSession({ exec: fake.exec, cwd: root }, { ...launchRequest(root), folder }),
  ).rejects.toThrow(`start folder is not a Git checkout: ${folder}`);

  expect(fake.calls).toEqual([]);
});

it('a right-of launch in a folder that is not a Git checkout runs no command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);
  const folder = temporaryDirectory(onTestFinished, 'tau-pi-launch-');

  await expect(
    launchPiSessionRightOf({ exec: fake.exec, cwd: root }, { ...paneRequest(root), folder }),
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
  const result = await launchPiSession({ exec: fake.exec, cwd: root }, launchRequest(root));

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
  const result = await launchPiSession({ exec: fake.exec, cwd: root }, launchRequest(root));

  expect(result.terminal).toBeUndefined();
  expect(result.killed).toBe(true);
  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).message).toContain('herdr-app do failed');
  expect((result.error as Error).message).toContain('the launch was killed');
});
