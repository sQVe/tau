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
import type { HerdrAppKey } from '../../tests/herdrAppFake.js';
import {
  launchRequest,
  paneRequest,
  readbackCall,
  readerFor,
  startRequest,
} from '../../tests/piStartRequests.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import {
  StartedTabError,
  launchPiSession,
  launchPiSessionRightOf,
  startPiSession,
  startPiSessionRightOf,
} from './piStart.js';

const terminalOf = (result: Awaited<ReturnType<typeof startPiSession>>): string | undefined =>
  'terminal' in result ? result.terminal : undefined;

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
      timeout: 30_000,
    },
    readbackCall('t-new'),
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
  expect(fake.calls).toHaveLength(1);
});

it('a required-terminal start rejects a reply without a terminal', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  fake.overrideOutput('space.new', '{"ok":true}');

  await expect(
    startPiSession(
      { exec: fake.exec, cwd: root },
      startRequest(root, readerFor(fake, root), {
        target: { name: 'ticket-1' },
        tabName: 'architect',
      }),
      { requireTerminal: true },
    ),
  ).rejects.toThrow('herdr-app do printed unexpected output');

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
      timeout: 30_000,
    },
    readbackCall('t-new'),
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

  expect(fake.calls).toHaveLength(2);
});

it('a bare repository starts a session without the caller naming it bare', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryBareRepository(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { bareRoot: false }),
  );

  expect(terminalOf(result)).toBe('t-new');
  expect(fake.calls).toHaveLength(2);
});

it('a bare root layout starts a session', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryBareRoot(onTestFinished);

  const result = await startPiSession(
    { exec: fake.exec, cwd: root },
    startRequest(root, readerFor(fake, root), { bareRoot: false }),
  );

  expect(terminalOf(result)).toBe('t-new');
  expect(fake.calls).toHaveLength(2);
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

  expect(terminalOf(result)).toBe('t-new');
  expect(fake.calls).toHaveLength(2);
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
      timeout: 30_000,
    },
    readbackCall('t-new'),
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

  expect(terminalOf(result)).toBe('t-new');
  expect(fake.calls).toHaveLength(2);
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

const paneAppFake = (splitReply: string): ExecFake<HerdrAppKey> => {
  const fake = createHerdrAppFake();

  fake.overrideOutput('pane.split', splitReply);

  return fake;
};

it('a pane start splits to the right of the requested pane once', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);

  const result = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root },
    { ...paneRequest(root, readerFor(fake, root)), environment: { TAU_ROLE: 'architect' } },
  );

  expect(result).toEqual({
    reply: '{"pane":"p-new","terminal":"t-new"}',
    terminal: 't-new',
    model: 'default',
  });

  expect(fake.calls).toHaveLength(2);
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
    startPiSessionRightOf({ exec: fake.exec, cwd: root }, paneRequest(root, readerFor(fake, root))),
  ).rejects.toThrow('herdr-app do pane.split printed unexpected output');

  expect(fake.calls).toHaveLength(1);
});

it('a refused split rejects with the command context and no second command', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);

  fake.failCommand('pane.split', 'pane p-lead is gone');

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
    model: undefined,
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

it('a launch aborted at the checkout probe rejects with an Error for a non-Error reason', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  controller.abort('cancelled during the checkout probe');

  const failure = await launchPiSession(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    launchRequest(root, readerFor(fake, root)),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe('cancelled during the checkout probe');
  expect(fake.calls).toEqual([]);
});

it('a start aborted at the checkout probe rejects with an Error for a non-Error reason', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  controller.abort('cancelled during the start checkout probe');

  const failure = await startPiSession(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    startRequest(root, readerFor(fake, root)),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe('cancelled during the start checkout probe');
  expect(fake.calls).toEqual([]);
});

it('a right-of start aborted at the checkout probe rejects with an Error for a non-Error reason', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  controller.abort('cancelled during the split checkout probe');

  const failure = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    paneRequest(root, readerFor(fake, root)),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe('cancelled during the split checkout probe');
  expect(fake.calls).toEqual([]);
});

