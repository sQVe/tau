import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { dispatch, setup } from './fixtures/workerExtensionHarness.js';

it('loads TypeScript rules from the worker entry point on first touch', () => {
  const { pi, context } = setup();
  const appendEntry = vi.fn<ExtensionAPI['appendEntry']>();

  pi.pi.appendEntry = appendEntry;
  dispatch(pi, 'context', { messages: [] }, context);
  dispatch(pi, 'tool_call', { toolName: 'read', input: { path: 'source.ts' } }, context);

  expect(appendEntry).toHaveBeenCalledExactlyOnceWith('tau-typescript-rules', { version: 1 });

  expect(pi.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ customType: 'tau-typescript-rules' }),
    { deliverAs: 'steer' },
  );
});
