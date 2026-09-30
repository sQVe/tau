import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { initTheme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';

// Pi does not export these renderers through the public package API.
import { editRenderers } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/edit.js';
import { writeRenderers } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/write.js';
import { ToolExecutionComponent } from '../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { loadTddConfig } from './config.js';
import tddExtension from './index.js';
import { configSummary, runContext, summarize } from './render.js';
import type { RunnerResult } from './runner/types.js';
import { runTests } from './runner/vitest.js';
import type * as runnerModule from './runner/vitest.js';

// eslint-disable-next-line tau/no-module-mocking -- observation.ts imports runTests directly.
vi.mock('./runner/vitest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof runnerModule>()),
  runTests: vi.fn<typeof runTests>(),
}));

const redHint =
  'Hint: No RED observed for this behavior; start the next behavior with a failing focused test.';

const setup = (hasUI = false, trusted = true) => {
  const notify = vi.fn<ExtensionContext['ui']['notify']>();
  const fake = fakeExtensionApi();

  // Keep the developer's own user config out of the tests.
  vi.stubEnv('PI_CODING_AGENT_DIR', join(tmpdir(), 'tau-no-agent-directory'));

  tddExtension(fake.pi);
  const tool = fake.tools.get('run_tests');

  const contextFor = (cwd: string) =>
    ({
      cwd,
      hasUI,
      ui: { notify },
      isProjectTrusted: () => trusted,
    }) as unknown as ExtensionToolContext;

  const emit = (name: string, cwd: string, event: Record<string, unknown> = {}) =>
    fake.handlers.has(name) ? fake.handler(name)(event, contextFor(cwd)) : undefined;

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
      contextFor(cwd),
    );
  };

  return { handlers: fake.handlers, commands: fake.commands, emit, edit, run, tool, notify };
};

it.for(['edit', 'write'] as const)(
  'notifies once for a new %s hint while preserving agent content and ignoring unrelated results',
  async (toolName, { onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-edit-notify-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const application = setup(true);

    const content = [
      { type: 'image', data: 'original', mimeType: 'image/png' },
      { type: 'text', text: 'Original result' },
    ];

    const event = {
      toolName,
      input: { path: 'src/value.ts' },
      isError: false,
      content,
      details: { original: true },
    };

    for (const ignored of [
      { ...event, isError: true },
      { ...event, input: { path: 'README.md' } },
      { ...event, input: { path: 'src/dist/value.ts' } },
      { ...event, toolName: 'bash' },
      { ...event, toolName: 'custom_write' },
    ]) {
      expect(await application.emit('tool_result', cwd, ignored)).toBeUndefined();
    }

    expect(application.notify).not.toHaveBeenCalled();

    const patch = await application.emit('tool_result', cwd, event);

    expect(patch).toEqual({ content: [...content, { type: 'text', text: redHint }] });

    expect(event).toEqual({
      toolName,
      input: { path: 'src/value.ts' },
      isError: false,
      content,
      details: { original: true },
    });

    expect(application.notify).toHaveBeenCalledExactlyOnceWith(redHint, 'info');
    expect(await application.emit('tool_result', cwd, event)).toBeUndefined();
    expect(application.notify).toHaveBeenCalledTimes(1);

    vi.mocked(runTests).mockResolvedValueOnce({
      kind: 'pass',
      tests: [{ file: 'value.test.ts', fullname: 'works', status: 'passed' }],
    });

    const tested = await application.run(cwd);

    expect(JSON.stringify(tested.content)).toContain('Hint:');
    expect(application.notify).toHaveBeenCalledTimes(1);
  },
);

it('keeps headless edit hints in agent content without notifying', async ({ onTestFinished }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-headless-hint-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const application = setup(false);

  expect(await application.edit(cwd)).toEqual({
    content: [
      { type: 'text', text: 'Original result' },
      { type: 'text', text: redHint },
    ],
  });

  expect(application.notify).not.toHaveBeenCalled();
});

it.for(['edit', 'write'] as const)(
  'confirms the installed successful %s renderer omits appended hint text',
  (toolName) => {
    initTheme('dark', false);

    const args =
      toolName === 'edit'
        ? { path: 'src/value.ts', edits: [{ oldText: '1', newText: '2' }] }
        : { path: 'src/value.ts', content: 'export const value = 2;' };

    const renderers = toolName === 'edit' ? editRenderers : writeRenderers;

    const component = new ToolExecutionComponent(
      toolName,
      'change',
      args,
      {},
      renderers,
      { requestRender: vi.fn<TUI['requestRender']>() } as unknown as TUI,
      '/repo',
    );

    component.updateResult({
      content: [
        { type: 'text', text: 'Successful change' },
        { type: 'text', text: redHint },
      ],
      details: {
        diff: '-1 export const value = 1;\n+1 export const value = 2;',
        firstChangedLine: 1,
      },
      isError: false,
    });

    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      const rendered = component.render(120).map(stripVTControlCharacters).join('\n');

      expect(rendered).toContain('value');
      expect(rendered).not.toContain('Successful change');
      expect(rendered).not.toContain(redHint);
    }
  },
);

