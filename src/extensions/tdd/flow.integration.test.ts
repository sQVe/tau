import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createCodingTools,
  defineTool,
} from '@mariozechner/pi-coding-agent';
import type {
  AgentSessionEvent,
  ExtensionFactory,
  ExtensionUIContext,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { TestContext } from 'vitest';
import { expect, it, onTestFinished as registerCleanup, vi } from 'vitest';

import type { createEvidenceStore } from './state.js';

interface ToolResult {
  details: Awaited<ReturnType<ReturnType<typeof createEvidenceStore>['run']>>;
  content: { type: 'text'; text: string }[];
}

vi.setConfig({ testTimeout: 60_000 });
let counter = 0;

const createWorktree = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-tdd-'));
  cleanup(() => rm(cwd, { recursive: true, force: true }));
  await promisify(execFile)('git', ['init', '--quiet', cwd]);
  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; it('required behavior', () => expect(1).toBe(2));",
  );
  return cwd;
};

const createHarness = async (
  cleanup: TestContext['onTestFinished'],
  extensionFactories: ExtensionFactory[] = [],
  reused?: string,
) => {
  const cwd = reused ?? (await createWorktree(cleanup));
  const agentDir = join(cwd, 'agent');
  const faux = registerFauxProvider({ provider: `tau-tdd-${++counter}` });
  cleanup(() => {
    faux.unregister();
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [resolve(import.meta.dirname, '..')],
    extensionFactories,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(faux.getModel().provider, 'faux-key');
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: createCodingTools(cwd),
  });
  cleanup(() => {
    session.dispose();
  });
  expect(extensionsResult.errors).toEqual([]);
  await session.bindExtensions({});
  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  const run = async (overrides = {}) => {
    events.length = 0;
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('run_tests', {
          behavior: 'required behavior',
          testFullName: 'required behavior',
          files: ['behavior.test.ts'],
          scope: 'focused',
          ...overrides,
        }),
      ]),
      fauxAssistantMessage('Done.'),
    ]);
    await session.prompt('Run the tests.');
    const event = events.find(
      (entry) => entry.type === 'tool_execution_end' && entry.toolName === 'run_tests',
    );
    if (event?.type !== 'tool_execution_end') throw new Error('Missing run_tests result');
    expect(event.isError).toBe(false);
    return event.result as ToolResult;
  };
  const call = async (toolName: string, input: Record<string, unknown>) => {
    events.length = 0;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(toolName, input)]),
      fauxAssistantMessage('Done.'),
    ]);
    await session.prompt('Call the tool.');
    const event = events.find(
      (entry) => entry.type === 'tool_execution_end' && entry.toolName === toolName,
    );
    if (event?.type !== 'tool_execution_end') throw new Error(`Missing ${toolName} result`);
    return event;
  };
  return { cwd, session, faux, events, run, call };
};

it('blocks production writes until run_tests records RED through pi', async ({
  onTestFinished,
}) => {
  const { cwd, run, call } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { appendFileSync } from 'node:fs'; it('required behavior', () => { appendFileSync('runs', 'run\\n'); expect(1).toBe(2); });",
  );
  const input = { path: 'src/value.ts', content: 'export const value = 1;' };
  const blocked = await call('write', input);
  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked.result)).toContain('src/value.ts');
  expect(JSON.stringify(blocked.result)).toContain('locked');
  expect(JSON.stringify(blocked.result)).toContain('none');
  expect(JSON.stringify(blocked.result)).toContain('Write a failing test with write');
  await expect(readFile(join(cwd, input.path))).rejects.toThrow(/ENOENT/);
  await run();
  expect((await call('write', input)).isError).toBe(false);
  expect(await readFile(join(cwd, input.path), 'utf8')).toBe(input.content);
  expect((await call('edit', { path: input.path, oldText: '= 1', newText: '= 2' })).isError).toBe(
    false,
  );
  expect(await readFile(join(cwd, input.path), 'utf8')).toBe('export const value = 2;');
  expect(await readFile(join(cwd, 'runs'), 'utf8')).toBe('run\n');
});

