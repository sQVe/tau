import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { onTestFinished, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { runCheck } from './run.js';

vi.mock(import('node:child_process'), async (importOriginal) => {
  const original = await importOriginal();

  const spawnFake = vi.fn<() => ChildProcess>();

  return { ...original, spawn: spawnFake as unknown as typeof original.spawn };
});

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../tests/timerFake.js');

  const delay = vi.fn<typeof original.setTimeout>(globalTimerDelay);

  return { ...original, setTimeout: delay as typeof original.setTimeout };
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
    vi.resetAllMocks();
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

const unknownGroup = (signals: unknown[]) => {
  vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
    if (signal === 0) {
      throw Object.assign(new Error('Probe failed'), { code: 'EINVAL' });
    }

    signals.push(signal);

    return true;
  });
};

it('waits for stopping an unknown group after the direct child closes', async () => {
  const { child, signals, outcome } = await setUp();
  unknownGroup(signals);
  let settled = false;

  const result = outcome.then((value) => {
    settled = true;

    return value;
  });

  child.emit('close', 0, null);
  await vi.advanceTimersByTimeAsync(0);

  expect(signals).toEqual(['SIGTERM']);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(5000);

  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(20);

  expect(await result).toMatchObject({ passed: true, exitCode: 0 });
  expect(vi.getTimerCount()).toBe(0);
});

it('reports a non-Error stopping rejection as an Error after close', async () => {
  const { child, signals, outcome } = await setUp();
  unknownGroup(signals);
  vi.mocked(sleep).mockRejectedValueOnce('poll failed');

  child.emit('close', 0, null);

  await expect(outcome).rejects.toThrow('poll failed');
  expect(signals).toEqual(['SIGTERM']);
  expect(vi.getTimerCount()).toBe(0);
});

it('sends one stop request when an abort follows an idle stop', async () => {
  const { child, signals, controller, outcome } = await setUp();

  vi.advanceTimersByTime(idleLimit * 1.5);
  controller.abort();

  expect(signals).toEqual(['SIGTERM']);

  child.emit('close', null, 'SIGTERM');

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