it.for(['ordinary', 'long'] as const)(
  'shows hints in collapsed %s results with the installed Pi renderer',
  async (size, { onTestFinished }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-hint-render-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(join(cwd, 'value.test.ts'), 'test');
    const directory = join(cwd, 'diagnostics');
    await mkdir(directory);
    const application = setup();

    const diagnostics = {
      directory,
      durationMs: 10,
      timeoutMs: 30_000,
      exitCode: size === 'ordinary' ? 0 : 1,
      stdout: { path: join(directory, 'stdout.txt'), bytes: 12, savedBytes: 12, truncated: false },
      excerpt: 'Runner diagnostic output',
    };

    const report: RunnerResult =
      size === 'ordinary'
        ? {
            kind: 'pass',
            tests: [{ file: 'value.test.ts', fullname: 'works', status: 'passed' }],
            diagnostics,
          }
        : {
            kind: 'fail',
            tests: [{ file: 'value.test.ts', fullname: 'works', status: 'failed' }],
            failures: Array.from({ length: 8 }, (_, index) => ({
              file: 'value.test.ts',
              fullname: `failure ${index}`,
              message: `Failure detail ${index}`,
            })),
            truncated: false,
            diagnostics,
          };

    vi.mocked(runTests).mockImplementationOnce(async () => {
      if (size === 'long') {
        await writeFile(join(cwd, 'value.test.ts'), 'changed during run');
      }

      return report;
    });

    const result = await application.run(cwd);

    const hint =
      size === 'ordinary'
        ? 'Hint: Focused tests passed; verify the full suite with the repository full check or run_tests scope "full".'
        : 'Hint: Test results are stale; rerun run_tests on the current inputs.';

    const parameters = {
      behavior: 'value',
      testFullName: 'works',
      files: ['value.test.ts'],
      scope: 'focused',
    };

    const details = result.details as Parameters<typeof summarize>[1];

    expect(details).toMatchObject({
      kind: report.kind,
      scope: 'focused',
      freshness: size === 'ordinary' ? 'fresh' : 'stale',
      runPath: join(directory, 'run.json'),
      report,
    });

    expect(details.inputs.before).toMatch(/^[a-f0-9]{64}$/);
    expect(details.inputs.after).toMatch(/^[a-f0-9]{64}$/);
    expect(details.report).toBe(report);

    expect(result.content).toEqual(
      expect.arrayContaining([
        { type: 'text', text: hint },
        { type: 'text', text: summarize(cwd, details) },
        { type: 'text', text: runContext(parameters, details) },
        {
          type: 'text',
          text: configSummary(loadTddConfig({ cwd, agentDirectory: cwd, projectTrusted: true })),
        },
      ]),
    );

    expect(result.content).toHaveLength(4);
    expect(application.tool?.renderResult).toBeUndefined();
    initTheme('dark', false);

    const component = new ToolExecutionComponent(
      'run_tests',
      'run',
      parameters,
      {},
      application.tool,
      { requestRender: vi.fn<TUI['requestRender']>() } as unknown as TUI,
      cwd,
    );

    component.updateResult({ ...result, isError: false });

    for (const width of [80, 160]) {
      const collapsed = component
        .render(width)
        .map(stripVTControlCharacters)
        .join('\n')
        .replace(/\s+/g, ' ');

      expect(collapsed).toContain(hint);
      expect(collapsed).toContain(`${report.kind} · focused · ${details.freshness}`);
      expect(collapsed).toContain('Files (1): value.test.ts');
      expect(collapsed).toContain('Exact names (1): works');
      expect(collapsed).toContain('more lines');
      expect(collapsed).not.toContain('Saved diagnostics are not reusable verification.');
    }

    component.setExpanded(true);

    const expanded = component
      .render(500)
      .map(stripVTControlCharacters)
      .map((line) => line.trim())
      .join('\n');

    const contentLines = result.content.flatMap((block) =>
      block.type === 'text' ? block.text.split('\n') : [],
    );

    for (const line of contentLines) {
      expect(expanded).toContain(line.trim());
    }

    expect(expanded).toContain(join(directory, 'run.json'));
    expect(expanded).toContain(diagnostics.stdout.path);
    expect(expanded).not.toContain('more lines,');
  },
);

it('emits advisory edit hints for supported layouts but not generated or dependency files', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-layout-edit-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));

  for (const path of [
    'apps/web/src/page.tsx',
    'packages/core/index.ts',
    'functions/notify/handler.js',
    'infra/stack.ts',
  ]) {
    const application = setup();

    const event = {
      toolName: 'write',
      input: { path },
      isError: false,
      content: [{ type: 'text', text: 'Written' }],
    };

    for (const excluded of [
      'apps/web/dist/page.tsx',
      'packages/core/node_modules/dep/index.ts',
      'infra/generated/stack.ts',
    ]) {
      expect(
        await application.emit('tool_result', cwd, { ...event, input: { path: excluded } }),
      ).toBeUndefined();
    }

    expect(await application.emit('tool_result', cwd, event)).toEqual({
      content: [...event.content, { type: 'text', text: redHint }],
    });

    expect(await application.emit('tool_result', cwd, event)).toBeUndefined();
  }
});