it('enforces file classifications across the evidence phases through pi', async ({
  onTestFinished,
}) => {
  const { cwd, run, call } = await createHarness(onTestFinished);
  await rm(join(cwd, 'behavior.test.ts'));
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  await promisify(execFile)('git', ['add', 'src/value.ts'], { cwd });
  const test =
    "import { it, expect } from 'vitest'; import { value } from './value'; it('required behavior', () => expect(value).toBe(1));";
  expect((await call('write', { path: 'src/value.test.ts', content: test })).isError).toBe(false);
  let recordedPhase = 'locked';
  for (const phase of ['locked', 'red', 'green', 'verified']) {
    if (phase !== 'locked') {
      const result = await run({
        files: ['src/value.test.ts'],
        scope: phase === 'verified' ? 'full' : 'focused',
      });
      recordedPhase = result.details.phase;
    }
    expect(recordedPhase).toBe(phase);
    const production = await call('write', {
      path: join(cwd, 'src/value.ts'),
      content: 'export const value = 1;',
    });
    expect(production.isError).toBe(phase !== 'red');
    for (const path of ['.tau/state.test.ts', 'vite.config.ts', 'package.json']) {
      const before = await readFile(join(cwd, path), 'utf8').catch(() => null);
      const blocked = await call('write', { path, content: 'changed' });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked.result)).toContain(phase);
      expect(await readFile(join(cwd, path), 'utf8').catch(() => null)).toBe(before);
    }
    const allowed = await call('write', { path: 'src/value.test.ts', content: test });
    expect(allowed.isError).toBe(false);
  }
  expect(
    (
      await call('edit', {
        path: 'src/value.test.ts',
        oldText: 'toBe(1)',
        newText: 'toBeGreaterThan(0)',
      })
    ).isError,
  ).toBe(false);
  const stale = await call('write', { path: 'src/value.ts', content: 'export const value = 2;' });
  expect(stale.isError).toBe(true);
  expect(JSON.stringify(stale.result)).toContain('locked');
  expect(JSON.stringify(stale.result)).toContain('required behavior');
  expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 1;');
  const behavior = { files: ['src/value.test.ts'] };
  expect((await run(behavior)).details).toMatchObject({ kind: 'pass', phase: 'locked' });
  expect((await call('bash', { command: 'git restore -- src/value.ts' })).isError).toBe(false);
  expect((await run(behavior)).details).toMatchObject({ kind: 'fail', phase: 'red' });
  expect(
    (await call('write', { path: 'src/value.ts', content: 'export const value = 1;' })).isError,
  ).toBe(false);
  expect((await run(behavior)).details.phase).toBe('green');
  expect((await run({ ...behavior, scope: 'full' })).details.phase).toBe('verified');
});

it('keeps RED evidence across a restarted pi session in the same worktree', async ({
  onTestFinished,
}) => {
  const first = await createHarness(onTestFinished);
  expect((await first.run()).details.phase).toBe('red');
  first.session.dispose();

  const second = await createHarness(onTestFinished, [], first.cwd);

  const production = await second.call('write', {
    path: 'src/value.ts',
    content: 'export const value = 1;',
  });
  expect(production.isError).toBe(false);
});

it('blocks an extension write tool before it executes through pi', async ({ onTestFinished }) => {
  const execute = vi.fn<ToolDefinition['execute']>(() =>
    Promise.resolve({
      content: [{ type: 'text' as const, text: 'Written' }],
      details: {},
    }),
  );
  const { run, call } = await createHarness(onTestFinished, [
    (pi) => {
      pi.registerTool(
        defineTool({
          name: 'mcp_patch',
          label: 'Patch',
          description: 'Write a file.',
          parameters: Type.Object({ targetPath: Type.String() }),
          execute,
        }),
      );
    },
  ]);
  await run();
  const result = await call('mcp_patch', { targetPath: 'behavior.test.ts' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.result)).toContain('unrecognized tool mcp_patch');
  expect(execute).not.toHaveBeenCalled();
});

