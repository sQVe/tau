import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import compactionExtension from './index.js';

const createHarness = (onTestFinished: TestContext['onTestFinished']) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_WORKER_RECORD', '');

  const fake = fakeExtensionApi();
  const notify = vi.fn<(message: string, level?: string) => void>();
  const compact = vi.fn<() => void>();
  let tokens: number | null = 0;

  const context = {
    hasUI: true,
    ui: { notify },
    compact,
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: null }),
  } as unknown as ExtensionContext;

  compactionExtension(fake.pi);

  const emit = async (name: string) => {
    await fake.handler(name)({}, context);
  };

  const settleAt = async (contextTokens: number | null) => {
    tokens = contextTokens;
    await emit('agent_settled');
  };

  return { fake, notify, compact, emit, settleAt };
};

it('reminds once when the context passes the threshold and again after a compaction', async ({
  onTestFinished,
}) => {
  const harness = createHarness(onTestFinished);

  await harness.emit('session_start');
  await harness.settleAt(190_000);

  expect(harness.notify).not.toHaveBeenCalled();

  await harness.settleAt(220_000);
  await harness.settleAt(230_000);

  expect(harness.notify).toHaveBeenCalledTimes(1);

  await harness.emit('session_compact');
  await harness.settleAt(null);
  await harness.settleAt(210_000);

  expect(harness.notify).toHaveBeenCalledTimes(2);
  expect(harness.compact).not.toHaveBeenCalled();
  expect(harness.fake.sendMessage).not.toHaveBeenCalled();
  expect(harness.fake.sendUserMessage).not.toHaveBeenCalled();
});

it('registers nothing in a worker', ({ onTestFinished }) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  vi.stubEnv('TAU_WORKER_RECORD', '/fixture/worker');
  const fake = fakeExtensionApi();

  compactionExtension(fake.pi);

  expect(fake.handlers.size).toBe(0);
});
