import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import compactionExtension from './index.js';

const createHarness = (onTestFinished: TestContext['onTestFinished'], config: unknown) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-compaction-reminder-'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  vi.stubEnv('TAU_WORKER_RECORD', '');
  writeFileSync(join(directory, 'tau.json'), JSON.stringify(config));

  const fake = fakeExtensionApi();
  const notify = vi.fn<(message: string, level?: string) => void>();
  const compact = vi.fn<() => void>();
  let tokens: number | null = 0;

  const context = {
    cwd: directory,
    isProjectTrusted: () => true,
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
  const harness = createHarness(onTestFinished, { compaction: { reminderTokens: 100_000 } });

  await harness.emit('session_start');
  await harness.settleAt(90_000);

  expect(harness.notify).not.toHaveBeenCalled();

  await harness.settleAt(120_000);
  await harness.settleAt(130_000);

  expect(harness.notify).toHaveBeenCalledTimes(1);
  expect(harness.notify.mock.calls[0]?.[0]).toContain('/compact');

  await harness.emit('session_compact');
  await harness.settleAt(null);
  await harness.settleAt(110_000);

  expect(harness.notify).toHaveBeenCalledTimes(2);
  expect(harness.compact).not.toHaveBeenCalled();
  expect(harness.fake.sendMessage).not.toHaveBeenCalled();
  expect(harness.fake.sendUserMessage).not.toHaveBeenCalled();
});

it('reminds again after the context drops below the threshold and passes it again', async ({
  onTestFinished,
}) => {
  const harness = createHarness(onTestFinished, { compaction: { reminderTokens: 100_000 } });

  await harness.emit('session_start');
  await harness.settleAt(120_000);
  await harness.settleAt(50_000);
  await harness.settleAt(120_000);

  expect(harness.notify).toHaveBeenCalledTimes(2);
});

it('refuses an invalid threshold at session start and shows no reminder', async ({
  onTestFinished,
}) => {
  const harness = createHarness(onTestFinished, { compaction: { reminderTokens: -1 } });

  await expect(harness.emit('session_start')).rejects.toThrow('tau.json');

  await harness.settleAt(500_000);

  expect(harness.notify).not.toHaveBeenCalled();
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