it('resets hints on session boundaries but not turns, compaction, or model changes', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-hint-lifecycle-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const application = setup();

  expect(application.handlers.has('tool_call')).toBe(false);
  expect(application.commands.size).toBe(0);

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

const writeEvent = (path: string) => ({
  toolName: 'write',
  input: { path },
  isError: false,
  content: [{ type: 'text', text: 'Written' }],
});

const configFixture = async (onTestFinished: (cleanup: () => Promise<void>) => void) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-config-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.pi'));
  await mkdir(join(cwd, 'agent'));
  await writeFile(join(cwd, 'value.test.ts'), 'test');

  const write = (path: string, tdd: unknown) => writeFile(join(cwd, path), JSON.stringify({ tdd }));

  return { cwd, writeProject: (tdd: unknown) => write('.pi/tau.json', tdd), write };
};

const runOutput = async (application: ReturnType<typeof setup>, cwd: string) => {
  vi.mocked(runTests).mockResolvedValueOnce({ kind: 'pass', tests: [] });

  return JSON.stringify((await application.run(cwd)).content);
};

it('reads source scope from .pi/tau.json and shows the effective config in run output', async ({
  onTestFinished,
}) => {
  const { cwd, writeProject } = await configFixture(onTestFinished);
  await writeProject({ excludedGlobs: ['**/node_modules/**', 'src/components/**'] });
  const application = setup();

  expect(
    await application.emit('tool_result', cwd, writeEvent('src/components/Button.tsx')),
  ).toBeUndefined();

  expect(await application.emit('tool_result', cwd, writeEvent('src/hooks/useValue.ts'))).toEqual({
    content: [
      { type: 'text', text: 'Written' },
      { type: 'text', text: redHint },
    ],
  });

  const tested = await runOutput(application, cwd);

  expect(tested).toContain(join(cwd, '.pi', 'tau.json'));
  expect(tested).toContain('src/components/**');
});

it('applies user config and lets the repository override it per field', async ({
  onTestFinished,
}) => {
  const { cwd, write, writeProject } = await configFixture(onTestFinished);

  await write('agent/tau.json', {
    productionGlobs: ['lib/**/*.ts'],
    excludedGlobs: ['lib/vendor/**'],
  });

  const application = setup();
  vi.stubEnv('PI_CODING_AGENT_DIR', join(cwd, 'agent'));

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  expect(await application.emit('tool_result', cwd, writeEvent('lib/vendor/x.ts'))).toBeUndefined();
  expect(await application.emit('tool_result', cwd, writeEvent('src/value.ts'))).toBeUndefined();

  await writeProject({ excludedGlobs: [] });

  expect(await application.emit('tool_result', cwd, writeEvent('lib/vendor/x.ts'))).toMatchObject({
    content: [{ text: 'Written' }, { text: redHint }],
  });

  const tested = await runOutput(application, cwd);

  expect(tested).toContain(join(cwd, 'agent', 'tau.json'));
  expect(tested).toContain(join(cwd, '.pi', 'tau.json'));
});

it('ignores repository config in an untrusted project and says so', async ({ onTestFinished }) => {
  const { cwd, writeProject } = await configFixture(onTestFinished);
  await writeProject({ productionGlobs: 'not a list' });
  const application = setup(false, false);

  expect(await application.emit('tool_result', cwd, writeEvent('src/value.ts'))).toMatchObject({
    content: [{ text: 'Written' }, { text: redHint }],
  });

  const tested = await runOutput(application, cwd);

  expect(tested).toContain(join(cwd, '.pi', 'tau.json'));
});

it('uses built-in defaults when no config file exists', async ({ onTestFinished }) => {
  const { cwd } = await configFixture(onTestFinished);
  const application = setup();

  expect(
    await application.emit('tool_result', cwd, writeEvent('src/components/Button.tsx')),
  ).toMatchObject({ content: [{ text: 'Written' }, { text: redHint }] });

  const tested = await runOutput(application, cwd);

  expect(tested).toContain('**/*.test.{ts,tsx,js,jsx,mjs,cjs}');
});

it('reports malformed config without falling back to defaults or blocking edits', async ({
  onTestFinished,
}) => {
  const { cwd, writeProject } = await configFixture(onTestFinished);
  const path = join(cwd, '.pi', 'tau.json');
  await writeProject({ productionGlobs: 'src/**' });
  vi.mocked(runTests).mockClear();
  const application = setup();
  const event = writeEvent('src/value.ts');
  const patch = await application.emit('tool_result', cwd, event);

  expect(patch).toEqual({
    content: [...event.content, { type: 'text', text: expect.stringContaining(path) as string }],
  });

  expect(JSON.stringify(patch)).toContain('productionGlobs');
  expect(JSON.stringify(patch)).not.toContain(redHint);
  expect(await application.emit('tool_result', cwd, event)).toBeUndefined();
  await expect(application.run(cwd)).rejects.toThrow(path);
  expect(runTests).not.toHaveBeenCalled();
});
