import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { terminalTypingReason } from './guard.js';
import inboxExtension from './inbox.js';

const context = {
  ui: { notify: () => undefined },
  sessionManager: { getSessionId: () => 'session-1', getEntries: () => [] },
} as unknown as ExtensionContext;

const bashEvent = (command: string): ToolCallEvent => ({
  type: 'tool_call',
  toolCallId: 'tool-call-1',
  toolName: 'bash',
  input: { command },
});

const start = async (fake: ReturnType<typeof fakeExtensionApi>): Promise<void> => {
  for (const handler of fake.handlers.get('session_start') ?? []) {
    await handler({ type: 'session_start', reason: 'startup' } as never, context);
  }
};

const shutdown = async (fake: ReturnType<typeof fakeExtensionApi>): Promise<void> => {
  for (const handler of fake.handlers.get('session_shutdown') ?? []) {
    await handler({ type: 'session_shutdown', reason: 'reload' } as never, context);
  }
};

const blocksTerminalTyping = (fake: ReturnType<typeof fakeExtensionApi>): unknown =>
  fake.handler('tool_call')(bashEvent('hc send t1 hello'), context);

it('serves the inbox from the kept load when Pi discards an earlier load', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const discarded = fakeExtensionApi();
  const kept = fakeExtensionApi();

  onTestFinished(async () => {
    await shutdown(kept);
    await shutdown(discarded);
    vi.unstubAllEnvs();
  });

  inboxExtension(discarded.pi);
  inboxExtension(kept.pi);

  await start(kept);

  expect(blocksTerminalTyping(kept)).toMatchObject({ block: true, reason: terminalTypingReason });
});

it('serves one inbox when a process keeps two loads', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const first = fakeExtensionApi();
  const second = fakeExtensionApi();

  onTestFinished(async () => {
    await shutdown(first);
    await shutdown(second);
    vi.unstubAllEnvs();
  });

  inboxExtension(first.pi);
  inboxExtension(second.pi);

  await start(first);
  await start(second);

  const guards = [first, second].map((fake) => blocksTerminalTyping(fake));

  expect(guards.filter((result) => result !== undefined)).toHaveLength(1);

  await shutdown(second);

  expect(blocksTerminalTyping(first)).toMatchObject({ block: true });
});

it('claims again after a reload', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const first = fakeExtensionApi();
  const reloaded = fakeExtensionApi();

  onTestFinished(async () => {
    await shutdown(first);
    await shutdown(reloaded);
    vi.unstubAllEnvs();
  });

  inboxExtension(first.pi);
  await start(first);
  await shutdown(first);

  inboxExtension(reloaded.pi);
  await start(reloaded);

  expect(blocksTerminalTyping(reloaded)).toMatchObject({ block: true });
  expect(blocksTerminalTyping(first)).toBeUndefined();
});
