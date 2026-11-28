import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { errorMessage } from '../errors.js';
import type { HcRuntime } from './hc.js';
import {
  HcError,
  matchParsedReply,
  parseHelloResult,
  parseJsonRpcReplies,
  parseTerminal,
  requestLine,
} from './replies.js';
import type { HcTerminal } from './replies.js';

interface ConnectOptions {
  cwd?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
  signal?: AbortSignal | undefined;
}

interface ConnectResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type Connect = (
  lines: readonly string[],
  options?: ConnectOptions,
) => Promise<ConnectResult>;

export interface TerminalRunRequest {
  argv: string[];
  env: Record<string, string>;
  name?: string | undefined;
  parent?: string | undefined;
  cwd?: string | undefined;
  labels?: Record<string, string> | undefined;
  noParent?: boolean | undefined;
  noNotify?: boolean | undefined;
}

const helloGeneration = 1;

export const streamKillGraceMilliseconds = 5000;

export const killConfirmMilliseconds = 2000;

const stdoutCharacterLimit = 1_048_576;
const stderrCharacterLimit = 4096;

const terminalRunParams = (request: TerminalRunRequest): Record<string, unknown> => ({
  argv: request.argv,
  env: request.env,
  ...(request.name === undefined ? {} : { name: request.name }),
  ...(request.parent === undefined ? {} : { parent: request.parent }),
  ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
  ...(request.labels === undefined ? {} : { labels: request.labels }),
  ...(request.noParent === undefined ? {} : { no_parent: request.noParent }),
  ...(request.noNotify === undefined ? {} : { no_notify: request.noNotify }),
});

const takeReply = (
  label: string,
  replies: readonly Record<string, unknown>[],
  id: number,
): unknown => {
  const reply = matchParsedReply(label, replies, id);

  if (reply === undefined) {
    throw new HcError('missing_reply', `${label} ended before reply ${id}`);
  }

  return reply;
};

const stderrDetail = (stderr: string): string => {
  const trimmed = stderr.trim();

  return trimmed === '' ? '' : `: ${trimmed}`;
};

const exitFailure = (result: ConnectResult): HcError | undefined => {
  if (result.code === 0 && result.signal === null) {
    return undefined;
  }

  if (result.signal !== null) {
    return new HcError('exited', `hc connect was killed by ${result.signal}`);
  }

  const details = result.code === null ? {} : { exitCode: result.code };
  const message = `hc connect exited with code ${String(result.code)}${stderrDetail(result.stderr)}`;

  return new HcError('exited', message, details);
};

export const runWithEnvironment = async (
  runtime: HcRuntime,
  request: TerminalRunRequest,
): Promise<HcTerminal> => {
  const label = 'hc connect terminal.run';

  const workingDirectory = request.cwd ?? runtime.cwd;

  const lines = [
    requestLine(1, 'hello', { generation: helloGeneration }),
    requestLine(2, 'terminal.run', terminalRunParams({ ...request, cwd: workingDirectory })),
  ];

  const result = await runtime.connect(lines, {
    cwd: runtime.cwd,
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
  });

  const failure = exitFailure(result);

  if (failure !== undefined) {
    throw failure;
  }

  const replyLines = result.stdout.split('\n');
  const replies = parseJsonRpcReplies(label, replyLines);

  parseHelloResult(label, takeReply(label, replies, 1));

  return parseTerminal(label, takeReply(label, replies, 2));
};

// An error after spawn may come with a request hc already received, so only an error before spawn
// is a definite start failure.
const childFailure = (error: Error, spawned: boolean): HcError =>
  spawned
    ? new HcError('connect_failed', `hc connect failed: ${errorMessage(error)}`)
    : new HcError('spawn_failed', `hc connect failed to start: ${errorMessage(error)}`);

export const connect: Connect = (lines, options = {}) => {
  if (options.signal?.aborted === true) {
    return Promise.reject(new HcError('aborted', 'hc connect was aborted'));
  }

  let child: ChildProcessWithoutNullStreams;

  try {
    child = spawn('hc', ['connect'], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    return Promise.reject(
      new HcError('spawn_failed', `hc connect failed to start: ${errorMessage(error)}`),
    );
  }

  return new Promise<ConnectResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let spawned = false;
    let childError: Error | undefined;
    let streamFailure: HcError | undefined;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let confirmTimer: NodeJS.Timeout | undefined;
    let onClose: (code: number | null, signal: NodeJS.Signals | null) => void = () => settled;
    const abortListener: { remove?: () => void } = {};

    const destroyPipes = () => {
      [child.stdout, child.stderr].forEach((stream) => stream.destroy());
    };

    const settle = (action: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(killTimer);
      clearTimeout(confirmTimer);
      abortListener.remove?.();
      child.off('exit', destroyPipes);
      child.off('close', onClose);
      destroyPipes();
      action();
    };

    const stopChild = (failure: HcError) => {
      if (settled) {
        return;
      }

      const overflowWins = failure.kind === 'output_too_large' && streamFailure?.kind !== 'aborted';

      if (streamFailure !== undefined && !overflowWins) {
        return;
      }

      streamFailure = failure;

      if (killTimer === undefined) {
        if (child.exitCode !== null || child.signalCode !== null) {
          destroyPipes();
        } else {
          child.kill('SIGTERM');
          child.once('exit', destroyPipes);
        }

        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, streamKillGraceMilliseconds);

        confirmTimer = setTimeout(() => {
          const latestFailure = streamFailure ?? failure;

          settle(() => {
            reject(
              new HcError(
                latestFailure.kind,
                `${latestFailure.message} and did not exit after SIGKILL`,
              ),
            );
          });
        }, streamKillGraceMilliseconds + killConfirmMilliseconds);
      }
    };

    const onAbort = () => {
      aborted = streamFailure === undefined;
      stopChild(new HcError('aborted', 'hc connect was aborted'));
    };

    abortListener.remove = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      const remaining = stdoutCharacterLimit - stdout.length;

      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);

        stopChild(
          new HcError(
            'output_too_large',
            `hc connect printed more than ${stdoutCharacterLimit} characters`,
          ),
        );

        return;
      }

      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');

    child.stderr.on('data', (chunk: string) => {
      const remaining = stderrCharacterLimit - stderr.length;

      if (remaining > 0) {
        stderr += chunk.slice(0, remaining);
      }
    });

    child.stdin.on('error', (error) => {
      stopChild(new HcError('write_failed', `hc connect input failed: ${errorMessage(error)}`));
    });

    child.stdout.on('error', (error) => {
      stopChild(new HcError('read_failed', `hc connect output failed: ${errorMessage(error)}`));
    });

    child.stderr.on('error', (error) => {
      stopChild(new HcError('read_failed', `hc connect stderr failed: ${errorMessage(error)}`));
    });

    child.on('spawn', () => {
      spawned = true;
    });

    child.on('error', (error) => {
      childError = error;
    });

    onClose = (code, signal) => {
      if (childError !== undefined) {
        const failure = childError;

        settle(() => {
          reject(childFailure(failure, spawned));
        });

        return;
      }

      if (aborted) {
        settle(() => {
          reject(new HcError('aborted', 'hc connect was aborted'));
        });

        return;
      }

      const exitWins = code !== null && code !== 0 && streamFailure?.kind !== 'output_too_large';

      if (streamFailure !== undefined && !exitWins) {
        const failure = streamFailure;

        settle(() => {
          reject(failure);
        });

        return;
      }

      settle(() => {
        resolve({ stdout, stderr, code, signal });
      });
    };

    child.on('close', onClose);

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdin.end(lines.join(''));
  });
};
