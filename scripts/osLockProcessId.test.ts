import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

import { probeTimeoutMilliseconds, readProcessId } from './osLockProcessId.js';

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

it('joins a process ID line that arrives in more than one chunk', async () => {
  vi.useFakeTimers();
  const { child, stdout } = fakeChild();
  const reading = readProcessId(child);

  stdout.emit('data', Buffer.from('12'));
  stdout.emit('data', Buffer.from('3\n'));

  await expect(reading).resolves.toBe(123);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { case: 'a word', text: 'not-a-process-id\n' },
  { case: 'leading spaces', text: ' 42\n' },
  { case: 'hexadecimal', text: '0x10\n' },
  { case: 'exponent notation', text: '1e3\n' },
  { case: 'a decimal point', text: '12.0\n' },
  { case: 'zero', text: '0\n' },
  { case: 'a negative number', text: '-1\n' },
])('rejects a process ID line holding $case', async ({ text }) => {
  vi.useFakeTimers();
  const { child, stdout } = fakeChild();
  const reading = readProcessId(child);

  stdout.emit('data', Buffer.from(text));

  await expect(reading).rejects.toThrow('plain decimal digits');
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects when the parent cannot be started', async () => {
  vi.useFakeTimers();
  const { child } = fakeChild();
  const reading = readProcessId(child);
  const startError = new Error('spawn tau-os-lock-parent ENOENT');

  child.emit('error', startError);

  await expect(reading).rejects.toThrow(startError);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps reading after the parent exits but before its output is drained', async () => {
  vi.useFakeTimers();
  const { child, stdout } = fakeChild();
  const reading = readProcessId(child);

  child.emit('exit', 0);
  stdout.emit('data', Buffer.from('123\n'));

  await expect(reading).resolves.toBe(123);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects when the parent closes before printing its process ID', async () => {
  vi.useFakeTimers();
  const { child } = fakeChild();
  const reading = readProcessId(child);

  child.emit('close', 0, null);

  await expect(reading).rejects.toThrow('exited before');
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects after the probe deadline when the parent prints no process ID', async () => {
  vi.useFakeTimers();
  const { child } = fakeChild();
  const reading = readProcessId(child);

  vi.advanceTimersByTime(probeTimeoutMilliseconds);

  await expect(reading).rejects.toThrow('did not print its holder process ID');
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects after the probe deadline when the parent has no output stream', async () => {
  vi.useFakeTimers();
  const child = new ChildProcess();
  const reading = readProcessId(child);

  vi.advanceTimersByTime(probeTimeoutMilliseconds);

  await expect(reading).rejects.toThrow('did not print its holder process ID');
  expect(vi.getTimerCount()).toBe(0);
});

it('detaches its output listeners once it reads the process ID', async () => {
  vi.useFakeTimers();
  const { child, stdout } = fakeChild();
  const reading = readProcessId(child);

  stdout.emit('data', Buffer.from('123\n'));

  await expect(reading).resolves.toBe(123);
  expect(stdout.listenerCount('data')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
  expect(() => child.emit('error', new Error('a late start failure'))).not.toThrow();
  await expect(reading).resolves.toBe(123);
});

it('absorbs a start failure that arrives after the read rejects', async () => {
  vi.useFakeTimers();
  const { child } = fakeChild();
  const reading = readProcessId(child);

  child.emit('error', new Error('spawn tau-os-lock-parent ENOENT'));

  await expect(reading).rejects.toThrow('ENOENT');
  expect(child.listenerCount('error')).toBe(1);
  expect(() => child.emit('error', new Error('a second start failure'))).not.toThrow();
  await expect(reading).rejects.toThrow('ENOENT');
});
