import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { onTestFinished, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { runCheck } from './run.js';

vi.mock(import('node:child_process'), async (importOriginal) => {
  const original = await importOriginal();

  const spawnFake = vi.fn<() => ChildProcess>();

  return { ...original, spawn: spawnFake as unknown as typeof original.spawn };
});

const idleLimit = 400;
const groupId = 424_242;

// A command that never exits by itself and writes to the log only when the test does.
const setUp = async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-fake-');
  // oxlint-disable-next-line unicorn/prefer-event-target -- runCheck calls the Node child process once and emit API.
  const child = Object.assign(new EventEmitter(), { pid: groupId }) as unknown as ChildProcess;
  const signals: unknown[] = [];

  vi.mocked(spawn).mockReturnValue(child);

  vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    }

    signals.push(signal);

    return true;
  });

  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const controller = new AbortController();
  const started = Promise.withResolvers<undefined>();

  vi.mocked(spawn).mockImplementation(() => {
    started.resolve(undefined);

    return child;
  });

  const outcome = runCheck(root, ['fake'], controller.signal, async () => {}, idleLimit);

  // Swallows a rejection until the test awaits the outcome.
  outcome.catch(() => undefined);
  await started.promise;

  const checks = join(root, '.tau', 'checks');

  const write = (text: string) => {
    const [name = ''] = readdirSync(checks);

    appendFileSync(join(checks, name), text);
  };

  return { child, signals, controller, outcome, write };
};

it('stops a silent command no later than the idle limit plus a short poll, and reports the hang', async () => {
  const { child, signals, outcome, write } = await setUp();

  write('summary\n');
  vi.advanceTimersByTime(idleLimit / 2);

  expect(signals).toEqual([]);

  vi.advanceTimersByTime(idleLimit);

  expect(signals).toEqual(['SIGTERM']);

  child.emit('close', null, 'SIGTERM');

  expect(await outcome).toMatchObject({ passed: false, idle: true });
});

it('keeps a command that writes more often than the idle limit, then stops it once it goes silent', async () => {
  const { child, signals, outcome, write } = await setUp();

  for (let step = 0; step < 10; step += 1) {
    write('tick\n');
    vi.advanceTimersByTime(idleLimit / 2);
  }

  expect(signals).toEqual([]);

  vi.advanceTimersByTime(idleLimit * 1.5);

  expect(signals).toEqual(['SIGTERM']);

  child.emit('close', null, 'SIGTERM');

  expect(await outcome).toMatchObject({ idle: true });
});

it('does not stop a command that wrote output twice again after the idle limit passed in total', async () => {
  const { child, signals, outcome, write } = await setUp();

  write('one\n');
  vi.advanceTimersByTime(idleLimit * 0.75);
  write('two\n');
  vi.advanceTimersByTime(idleLimit * 0.75);

  expect(signals).toEqual([]);

  child.emit('close', 0, null);

  expect(await outcome).toMatchObject({ passed: true, idle: false });
});

it('sends one stop request and one kill when an abort follows an idle stop', async () => {
  const { child, signals, controller, outcome } = await setUp();

  vi.advanceTimersByTime(idleLimit * 1.5);
  controller.abort();
  vi.advanceTimersByTime(10_000);

  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);

  child.emit('close', null, 'SIGKILL');

  await expect(outcome).rejects.toThrow('its command has stopped');
});

it('sends one stop request when an idle stop follows an abort', async () => {
  const { child, signals, controller, outcome } = await setUp();

  controller.abort();
  controller.abort();
  vi.advanceTimersByTime(idleLimit * 1.5);

  expect(signals).toEqual(['SIGTERM']);

  child.emit('close', null, 'SIGTERM');

  await expect(outcome).rejects.toThrow('its command has stopped');
});
