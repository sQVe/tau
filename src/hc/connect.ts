import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { errorMessage } from '../errors.js';
import type { HcRuntime } from './hc.js';
import {
  HcError,
  isAbortError,
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
  cwd?: string | undefined;
  labels?: Record<string, string> | undefined;
  noParent?: boolean | undefined;
}

const helloGeneration = 1;

const streamKillGraceMilliseconds = 5000;

const terminalRunParams = (request: TerminalRunRequest): Record<string, unknown> => ({
  argv: request.argv,
  env: request.env,
  ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
  ...(request.labels === undefined ? {} : { labels: request.labels }),
  ...(request.noParent === undefined ? {} : { no_parent: request.noParent }),
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

export const connect: Connect = (lines, options = {}) => {
  let child: ChildProcessWithoutNullStreams;

  try {
    child = spawn('hc', ['connect'], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    return Promise.reject(
      new HcError('spawn_failed', `hc connect failed to start: ${errorMessage(error)}`),
    );
  }

  return new Promise<ConnectResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let spawnError: Error | undefined;
    let streamFailure: HcError | undefined;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const failStream = (failure: HcError) => {
      streamFailure ??= failure;
      child.kill('SIGTERM');

      killTimer ??= setTimeout(() => {
        child.kill('SIGKILL');
      }, streamKillGraceMilliseconds);
    };

    child.stdout.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.stdin.on('error', (error) => {
      failStream(new HcError('write_failed', `hc connect input failed: ${errorMessage(error)}`));
    });

    child.stdout.on('error', (error) => {
      failStream(new HcError('read_failed', `hc connect output failed: ${errorMessage(error)}`));
    });

    child.stderr.on('error', (error) => {
      failStream(new HcError('read_failed', `hc connect stderr failed: ${errorMessage(error)}`));
    });

    child.on('error', (error) => {
      if (isAbortError(error)) {
        aborted = true;
      } else {
        spawnError = error;
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);

      if (spawnError !== undefined) {
        reject(
          new HcError('spawn_failed', `hc connect failed to start: ${errorMessage(spawnError)}`),
        );

        return;
      }

      if (aborted) {
        reject(new HcError('aborted', 'hc connect was aborted'));

        return;
      }

      const naturalNonZero = code !== null && code !== 0;

      if (streamFailure !== undefined && !naturalNonZero) {
        reject(streamFailure);

        return;
      }

      resolve({ stdout, stderr, code, signal });
    });

    child.stdin.end(lines.join(''));
  });
};
