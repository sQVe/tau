import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import tddExtension from './index.js';
import { runTests } from './runner/index.js';

vi.mock('./runner/index.js', () => ({ runTests: vi.fn<typeof runTests>() }));

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;

const redHint =
  'Hint: No RED observed for this behavior; start the next behavior with a failing focused test.';

const setup = () => {
  const handlers = new Map<string, Handler>();
  const registerCommand = vi.fn<ExtensionAPI['registerCommand']>();
  let tool: ToolDefinition | undefined;

  tddExtension({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand,
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
  } as unknown as ExtensionAPI);

  const emit = (name: string, cwd: string, event: Record<string, unknown> = {}) =>
    handlers.get(name)?.(event, { cwd } as ExtensionContext);
  const edit = (cwd: string) =>
    emit('tool_result', cwd, {
      toolName: 'write',
      input: { path: 'src/value.ts' },
      isError: false,
      content: [{ type: 'text', text: 'Original result' }],
      details: { original: true },
    });
  const run = (cwd: string) => {
    if (tool === undefined) {
      throw new Error('Missing test tool');
    }

    return tool.execute(
      'run',
      { behavior: 'value', testFullName: 'works', files: ['value.test.ts'], scope: 'focused' },
      undefined,
      undefined,
      { cwd } as ExtensionContext,
    );
  };

  return { handlers, registerCommand, emit, edit, run };
};

it('resets hints on session boundaries but not turns, compaction, or model changes', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-hint-lifecycle-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const application = setup();

  expect(application.handlers.has('tool_call')).toBe(false);
  expect(application.registerCommand).not.toHaveBeenCalled();
  expect(await application.edit(cwd)).toMatchObject({
    content: [{ text: 'Original result' }, { text: redHint }],
  });

  for (const event of [
    'agent_start',
    'agent_end',
    'session_compact',
    'model_select',
    'session_before_switch',
    'session_before_fork',
  ]) {
    await application.emit(event, cwd);
    expect(await application.edit(cwd)).toBeUndefined();
  }

  for (const reason of ['new', 'resume', 'fork', 'reload']) {
    await application.emit('session_shutdown', cwd, { reason });
    await application.emit('session_start', cwd, { reason });
    expect(await application.edit(cwd)).toMatchObject({
      content: [{ text: 'Original result' }, { text: redHint }],
    });
    expect(await application.edit(cwd)).toBeUndefined();
  }
});

it('isolates cwd and preserves arbitrary tool content, details, and errors', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-hint-cwd-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const application = setup();
  const content = [
    { type: 'image', data: 'original', mimeType: 'image/png' },
    { type: 'text', text: 'custom output' },
  ];
  const event = {
    toolName: 'edit',
    input: { path: 'src/value.ts' },
    content,
    details: { diff: 'original' },
    isError: false,
  };

  expect(await application.emit('tool_result', cwd, { ...event, isError: true })).toBeUndefined();
  expect(
    await application.emit('tool_result', cwd, { ...event, toolName: 'custom_write' }),
  ).toBeUndefined();
  const patch = await application.emit('tool_result', cwd, event);

  expect(patch).toEqual({
    content: [...content, { type: 'text', text: redHint }],
  });
  expect(await application.edit(cwd)).toBeUndefined();
  await mkdir(join(cwd, 'second'));
  expect(await application.edit(join(cwd, 'second'))).not.toBeUndefined();
});

it('does not let a late run completion restore observations after a session reset', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-hint-late-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'value.test.ts'), 'test');
  const application = setup();
  const started = Promise.withResolvers<undefined>();
  const finished = Promise.withResolvers<Awaited<ReturnType<typeof runTests>>>();
  vi.mocked(runTests).mockImplementationOnce(() => {
    started.resolve(undefined);

    return finished.promise;
  });

  const running = application.run(cwd);
  await started.promise;
  await application.emit('session_shutdown', cwd, { reason: 'new' });
  await application.emit('session_start', cwd, { reason: 'new' });
  finished.resolve({
    kind: 'fail',
    failures: [],
    truncated: false,
    tests: [{ file: 'value.test.ts', fullname: 'works', status: 'failed' }],
  });
  await running;

  expect(await application.edit(cwd)).toMatchObject({
    content: [{ text: 'Original result' }, { text: redHint }],
  });
});
