import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { FauxResponseStep } from '@earendil-works/pi-ai';
import type {
  AgentSessionEvent,
  ExtensionFactory,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { expect, it, onTestFinished as registerCleanup, vi } from 'vitest';

import { initializeRepository } from '../../../tests/gitRepository.js';
import { isolateWebAccessConfig } from '../../../tests/isolateWebAccessConfig.js';
import { createPiSession } from '../../../tests/piSession.js';
import type { createTestObservation } from './observation.js';

interface ToolResult {
  details: Awaited<ReturnType<ReturnType<typeof createTestObservation>['run']>>;
  content: { type: 'text'; text: string }[];
}

vi.setConfig({ testTimeout: 125_000 });

let counter = 0;

const createWorktree = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-tdd-'));
  cleanup(() => rm(cwd, { recursive: true, force: true }));

  await initializeRepository(cwd);
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
  const agentDirectory = join(cwd, 'agent');

  isolateWebAccessConfig(agentDirectory, cleanup);
  counter += 1;

  const faux = fauxProvider({ provider: `tau-tdd-${counter}` });
  const { session, extensionsResult } = await createPiSession(cleanup, {
    cwd,
    agentDirectory,
    providers: [faux],
    tools: ['read', 'bash', 'edit', 'write', 'run_tests', 'commit'],
    extensionPaths: [
      resolve(import.meta.dirname, '..'),
      resolve(
        import.meta.dirname,
        '../../../node_modules/@juicesharp/rpiv-ask-user-question/index.ts',
      ),
      resolve(import.meta.dirname, '../../../node_modules/pi-web-access/index.ts'),
    ],
    extensionFactories,
  });

  expect(extensionsResult.errors).toEqual([]);
  await session.bindExtensions({});

  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  const call = async (
    toolName: string,
    input: Record<string, unknown>,
    between: FauxResponseStep[] = [],
  ) => {
    events.length = 0;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(toolName, input)]),
      ...between,
      fauxAssistantMessage('Done.'),
    ]);

    await session.prompt('Call the tool.');

    const event = events.find(
      (entry) => entry.type === 'tool_execution_end' && entry.toolName === toolName,
    );

    if (event?.type !== 'tool_execution_end') {
      throw new Error(`Missing ${toolName} result`);
    }

    return event;
  };

  const run = async (overrides = {}) => {
    const event = await call('run_tests', {
      behavior: 'required behavior',
      testFullName: 'required behavior',
      files: ['behavior.test.ts'],
      scope: 'focused',
      ...overrides,
    });

    expect(event.isError).toBe(false);

    const result = event.result as ToolResult;
    const directory = result.details.report.diagnostics?.directory;

    if (directory !== undefined) {
      cleanup(() => rm(directory, { recursive: true, force: true }));
    }

    return result;
  };

  return { cwd, session, faux, events, run, call };
};

it('shows the selected tests before completion and saves full-suite input evidence', async ({
  onTestFinished,
}) => {
  const { cwd, run, events } = await createHarness(onTestFinished);
  const focused = await run();
  const updates = events.filter((event) => event.type === 'tool_execution_update');

  expect(JSON.stringify(updates)).toContain('behavior.test.ts');
  expect(JSON.stringify(updates)).toContain('required behavior');
  expect(focused.content.map((block) => block.text).join('\n')).toContain('Scope: focused');

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => { console.warn('warning remains'); });",
  );
  const full = await run({ scope: 'full' });
  const text = full.content.map((block) => block.text).join('\n');

  expect(text).toContain('Scope: full suite');
  expect(text).toContain('Full suite passed');
  expect(text).toContain('inputs unchanged during this run');
  expect(text).toContain('run.json');
  expect(text).toContain('stdout.txt');
  expect(text).toContain('stderr.txt');
  const diagnostics = full.details.report.diagnostics!;
  const manifest: unknown = JSON.parse(
    await readFile(join(diagnostics.directory, 'run.json'), 'utf8'),
  );

  expect(manifest).toMatchObject({
    cwd,
    scope: 'full',
    kind: 'pass',
    freshness: 'fresh',
    inputs: full.details.inputs,
  });
  expect(full.details.inputs.before).toMatch(/^[a-f0-9]{64}$/);
  expect(full.details.inputs.before).toBe(full.details.inputs.after);
  expect(await readFile(diagnostics.stderr!.path, 'utf8')).toContain('warning remains');
  expect(await readFile(join(diagnostics.directory, 'completed'), 'utf8')).toBe('');
  expect(JSON.stringify(updates)).not.toContain('Full suite passed');
});

