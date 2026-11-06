import { lstatSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { join } from 'node:path';

import { hasErrorCode, isMissingFile } from '../errors.js';
import { withFileLock } from '../fileLock/fileLock.js';
import {
  encodeFrame,
  isUuid,
  oversizedReason,
  refusedReply,
  requestByteLimit,
} from './protocol.js';

type Respond = (request: Buffer) => Promise<string>;

export interface EndpointOptions {
  path: string;
  respond: Respond;
}

export interface Endpoint {
  path: string;
  close: () => Promise<void>;
}

type ProbeResult = 'live' | 'refused' | 'missing';

// macOS limits a socket path to 104 bytes, including the terminating NUL.
const socketPathByteLimit = 103;

const readMilliseconds = 5000;

const probeMilliseconds = 1000;

const drainMilliseconds = 5000;

const lockPollMilliseconds = 10;

const permissionBits = 0o777;

const groupAndOtherBits = 0o077;

const octal = 8;

export class LiveOwnerError extends Error {
  override name = 'LiveOwnerError';

  constructor(path: string) {
    super(`Inbox socket ${path} already has a live owner.`);
  }
}

export const socketDirectoryFor = (uid: number): string => `/tmp/tau-${String(uid)}`;

export const socketPathFor = (directory: string, sessionId: string): string => {
  if (!isUuid(sessionId)) {
    throw new Error(`Session "${sessionId}" is not a UUID, so it cannot name an inbox socket.`);
  }

  const path = join(directory, `${sessionId}.sock`);
  const bytes = Buffer.byteLength(path);

  if (bytes > socketPathByteLimit) {
    throw new Error(
      `Inbox socket path ${path} is ${String(bytes)} bytes; the limit is ${String(socketPathByteLimit)}.`,
    );
  }

  return path;
};

const createDirectory = (directory: string): void => {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }
};

export const ensurePrivateDirectory = (directory: string): void => {
  createDirectory(directory);

  const stats = lstatSync(directory);

  if (!stats.isDirectory()) {
    throw new Error(`Inbox directory ${directory} is not a directory.`);
  }

  if (stats.uid !== process.getuid?.()) {
    throw new Error(`Inbox directory ${directory} belongs to uid ${String(stats.uid)}.`);
  }

  const mode = stats.mode & permissionBits;

  if ((mode & groupAndOtherBits) !== 0) {
    throw new Error(
      `Inbox directory ${directory} has mode ${mode.toString(octal)}; it must be 700.`,
    );
  }
};

const lockFor = (path: string) => ({
  lockPath: `${path}.lock`,
  checkout: path,
  signal: undefined,
  pollMilliseconds: lockPollMilliseconds,
  onWaiting: () => undefined,
  cancelled: () => new Error(`Waiting for the inbox lock of ${path} was cancelled.`),
});

// A connect that succeeds proves an owner, even one whose handler hangs.
const probe = (path: string): Promise<ProbeResult> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);

    const timer = setTimeout(() => {
      socket.destroy();

      reject(
        new Error(
          `Inbox socket ${path} did not answer a connect within ${String(probeMilliseconds)} ms.`,
        ),
      );
    }, probeMilliseconds);

    const settle = (): void => {
      clearTimeout(timer);
      socket.destroy();
    };

    socket.once('connect', () => {
      settle();
      resolve('live');
    });

    socket.once('error', (error) => {
      settle();

      if (hasErrorCode(error, 'ECONNREFUSED')) {
        resolve('refused');
      } else if (isMissingFile(error)) {
        resolve('missing');
      } else {
        reject(error);
      }
    });
  });

const listen = (server: Server, path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once('error', onError);

    server.listen(path, () => {
      server.off('error', onError);
      resolve();
    });
  });

const unlinkIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
};

// Binds first. Only a refused connect proves a dead owner, so only then is the file removed.
const bind = async (server: Server, path: string): Promise<void> => {
  try {
    await listen(server, path);

    return;
  } catch (error) {
    if (!hasErrorCode(error, 'EADDRINUSE')) {
      throw error;
    }
  }

  const state = await probe(path);

  if (state === 'live') {
    throw new LiveOwnerError(path);
  }

  if (state === 'refused') {
    await unlinkIfPresent(path);
  }

  await listen(server, path);
};

const readRequest = (socket: Socket, respond: Respond): Promise<void> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;

    const finish = (reply: (() => Promise<string>) | undefined): void => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      if (reply === undefined) {
        socket.destroy();
        resolve();

        return;
      }

      void reply()
        .then((line) => {
          socket.end(line);
        })
        .catch(() => {
          socket.destroy();
        })
        .finally(resolve);
    };

    const timer = setTimeout(() => {
      finish(undefined);
    }, readMilliseconds);

    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size > requestByteLimit) {
        socket.pause();
        finish(() => Promise.resolve(encodeFrame(refusedReply(oversizedReason(requestByteLimit)))));

        return;
      }

      chunks.push(chunk);
    });

    socket.once('end', () => {
      finish(() => respond(Buffer.concat(chunks)));
    });

    socket.once('error', () => {
      finish(undefined);
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

// Node unlinks the bound path on close; the unlink after it covers runtimes that leave the file.
// `closed` settles once open connections end.
const stopListening = async (server: Server, path: string): Promise<{ closed: Promise<void> }> => {
  const closed = closeServer(server);

  await unlinkIfPresent(path);

  return { closed };
};

const settleWithin = async (work: Promise<unknown>, milliseconds: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });

  await Promise.race([work, deadline]);
  clearTimeout(timer);
};

export const openEndpoint = async (options: EndpointOptions): Promise<Endpoint> => {
  const { path, respond } = options;
  // The sender half-closes after its request, and the reply still has to go out.
  const server = createServer({ allowHalfOpen: true });
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));

    const request = readRequest(socket, respond);

    pending.add(request);

    const forget = (): void => {
      pending.delete(request);
    };

    void request.then(forget, forget);
  });

  await withFileLock(lockFor(path), () => bind(server, path));

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    const { closed } = await withFileLock(lockFor(path), () => stopListening(server, path));

    await settleWithin(Promise.allSettled(pending), drainMilliseconds);

    for (const socket of sockets) {
      socket.destroy();
    }

    await closed;
  };

  return {
    path,
    close: () => {
      closing ??= close();

      return closing;
    },
  };
};