it('allows commit and its pre-commit formatter writes outside the file-tool guard', async ({
  onTestFinished,
}) => {
  const { cwd, session, call } = await createHarness(onTestFinished);
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd });
  await git(['config', 'user.name', 'Tau Test']);
  await git(['config', 'user.email', 'tau@example.com']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.hooksPath', '.vite-hooks']);
  await mkdir(join(cwd, '.vite-hooks'));
  await writeFile(
    join(cwd, '.vite-hooks/pre-commit'),
    `#!/bin/sh\n${await readFile(resolve('.vite-hooks/pre-commit'), 'utf8')}`,
  );
  await chmod(join(cwd, '.vite-hooks/pre-commit'), 0o755);
  await writeFile(
    join(cwd, 'vite.config.ts'),
    "export default { staged: { '*.ts': 'vp fmt --write' } };",
  );
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value=1');
  const blocked = await call('write', {
    path: 'src/value.ts',
    content: 'export const value = 1;\n',
  });
  expect(blocked.isError).toBe(true);
  expect(JSON.stringify(blocked.result)).toContain('locked');
  await session.bindExtensions({
    uiContext: { custom: () => Promise.resolve('approve') } as unknown as ExtensionUIContext,
  });
  const committed = await call('commit', {
    files: ['src/value.ts'],
    subject: 'feat: format fixture',
  });
  expect(committed).toMatchObject({ isError: false });
  expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect((await git(['show', 'HEAD:src/value.ts'])).stdout).toBe('export const value = 1;\n');
});

it('records a focused assertion failure as RED through pi', async ({ onTestFinished }) => {
  const { run } = await createHarness(onTestFinished);
  const result = await run();
  expect(result.details.evidence.red?.report.kind).toBe('fail');
  expect(result.details.evidence.red?.before).toEqual(result.details.evidence.red?.after);
  expect(result.details.implementationAllowed).toBe(true);
});

it('records focused and full passes without unlocking a first-run pass', async ({
  onTestFinished,
}) => {
  const { cwd, run } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {});",
  );
  const focused = await run();
  expect(focused.details).toMatchObject({ phase: 'locked', focusedPassValid: false });
  expect(focused.details.implementationAllowed).toBe(false);
  expect(JSON.parse(focused.content[0]!.text)).toMatchObject({
    kind: 'pass',
    phase: 'locked',
    implementationAllowed: false,
    next: 'The test does not fail yet; the behavior may already be implemented. Write a test that fails before the fix, then call run_tests {"behavior":"required behavior","testFullName":"required behavior","files":["behavior.test.ts"],"scope":"focused"}.',
  });
  expect(focused.details.evidence.red).toBeNull();
  expect(focused.details.evidence.focusedPass?.report.kind).toBe('pass');
  const full = await run({ scope: 'full' });
  expect(full.details.evidence.fullPass?.report.kind).toBe('pass');
  expect(full.details).toMatchObject({ phase: 'locked', fullPassValid: false });
  expect(full.details.implementationAllowed).toBe(false);
});

it('names the ambiguous file while keeping a RED proven by another required file', async ({
  onTestFinished,
}) => {
  const { cwd, run } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'other.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {}); it('required behavior', () => {});",
  );

  const result = await run({ files: ['behavior.test.ts', 'other.test.ts'] });

  expect(result.details.phase).toBe('red');
  expect(result.details.evidence.red?.report.kind).toBe('fail');
  const text = JSON.parse(result.content[0]!.text) as { next: string };
  expect(text.next).toContain('["other.test.ts"]');
  expect(text.next).toContain('the phase is red');
  expect(text.next).not.toContain('no evidence was recorded');
});

