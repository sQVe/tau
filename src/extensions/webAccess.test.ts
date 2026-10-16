import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxProvider } from '@earendil-works/pi-ai';
import type { ExtensionContext, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import webAccessExtension from './webAccess.js';

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

const startSession = (worker: string, toolNames: string[] = []) => {
  vi.stubEnv('TAU_WORKER_RECORD', worker);

  const fake = fakeExtensionApi({
    getAllTools: () => toolNames.map((name) => ({ name })) as never,
  });

  webAccessExtension(fake.pi);

  return () => {
    for (const handler of fake.handlers.get('session_start') ?? []) {
      handler(undefined as never, {} as ExtensionContext);
    }
  };
};

afterEach(() => vi.unstubAllEnvs());

it('names a missing bundled tool in a parent session but leaves worker tools to the profile', () => {
  expect(startSession('')).toThrow('"web_search", "fetch_content" are not registered');
  expect(startSession('/records/task')).not.toThrow();
});

it('accepts a parent session that registers both web tools and names only the missing one', () => {
  expect(startSession('', ['web_search', 'fetch_content', 'read'])).not.toThrow();
  expect(startSession('', ['web_search'])).toThrow('Tool "fetch_content" is not registered');
  expect(startSession('', ['fetch_content'])).toThrow('Tool "web_search" is not registered');
});

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

it('lets a native answerModel through when a router lists the same ID', () => {
  const app = setup();

  const routed = fauxProvider({
    provider: 'router',
    models: [{ id: 'custom/model' }],
  }).getModel();

  const native = fauxProvider({ provider: 'custom', models: [{ id: 'model' }] }).getModel();
  app.getAvailable.mockReturnValue([routed, native]);

  expect(app.emit({ mode: 'answer', answerModel: ' custom/model ' })).toStrictEqual({
    mode: 'answer',
    answerModel: 'custom/model',
  });
});

it('blocks a routed answerModel when the native model is unavailable, whatever else is listed', () => {
  const app = setup();

  const models = [
    fauxProvider({ provider: 'custom', models: [{ id: 'unrelated' }] }).getModel(),
    fauxProvider({ provider: 'elsewhere', models: [{ id: 'model' }] }).getModel(),
    fauxProvider({ provider: 'router', models: [{ id: 'custom/model' }] }).getModel(),
  ];

  app.getAvailable.mockReturnValue(models);

  expect(() => app.emit({ mode: 'answer', answerModel: 'custom/model' })).toThrow('not available');
});

it('lets a native answerModel through when the availability snapshot lacks it and no router lists it', () => {
  const app = setup();
  const other = fauxProvider({ provider: 'test-provider', models: [{ id: 'other' }] }).getModel();
  app.getAvailable.mockReturnValue([other]);

  expect(app.emit({ mode: 'answer', answerModel: 'custom/model' })).toStrictEqual({
    mode: 'answer',
    answerModel: 'custom/model',
  });
});
