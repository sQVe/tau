import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { setup } from './fixtures/workerExtensionHarness.js';

type Fixture = ReturnType<typeof setup>;

const dispatchAll = async (
  { pi, context }: Fixture,
  name: string,
  event: unknown,
): Promise<void> => {
  for (const handler of pi.handlers.get(name) ?? []) {
    await handler(event as never, context);
  }
};

it.for([
  { language: 'TypeScript', path: 'source.ts', customType: 'tau-typescript-rules' },
  { language: 'Rust', path: 'src/lib.rs', customType: 'tau-rust-rules' },
])('loads $language rules from the worker entry point on first touch', async (fixture) => {
  const worker = setup();
  const { pi } = worker;
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();

  pi.pi.appendEntry = appendEntry;
  await dispatchAll(worker, 'session_start', { reason: 'startup' });
  await dispatchAll(worker, 'context', { messages: [] });

  await dispatchAll(worker, 'tool_call', {
    toolName: 'read',
    input: { path: fixture.path },
  });

  expect(appendEntry).toHaveBeenCalledExactlyOnceWith(fixture.customType, { version: 1 });

  expect(pi.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ customType: fixture.customType }),
    { deliverAs: 'steer' },
  );
});
