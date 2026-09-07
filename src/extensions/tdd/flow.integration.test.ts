import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
} from '@mariozechner/pi-coding-agent';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, it, onTestFinished as registerCleanup, vi } from 'vitest';

import type { createEvidenceStore } from './state.js';

interface ToolResult {
  details: Awaited<ReturnType<ReturnType<typeof createEvidenceStore>['run']>>;
  content: { type: 'text'; text: string }[];
}

vi.setConfig({ testTimeout: 60_000 });
let counter = 0;

const createHarness = async (cleanup: TestContext['onTestFinished']) => {
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
  return { cwd, session, faux, events, run };
};

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
  expect(focused.details.evidence.red).toBeNull();
  expect(focused.details.evidence.focusedPass?.report.kind).toBe('pass');
  const full = await run({ scope: 'full' });
  expect(full.details.evidence.fullPass?.report.kind).toBe('pass');
  expect(full.details).toMatchObject({ phase: 'locked', fullPassValid: false });
  expect(full.details.implementationAllowed).toBe(false);
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

it('runs three behaviors as separate red-green cycles through pi', async ({ onTestFinished }) => {
  const { cwd, run } = await createHarness(onTestFinished);
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    `import { it, expect } from 'vitest'; import { value } from './src/value';
    ${[1, 2, 3].map((n) => `it('behavior ${n}', () => expect(value).toBeGreaterThanOrEqual(${n}));`).join('\n')}`,
  );
  for (const n of [1, 2, 3]) {
    const behavior = { behavior: `behavior ${n}`, testFullName: `behavior ${n}` };
    const red = await run(behavior);
    expect(red.details).toMatchObject({ phase: 'red', implementationAllowed: true });
    expect(red.details.evidence.active).toMatchObject(behavior);
    await writeFile(join(cwd, 'src/value.ts'), `export const value = ${n};`);
    const green = await run(behavior);
    expect(green.details).toMatchObject({
      phase: 'green',
      implementationAllowed: false,
      focusedPassValid: true,
      fullPassValid: false,
    });
  }
  const verified = await run({ behavior: 'behavior 3', testFullName: 'behavior 3', scope: 'full' });
  expect(verified.details).toMatchObject({ phase: 'verified', fullPassValid: true });
  const next = await run({ behavior: 'next behavior', testFullName: 'behavior 1' });
  expect(next.details).toMatchObject({ phase: 'locked', implementationAllowed: false });
});
