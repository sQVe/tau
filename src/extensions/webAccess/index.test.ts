import { fauxProvider } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import webAccessExtension from './index.js';

const setup = () => {
  const delegate = fauxProvider({
    provider: 'test-provider',
    models: [{ id: 'delegate' }],
  }).getModel();
  const override = fauxProvider({ provider: 'custom', models: [{ id: 'model' }] }).getModel();
  const available = [delegate, override];
  const find = vi.fn<ExtensionContext['modelRegistry']['find']>((provider, id) =>
    available.find((model) => model.provider === provider && model.id === id),
  );
  const getAvailable = vi.fn<ExtensionContext['modelRegistry']['getAvailable']>(() => available);
  const context = { modelRegistry: { find, getAvailable } } as unknown as ExtensionContext;
  const handlers = new Map<string, (event: ToolCallEvent, context: ExtensionContext) => void>();

  webAccessExtension({
    on: (name: string, handler: (event: ToolCallEvent, context: ExtensionContext) => void) =>
      handlers.set(name, handler),
  } as unknown as ExtensionAPI);

  const emit = (input: Record<string, unknown>, toolName = 'fetch_content') => {
    const event: ToolCallEvent = { type: 'tool_call', toolCallId: 'fetch', toolName, input };
    handlers.get('tool_call')?.(event, context);

    return event.input;
  };

  return { emit, find, getAvailable };
};

afterEach(() => vi.unstubAllEnvs());

it('sets the delegate only for answer fetches without an explicit answerModel', () => {
  vi.stubEnv('TAU_DELEGATE_MODEL', 'test-provider/delegate');
  const app = setup();
  const cases = [
    { toolName: 'fetch_content', input: { mode: 'answer' }, answerModel: 'test-provider/delegate' },
    { toolName: 'fetch_content', input: { mode: 'answer', answerModel: 'custom/model' } },
    {
      toolName: 'fetch_content',
      input: { mode: 'answer', answerModel: ' custom/model ' },
      answerModel: 'custom/model',
    },
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
    const expected = { ...input, ...(answerModel === undefined ? {} : { answerModel }) };

    expect(app.emit(input, toolName)).toStrictEqual(expected);
  }
});

it('uses an explicit web override even when the shared configuration is invalid', () => {
  vi.stubEnv('TAU_DELEGATE_MODEL', 'invalid');
  const app = setup();

  expect(app.emit({ mode: 'answer', answerModel: 'custom/model' })).toEqual({
    mode: 'answer',
    answerModel: 'custom/model',
  });
});

it.each(['invalid', 'missing/model'])(
  'rejects invalid or missing web delegates: %s',
  (reference) => {
    vi.stubEnv('TAU_DELEGATE_MODEL', reference);
    const app = setup();

    expect(() => app.emit({ mode: 'answer' })).toThrow(
      reference === 'invalid' ? 'Invalid delegate model' : 'model not found',
    );
    expect(app.emit({ mode: 'raw' })).toEqual({ mode: 'raw' });
  },
);

it('blocks unavailable web delegates instead of letting the package route to another provider', () => {
  vi.stubEnv('TAU_DELEGATE_MODEL', 'test-provider/delegate');
  const app = setup();
  const routed = fauxProvider({
    provider: 'router',
    models: [{ id: 'test-provider/delegate' }],
  }).getModel();
  app.getAvailable.mockReturnValue([routed]);

  expect(() => app.emit({ mode: 'answer' })).toThrow('not available');
});
