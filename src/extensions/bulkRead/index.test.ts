import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import bulkReadExtension, {
  BULK_READ_LINE_THRESHOLD,
  delegateReference,
  isHardFailure,
  rewriteContinuationNotice,
} from './index.js';

type ToolResultEventResult = Partial<Pick<ToolResultEvent, 'content' | 'isError'>>;

const setup = () => {
  const handlers = new Map<
    string,
    (event: unknown, context: ExtensionContext) => ToolResultEventResult | undefined
  >();
  const registerTool = vi.fn<(tool: ToolDefinition) => void>();
  const find = vi
    .fn<ExtensionContext['modelRegistry']['find']>()
    .mockReturnValue(fauxProvider().getModel());
  const complete = vi
    .fn<ExtensionContext['modelRegistry']['complete']>()
    .mockResolvedValue(fauxAssistantMessage('answer'));
  const context = { cwd: '/tmp', modelRegistry: { find, complete } } as unknown as ExtensionContext;

  bulkReadExtension({
    on: (
      name: string,
      handler: (event: unknown, context: ExtensionContext) => ToolResultEventResult | undefined,
    ) => handlers.set(name, handler),
    registerTool,
  } as unknown as ExtensionAPI);

  const execute = () =>
    registerTool.mock.calls[0]![0].execute(
      'bulk',
      { paths: [import.meta.filename], question: 'Why?' },
      undefined,
      undefined,
      context,
    );
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, context);

  return { handlers, registerTool, find, complete, context, execute, emit };
};

afterEach(() => vi.unstubAllEnvs());

const readCall = (toolCallId = 'read', limit?: number) => ({
  type: 'tool_call',
  toolName: 'read',
  toolCallId,
  input: { path: 'file', ...(limit === undefined ? {} : { limit }) },
});

const notice = '[Showing lines 1-400 of 450. Use offset=401 to continue.]';
const hint =
  'File continues past line 400. For a question about this file call bulk_read with paths and question. To edit, read again with offset and limit.';

it('clamps a read without limit to the threshold and leaves an explicit limit untouched', () => {
  const app = setup();
  const unbounded = readCall();
  const bounded = readCall('bounded', 600);

  expect(app.emit('tool_call', unbounded)).toBeUndefined();
  app.emit('tool_call', bounded);

  expect(unbounded.input).toHaveProperty('limit', BULK_READ_LINE_THRESHOLD);
  expect(bounded.input.limit).toBe(600);
  expect(app.find).toHaveBeenCalledOnce();
});

it('rewrites the trailing continuation notice of a clamped read into the hint', () => {
  const app = setup();
  app.emit('tool_call', readCall());
  const image = { type: 'image', data: 'image', mimeType: 'image/png' };
  const event = {
    toolCallId: 'read',
    content: [{ type: 'text', text: 'first' }, { type: 'text', text: `head\n\n${notice}` }, image],
  };

  expect(app.emit('tool_result', event)).toEqual({
    content: [{ type: 'text', text: 'first' }, { type: 'text', text: `head\n\n${hint}` }, image],
  });
  expect(app.emit('tool_result', event)).toBeUndefined();
});

it('rewrites the 50KB notice form as well', () => {
  expect(
    rewriteContinuationNotice(
      'head\n\n[Showing lines 1-100 of 450 (50.0KB limit). Use offset=101 to continue.]',
    ),
  ).toBe(`head\n\n${hint}`);
  expect(rewriteContinuationNotice('small file')).toBeUndefined();
  expect(rewriteContinuationNotice(`${notice}\nmore text`)).toBeUndefined();
});

it('leaves an unclamped read result and other tool results untouched', () => {
  const app = setup();
  app.emit('tool_call', readCall('bounded', 20));
  const bash = { ...readCall('bash'), toolName: 'bash' };
  app.emit('tool_call', bash);

  expect(bash.input).not.toHaveProperty('limit');
  expect(
    app.emit('tool_result', { toolCallId: 'bounded', content: [{ type: 'text', text: notice }] }),
  ).toBeUndefined();
  expect(
    app.emit('tool_result', { toolCallId: 'bash', content: [{ type: 'text', text: notice }] }),
  ).toBeUndefined();
  app.emit('tool_call', readCall());
  expect(
    app.emit('tool_result', { toolCallId: 'read', content: [{ type: 'text', text: 'small' }] }),
  ).toBeUndefined();
});

