import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import webAccessExtension from './index.js';

// The user file holds only the given config, whatever the developer's agent directory holds.
const setup = (config: unknown = {}) => {
  const agentDirectory = mkdtempSync(join(tmpdir(), 'tau-web-access-agent-'));

  onTestFinished(() => {
    rmSync(agentDirectory, { recursive: true, force: true });
  });

  writeFileSync(join(agentDirectory, 'tau.json'), JSON.stringify(config));
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const other = fauxProvider({ provider: 'test-provider', models: [{ id: 'other' }] }).getModel();
  const passed = fauxProvider({ provider: 'custom', models: [{ id: 'model' }] }).getModel();
  const available = [other, passed];

  const find = vi.fn<ExtensionContext['modelRegistry']['find']>((provider, id) =>
    available.find((model) => model.provider === provider && model.id === id),
  );

  const getAvailable = vi.fn<ExtensionContext['modelRegistry']['getAvailable']>(() => available);

  const context = {
    cwd: '/tmp',
    isProjectTrusted: () => false,
    modelRegistry: { find, getAvailable },
  } as unknown as ExtensionContext;

  const fake = fakeExtensionApi();

  webAccessExtension(fake.pi);

  const emit = (input: Record<string, unknown>, toolName = 'fetch_content') => {
    const event: ToolCallEvent = { type: 'tool_call', toolCallId: 'fetch', toolName, input };
    fake.handler('tool_call')(event, context);

    return event.input;
  };

  return { emit, find, getAvailable };
};

afterEach(() => vi.unstubAllEnvs());

it('leaves answer fetches without a passed answerModel untouched and trims a passed one', () => {
  const app = setup();

  const cases = [
    { toolName: 'fetch_content', input: { mode: 'answer' } },
    { toolName: 'fetch_content', input: { mode: 'answer', answerModel: '' } },
    { toolName: 'fetch_content', input: { mode: 'answer', answerModel: '  ' } },
    { toolName: 'fetch_content', input: { mode: 'answer', answerModel: 'custom/model' } },
    {
      toolName: 'fetch_content',
      input: { mode: 'answer', answerModel: ' custom/model ' },
      answerModel: 'custom/model',
    },
    { toolName: 'fetch_content', input: { mode: 'readable', answerModel: 'invalid' } },
    { toolName: 'fetch_content', input: {} },
    { toolName: 'web_search', input: { mode: 'answer', answerModel: 'invalid' } },
  ];

  for (const { toolName, input, answerModel } of cases) {
    const expected = { ...input, ...(answerModel === undefined ? {} : { answerModel }) };

    expect(app.emit({ ...input }, toolName)).toStrictEqual(expected);
  }

  expect(app.find).toHaveBeenCalledTimes(2);
});

it('refuses a passed answerModel outside allowedModels and leaves blank ones untouched', () => {
  const app = setup({ allowedModels: ['test-provider/other'] });
  const input = { mode: 'answer', answerModel: 'custom/model' };

  const refused = () => app.emit(input);
  expect(refused).toThrow('custom/model is not allowed');
  expect(input.answerModel).toBe('custom/model');

  expect(app.emit({ mode: 'answer', answerModel: '' })).toStrictEqual({
    mode: 'answer',
    answerModel: '',
  });

  expect(app.find).not.toHaveBeenCalled();
});

it.each(['invalid', 'missing/model'])(
  'rejects an invalid or unknown answerModel: %s',
  (reference) => {
    const app = setup();

    expect(() => app.emit({ mode: 'answer', answerModel: reference })).toThrow(
      reference === 'invalid' ? 'Invalid model' : 'not found',
    );

    expect(app.emit({ mode: 'raw' })).toEqual({ mode: 'raw' });
  },
);

it('blocks an unavailable answerModel instead of letting the package route to another provider', () => {
  const app = setup();

  const routed = fauxProvider({
    provider: 'router',
    models: [{ id: 'custom/model' }],
  }).getModel();

  app.getAvailable.mockReturnValue([routed]);

  expect(() => app.emit({ mode: 'answer', answerModel: 'custom/model' })).toThrow('not available');
});
