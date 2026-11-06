import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { LiveOwnerError, ensurePrivateDirectory, openEndpoint, socketPathFor } from './endpoint.js';
import type { Endpoint } from './endpoint.js';

let root = '';
const endpoints: Endpoint[] = [];

// Unix socket paths have a short byte limit, so tests use a short root under /tmp.
beforeEach(() => {
  root = mkdtempSync('/tmp/tau-endpoint-');
  chmodSync(root, 0o700);
});

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  rmSync(root, { recursive: true, force: true });
});

const open = async (path: string, reply = 'first'): Promise<Endpoint> => {
  const endpoint = await openEndpoint({
    path,
    respond: () => Promise.resolve(`${reply}\n`),
  });

  endpoints.push(endpoint);

  return endpoint;
};

const exchange = (path: string, chunks: readonly (string | Buffer)[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let reply = '';

    socket.setEncoding('utf8');

    socket.once('connect', () => {
      for (const chunk of chunks) {
        socket.write(chunk);
      }

      socket.end();
    });

    socket.on('data', (chunk: string) => {
      reply += chunk;
    });

    socket.once('close', () => {
      resolve(reply);
    });

    socket.once('error', reject);
  });

const listenerScript =
  "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))";

// A killed owner leaves its socket file behind, and a connect to it is refused.
const leaveStaleSocket = async (path: string): Promise<void> => {
  const child = spawn(process.execPath, ['-e', listenerScript, path], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  await new Promise<void>((resolve) => {
    child.stdout.once('data', () => {
      resolve();
    });
  });

  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });

  child.kill('SIGKILL');
  await exited;
};

it('refuses a second owner and keeps the first answering', async () => {
  const path = socketPathFor(root, randomUUID());

  await open(path, 'first');

  await expect(open(path, 'second')).rejects.toBeInstanceOf(LiveOwnerError);
  await expect(exchange(path, ['{}\n'])).resolves.toBe('first\n');
});

it('replaces a socket file that a killed process left behind', async () => {
  const path = socketPathFor(root, randomUUID());

  await leaveStaleSocket(path);
  expect(existsSync(path)).toBe(true);

  await open(path, 'replacement');

  await expect(exchange(path, ['{}\n'])).resolves.toBe('replacement\n');
});

it('lets one of two simultaneous reclaimers own a stale path', async () => {
  const path = socketPathFor(root, randomUUID());

  await leaveStaleSocket(path);

  const results = await Promise.allSettled([open(path, 'a'), open(path, 'b')]);
  const opened = results.filter((result) => result.status === 'fulfilled');
  const refused = results.filter((result) => result.status === 'rejected');

  expect(opened).toHaveLength(1);
  expect(refused.map((result): unknown => result.reason)).toEqual([expect.any(LiveOwnerError)]);

  const reply = await exchange(path, ['{}\n']);

  expect(['a\n', 'b\n']).toContain(reply);
});

it('binds a missing path', async () => {
  const path = socketPathFor(root, randomUUID());

  await open(path, 'fresh');

  await expect(exchange(path, ['{}\n'])).resolves.toBe('fresh\n');
});

it('removes its own socket file on close', async () => {
  const path = socketPathFor(root, randomUUID());
  const endpoint = await open(path);

  await endpoint.close();

  expect(existsSync(path)).toBe(false);
});

it('passes a frame split across writes to the responder as one request', async () => {
  const path = socketPathFor(root, randomUUID());
  const received: string[] = [];

  endpoints.push(
    await openEndpoint({
      path,
      respond: (request) => {
        received.push(request.toString('utf8'));

        return Promise.resolve('ok\n');
      },
    }),
  );

  await exchange(path, ['{"proto', 'col":"rpc1",', '"kind":"hello"}\n']);

  expect(received).toEqual(['{"protocol":"rpc1","kind":"hello"}\n']);
});

it('refuses an oversized request before the responder runs', async () => {
  const path = socketPathFor(root, randomUUID());
  const received: string[] = [];

  endpoints.push(
    await openEndpoint({
      path,
      respond: (request) => {
        received.push(request.toString('utf8'));

        return Promise.resolve('ok\n');
      },
    }),
  );

  const reply = await exchange(path, [Buffer.alloc(102_401, 'a')]);

  expect(received).toEqual([]);

  expect(JSON.parse(reply)).toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'The frame is larger than 102400 bytes.',
  });
});

it('waits for an accepted request to finish before close completes', async () => {
  const path = socketPathFor(root, randomUUID());
  const responding = Promise.withResolvers<string>();
  const started = Promise.withResolvers<undefined>();

  const endpoint = await openEndpoint({
    path,
    respond: () => {
      started.resolve(undefined);

      return responding.promise;
    },
  });

  const reply = exchange(path, ['{}\n']);

  await started.promise;

  let closed = false;

  const closing = endpoint.close().then(() => {
    closed = true;

    return closed;
  });

  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  expect(closed).toBe(false);

  responding.resolve('done\n');
  await closing;

  await expect(reply).resolves.toBe('done\n');
});

it('builds a socket path from a session UUID', () => {
  const sessionId = randomUUID();

  expect(socketPathFor('/tmp/tau-1000', sessionId)).toBe(`/tmp/tau-1000/${sessionId}.sock`);
});

it('refuses a session identifier that is not a UUID', () => {
  expect(() => socketPathFor(root, '../escape')).toThrow(
    'Session "../escape" is not a UUID, so it cannot name an inbox socket.',
  );
});

it('refuses a socket path of 104 bytes or more', () => {
  const directory = `/tmp/${'d'.repeat(57)}`;
  const sessionId = randomUUID();

  expect(Buffer.byteLength(`${directory}/${sessionId}.sock`)).toBe(104);

  expect(() => socketPathFor(directory, sessionId)).toThrow(
    `Inbox socket path ${directory}/${sessionId}.sock is 104 bytes; the limit is 103.`,
  );

  expect(socketPathFor(directory.slice(0, -1), sessionId)).toHaveLength(103);
});

it('creates a missing socket directory with mode 700', () => {
  const directory = join(root, 'sockets');

  ensurePrivateDirectory(directory);

  expect(() => {
    ensurePrivateDirectory(directory);
  }).not.toThrow();
});

it('refuses a socket directory other users can read', () => {
  const directory = join(root, 'shared');

  mkdirSync(directory, { mode: 0o755 });
  chmodSync(directory, 0o755);

  expect(() => {
    ensurePrivateDirectory(directory);
  }).toThrow(`Inbox directory ${directory} has mode 755; it must be 700.`);
});

it('refuses a socket directory that is a symbolic link', () => {
  const target = join(root, 'target');
  const directory = join(root, 'link');

  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, directory);

  expect(() => {
    ensurePrivateDirectory(directory);
  }).toThrow(`Inbox directory ${directory} is not a directory.`);
});
