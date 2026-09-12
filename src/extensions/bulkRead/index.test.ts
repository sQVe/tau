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
  bulkReadLineThreshold,
  delegateReference,
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

  const execute = (signal?: AbortSignal, paths = [import.meta.filename]) =>
    registerTool.mock.calls[0]![0].execute(
      'bulk',
      { paths, question: 'Why?' },
      signal,
      undefined,
      context,
    );
  const emit = (name: string, event: unknown) => handlers.get(name)?.(event, context);

  return { find, complete, execute, emit, registerTool };
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
  'File continues at line 401. For a question about this file call bulk_read with paths and question. To edit, read again with offset and limit.';

it('describes bulk reads as evidence gathering rather than review judgments', () => {
  const { registerTool } = setup();
  const tool = registerTool.mock.calls[0]![0];

  expect(tool.description).toContain('supplied files');
  expect(tool.description).toContain(
    'focused summaries, test inventories, and line-cited evidence',
  );
  expect(tool.description).toContain('not correctness or branch review judgments');
  expect(tool.promptSnippet).toBe(tool.description);
});

it('keeps selective verification guidance on the bulk-read tool', () => {
  const { registerTool } = setup();
  const guidelines = registerTool.mock.calls[0]![0].promptGuidelines?.join(' ') ?? '';

  expect(guidelines).toContain('bulk_read');
  expect(guidelines).toContain('navigation without rereading');
  expect(guidelines).toMatch(/verify only consequential claims/i);
  expect(guidelines).toContain('edits or reports');
  expect(guidelines).toContain('bounded reads');
  expect(guidelines).toContain('production callers');
  expect(guidelines).toContain('regressions');
  expect(guidelines).toContain('actual diff');
  expect(guidelines).toContain('applicable project rules');
  expect(guidelines).toContain('inherited code');
});

it('clamps a read without limit to the threshold and leaves an explicit limit untouched', () => {
  const app = setup();
  const unbounded = readCall();
  const bounded = readCall('bounded', 600);

  expect(app.emit('tool_call', unbounded)).toBeUndefined();
  app.emit('tool_call', bounded);

  expect(unbounded.input).toHaveProperty('limit', bulkReadLineThreshold);
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
  ).toBe(`head\n\n${hint.replace('401', '101')}`);
  expect(rewriteContinuationNotice('small file')).toBe('small file');
  expect(rewriteContinuationNotice(`${notice}\nmore text`)).toBe(`${notice}\nmore text`);
});

it('uses the continuation offset in the hint for an offset read', () => {
  const app = setup();
  const read = { ...readCall(), input: { path: 'file', offset: 401 } };
  app.emit('tool_call', read);

  const result = app.emit('tool_result', {
    toolCallId: 'read',
    content: [
      { type: 'text', text: 'head\n\n[200 more lines in file. Use offset=801 to continue.]' },
    ],
  });

  expect(read.input).toHaveProperty('limit', 400);
  expect(result?.content).toEqual([
    { type: 'text', text: `head\n\n${hint.replace('401', '801')}` },
  ]);
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
    { type: 'text', text: `${content}\n\n[1 more lines in file. Use offset=401 to continue.]` },
  ]);
});

it('turns trimming off after a registry miss at the first clamp', () => {
  const app = setup();
  app.find.mockReturnValueOnce(undefined);
  const first = readCall();
  const second = readCall('second');

  expect(app.emit('tool_call', first)).toBeUndefined();
  app.emit('tool_call', second);

  expect(first.input).not.toHaveProperty('limit');
  expect(second.input).not.toHaveProperty('limit');
  expect(app.find).toHaveBeenCalledOnce();
});

it('turns trimming off when the registry throws at the first clamp', () => {
  const app = setup();
  app.find.mockImplementationOnce(() => {
    throw new Error('denied');
  });
  const first = readCall();
  const second = readCall('second');

  expect(() => app.emit('tool_call', first)).not.toThrow();
  app.emit('tool_call', second);

  expect(first.input).not.toHaveProperty('limit');
  expect(second.input).not.toHaveProperty('limit');
  expect(app.find).toHaveBeenCalledOnce();
});

it('throws a registry miss and leaves later reads untouched', async () => {
  vi.stubEnv('TAU_BULK_READ_MODEL', 'missing/reader');
  const app = setup();
  app.find.mockReturnValueOnce(undefined);

  await expect(app.execute()).rejects.toThrow(
    'Bulk read missing/reader failed: model not found. Check pi --list-models.',
  );
  const read = readCall();
  app.emit('tool_call', read);

  expect(read.input).not.toHaveProperty('limit');
});

it.each(['error', 'aborted', 'length', 'throw', 'abort', 'timeout', 'file', 'lookup'] as const)(
  'throws failures and disables trimming only for hard errors: %s',
  async (reason) => {
    const app = setup();
    let signal: AbortSignal | undefined;
    let paths: string[] | undefined;
    if (reason === 'throw' || reason === 'lookup') {
      const error = new Error('denied');
      if (reason === 'lookup') {
        app.find.mockImplementationOnce(() => {
          throw error;
        });
      } else {
        app.complete.mockRejectedValue(error);
      }
    } else if (reason === 'abort') {
      signal = AbortSignal.abort(new DOMException('cancelled', 'AbortError'));
    } else if (reason === 'timeout') {
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
      onTestFinished(() => {
        timeout.mockRestore();
      });
    } else if (reason === 'file') {
      paths = ['/missing/tau-bulk-file'];
    } else {
      app.complete.mockResolvedValue({ ...fauxAssistantMessage(''), stopReason: reason });
    }

    const expected = {
      error: { name: 'Error', message: 'pi --list-models' },
      aborted: { name: 'AbortError', message: 'failed: aborted' },
      length: { name: 'AbortError', message: 'failed: length' },
      throw: { name: 'Error', message: 'denied. Check pi --list-models.' },
      abort: { name: 'AbortError', message: 'cancelled' },
      timeout: { name: 'TimeoutError', message: 'timed out' },
      file: { name: 'BulkReadInputError', message: '/missing/tau-bulk-file' },
      lookup: { name: 'Error', message: 'denied' },
    }[reason];
    const failure = app.execute(signal, paths);

    await expect(failure).rejects.toThrow(expected.message);
    await expect(failure).rejects.toHaveProperty('name', expected.name);

    const read = readCall();
    app.emit('tool_call', read);

    const hard = ['error', 'throw', 'lookup'].includes(reason);
    expect(read.input.limit).toBe(hard ? undefined : 400);
  },
);

it.each(['session_start', 'session_before_switch', 'session_before_fork'] as const)(
  'restores trimming for the next session on %s',
  (event) => {
    const app = setup();
    app.find.mockReturnValueOnce(undefined);
    app.emit('tool_call', readCall('first'));

    app.emit(event, {});
    const later = readCall('later');
    app.emit('tool_call', later);

    expect(later.input).toHaveProperty('limit', bulkReadLineThreshold);
  },
);

it('reads the reference from the environment and falls back to the default', () => {
  vi.stubEnv('TAU_BULK_READ_MODEL', undefined);

  expect(delegateReference()).toBe('openai-codex/gpt-5.6-luna');

  vi.stubEnv('TAU_BULK_READ_MODEL', '');

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