it.for(['tui', 'rpc'] as const)(
  'notifies once for an edit hint through Pi in %s mode without changing tool results',
  async (mode, { onTestFinished }) => {
    const { cwd, session, call } = await createHarness(onTestFinished);
    const notify = vi.fn<ExtensionUIContext['notify']>();
    await session.bindExtensions({
      mode,
      uiContext: { ...session.extensionRunner.getUIContext(), notify },
    });
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');
    const failed = await call('edit', {
      path: 'src/value.ts',
      edits: [{ oldText: 'missing', newText: '2' }],
    });

    expect(failed.isError).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    const edited = await call('edit', {
      path: 'src/value.ts',
      edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
    });
    const hint =
      'Hint: No RED observed for this behavior; start the next behavior with a failing focused test.';

    expect(edited.isError).toBe(false);
    expect(edited.result).toHaveProperty('details.diff', expect.stringContaining('value = 2'));
    expect(JSON.stringify(edited.result)).toContain(hint);
    expect(notify).toHaveBeenCalledExactlyOnceWith(hint, 'info');
    const written = await call('write', {
      path: 'src/value.ts',
      content: 'export const value = 3;',
    });

    expect(written.isError).toBe(false);
    expect(JSON.stringify(written.result)).not.toContain('Hint:');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 3;');
  },
);

it('allows production edits with one advisory hint and no persisted permission state', async ({
  onTestFinished,
}) => {
  const { cwd, call } = await createHarness(onTestFinished);
  const input = { path: 'src/value.ts', content: 'export const value = 1;' };
  const written = await call('write', input);

  expect(written.isError).toBe(false);
  expect(JSON.stringify(written.result)).toContain('Hint:');
  expect(JSON.stringify(written.result)).toContain('RED');
  expect(await readFile(join(cwd, input.path), 'utf8')).toBe(input.content);

  const repeated = await call('write', { ...input, content: 'export const value = 2;' });

  expect(repeated.isError).toBe(false);
  expect(JSON.stringify(repeated.result)).not.toContain('Hint:');
  await expect(readFile(join(cwd, '.tau/state.json'))).rejects.toThrow(/ENOENT/);
});

it('observes RED and focused passes, then accepts full verification after formatting through Pi', async ({
  onTestFinished,
}) => {
  const { cwd, run, call, session } = await createHarness(onTestFinished);
  const red = await run();

  expect(red.details).toMatchObject({ kind: 'fail', freshness: 'fresh', report: { kind: 'fail' } });
  expect(red.content[0]!.text).toContain('✗ behavior.test.ts › required behavior');
  expect(red.content[0]!.text).not.toContain(cwd);
  expect(red.content[0]!.text).not.toMatch(/\n\s+at /);
  expect(red.details).not.toHaveProperty('phase');
  expect(red.details).not.toHaveProperty('implementationAllowed');
  expect(session.getAllTools().find((tool) => tool.name === 'run_tests')?.description).toContain(
    'never edit permissions',
  );

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {});",
  );
  const green = await run();

  expect(green.details.kind).toBe('pass');
  expect(green.content[0]?.text).toContain('scope "full"');
  expect((await run()).content).toHaveLength(2);

  await call('bash', { command: "printf '\n' >> behavior.test.ts" });
  const full = await run({ scope: 'full' });

  expect(full.details).toMatchObject({ kind: 'pass', scope: 'full', freshness: 'fresh' });
  expect(full.content).toHaveLength(2);
  expect((await run({ scope: 'full' })).content).toHaveLength(2);

  const edited = await call('write', { path: 'src/value.ts', content: 'export const value = 2;' });

  expect(JSON.stringify(edited.result)).toContain('stale');
  expect(JSON.stringify(edited.result)).not.toContain('RED');
});

it('keeps generated output quiet and hints stale after a layout edit through Pi', async ({
  onTestFinished,
}) => {
  const { cwd, run, call } = await createHarness(onTestFinished);
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {});",
  );
  const verified = await run({ scope: 'full' });

  expect(verified.details).toMatchObject({ kind: 'pass', freshness: 'fresh' });
  const generated = await call('write', {
    path: 'apps/web/dist/page.ts',
    content: 'generated output',
  });

  expect(generated.isError).toBe(false);
  expect(JSON.stringify(generated.result)).not.toContain('Hint:');
  const afterGenerated = await run({ scope: 'full' });

  expect(afterGenerated.details.inputs).toEqual(verified.details.inputs);
  const edited = await call('write', {
    path: 'apps/web/src/page.ts',
    content: 'export const page = 1;',
  });

  expect(edited.isError).toBe(false);
  expect(JSON.stringify(edited.result)).toContain('stale');
  expect(await readFile(join(cwd, 'apps/web/src/page.ts'), 'utf8')).toBe('export const page = 1;');
});

