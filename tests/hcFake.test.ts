import { expect, it } from 'vitest';

import { createHcFake } from './hcFake.js';

const helloLine = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: {} })}\n`;
const runLine = `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'terminal.run', params: {} })}\n`;

it('answers the configured connect requests', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, { generation: 1 });
  fake.replyConnect('terminal.run', 2, { address: 't7' });

  const result = await fake.connect([helloLine, runLine]);

  expect(result).toMatchObject({ code: 0, signal: null });
  expect(result.stdout.split('\n').filter((line) => line !== '')).toHaveLength(2);
});

it('refuses a connect call with no setup', async () => {
  const fake = createHcFake();

  await expect(fake.connect([helloLine, runLine])).rejects.toThrow(
    'unexpected connect request: hello',
  );
});

it('refuses a request that does not match the setup', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, {});

  await expect(fake.connect([runLine])).rejects.toThrow('unexpected connect request: terminal.run');
});

it('refuses an extra request', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, {});

  await expect(fake.connect([helloLine, runLine])).rejects.toThrow(
    'unexpected connect request: terminal.run',
  );
});

it('refuses a repeated connect call after the setup is consumed', async () => {
  const fake = createHcFake();

  fake.replyConnect('hello', 1, {});
  fake.replyConnect('terminal.run', 2, {});

  await fake.connect([helloLine, runLine]);

  await expect(fake.connect([helloLine, runLine])).rejects.toThrow(
    'unexpected connect request: hello',
  );
});
