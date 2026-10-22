import { createServer } from 'node:net';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import * as cancellation from '../cancellation.js';
import { herdrClient, isHerdrError, RequestNotSentError, socketRequest } from './inspect.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// A herdr stand-in that answers each request line with `reply`, never answers, or hangs up.
const herdrSocket = async (
  reply?: ((request: Record<string, unknown>) => unknown) | 'hang up',
  onConnectionClosed?: () => void,
  onRequest?: () => void,
) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-socket-');
  const path = join(directory, 'herdr.sock');

  const server = createServer((socket) => {
    socket.setEncoding('utf8');

    if (onConnectionClosed) {
      socket.on('close', onConnectionClosed);
    }

    socket.on('data', (line: string) => {
      onRequest?.();

      if (reply === 'hang up') {
        socket.end();
      } else if (reply) {
        socket.write(`${JSON.stringify(reply(JSON.parse(line) as Record<string, unknown>))}\n`);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  return path;
};

const request = ['layout', 'apply', JSON.stringify({ root: { type: 'pane' } })];

it('sends layout apply over the socket and returns the response line', async () => {
  const path = await herdrSocket(({ method, params }) => ({ result: { method, params } }));

  expect(JSON.parse(await socketRequest(path, request, 1000))).toEqual({
    result: { method: 'layout.apply', params: { root: { type: 'pane' } } },
  });
});

it('reports a herdr error with its structured code', async () => {
  const path = await herdrSocket(() => ({ error: { code: 'workspace_not_found' } }));

  const failure = socketRequest(path, request, 1000);

  await expect(failure).rejects.toSatisfy((error) => isHerdrError(error, 'workspace_not_found'));
});

it('fails when herdr does not answer within the budget', async () => {
  const path = await herdrSocket();

  await expect(socketRequest(path, request, 50)).rejects.toThrow('budget expired');
});

it('reports a request that never reached herdr as not sent', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-socket-');

  await expect(socketRequest(join(directory, 'missing.sock'), request, 1000)).rejects.toThrow(
    RequestNotSentError,
  );
});

it('fails at once when herdr hangs up without a response', async () => {
  const path = await herdrSocket('hang up');
  const started = performance.now();

  await expect(socketRequest(path, request, 5000)).rejects.toThrow('without a response');
  expect(performance.now() - started).toBeLessThan(1000);
});

it('closes its connection once herdr has answered', async () => {
  const closed = Promise.withResolvers<undefined>();

  const path = await herdrSocket(
    () => ({ result: {} }),
    () => {
      closed.resolve(undefined);
    },
  );

  await socketRequest(path, request, 1000);

  await closed.promise;

  await expect(closed.promise).resolves.toBeUndefined();
});

it('stops waiting for an answer when the caller aborts', async () => {
  const abort = new AbortController();

  // The caller aborts only after herdr has received the request.
  const path = await herdrSocket(undefined, undefined, () => {
    abort.abort();
  });

  await expect(socketRequest(path, request, 5000, abort.signal)).rejects.toThrow('aborted');
});

it('reports a request aborted before it connected as not sent', async () => {
  const path = await herdrSocket(() => ({ result: {} }));
  const abort = new AbortController();

  abort.abort();

  await expect(socketRequest(path, request, 1000, abort.signal)).rejects.toThrow(
    RequestNotSentError,
  );
});

it('sends a layout request over the socket named by the environment', async () => {
  const path = await herdrSocket(({ method }) => ({ result: { method } }));
  const runClient = vi.spyOn(cancellation, 'runClient');

  vi.stubEnv('HERDR_SOCKET_PATH', path);

  const response = await herdrClient(request, 1000);

  expect(JSON.parse(response)).toEqual({ result: { method: 'layout.apply' } });
  expect(runClient).not.toHaveBeenCalled();
});

it('sends any other request to the herdr command with the caller signal', async () => {
  const runClient = vi.spyOn(cancellation, 'runClient').mockResolvedValue('{}');
  const signal = new AbortController().signal;

  await herdrClient(['pane', 'list'], 1000, signal);
  await herdrClient(['pane', 'list'], 1000);

  expect(runClient.mock.calls.map((call) => [call[0], call[1], call[2], call[3]?.signal])).toEqual([
    ['herdr', ['pane', 'list'], 1000, signal],
    ['herdr', ['pane', 'list'], 1000, undefined],
  ]);
});
