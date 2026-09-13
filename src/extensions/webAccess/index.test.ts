import type { ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import webAccessExtension from './index.js';

it('sets the delegate only for answer fetches without an explicit answerModel', () => {
  vi.stubEnv('TAU_BULK_READ_MODEL', 'test-provider/delegate');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const handlers = new Map<string, (event: ToolCallEvent) => void>();

  webAccessExtension({
    on: (name: string, handler: (event: ToolCallEvent) => void) => handlers.set(name, handler),
  } as unknown as ExtensionAPI);

  const cases = [
    { toolName: 'fetch_content', input: { mode: 'answer' }, answerModel: 'test-provider/delegate' },
    { toolName: 'fetch_content', input: { mode: 'answer', answerModel: 'custom/model' } },
    {
      toolName: 'fetch_content',
      input: { mode: 'answer', answerModel: '' },
      answerModel: 'test-provider/delegate',
    },
    {
      toolName: 'fetch_content',
      input: { mode: 'answer', answerModel: '  ' },
      answerModel: 'test-provider/delegate',
    },
    { toolName: 'fetch_content', input: { mode: 'readable' } },
    { toolName: 'fetch_content', input: { mode: 'raw' } },
    { toolName: 'fetch_content', input: {} },
    { toolName: 'web_search', input: { mode: 'answer' } },
  ];

  for (const { toolName, input, answerModel } of cases) {
    const event: ToolCallEvent = { type: 'tool_call', toolCallId: 'fetch', toolName, input };
    const expected = { ...input, ...(answerModel === undefined ? {} : { answerModel }) };

    handlers.get('tool_call')?.(event);

    expect(event.input).toStrictEqual(expected);
  }
});
