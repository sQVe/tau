import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const maximumOutputBytes = 1024 * 1024;
const captureOutput = (stream: Readable) => {
  const captured = Buffer.alloc(maximumOutputBytes);
  let size = 0;
  let truncated = false;
  const append = (bytes: Buffer) => {
    const retained = Math.min(bytes.length, maximumOutputBytes - size);

    if (retained) {
      bytes.copy(captured, size, 0, retained);
      size += retained;
    }

    truncated ||= retained < bytes.length;
  };
  const closed = new Promise<void>((resolve) => stream.once('close', resolve));
  stream.on('data', append);
  stream.on('error', (error) => append(Buffer.from(String(error))));

  return {
    append,
    closed,
    text: () =>
      captured.subarray(0, size).toString() +
      (truncated ? `\n[output truncated after ${maximumOutputBytes} bytes]\n` : ''),
  };
};

const checkerEnvironment = () => {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  const count = Number(environment.GIT_CONFIG_COUNT ?? '0');

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      'Invalid inherited GIT_CONFIG_COUNT. Use a valid Git environment before retrying.',
    );
  }

  // Git diff can refresh the index even with optional locks disabled. This setting is checker-local.
  return {
    ...environment,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'diff.autoRefreshIndex',
    [`GIT_CONFIG_VALUE_${count}`]: 'false',
  };
};

// Cooperative POSIX children must stay in this process group. Detached writers are not contained.
export const runChecker = async (command: string[], root: string, signal?: AbortSignal) => {
  const [executable, ...arguments_] = command;

  if (!executable || process.platform === 'win32') {
    throw new Error('In-place checks require an executable and a local POSIX checkout.');
  }

  if (signal?.aborted) {
    return { code: 1, killed: true, stdout: '', stderr: '' };
  }

  const child = spawn(executable, arguments_, {
    cwd: root,
    env: checkerEnvironment(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = captureOutput(child.stdout);
  const stderr = captureOutput(child.stderr);
  let killed = false;
  let termination: ReturnType<typeof setTimeout> | undefined;
  let drainTimeout: ReturnType<typeof setTimeout> | undefined;
  const send = (name: NodeJS.Signals | 0) => {
    if (!child.pid) {
      return false;
    }

    try {
      process.kill(-child.pid, name);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return false;
      }

      throw error;
    }
  };
  const stop = () => {
    if (killed) {
      return;
    }

    killed = true;
    send('SIGTERM');
    termination = setTimeout(() => send('SIGKILL'), 1000);
  };
  const timeout = setTimeout(stop, 600_000);
  signal?.addEventListener('abort', stop, { once: true });

  try {
    const code = await new Promise<number>((resolve) => {
      child.once('error', (error) => {
        stderr.append(Buffer.from(String(error)));
        resolve(1);
      });
      child.once('exit', (status, terminationSignal) => {
        killed ||= terminationSignal !== null;
        resolve(status ?? 1);
      });
    });
    const survivingChildren = send(0);

    if (survivingChildren) {
      send('SIGKILL');
    }

    for (let attempt = 0; send(0); attempt += 1) {
      if (attempt >= 100) {
        throw new Error(
          'Checker process group has not terminated. Keep pending recovery; stop surviving writers before manual recovery.',
        );
      }

      await delay(10);
    }

    await Promise.race([
      Promise.all([stdout.closed, stderr.closed]),
      new Promise<never>((_resolve, reject) => {
        drainTimeout = setTimeout(
          () =>
            reject(
              new Error(
                'Checker output streams did not close. Keep pending recovery and stop detached writers before manual recovery.',
              ),
            ),
          1000,
        );
      }),
    ]);

    return {
      code: survivingChildren ? 1 : code,
      killed: killed || survivingChildren,
      stdout: stdout.text(),
      stderr: stderr.text(),
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(termination);
    clearTimeout(drainTimeout);
    signal?.removeEventListener('abort', stop);
  }
};