it('recommends full verification for regression checks across Pi session handoffs', async ({
  onTestFinished,
}) => {
  const first = await createHarness(onTestFinished);
  await writeFile(
    join(first.cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {});",
  );
  const regression = await first.run();

  expect(regression.details).toMatchObject({ kind: 'pass', freshness: 'fresh' });
  expect(regression.content[0]?.text).toContain('scope "full"');
  expect(JSON.stringify(regression.content)).not.toContain('RED');
  const second = await createHarness(onTestFinished, [], first.cwd);
  const handoff = await second.run();

  expect(handoff.details).toMatchObject({ kind: 'pass', freshness: 'fresh' });
  expect(handoff.content[0]?.text).toContain('scope "full"');
  expect(JSON.stringify(handoff.content)).not.toContain('RED');
  expect((await second.run()).content).toHaveLength(2);
});

it('counts a full pass without RED and resets observations in another Pi session', async ({
  onTestFinished,
}) => {
  const first = await createHarness(onTestFinished);

  await writeFile(
    join(first.cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required behavior', () => {});",
  );
  expect(await first.run({ scope: 'full' })).toMatchObject({
    details: { kind: 'pass', freshness: 'fresh' },
  });

  const second = await createHarness(onTestFinished, [], first.cwd);
  const result = await second.call('write', {
    path: 'src/value.ts',
    content: 'export const value = 1;',
  });

  expect(result.isError).toBe(false);
  expect(JSON.stringify(result.result)).toContain('RED');
  expect(JSON.stringify(result.result)).not.toContain('stale');
});

it('preserves edit details and errors and ignores old malformed evidence through Pi', async ({
  onTestFinished,
}) => {
  const { cwd, call } = await createHarness(onTestFinished);

  await mkdir(join(cwd, '.tau'));
  await writeFile(join(cwd, '.tau/state.json'), 'corrupt');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  const failed = await call('edit', {
    path: 'src/value.ts',
    edits: [{ oldText: 'missing', newText: '2' }],
  });

  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed.result)).not.toContain('Hint:');

  const edited = await call('edit', {
    path: 'src/value.ts',
    edits: [{ oldText: '= 1', newText: '= 2' }],
  });

  expect(edited.isError).toBe(false);
  expect(edited.result).toHaveProperty('details.diff');
  expect(JSON.stringify(edited.result)).toContain('Hint:');
  expect(await readFile(join(cwd, '.tau/state.json'), 'utf8')).toBe('corrupt');
  expect(
    (await call('write', { path: 'package.json', content: '{"type":"module"}' })).isError,
  ).toBe(false);
});

it('keeps actual test failures when a sibling bash edits inputs during the run', async ({
  onTestFinished,
}) => {
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
      details: {
        kind: 'fail',
        freshness: 'stale',
        report: { kind: 'fail', tests: [{ status: 'failed' }] },
      },
    },
  });
});

it('serializes overlapping calls through pi', async ({ onTestFinished }) => {
  const { cwd, session, faux, events } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; import { appendFile } from 'node:fs/promises'; it('required behavior', async () => { await appendFile('order', 'start\\n'); await new Promise(r => setTimeout(r, 100)); await appendFile('order', 'end\\n'); });",
  );
  const parameters = {
    behavior: 'required behavior',
    testFullName: 'required behavior',
    files: ['behavior.test.ts'],
    scope: 'focused',
  };
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall('run_tests', parameters),
      fauxToolCall('run_tests', parameters),
    ]),
    fauxAssistantMessage('Done.'),
  ]);

  await session.prompt('Run twice concurrently.');

  expect(
    events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'run_tests'),
  ).toHaveLength(2);
  expect(await readFile(join(cwd, 'order'), 'utf8')).toBe('start\nend\nstart\nend\n');
});

it('appends production hints through a symlinked Pi cwd', async ({ onTestFinished }) => {
  const cwd = await createWorktree(onTestFinished);
  const alias = `${cwd}-hint-alias`;

  await symlink(cwd, alias, 'dir');
  onTestFinished(() => rm(alias, { force: true }));
  const { call } = await createHarness(onTestFinished, [], alias);
  const written = await call('write', { path: 'src/value.ts', content: 'export const value = 1;' });

  expect(written.isError).toBe(false);
  expect(JSON.stringify(written.result)).toContain('RED');
  expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 1;');

  const second = await createHarness(onTestFinished, [], alias);
  const edited = await second.call('edit', {
    path: join(alias, 'src/value.ts'),
    edits: [{ oldText: '= 1', newText: '= 2' }],
  });

  expect(edited.isError).toBe(false);
  expect(JSON.stringify(edited.result)).toContain('RED');
  expect(edited.result).toHaveProperty('details.diff');
});