it('a start whose resolver aborts with a non-Error reason rejects with an Error', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();

  const failure = await startPiSession(
    { exec: fake.exec, cwd: root, signal: controller.signal },
    startRequest(root, readerFor(fake, root), {
      target: async () => {
        controller.abort('cancelled during resolution');

        return { space: 'resolved-space' };
      },
    }),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe('cancelled during resolution');
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

it('a start bounds the creation command with the launch timeout', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const timeouts: (number | undefined)[] = [];

  const exec: typeof fake.exec = (command, commandArguments, options) => {
    timeouts.push(options?.timeout);

    return fake.exec(command, commandArguments, options);
  };

  await startPiSession({ exec, cwd: root }, startRequest(root, readerFor(fake, root)));

  expect(timeouts[0]).toBe(30_000);
});

it('a right-of start bounds the split command with the launch timeout', async () => {
  const fake = paneAppFake('{"pane":"p-new","terminal":"t-new"}');
  const root = await createTemporaryRepository(onTestFinished);
  const timeouts: (number | undefined)[] = [];

  const exec: typeof fake.exec = (command, commandArguments, options) => {
    timeouts.push(options?.timeout);

    return fake.exec(command, commandArguments, options);
  };

  await startPiSessionRightOf({ exec, cwd: root }, paneRequest(root, readerFor(fake, root)));

  expect(timeouts[0]).toBe(30_000);
});

it('a start normalizes a non-Error cancellation from the creation command', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const reason = 'cancelled during the launch command';

  const exec: typeof fake.exec = (command, commandArguments, options) => {
    controller.abort(reason);
    controller.signal.throwIfAborted();

    return fake.exec(command, commandArguments, options);
  };

  const failure = await startPiSession(
    { exec, cwd: root, signal: controller.signal },
    startRequest(root, readerFor(fake, root)),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).cause).toBe(reason);
});

it('a launch normalizes a non-Error cancellation from the creation command', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);
  const controller = new AbortController();
  const reason = 'cancelled during the launch command';

  const exec: typeof fake.exec = (command, commandArguments, options) => {
    controller.abort(reason);
    controller.signal.throwIfAborted();

    return fake.exec(command, commandArguments, options);
  };

  const result = await launchPiSession(
    { exec, cwd: root, signal: controller.signal },
    launchRequest(root, readerFor(fake, root)),
  );

  expect(result.error).toBeInstanceOf(Error);
  expect((result.error as Error).cause).toBe(reason);
});

const mismatchingReader = async (): Promise<readonly string[] | undefined> => [
  'pi',
  '--provider',
  'morph',
  '--model',
  'morph-dsv41flash-1017',
];

it('a space start readback failure carries the started space and tab', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSession(
    { exec: fake.exec, cwd: root },
    { ...startRequest(root, readerFor(fake, root)), readForegroundArgv: mismatchingReader },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(StartedTabError);

  const started = failure as StartedTabError;

  expect(started.terminal).toBe('t-new');
  expect(started.space).toBe('space-1');
  expect(started.tab).toBe('tb-new');
  expect(started.message).toContain('space space-1');
  expect(started.message).toContain('tab tb-new');
  expect(started.message).toContain('may still be running');
  expect(started.message).toContain('hc kill t-new');
});

it('a right-of start readback failure names the created pane', async () => {
  const fake = createHerdrAppFake();
  const root = await createTemporaryRepository(onTestFinished);

  const failure = await startPiSessionRightOf(
    { exec: fake.exec, cwd: root },
    { ...paneRequest(root, readerFor(fake, root)), readForegroundArgv: mismatchingReader },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(StartedTabError);

  const started = failure as StartedTabError;

  expect(started.terminal).toBe('t-new');
  expect(started.pane).toBe('p-new');
  expect(started.message).toContain('pane p-new');
});
