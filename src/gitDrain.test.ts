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

it('keeps Git running when the timeout is 0', async () => {
  const capture = captureProcess();
  const kill = vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 0 });

  await vi.advanceTimersByTimeAsync(1000);

  expect(kill).not.toHaveBeenCalled();

  capture.complete();
  const result = await pending;

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe('collected output');
});

it('keeps Git output when Git exits before the deadline and the drain finishes after it', async () => {
  const capture = captureProcess();
  const kill = vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  Object.defineProperty(capture.child, 'exitCode', { value: 0, configurable: true });
  capture.child.emit('exit', 0, null);

  await vi.advanceTimersByTimeAsync(50);

  expect(kill).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(50);
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

it('sends SIGTERM at the deadline, SIGKILL after the grace, and settles after the confirm', async () => {
  const capture = captureProcess();
  const kill = vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(49);

  expect(kill).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);

  expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

  await vi.advanceTimersByTimeAsync(4999);

  expect(kill).not.toHaveBeenCalledWith('SIGKILL');

  await vi.advanceTimersByTimeAsync(1);

  expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

  await vi.advanceTimersByTimeAsync(2000);

  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stdout.length).toBe(0);
  expect(result.stderr).toBe('git status timed out after 50 ms and did not exit after SIGKILL');
  expect(vi.getTimerCount()).toBe(0);
  expect(capture.child.listenerCount('exit')).toBe(0);
});

it('reports that Git could not be stopped when SIGKILL is refused', async () => {
  const capture = captureProcess();

  const kill = vi.spyOn(capture.child, 'kill').mockImplementation((signal) => signal !== 'SIGKILL');

  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(5050);

  expect(kill).toHaveBeenCalledWith('SIGKILL');

  await vi.advanceTimersByTimeAsync(2000);

  const stillPending = vi.advanceTimersByTimeAsync(0).then(() => 'pending' as const);

  expect(await Promise.race([pending.then(() => 'settled' as const), stillPending])).toBe(
    'settled',
  );

  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain('git status timed out after 50 ms');
  expect(result.stderr).not.toContain('did not exit after SIGKILL');
  expect(vi.getTimerCount()).toBe(0);
});

it('settles with the timeout reason before the final deadline and ignores a later callback', async () => {
  const capture = captureProcess();
  vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(50);
  capture.complete(Object.assign(new Error('killed'), { code: null }));

  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toBe('git status timed out after 50 ms');
  expect(vi.getTimerCount()).toBe(0);

  capture.complete();

  expect(result.exitCode).toBeNull();
});

it('does not send SIGKILL when Git exited at the kill grace', async () => {
  const capture = captureProcess();
  const kill = vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(50);

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  Object.defineProperty(capture.child, 'exitCode', { value: 0, configurable: true });
  await vi.advanceTimersByTimeAsync(5000);

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  capture.complete(Object.assign(new Error('killed'), { code: 0 }));

  expect((await pending).exitCode).toBeNull();
});

it('keeps Git output when Git exits during the kill grace', async () => {
  const capture = captureProcess();
  const kill = vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(50);

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  Object.defineProperty(capture.child, 'exitCode', { value: 0, configurable: true });
  capture.child.emit('exit', 0, null);

  await vi.advanceTimersByTimeAsync(7000);

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');

  capture.complete(Object.assign(new Error('killed'), { code: null }));

  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stdout.toString()).toBe('collected output');
  expect(result.stderr).toBe('git status timed out after 50 ms');
});

it('keeps the abort reason when the abort lands during the kill grace', async () => {
  const capture = captureProcess();
  const controller = new AbortController();
  vi.spyOn(capture.child, 'kill').mockReturnValue(true);

  const pending = runGit('/repository', ['status'], {
    timeoutMilliseconds: 50,
    signal: controller.signal,
  });

  await vi.advanceTimersByTimeAsync(50);
  controller.abort();
  capture.complete(Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }));

  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain('The operation was aborted');
  expect(result.stderr).not.toContain('timed out');
});

it('keeps the buffer-limit reason when it lands during the kill grace', async () => {
  const capture = captureProcess();
  vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(50);

  capture.complete(
    Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    }),
  );

  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain('stdout maxBuffer length exceeded');
  expect(result.stderr).not.toContain('timed out');
});

it('destroys its output pipes at the final fallback', async () => {
  const capture = captureProcess();
  vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(7050);
  await pending;

  expect(capture.stdout.destroyed).toBe(true);
  expect(capture.stderr.destroyed).toBe(true);
});

it('does not arm a timer after the native callback settles during a signal', async () => {
  const capture = captureProcess();

  const kill = vi.spyOn(capture.child, 'kill').mockImplementation((signal) => {
    if (signal === 'SIGTERM') {
      capture.complete(Object.assign(new Error('killed'), { code: null }));
    }

    return true;
  });

  const pending = runGit('/repository', ['status'], { timeoutMilliseconds: 50 });

  await vi.advanceTimersByTimeAsync(50);
  const result = await pending;

  expect(result.stderr).toBe('git status timed out after 50 ms');
  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(10000);

  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
});

it('reports the timeout reason when an abort lands late without a native abort error', async () => {
  const capture = captureProcess();
  vi.spyOn(capture.child, 'kill').mockReturnValue(true);
  const controller = new AbortController();

  const pending = runGit('/repository', ['status'], {
    timeoutMilliseconds: 50,
    signal: controller.signal,
  });

  await vi.advanceTimersByTimeAsync(50);
  controller.abort();
  capture.complete();

  const result = await pending;

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toBe('git status timed out after 50 ms');
});
