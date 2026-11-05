import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { errorMessage } from '../errors.js';
import { isRecord } from '../schema.js';
import { streamKillGraceMilliseconds } from './connect.js';
import { isAbortError, matchParsedReply, requestLine } from './replies.js';

export interface HcEvent {
  method: string;
  type?: string | undefined;
}

export interface EventSubscription {
  stop: () => void;
}

export interface SubscribeHandlers {
  onReady: () => void;
  onEvent: (event: HcEvent) => void;
  onClose: (reason: string) => void;
}

interface SubscribeOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
}

export type EventSelector =
  | { terminal: string; childrenOf?: never }
  | { childrenOf: string; terminal?: never };

export type SubscribeEvents = (
  selector: EventSelector,
  handlers: SubscribeHandlers,
  options?: SubscribeOptions,
) => EventSubscription;

const helloGeneration = 1;

const closeMessage = (code: number | null, signal: NodeJS.Signals | null): string => {
  if (signal !== null) {
    return `hc connect was killed by ${signal}`;
  }

  return `hc connect exited with code ${String(code)}`;
};

const errorMessageOf = (value: unknown): string => {
  if (!isRecord(value)) {
    return 'unknown error';
  }

  return typeof value.message === 'string' ? value.message : 'unknown error';
};

const eventOf = (value: Record<string, unknown>): HcEvent | undefined => {
  const { method } = value;

  if (typeof method !== 'string') {
    return undefined;
  }

  const params = isRecord(value.params) ? value.params : {};
  const type = typeof params.type === 'string' ? params.type : undefined;

  return type === undefined ? { method } : { method, type };
};

const start = (options: SubscribeOptions): ChildProcessWithoutNullStreams => {
  const child = spawn('hc', ['connect'], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  return child;
};

const subscribeParams = (selector: EventSelector): Record<string, string> => {
  if ('terminal' in selector) {
    return { terminal: selector.terminal };
  }

  return { children_of: selector.childrenOf };
};

export const subscribeEvents: SubscribeEvents = (selector, handlers, options = {}) => {
  let child: ChildProcessWithoutNullStreams;

  try {
    child = start(options);
  } catch (error) {
    queueMicrotask(() => {
      handlers.onClose(`hc connect failed to start: ${errorMessage(error)}`);
    });

    return { stop: () => undefined };
  }

  let buffer = '';
  let stopped = false;
  let ready = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = (): void => {
    child.kill('SIGTERM');

    killTimer ??= setTimeout(() => {
      child.kill('SIGKILL');
    }, streamKillGraceMilliseconds);
  };

  const fail = (reason: string) => {
    if (stopped) {
      return;
    }

    stopped = true;
    terminate();
    handlers.onClose(reason);
  };

  const reportClose = (reason: string) => {
    if (stopped) {
      return;
    }

    stopped = true;
    handlers.onClose(reason);
  };

  const handleLine = (line: string) => {
    if (stopped || line.trim() === '') {
      return;
    }

    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch {
      fail('hc connect printed a line that is not JSON');

      return;
    }

    if (!isRecord(value)) {
      fail('hc connect printed a reply that is not an object');

      return;
    }

    if ('id' in value) {
      if ('error' in value) {
        fail(`hc connect ${String(value.id)} failed: ${errorMessageOf(value.error)}`);

        return;
      }

      if (value.id === 2 && !ready) {
        try {
          matchParsedReply('hc connect', [value], 2);
        } catch (error) {
          fail(errorMessage(error));

          return;
        }

        ready = true;
        handlers.onReady();
      }

      return;
    }

    const event = eventOf(value);

    if (event !== undefined) {
      handlers.onEvent(event);
    }
  };

  child.stdout.setEncoding('utf8');

  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;

    for (;;) {
      const newline = buffer.indexOf('\n');

      if (newline === -1) {
        return;
      }

      const line = buffer.slice(0, newline);

      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  });

  child.stdout.on('error', (error) => {
    fail(`hc connect output failed: ${errorMessage(error)}`);
  });

  child.stderr.on('error', () => undefined);
  child.stderr.on('data', () => undefined);

  child.stdin.on('error', (error) => {
    fail(`hc connect input failed: ${errorMessage(error)}`);
  });

  child.on('error', (error) => {
    if (!isAbortError(error)) {
      fail(`hc connect failed to start: ${errorMessage(error)}`);
    }
  });

  child.on('close', (code, signal) => {
    clearTimeout(killTimer);
    killTimer = undefined;
    reportClose(closeMessage(code, signal));
  });

  child.stdin.write(
    requestLine(1, 'hello', { generation: helloGeneration }) +
      requestLine(2, 'events.subscribe', subscribeParams(selector)),
  );

  return {
    stop: () => {
      if (stopped) {
        return;
      }

      stopped = true;
      terminate();
    },
  };
};