it('names an earlier RED whose full name became duplicated in its file', async ({
  onTestFinished,
}) => {
  const { cwd, run } = await createHarness(onTestFinished);
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  const first =
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('required behavior', () => expect(value).toBeGreaterThanOrEqual(1));";
  await writeFile(join(cwd, 'behavior.test.ts'), first);
  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second behavior', () => expect(value).toBe(2));",
  );
  expect((await run()).details.phase).toBe('red');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
  await run();
  const second = {
    behavior: 'second behavior',
    testFullName: 'second behavior',
    files: ['second.test.ts'],
  };
  expect((await run(second)).details.phase).toBe('red');
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');
  await run(second);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    `${first} it('required behavior', () => expect(value).toBe(2));`,
  );

  const full = await run({ ...second, scope: 'full' });

  expect(full.details.fullPassValid).toBe(false);
  const text = JSON.parse(full.content[0]!.text) as { next: string };
  expect(text.next).toContain('"required behavior"');
  expect(text.next).toContain('["behavior.test.ts"]');
  expect(text.next).toContain('Rename the duplicate');
});

it.each([
  [
    'empty selection',
    "import { it } from 'vitest'; it('another behavior', () => {});",
    'no-tests-collected',
  ],
  ['load error', "throw new Error('cannot load');", 'fail'],
  ['timeout', 'await new Promise(() => {});', 'timeout'],
])('keeps the gate shut for %s', async (_name, source, kind) => {
  const { cwd, run } = await createHarness(registerCleanup);
  await writeFile(join(cwd, 'behavior.test.ts'), source);
  const result = await run();
  expect(result.details.kind).toBe(kind);
  expect(result.details.implementationAllowed).toBe(false);
  expect(result.details.evidence.red).toBeNull();
});

it('discards a run when a sibling bash tool edits its inputs', async ({ onTestFinished }) => {
  const { cwd, session, faux, events } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { writeFile } from 'node:fs/promises'; it('required behavior', async () => { await writeFile('started', ''); await new Promise(r => setTimeout(r, 500)); expect(1).toBe(2); });",
  );
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('run_tests', {
        behavior: 'required behavior',
        testFullName: 'required behavior',
        files: ['behavior.test.ts'],
        scope: 'focused',
      }),
      fauxToolCall('bash', {
        command:
          "while [ ! -f started ]; do sleep 0.02; done; printf 'export default { test: {} };' > vite.config.ts",
      }),
    ]),
    fauxAssistantMessage('Done.'),
  ]);
  await session.prompt('Run and edit concurrently.');
  const result = events.find(
    (event) => event.type === 'tool_execution_end' && event.toolName === 'run_tests',
  );
  if (result?.type !== 'tool_execution_end') throw new Error('Missing run_tests result');
  expect(JSON.parse((result.result as ToolResult).content[0]!.text)).toMatchObject({
    kind: 'inputs-changed',
    phase: 'locked',
    report: null,
    next: 'Inputs changed during the run; no evidence was recorded. Stop concurrent edits, then call run_tests {"behavior":"required behavior","testFullName":"required behavior","files":["behavior.test.ts"],"scope":"focused"}.',
  });
  expect(result).toMatchObject({
    isError: false,
    result: {
      details: { kind: 'inputs-changed', evidence: { active: null, red: null, latestRun: null } },
    },
  });
});

it('serializes overlapping calls through pi', async ({ onTestFinished }) => {
  const { cwd, session, faux, events } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; import { appendFile } from 'node:fs/promises'; it('required behavior', async () => { await appendFile('order', 'start\\n'); await new Promise(r => setTimeout(r, 800)); await appendFile('order', 'end\\n'); });",
  );
  const params = {
    behavior: 'required behavior',
    testFullName: 'required behavior',
    files: ['behavior.test.ts'],
    scope: 'focused',
  };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('run_tests', params), fauxToolCall('run_tests', params)]),
    fauxAssistantMessage('Done.'),
  ]);
  await session.prompt('Run twice concurrently.');
  expect(
    events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'run_tests'),
  ).toHaveLength(2);
  expect(await readFile(join(cwd, 'order'), 'utf8')).toBe('start\nend\nstart\nend\n');
});

