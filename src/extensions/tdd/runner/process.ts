import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { signalGroup } from '../../../process/process.js';
import type { SpawnCommand, SpawnResult } from './types.js';

interface SpawnState {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut: boolean;
  settled: boolean;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  stdoutFileDescriptor: number | undefined;
}

interface SettleRequest {
  state: SpawnState;
  child: ChildProcess;
  resolve: (result: SpawnResult) => void;
  code: number | null;
  command: string[];
  release: () => void;
}

const bytesPerKibibyte = 1024;
const bytesPerMebibyte = bytesPerKibibyte * bytesPerKibibyte;
const maximumTotalKibibytes = 32;
const maximumStdoutMebibytes = 8;
const ownerReadWriteMode = 0o600;

export const maximumTotalBytes = maximumTotalKibibytes * bytesPerKibibyte;
// Bound captured process output separately from the shorter diagnostic messages.
export const maximumStdoutBytes = maximumStdoutMebibytes * bytesPerMebibyte;

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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failedSpawnResult = (command: string[], error: unknown): SpawnResult => {
  const message = errorMessage(error);

  return {
    stdout: '',
    stderr: message,
    code: null,
    timedOut: false,
    command,
    started: false,
    stdoutTruncated: false,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(message),
  };
};

const settleSpawn = (request: SettleRequest): void => {
  const { state, child, resolve, code, command, release } = request;

  if (state.settled) {
    return;
  }

  state.settled = true;
  release();
  state.stdout += state.stdoutDecoder.end();
  state.stderr += state.stderrDecoder.end();

  if (state.stdoutFileDescriptor !== undefined) {
    closeSync(state.stdoutFileDescriptor);
    state.stdoutFileDescriptor = undefined;
  }

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

export const defaultSpawn: SpawnCommand = (executable, argumentsList, options) =>
  new Promise<SpawnResult>((resolve) => {
    const commandLine = [executable, ...argumentsList];
    let captureDescriptor: number | undefined;

    if (options.stdoutFile !== undefined) {
      try {
        captureDescriptor = openSync(options.stdoutFile, 'w', ownerReadWriteMode);
      } catch (error) {
        resolve(failedSpawnResult(commandLine, error));

        return;
      }
    }

    const child = nodeSpawn(executable, argumentsList, {
      cwd: options.cwd,
      detached: true,
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
      stdoutFileDescriptor: captureDescriptor,
    };

    const abortListener = new AbortController();

    const settle = (code: number | null) => {
      settleSpawn({
        state,
        child,
        resolve,
        code,
        command: commandLine,
        release: () => {
          clearTimeout(timer);
          // The signal can outlive this run; a listener left on it would kill this group later.
          abortListener.abort();
        },
      });
    };

    const abort = () => {
      signalGroup(child, 'SIGKILL');
      settle(null);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      captureStdout(state, chunk);

      if (state.stdoutFileDescriptor === undefined) {
        return;
      }

      try {
        writeSync(state.stdoutFileDescriptor, chunk);
      } catch (error) {
        captureStderr(state, Buffer.from(errorMessage(error)));
        signalGroup(child, 'SIGKILL');
        settle(null);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      captureStderr(state, chunk);
    });

    // Settle here rather than waiting for `close`: a descendant that left the group and holds the
    // piped stdio would keep `close` pending forever.
    const timer = setTimeout(() => {
      state.timedOut = true;
      signalGroup(child, 'SIGKILL');
      settle(null);
    }, options.timeoutMs);

    timer.unref();

    child.on('close', settle);

    child.on('error', (error) => {
      captureStderr(state, Buffer.from(error.message));
      settle(null);
    });

    if (options.signal?.aborted === true) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abort, {
        once: true,
        signal: abortListener.signal,
      });
    }
  });
