import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { succeededResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import type { Exec } from '../../command.js';
import piResumeExtension from './piResume.js';

const defaultSessionFile = '/sessions/a.jsonl';

const terminal = (foregroundPid: number): string =>
  JSON.stringify({
    address: 't7',
    state: 'live',
    foreground: { pid: foregroundPid, name: 'pi', argv: ['pi'], cwd: '/repository' },
  });

const buildContext = (
  changes: { mode?: string; cwd?: string; sessionFile?: string | undefined } = {},
): ExtensionContext =>
  ({
    cwd: changes.cwd ?? '/repository',
    mode: changes.mode ?? 'tui',
    sessionManager: {
      getSessionFile: () => ('sessionFile' in changes ? changes.sessionFile : defaultSessionFile),
    },
  }) as unknown as ExtensionContext;

const mount = (fake: HcFake) => {
  const api = fakeExtensionApi({ exec: fake.exec });

  piResumeExtension(api.pi);

  const start = (context: ExtensionContext = buildContext()) =>
    api.handler('session_start')({ type: 'session_start', reason: 'startup' }, context);

  const shutdown = (context: ExtensionContext = buildContext()) =>
    api.handler('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, context);

  return { start, shutdown };
};

const labelCalls = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments.slice(3));

afterEach(() => {
  vi.unstubAllEnvs();
});

it('labels the owning TUI Pi session on start', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake);

  await resume.start();

  expect(labelCalls(fake)).toEqual([['t7', 'pi.session=/sessions/a.jsonl', 'pi.cwd=/repository']]);

  await resume.shutdown();
});

it('does not call hc for a nested non-interactive Pi', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const resume = mount(fake);

  await resume.start(buildContext({ mode: 'print' }));
  await resume.shutdown();

  expect(fake.calls).toEqual([]);
});

it('does not call hc for a Pi without a terminal id', async () => {
  const fake = createHcFake();
  const resume = mount(fake);

  await resume.start();
  await resume.shutdown();

  expect(fake.calls).toEqual([]);
});

it('does not label a Pi that is not the terminal foreground process', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid + 1));
  const resume = mount(fake);

  await resume.start();
  await resume.shutdown();

  expect(labelCalls(fake)).toEqual([]);
});

it.each(['SIGTERM', 'SIGHUP'] as const)(
  'makes no hc label call when %s arrives while hc get is pending',
  async (signal) => {
    vi.stubEnv('HC_TERMINAL_ID', 't7');
    const calls: string[][] = [];

    let releaseGet: (() => void) | undefined;

    const pendingGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    const exec: Exec = async (_command, commandArguments) => {
      calls.push([...commandArguments]);

      if (commandArguments[0] === 'get') {
        await pendingGet;
      }

      return succeededResult(terminal(process.pid));
    };

    const api = fakeExtensionApi({ exec });
    piResumeExtension(api.pi);

    const started = api.handler('session_start')(
      { type: 'session_start', reason: 'startup' },
      buildContext(),
    );

    process.emit(signal);
    releaseGet?.();
    await started;

    expect(calls.filter((call) => call[0] === 'label')).toEqual([]);

    await api.handler('session_shutdown')(
      { type: 'session_shutdown', reason: 'quit' },
      buildContext(),
    );
  },
);

it('clears both labels on a quit without a signal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake);

  await resume.start();
  await resume.shutdown();

  expect(labelCalls(fake).at(-1)).toEqual(['t7', 'pi.session=', 'pi.cwd=']);
});

it.each(['SIGTERM', 'SIGHUP'] as const)('makes no hc call after %s', async (signal) => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake);

  await resume.start();

  const callsBeforeSignal = fake.calls.length;

  process.emit(signal);

  await resume.shutdown();

  expect(fake.calls.length).toBe(callsBeforeSignal);
});

it('overwrites the labels when a new session starts', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  fake.reply('get', terminal(process.pid));
  fake.reply('label', terminal(process.pid));
  const resume = mount(fake);

  await resume.start();
  await resume.start(buildContext({ sessionFile: '/sessions/b.jsonl' }));

  expect(labelCalls(fake).at(-1)).toEqual([
    't7',
    'pi.session=/sessions/b.jsonl',
    'pi.cwd=/repository',
  ]);

  await resume.shutdown();
});

it('does not clear labels after a non-owning Pi shuts down', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');
  const fake = createHcFake();
  const resume = mount(fake);

  await resume.start(buildContext({ mode: 'print' }));
  await resume.shutdown();

  expect(fake.calls).toEqual([]);
});