it('keeps the full report while shortening displayed output', async ({ onTestFinished }) => {
  const { cwd, run } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    `import { it } from 'vitest'; it('required behavior', () => {}); ${Array.from({ length: 100 }, (_, index) => `it('${index} ${'long name '.repeat(20)}', () => {});`).join('\n')}`,
  );
  const result = await run({ scope: 'full' });
  expect(result.details.evidence.fullPass?.report).toHaveProperty('tests.length', 101);
  expect(result.content[0]!.text.length).toBeLessThanOrEqual(4000);
  expect(result.content[0]!.text).toContain('truncated');
});

it('rejects production and escaping paths through pi', async ({ onTestFinished }) => {
  const { session, faux, events } = await createHarness(onTestFinished);
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('run_tests', {
        behavior: 'behavior',
        testFullName: 'required',
        files: ['../outside.test.ts'],
        scope: 'focused',
      }),
      fauxToolCall('run_tests', {
        behavior: 'behavior',
        testFullName: 'required',
        files: ['src/index.ts'],
        scope: 'focused',
      }),
    ]),
    fauxAssistantMessage('Done.'),
  ]);
  await session.prompt('Run invalid selections.');
  const results = events.filter((event) => event.type === 'tool_execution_end');
  expect(results).toHaveLength(2);
  expect(results.every((event) => event.isError)).toBe(true);
});

it('verifies two behaviors authored incrementally in one test file through pi', async ({
  onTestFinished,
}) => {
  const { cwd, run, call } = await createHarness(onTestFinished);
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  let tests = "import { it, expect } from 'vitest'; import { value } from './src/value';";
  for (const n of [1, 2]) {
    tests += `it('behavior ${n}', () => expect(value).toBeGreaterThanOrEqual(${n}));`;
    expect((await call('write', { path: 'behavior.test.ts', content: tests })).isError).toBe(false);
    const behavior = { behavior: `behavior ${n}`, testFullName: `behavior ${n}` };
    const red = await run(behavior);
    expect(red.details).toMatchObject({ phase: 'red', implementationAllowed: true });
    expect(red.details.evidence.active).toMatchObject(behavior);
    expect(
      (await call('write', { path: 'src/value.ts', content: `export const value = ${n};` }))
        .isError,
    ).toBe(false);
    const green = await run(behavior);
    expect(green.details).toMatchObject({
      phase: 'green',
      implementationAllowed: false,
      focusedPassValid: true,
      fullPassValid: false,
    });
  }
  const verified = await run({ behavior: 'behavior 2', testFullName: 'behavior 2', scope: 'full' });
  expect(verified.details.evidence.reds).toHaveLength(2);
  expect(verified.details.evidence.red).not.toBeNull();
  expect(verified.details).toMatchObject({ phase: 'verified', fullPassValid: true });
  const next = await run({ behavior: 'next behavior', testFullName: 'behavior 1' });
  expect(next.details).toMatchObject({ phase: 'locked', implementationAllowed: false });
});

it('describes the cycle and exact nested test names in the registered tool', async ({
  onTestFinished,
}) => {
  const { session, cwd, run } = await createHarness(onTestFinished);
  const tool = session.getAllTools().find((entry) => entry.name === 'run_tests')!;
  for (const text of [
    'Name a behavior',
    'scope "focused"',
    'RED',
    'GREEN',
    'scope "full"',
    'verified',
    're-locks',
    'git restore/stash',
    'Skipped and deleted tests never count',
    'kind',
    'phase',
    'implementationAllowed',
    'report',
    'locked',
    'red',
    'green',
  ]) {
    expect(tool.description).toContain(text);
  }
  expect(tool.parameters).toMatchObject({
    properties: {
      behavior: {
        description:
          'Name the behavior to implement; keep it unchanged through RED, GREEN, and full verification.',
      },
      files: {
        description:
          'Required test files as worktree-relative paths; keep the same files through the cycle, including full runs.',
      },
      scope: {
        description:
          'Use focused for the exact test in files to prove RED and GREEN; use full for all tests at the end to verify every recorded RED.',
      },
      testFullName: {
        description:
          'Exact Vitest full name: describe names then the it name, joined with spaces, not " > "; for example "outer inner works". Use the same name for focused and full runs.',
      },
    },
  });
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { describe, it, expect } from 'vitest'; describe('outer', () => describe('inner', () => it('works', () => expect(1).toBe(2))));",
  );
  const result = await run({ testFullName: 'outer inner works' });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({
    phase: 'red',
    implementationAllowed: true,
  });
});

