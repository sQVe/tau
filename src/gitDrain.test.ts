import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

import { expect, it, onTestFinished, vi } from 'vitest';

import { runGit } from './git.js';

type CaptureCallback = (error: Error | null, stdout: Buffer, stderr: Buffer) => void;

const captureProcess = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const child = new childProcess.ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;

  let callback: CaptureCallback | undefined;

  vi.spyOn(childProcess, 'execFile').mockImplementation((...argumentsList: unknown[]) => {
    callback = argumentsList[3] as CaptureCallback;

    return child;
  });

  syncBuiltinESMExports();

  onTestFinished(() => {
    stdout.destroy();
    stderr.destroy();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.useRealTimers();
  });

  return {
    child,
    stdout,
    stderr,
    complete: (error: Error | null = null) => {
      if (callback === undefined) {
        throw new Error('Git has not started');
      }

      callback(error, Buffer.from('collected output'), Buffer.alloc(0));
    },
  };
};

it('waits for Git exit before closing idle output streams', async () => {
  const capture = captureProcess();
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: null });

  await vi.advanceTimersByTimeAsync(1000);

  expect(capture.stdout.destroyed).toBe(false);
  expect(capture.stderr.destroyed).toBe(false);

  capture.child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(100);

  expect(capture.stdout.destroyed).toBe(true);
  expect(capture.stderr.destroyed).toBe(true);

  capture.complete();
  const result = await pending;

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe('collected output');
});

it.for(['stdout', 'stderr'] as const)(
  'restarts the idle drain when %s receives data after Git exits',
  async (stream) => {
    const capture = captureProcess();
    const pending = runGit('/repository', ['status'], { timeoutMilliseconds: null });
    capture.child.emit('exit', 0, null);

    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(90);
      capture[stream].write(Buffer.from([0xff, 0, 0xc3]));
    }

    await vi.advanceTimersByTimeAsync(99);

    expect(capture.stdout.destroyed).toBe(false);
    expect(capture.stderr.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(capture.stdout.destroyed).toBe(true);
    expect(capture.stderr.destroyed).toBe(true);

    capture.complete();
    expect((await pending).exitCode).toBe(0);
  },
);

it('ignores a late exit after the native callback reports a spawn failure', async () => {
  const capture = captureProcess();
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: null });
  capture.complete(new Error('spawn failed'));
  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain('spawn failed');

  capture.child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(1000);

  expect(capture.stdout.destroyed).toBe(false);
  expect(capture.stderr.destroyed).toBe(false);
});

it('cancels idle draining when the native callback completes', async () => {
  const capture = captureProcess();
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: null });
  capture.child.emit('exit', 0, null);
  capture.complete();

  expect((await pending).exitCode).toBe(0);

  capture.stdout.write('late output');
  capture.stderr.write('late diagnostic');
  await vi.advanceTimersByTimeAsync(1000);

  expect(capture.stdout.destroyed).toBe(false);
  expect(capture.stderr.destroyed).toBe(false);
});
