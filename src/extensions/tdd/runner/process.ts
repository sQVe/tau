import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { SpawnFn, SpawnResult } from './types.js';

export const maximumTotalBytes = 32 * 1024;
// Bound captured process output separately from the shorter diagnostic messages.
export const maximumStdoutBytes = 8 * 1024 * 1024;

// Debian-family systems name the runtime `nodejs`, so both spellings count as a Node command.
const nodeNames = process.platform === 'win32' ? ['node.exe'] : ['node', 'nodejs'];

// oxlint-disable-next-line node/no-process-env -- Compiled Pi needs a real Node executable from the caller's PATH.
const nodeOnPath = (path = process.env.PATH ?? '') =>
  path
    .split(delimiter)
    .flatMap((directory) => nodeNames.map((name) => join(directory, name)))
    .find((executable) => {
      try {
        accessSync(executable, constants.X_OK);

        return statSync(executable).isFile();
      } catch {
        return false;
      }
    });

// In compiled Pi, process.execPath is the agent and cannot run Vitest. Prefer Node from PATH.
// Keep the fallback for Node executables with other names, such as `nodejs`.
export const nodeExecutable = (executablePath = process.execPath) =>
  /^node(\.exe)?$/i.test(basename(executablePath.replaceAll('\\', '/')))
    ? executablePath
    : (nodeOnPath() ?? executablePath);

const appendChunk = (
  chunk: Buffer,
  decoder: StringDecoder,
  current: string,
  remaining: number,
): string => {
  if (remaining <= 0) {
    return current;
  }

  return current + decoder.write(chunk.subarray(0, remaining));
};

interface SpawnState {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  settled: boolean;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
}

const killChild = (child: ChildProcess, useProcessGroup: boolean): void => {
  try {
    if (useProcessGroup && child.pid != null) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
};

interface SettleRequest {
  state: SpawnState;
  child: ChildProcess;
  resolve: (result: SpawnResult) => void;
  code: number | null;
  command: string[];
  clearTimer: () => void;
}

const settleSpawn = (request: SettleRequest): void => {
  const { state, child, resolve, code, command, clearTimer } = request;

  if (state.settled) {
    return;
  }

  state.settled = true;
  clearTimer();
  state.stdout += state.stdoutDecoder.end();
  state.stderr += state.stderrDecoder.end();

  resolve({
    stdout: state.stdout,
    stderr: state.stderr,
    code,
    timedOut: state.timedOut,
    stdoutBytes: state.stdoutBytes,
    stderrBytes: state.stderrBytes,
    stdoutTruncated: state.stdoutBytes > maximumStdoutBytes,
    command,
    started: child.pid !== undefined,
  });
};

// Continue draining after the capture limit; console noise cannot decide the test verdict.
const captureStdout = (state: SpawnState, chunk: Buffer): void => {
  state.stdout = appendChunk(
    chunk,
    state.stdoutDecoder,
    state.stdout,
    maximumStdoutBytes - state.stdoutBytes,
  );
  state.stdoutBytes += chunk.length;
};

const captureStderr = (state: SpawnState, chunk: Buffer): void => {
  state.stderr = appendChunk(
    chunk,
    state.stderrDecoder,
    state.stderr,
    maximumTotalBytes - state.stderrBytes,
  );
  state.stderrBytes += chunk.length;
};

const captureSpawnError = (state: SpawnState, error: Error): void => {
  const message = Buffer.from(error.message);

  state.stderr = appendChunk(
    message,
    state.stderrDecoder,
    state.stderr,
    maximumTotalBytes - state.stderrBytes,
  );
  state.stderrBytes += message.length;
};

export const defaultSpawn: SpawnFn = (command, argumentsList, options) =>
  new Promise<SpawnResult>((resolve) => {
    // detached lets the timeout path signal the whole process group on POSIX.
    // Windows has no equivalent; we fall back to child.kill there.
    const useProcessGroup = process.platform !== 'win32';
    const executable = nodeExecutable();
    const commandLine = [executable, command, ...argumentsList];
    const child = nodeSpawn(executable, [command, ...argumentsList], {
      cwd: options.cwd,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const state: SpawnState = {
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      timedOut: false,
      settled: false,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
    };

    const settle = (code: number | null) => {
      settleSpawn({
        state,
        child,
        resolve,
        code,
        command: commandLine,
        clearTimer: () => {
          clearTimeout(timer);
        },
      });
    };

    const abort = () => {
      killChild(child, useProcessGroup);
      settle(null);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      captureStdout(state, chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      captureStderr(state, chunk);
    });

    // Settle here rather than waiting for `close`: on Windows only the direct child dies,
    // and a descendant holding the piped stdio would keep `close` pending forever.
    const timer = setTimeout(() => {
      state.timedOut = true;
      killChild(child, useProcessGroup);
      settle(null);
    }, options.timeoutMs);

    timer.unref();

    child.on('close', settle);
    child.on('error', (error) => {
      captureSpawnError(state, error);
      settle(null);
    });

    if (options.signal?.aborted === true) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }
  });