it('keeps the full report while shortening displayed output', async ({ onTestFinished }) => {
  const { cwd, run } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    `import { it } from 'vitest'; it('required behavior', () => {}); ${Array.from({ length: 100 }, (_, index) => `it('${index} ${'long name '.repeat(20)}', () => {});`).join('\n')}`,
  );
  const result = await run({ scope: 'full' });

  expect(result.details.report).toHaveProperty('tests.length', 101);
  expect(result.content[0]!.text.length).toBeLessThanOrEqual(2000);
  expect(result.content[0]!.text).toContain('101 passed, 0 failed, 0 skipped');
});

it.each(['../outside.test.ts', 'src/value.ts', '/absolute.test.ts', '*.test.ts'])(
  'rejects invalid test paths through Pi: %s',
  async (file) => {
    const { call } = await createHarness(registerCleanup);
    const result = await call('run_tests', {
      behavior: 'behavior',
      testFullName: 'required',
      files: [file],
      scope: 'focused',
    });

    expect(result.isError).toBe(true);
  },
);

it('selects exact nested names including regular expression characters through a symlinked worktree', async ({
  onTestFinished,
}) => {
  const cwd = await createWorktree(onTestFinished);
  const alias = `${cwd}-alias`;

  await symlink(cwd, alias, 'dir');
  onTestFinished(() => rm(alias, { force: true }));
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { describe, it } from 'vitest'; describe('outer', () => { it('works (1)+', () => {}); it('works 11', () => { throw Error('not selected'); }); });",
  );

  const { run } = await createHarness(onTestFinished, [], alias);
  const result = await run({ testFullName: ['outer works (1)+'] });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ fullname: 'outer works (1)+', status: 'passed' }],
  });
  expect(result.details.report).toHaveProperty('tests.length', 1);
});

it('rejects unformatted files in the real hook without rewriting them', async ({
  onTestFinished,
}) => {
  const cwd = await createWorktree(onTestFinished);
  const git = (argumentsList: string[]) => promisify(execFile)('git', argumentsList, { cwd });

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
  await writeFile(join(cwd, 'vite.config.ts'), await readFile(resolve('vite.config.ts'), 'utf8'));
  await writeFile(join(cwd, 'value.json'), '{"value":1}');
  await git(['add', '--', 'value.json']);

  await expect(git(['commit', '-m', 'test: reject formatting'])).rejects.toThrow(/format/i);
  expect(await readFile(join(cwd, 'value.json'), 'utf8')).toBe('{"value":1}');
  expect((await git(['rev-list', '--all', '--count'])).stdout.trim()).toBe('0');
});

it('runs commit hooks through Pi without approval or TDD notices', async ({ onTestFinished }) => {
  const { cwd, session, call, faux } = await createHarness(onTestFinished);
  vi.stubEnv('TAU_DELEGATE_MODEL', `${faux.getModel().provider}/${faux.getModel().id}`);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const git = (argumentsList: string[]) => promisify(execFile)('git', argumentsList, { cwd });

  await writeFile(join(cwd, '.git/info/exclude'), 'node_modules\n');
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
    "export default { staged: { '*.ts': 'vp fmt --check' } };",
  );
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;\n');

  const custom = vi.fn<() => never>(() => {
    throw new Error('Unexpected approval UI');
  });
  await session.bindExtensions({ uiContext: { custom } as unknown as ExtensionUIContext });
  const committed = await call(
    'commit',
    {
      groups: [{ files: ['src/value.ts', 'package.json'], subject: 'feat: add formatted fixture' }],
    },
    [fauxAssistantMessage('{"findings":[]}')],
  );

  expect(committed.isError && JSON.stringify(committed.result)).toBe(false);
  expect(custom).not.toHaveBeenCalled();
  expect(JSON.stringify(committed.result)).toContain('Git hooks: run');
  expect(JSON.stringify(committed.result)).not.toContain('TDD');
  expect(await readFile(join(cwd, 'src/value.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect((await git(['show', 'HEAD:src/value.ts'])).stdout).toBe('export const value = 1;\n');
});
