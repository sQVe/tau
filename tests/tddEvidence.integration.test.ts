import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { createHarness } from './tddHarness.js';

vi.setConfig({ testTimeout: 125_000 });

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

it.for([
  {
    scenario: 'assertion failure',
    body: 'expect(run()).toBe(2)',
    implementation: 'return 1;',
    expectedHint: /^$/,
  },
  {
    scenario: 'production TypeError',
    body: 'run()',
    implementation: 'return null.value;',
    expectedHint: /TypeError.*expected behavior/i,
  },
  {
    scenario: 'missing dynamic import',
    body: "await import('./missing.js')",
    implementation: 'return 1;',
    expectedHint: /Error.*expected behavior/i,
  },
])(
  'keeps advice separate from real Vitest failure evidence for $scenario',
  async ({ body, implementation, expectedHint }, { onTestFinished }) => {
    const { cwd, run, call } = await createHarness(onTestFinished);
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src/value.js'), `export function run() { ${implementation} }`);
    await writeFile(
      join(cwd, 'behavior.test.ts'),
      `import { it, expect } from 'vitest'; import { run } from './src/value.js'; it('required behavior', async () => { ${body}; });`,
    );

    const result = await run();

    expect(result.details).toMatchObject({
      kind: 'fail',
      freshness: 'fresh',
      report: { kind: 'fail' },
    });

    const hint = result.content.find((block) => block.text.startsWith('Hint:'))?.text;

    expect(hint ?? '').toMatch(expectedHint);

    const edited = await call('write', {
      path: 'src/value.js',
      content: 'export function run() { return 2; }',
    });

    expect(edited.isError).toBe(false);
    expect(await readFile(join(cwd, 'src/value.js'), 'utf8')).toContain('return 2;');
  },
);

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
