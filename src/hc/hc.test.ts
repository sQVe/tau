import { afterEach, expect, it, vi } from 'vitest';

import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import {
  HcError,
  currentTerminalAddress,
  get,
  label,
  ls,
  readCurrentTerminal,
  run,
  send,
} from './hc.js';
import type { HcRuntime } from './hc.js';

const terminal = {
  address: 't7',
  state: 'live',
  labels: { role: 'worker' },
};

const notFound = JSON.stringify({
  error: { kind: 'not_found', message: 'gone', hint: 'check the address' },
});

const runtimeOf = (fake: HcFake): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const inheritedTerminalAddress = currentTerminalAddress();

afterEach(() => {
  vi.unstubAllEnvs();
});

it('returns the terminal a get command parsed and starts no connection', async () => {
  const fake = createHcFake();

  fake.reply('get', JSON.stringify(terminal));

  const result = await get(runtimeOf(fake), 't7');

  expect(result.address).toBe('t7');
  expect(result.labels).toEqual({ role: 'worker' });
  expect(fake.calls).toHaveLength(1);
  expect(fake.connectCalls).toHaveLength(0);
});

it('passes the runtime signal to exec', async () => {
  const fake = createHcFake();
  const controller = new AbortController();

  fake.reply('get', JSON.stringify(terminal));

  await get({ ...runtimeOf(fake), signal: controller.signal }, 't7');

  expect(fake.calls[0]?.signal).toBe(controller.signal);
});

it('keeps a not_found from get as an HcError with its exit code', async () => {
  const fake = createHcFake();

  fake.fail('get', notFound, 3);

  const failure = await get(runtimeOf(fake), 't7').catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'not_found', exitCode: 3 });
  expect(fake.calls).toHaveLength(1);
  expect(fake.connectCalls).toHaveLength(0);
});

it('rejects malformed get evidence', async () => {
  const fake = createHcFake();

  fake.reply('get', 'not-json');

  const failure = await get(runtimeOf(fake), 't7').catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'malformed' });
  expect(fake.calls).toHaveLength(1);
  expect(fake.connectCalls).toHaveLength(0);
});

it('turns a rejected exec into a spawn_failed HcError', async () => {
  const fake = createHcFake();

  const runtime: HcRuntime = {
    exec: () => Promise.reject(new Error('spawn E2BIG')),
    connect: fake.connect,
    cwd: '/repository',
  };

  const failure = await get(runtime, 't7').catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'spawn_failed' });
});

it('fails a command the fake was not set up for', async () => {
  const fake = createHcFake();

  await expect(ls(runtimeOf(fake))).rejects.toMatchObject({
    name: 'HcError',
    kind: 'failed',
    exitCode: 1,
    message: 'hc ls failed: unknown command: ls',
  });
});

it('passes the run options as command flags', async () => {
  const fake = createHcFake();

  fake.reply('run', JSON.stringify(terminal));

  await run(runtimeOf(fake), {
    argv: ['pi', '--model', 'x'],
    name: 'worker',
    cwd: '/working',
    labels: { role: 'probe' },
    noParent: true,
    background: true,
  });

  expect(fake.calls[0]?.commandArguments).toEqual([
    'run',
    '--json',
    '--name',
    'worker',
    '--cwd',
    '/working',
    '--no-parent',
    '--bg',
    '--label',
    'role=probe',
    '--',
    'pi',
    '--model',
    'x',
  ]);
});

it('separates an argv that starts with dashes from the run flags', async () => {
  const fake = createHcFake();

  fake.reply('run', JSON.stringify(terminal));

  await run(runtimeOf(fake), { argv: ['--version'] });

  expect(fake.calls[0]?.commandArguments).toEqual(['run', '--json', '--', '--version']);
});