it('documents the extra notice for a threshold-length file with a trailing newline', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-read-boundary-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const content = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n');
  const tool = createReadTool(cwd);
  await writeFile(join(cwd, 'file'), content);

  const exact = await tool.execute('exact', { path: 'file', limit: 400 });
  expect(exact.content).toEqual([{ type: 'text', text: content }]);

  await writeFile(join(cwd, 'file'), `${content}\n`);
  const trailing = await tool.execute('trailing', { path: 'file', limit: 400 });
  expect(trailing.content).toEqual([
    {
      type: 'text',
      text: `${content}\n\n[1 more lines in file. Use offset=401 to continue.]`,
    },
  ]);
});

it('turns trimming off after a registry miss at the first clamp', () => {
  const app = setup();
  app.find.mockReturnValueOnce(undefined);
  const first = readCall();
  const second = readCall('second');

  app.emit('tool_call', first);
  app.emit('tool_call', second);

  expect(first.input).not.toHaveProperty('limit');
  expect(second.input).not.toHaveProperty('limit');
  expect(app.find).toHaveBeenCalledOnce();
});

it('leaves reads untouched when trimming is off', async () => {
  const app = setup();
  app.find.mockReturnValueOnce(undefined);
  await app.execute();
  const read = readCall();

  app.emit('tool_call', read);

  expect(read.input).not.toHaveProperty('limit');
});

it.each(['error', 'aborted', 'length', 'throw', 'timeout'] as const)(
  'turns trimming off only for hard delegate failures: %s',
  async (reason) => {
    const app = setup();
    if (reason === 'throw') {
      app.complete.mockRejectedValue(new Error('denied'));
    } else if (reason === 'timeout') {
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
      onTestFinished(() => {
        timeout.mockRestore();
      });
      app.complete.mockRejectedValue(new Error('cancelled'));
    } else {
      app.complete.mockResolvedValue({ ...fauxAssistantMessage(''), stopReason: reason });
    }

    const result = await app.execute();
    const read = readCall();
    app.emit('tool_call', read);

    const hard = reason === 'error' || reason === 'throw';
    expect(isHardFailure(result)).toBe(hard);
    expect(read.input.limit).toBe(hard ? undefined : 400);
    expect(
      app.emit('tool_result', {
        toolName: 'bulk_read',
        toolCallId: 'bulk',
        details: result.details,
        content: result.content,
      }),
    ).toEqual({ isError: true });
  },
);

it('classifies errors without treating file errors as delegate failures', () => {
  expect(isHardFailure(new Error('denied'))).toBe(true);
  expect(isHardFailure(new DOMException('cancelled', 'AbortError'))).toBe(false);
  expect(isHardFailure(new DOMException('timeout', 'TimeoutError'))).toBe(false);
  expect(isHardFailure({ content: [], details: {} })).toBe(false);
});

it.each(['', 'invalid', '/reader', 'provider/'])(
  'rejects an invalid reference without a registry lookup: %s',
  async (reference) => {
    vi.stubEnv('TAU_BULK_READ_MODEL', reference);
    const app = setup();

    expect(await app.execute()).toMatchObject({ isError: true });
    expect(app.find).not.toHaveBeenCalled();
  },
);

it('registers the tool with a prompt snippet and both read hooks', () => {
  const app = setup();

  expect(app.registerTool).toHaveBeenCalledOnce();
  expect(app.registerTool.mock.calls[0]![0]).toMatchObject({
    name: 'bulk_read',
    description:
      'Ask a cheaper model a question about one or more large files instead of reading them.',
    promptSnippet:
      'Ask a cheaper model a question about one or more large files instead of reading them.',
  });
  expect([...app.handlers.keys()]).toEqual(['tool_call', 'tool_result']);
});

it('reads the reference from the environment and falls back to the default', () => {
  vi.stubEnv('TAU_BULK_READ_MODEL', undefined);

  expect(delegateReference()).toBe('openai-codex/gpt-5.6-luna');

  vi.stubEnv('TAU_BULK_READ_MODEL', 'openrouter/vendor/model');

  expect(delegateReference()).toBe('openrouter/vendor/model');
});

it('splits the reference at the first slash and passes the rest as the model id', async () => {
  vi.stubEnv('TAU_BULK_READ_MODEL', 'openrouter/vendor/model');
  const app = setup();

  await app.execute();

  expect(app.find).toHaveBeenCalledWith('openrouter', 'vendor/model');
});

it('execute returns an error result naming the reference when find returns undefined', async () => {
  vi.stubEnv('TAU_BULK_READ_MODEL', 'missing/reader');
  const app = setup();
  app.find.mockReturnValue(undefined);

  const result = await app.execute();

  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('missing/reader') as unknown }],
  });
  expect(result.content).toEqual([
    { type: 'text', text: expect.stringContaining('pi --list-models') as unknown },
  ]);
});