const REQUIRED_RED_TEST =
  "import { it, expect } from 'vitest'; import { value } from './src/value'; if (value !== 2) it.skipIf(value === 1)('required behavior', () => expect(value).toBe(3)); it('other in file', () => {});";
const UNRELATED_PASSING_TEST = "import { it } from 'vitest'; it('other', () => {});";
const RESTORE_RED_NEXT_STEP =
  'A required RED test is skipped or missing: "required behavior" in ["behavior.test.ts"]. Restore that test so it runs and passes, then call run_tests {"behavior":"required behavior","testFullName":"required behavior","files":["behavior.test.ts"],"scope":"full"}.';

const createMissingRedHarness = async () => {
  const harness = await createHarness(registerCleanup);
  await mkdir(join(harness.cwd, 'src'));
  await writeFile(join(harness.cwd, 'src/value.ts'), 'export const value = 0;');
  return harness;
};

it.each([
  ['skipped', 1],
  ['missing', 2],
])('explains why a full pass cannot verify a %s RED test', async (_status, value) => {
  const { run, call } = await createMissingRedHarness();
  expect(
    (await call('write', { path: 'behavior.test.ts', content: REQUIRED_RED_TEST })).isError,
  ).toBe(false);
  expect(
    (await call('write', { path: 'other.test.ts', content: UNRELATED_PASSING_TEST })).isError,
  ).toBe(false);
  expect((await run()).details.phase).toBe('red');
  expect(
    (await call('write', { path: 'src/value.ts', content: `export const value = ${value};` }))
      .isError,
  ).toBe(false);

  const result = await run({ scope: 'full' });

  expect(result.details.fullPassValid).toBe(false);
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({
    kind: 'pass',
    phase: 'red',
    implementationAllowed: true,
    next: RESTORE_RED_NEXT_STEP,
  });
});

it.each(['skip edit', 'deleted file'])(
  'locks verification when a proven RED test is %s after green',
  async (status) => {
    const { run, call } = await createMissingRedHarness();
    expect(
      (await call('write', { path: 'behavior.test.ts', content: REQUIRED_RED_TEST })).isError,
    ).toBe(false);
    expect(
      (await call('write', { path: 'other.test.ts', content: UNRELATED_PASSING_TEST })).isError,
    ).toBe(false);
    expect((await run()).details.phase).toBe('red');
    expect(
      (await call('write', { path: 'src/value.ts', content: 'export const value = 3;' })).isError,
    ).toBe(false);
    expect((await run()).details.phase).toBe('green');
    const changed =
      status === 'deleted file'
        ? await call('bash', { command: 'rm behavior.test.ts' })
        : await call('edit', {
            path: 'behavior.test.ts',
            oldText: 'it.skipIf(value === 1)',
            newText: 'it.skip',
          });
    expect(changed.isError).toBe(false);

    const result = await run({ scope: 'full' });

    expect(result.details.fullPassValid).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      kind: 'pass',
      phase: 'locked',
      implementationAllowed: false,
      next: RESTORE_RED_NEXT_STEP,
    });
    expect(
      (await call('write', { path: 'src/value.ts', content: 'export const value = 4;' })).isError,
    ).toBe(true);
    expect(
      (await call('write', { path: 'behavior.test.ts', content: REQUIRED_RED_TEST })).isError,
    ).toBe(false);
    expect((await run({ scope: 'full' })).details.phase).toBe('verified');
  },
);
