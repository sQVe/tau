import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { isHerdrError, RequestNotSentError, socketRequest } from './inspect.js';

// A herdr stand-in that answers each request line with `reply`, never answers, or hangs up.
const herdrSocket = async (reply?: ((request: Record<string, unknown>) => unknown) | 'hang up') => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-socket-'));
  const path = join(directory, 'herdr.sock');

  const server = createServer((socket) => {
    socket.setEncoding('utf8');

    socket.on('data', (line: string) => {
      if (reply === 'hang up') {
        socket.end();
      } else if (reply) {
        socket.write(`${JSON.stringify(reply(JSON.parse(line) as Record<string, unknown>))}\n`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(path, resolve));

  onTestFinished(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
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
  const directory = mkdtempSync(join(tmpdir(), 'tau-socket-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

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
