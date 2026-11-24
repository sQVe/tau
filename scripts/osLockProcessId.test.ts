import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { readProcessId } from './osLockProcessId.js';

const fakeChild = (): { child: ChildProcess; stdout: PassThrough } => {
  const child = new ChildProcess();
  const stdout = new PassThrough();
  child.stdout = stdout;

  return { child, stdout };
};

afterEach(() => {
  vi.useRealTimers();
});

it('reads the first process ID line the parent prints', async () => {
  vi.useFakeTimers();
  const { child, stdout } = fakeChild();
  const reading = readProcessId(child);

  stdout.emit('data', Buffer.from('123\n456\n'));

  await expect(reading).resolves.toBe(123);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects a process ID line that is not a positive whole number', async () => {
  vi.useFakeTimers();
  const { child, stdout } = fakeChild();
  const reading = readProcessId(child);

  stdout.emit('data', Buffer.from('not-a-process-id\n'));

  await expect(reading).rejects.toThrow('no usable process ID');
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects when the parent exits before printing its process ID', async () => {
  vi.useFakeTimers();
  const { child } = fakeChild();
  const reading = readProcessId(child);

  child.emit('exit', 0);

  await expect(reading).rejects.toThrow('exited before');
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects after the probe deadline when the parent prints no process ID', async () => {
  vi.useFakeTimers();
  const { child } = fakeChild();
  const reading = readProcessId(child);

  vi.advanceTimersByTime(10_000);

  await expect(reading).rejects.toThrow('did not print its holder process ID');
  expect(vi.getTimerCount()).toBe(0);
});