it('passes --all only when all terminals are requested', async () => {
  const fake = createHcFake();

  fake.reply('ls', JSON.stringify({ terminals: [] }));

  await ls(runtimeOf(fake), { all: true });
  await ls(runtimeOf(fake));

  expect(fake.calls.map((call) => call.commandArguments)).toEqual([
    ['ls', '--json', '--all'],
    ['ls', '--json'],
  ]);
});

it('passes the send flags and separates text that starts with dashes', async () => {
  const fake = createHcFake();

  fake.reply('send', JSON.stringify({ turn: 2 }));

  await send(runtimeOf(fake), 't7', { text: '--probe', force: true, wait: true, timeout: 30 });

  expect(fake.calls[0]?.commandArguments).toEqual([
    'send',
    '--json',
    '--force',
    '--wait',
    '--timeout',
    '30',
    '--',
    't7',
    '--probe',
  ]);
});

it('sends text without flags by default', async () => {
  const fake = createHcFake();

  fake.reply('send', JSON.stringify({ turn: 2 }));

  await send(runtimeOf(fake), 't7', { text: 'hello' });

  expect(fake.calls[0]?.commandArguments).toEqual(['send', '--json', '--', 't7', 'hello']);
});

it('separates label assignments that start with dashes from the terminal', async () => {
  const fake = createHcFake();

  fake.reply('label', JSON.stringify(terminal));

  await label(runtimeOf(fake), 't7', { '-role': 'worker' });

  expect(fake.calls[0]?.commandArguments).toEqual(['label', '--json', '--', 't7', '-role=worker']);
});

it('returns undefined for an empty terminal address', () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  expect(currentTerminalAddress()).toBeUndefined();
});

it('returns undefined for an unset terminal address', () => {
  vi.stubEnv('HC_TERMINAL_ID', undefined);

  expect(currentTerminalAddress()).toBeUndefined();
});

it('returns the terminal address when it is set', () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  expect(currentTerminalAddress()).toBe('t7');
});

it('restores the terminal address the file inherited', () => {
  expect(currentTerminalAddress()).toBe(inheritedTerminalAddress);
});

it('reads the current terminal and its labels when the address is set', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  const fake = createHcFake();

  fake.reply('get', JSON.stringify(terminal));

  const result = await readCurrentTerminal(runtimeOf(fake));

  expect(result?.address).toBe('t7');
  expect(result?.labels).toEqual({ role: 'worker' });
  expect(fake.calls).toHaveLength(1);
  expect(fake.connectCalls).toHaveLength(0);
});

it('does not read when the terminal address is empty', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const fake = createHcFake();

  expect(await readCurrentTerminal(runtimeOf(fake))).toBeUndefined();
  expect(fake.calls).toHaveLength(0);
  expect(fake.connectCalls).toHaveLength(0);
});

it('does not read when the terminal address is unset', async () => {
  vi.stubEnv('HC_TERMINAL_ID', undefined);

  const fake = createHcFake();

  expect(await readCurrentTerminal(runtimeOf(fake))).toBeUndefined();
  expect(fake.calls).toHaveLength(0);
  expect(fake.connectCalls).toHaveLength(0);
});

it('keeps a not_found from the current terminal read as an HcError', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  const fake = createHcFake();

  fake.fail('get', notFound, 3);

  const failure = await readCurrentTerminal(runtimeOf(fake)).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(HcError);
  expect(failure).toMatchObject({ name: 'HcError', kind: 'not_found' });
  expect(fake.calls).toHaveLength(1);
  expect(fake.connectCalls).toHaveLength(0);
});

it('rejects malformed evidence for the current terminal', async () => {
  vi.stubEnv('HC_TERMINAL_ID', 't7');

  const fake = createHcFake();

  fake.reply('get', 'not-json');

  await expect(readCurrentTerminal(runtimeOf(fake))).rejects.toMatchObject({
    name: 'HcError',
    kind: 'malformed',
  });

  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]?.commandArguments).toEqual(['get', '--json', 't7']);
  expect(fake.connectCalls).toHaveLength(0);
});
