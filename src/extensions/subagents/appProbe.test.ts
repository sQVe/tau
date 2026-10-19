import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it, onTestFinished as afterTest } from 'vitest';

import { appAnswers } from './appProbe.js';

const serve = async (listener: RequestListener): Promise<string> => {
  const server = createServer(listener);

  afterTest(async () => {
    server.closeAllConnections();

    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return `http://127.0.0.1:${port}/`;
};

it('counts an answer without a body as up', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(204).end();
  });

  await expect(appAnswers(url, undefined)).resolves.toBe(true);
});

it('counts a redirect to an unreachable address as up', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
  });

  await expect(appAnswers(url, undefined)).resolves.toBe(true);
});

it('stops waiting for a silent app when the caller aborts', async () => {
  const url = await serve(() => undefined);
  const controller = new AbortController();
  const probe = appAnswers(url, controller.signal);

  controller.abort();

  await expect(probe).rejects.toThrow('abort');
});
