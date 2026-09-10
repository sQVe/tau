import { strictEqual } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import type { TestContext } from 'vitest';
import { afterEach, beforeEach, expect, it, onTestFinished as registerCleanup, vi } from 'vitest';

import { guardToolCall } from './guard.js';
import { runTests } from './runner/index.js';
import type { RunnerResult, TestResult } from './runner/types.js';
import { createEvidenceStore, tddGateStatus, unknownGateStatus } from './state.js';

// Keep runner discovery real, including its install and package-change cache tests.
vi.mock(import('./runner/index.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  runTests: vi.fn<typeof runTests>(),
}));

let expectedRuns = 0;

beforeEach(() => {
  expectedRuns = 0;
  vi.mocked(runTests)
    .mockReset()
    .mockImplementation(() => {
      throw new Error('Unexpected runner call: supply a report for this step');
    });
});

afterEach(({ task }) => {
  // A failed test already reported its cause; leftover reports are its symptom, not a second defect.
  if (task.result?.state === 'fail') {
    return;
  }

  strictEqual(vi.mocked(runTests).mock.calls.length, expectedRuns, 'Unused runner reports');
});

const queueReports = (...reports: RunnerResult[]) => {
  expectedRuns += reports.length;

  for (const report of reports) {
    vi.mocked(runTests).mockResolvedValueOnce(report);
  }
};

const result = (
  status: TestResult['status'],
  fullname = 'required',
  file = 'behavior.test.ts',
): TestResult => ({ file, fullname, status });

const pass = (...tests: TestResult[]): RunnerResult => ({
  kind: 'pass',
  tests: tests.length > 0 ? tests : [result('passed')],
});

const fail = (...tests: TestResult[]): RunnerResult => ({
  kind: 'fail',
  tests: tests.length > 0 ? tests : [result('failed')],
  failures: [],
  truncated: false,
});

it('checks active test bytes and accepts restored content', async ({ onTestFinished }) => {
  queueReports(fail(), { kind: 'no-tests-collected', tests: [] }, pass(), pass());

  const cwd = await mkdtemp(join(tmpdir(), 'tau-evidence-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));

  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; it('required', () => expect(1).toBe(2));",
  );

  const store = createEvidenceStore();

  await store.run(
    cwd,
    { behavior: 'behavior', testFullName: 'required', files: ['behavior.test.ts'] },
    'focused',
  );

  expect((await store.read(cwd)).implementationAllowed).toBe(true);

  for (const file of ['behavior.test.ts', 'vite.config.ts', 'package.json']) {
    const path = join(cwd, file);
    const original = await readFile(path);

    await writeFile(path, 'changed');

    expect((await store.read(cwd)).implementationAllowed).toBe(file !== 'behavior.test.ts');

    await writeFile(path, original);

    expect((await store.read(cwd)).implementationAllowed).toBe(true);
  }

  const snapshot = await store.read(cwd);

  expect(snapshot.evidence.reds[0]?.testHashes[join(cwd, 'behavior.test.ts')]).toMatch(
    /^[a-f0-9]{64}$/,
  );

  await store.run(
    cwd,
    { behavior: 'different', testFullName: 'absent', files: ['behavior.test.ts'] },
    'focused',
  );

  expect((await store.read(cwd)).implementationAllowed).toBe(false);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it } from 'vitest'; it('required', () => {});",
  );

  const behavior = { behavior: 'passing', testFullName: 'required', files: ['behavior.test.ts'] };

  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');

  expect(await store.read(cwd)).toMatchObject({ phase: 'verified', fullPassValid: true });

  await writeFile(join(cwd, 'package.json'), '{}');

  expect(await store.read(cwd)).toMatchObject({ phase: 'green', fullPassValid: false });

  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');

  expect(await store.read(cwd)).toMatchObject({ phase: 'verified', fullPassValid: true });
});

it('turns the gate off until a test runner resolves from the worktree', async ({
  onTestFinished,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-no-runner-'));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));

  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');

  const store = createEvidenceStore();

  expect((await store.read(cwd)).notice).toBe('no test runner resolves from this worktree');

  // An install leaves package.json untouched, so the absent answer must not be cached.
  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');

  expect((await store.read(cwd)).notice).toBeUndefined();

  await rm(join(cwd, 'node_modules'));

  expect((await store.read(cwd)).notice).toBeUndefined();

  await writeFile(join(cwd, 'package.json'), '{"type":"module","name":"gated"}');

  expect((await store.read(cwd)).notice).toBe('no test runner resolves from this worktree');
});

const createHarness = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-cycle-'));
  cleanup(() => rm(cwd, { recursive: true, force: true }));

  await symlink(resolve('node_modules'), join(cwd, 'node_modules'), 'dir');
  await writeFile(join(cwd, 'package.json'), '{"type":"module"}');
  await writeFile(join(cwd, 'vite.config.ts'), 'export default {};');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');
  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('required', () => expect(value).toBe(1));",
  );

  const store = createEvidenceStore();
  const behavior = { behavior: 'behavior', testFullName: 'required', files: ['behavior.test.ts'] };

  return { cwd, store, behavior };
};

it('keeps the gate shut for timeout', async ({ onTestFinished }) => {
  queueReports({ kind: 'timeout' });

  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const timedOut = await store.run(cwd, behavior, 'focused');

  expect(timedOut).toMatchObject({
    kind: 'timeout',
    phase: 'locked',
    implementationAllowed: false,
    evidence: { reds: [] },
  });
  expect(
    await guardToolCall(
      {
        type: 'tool_call',
        toolCallId: 'timeout-write',
        toolName: 'write',
        input: { path: 'src/value.ts', content: 'export const value = 1;' },
      },
      cwd,
      store,
    ),
  ).toMatchObject({ block: true });
});

it('refuses full verification when a protected input changed after RED', async ({
  onTestFinished,
}) => {
  queueReports(fail(), pass(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'vite.config.ts'), 'export default { test: {} };');

  expect(await store.run(cwd, behavior, 'full')).toMatchObject({ phase: 'green' });
});

it('allows behavior-preserving production edits after focused GREEN', async ({
  onTestFinished,
}) => {
  queueReports(fail(), pass(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  const edit = {
    type: 'tool_call',
    toolCallId: 'cleanup',
    toolName: 'edit',
    input: { path: 'src/value.ts', oldText: '1', newText: '(1)' },
  } as ToolCallEvent;

  expect(await guardToolCall(edit, cwd, store)).toBeUndefined();

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = (1);');

  expect(await store.read(cwd)).toMatchObject({ phase: 'green', implementationAllowed: true });
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({
    phase: 'verified',
    fullPassValid: true,
  });
});

it('invalidates a focused pass on changed inputs without closing GREEN', async ({
  onTestFinished,
}) => {
  queueReports(fail(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  for (const file of ['src/value.ts', 'behavior.test.ts', 'vite.config.ts']) {
    const path = join(cwd, file);
    const original = await readFile(path, 'utf8');

    await writeFile(path, `${original}\n// changed after the passing run\n`);

    expect(await store.read(cwd)).toMatchObject({
      phase: 'green',
      implementationAllowed: true,
      focusedPassValid: false,
      fullPassValid: false,
    });

    await writeFile(path, original);

    expect(await createEvidenceStore().read(cwd)).toMatchObject({ focusedPassValid: true });
  }
});

it('verifies a shared file after renewing the earlier behavior', async ({ onTestFinished }) => {
  queueReports(
    fail(),
    pass(),
    fail(result('failed', 'second')),
    pass(result('passed', 'second')),
    pass(),
    pass(result('passed'), result('passed', 'second')),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const path = join(cwd, 'behavior.test.ts');

  const originalTest = await readFile(path, 'utf8');
  const amendedTest = originalTest.replace('toBe(1)', 'toBeGreaterThan(0)');

  await writeFile(path, amendedTest);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  const firstTest = await readFile(path, 'utf8');
  const combinedTests = `${firstTest}\nit('second', () => expect(value).toBe(2));`;

  await writeFile(path, combinedTests);

  const second = { ...behavior, behavior: 'second', testFullName: 'second' };

  await store.run(cwd, second, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');

  await store.run(cwd, second, 'focused');

  const passingTests = await readFile(path, 'utf8');

  await writeFile(path, `${passingTests}\n// formatting after both behaviors passed\n`);

  const renewed = await store.run(cwd, behavior, 'focused');

  expect(renewed).toMatchObject({ phase: 'green', focusedPassValid: true });
  expect(await createEvidenceStore().run(cwd, behavior, 'full')).toMatchObject({
    phase: 'verified',
    fullPassValid: true,
  });
});

it('reloads recorded evidence into a new store for the same worktree', async ({
  onTestFinished,
}) => {
  queueReports(fail(), pass(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  expect(await createEvidenceStore().read(cwd)).toMatchObject({
    phase: 'red',
    implementationAllowed: true,
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');

  expect(await createEvidenceStore().read(cwd)).toMatchObject({
    phase: 'verified',
    fullPassValid: true,
  });
});

it('keeps the stored evidence loadable after an interrupted write', async ({ onTestFinished }) => {
  queueReports(fail());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, '.tau/state.json.tmp'), '{"tdd":{"active"');

  expect(JSON.parse(await readFile(join(cwd, '.tau/state.json'), 'utf8'))).toHaveProperty('tdd');
  expect(await createEvidenceStore().read(cwd)).toMatchObject({
    phase: 'red',
    implementationAllowed: true,
  });
});

it('keeps evidence out of another worktree', async ({ onTestFinished }) => {
  queueReports(fail());

  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const other = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  expect(await store.read(other.cwd)).toMatchObject({
    phase: 'locked',
    implementationAllowed: false,
  });
  expect(await createEvidenceStore().read(other.cwd)).toMatchObject({ phase: 'locked' });
});

it('fails loudly when the stored evidence is unreadable', async ({ onTestFinished }) => {
  const { cwd } = await createHarness(onTestFinished);

  await mkdir(join(cwd, '.tau'));
  await writeFile(join(cwd, '.tau/state.json'), '{ not json');

  await expect(createEvidenceStore().read(cwd)).rejects.toThrow(join(cwd, '.tau/state.json'));
});

it('fails loudly when a stored RED lacks its report or hashes', async ({ onTestFinished }) => {
  const { cwd, behavior } = await createHarness(onTestFinished);

  await mkdir(join(cwd, '.tau'));
  await writeFile(join(cwd, '.tau/state.json'), JSON.stringify({ tdd: { reds: [{ behavior }] } }));

  await expect(createEvidenceStore().read(cwd)).rejects.toThrow(join(cwd, '.tau/state.json'));
});

it('reads the repaired evidence after a failed load', async ({ onTestFinished }) => {
  const { cwd } = await createHarness(onTestFinished);

  await mkdir(join(cwd, '.tau'));
  await writeFile(join(cwd, '.tau/state.json'), '{ not json');

  const store = createEvidenceStore();

  await expect(store.read(cwd)).rejects.toThrow(join(cwd, '.tau/state.json'));

  await writeFile(join(cwd, '.tau/state.json'), '{"tdd":{"reds":[],"active":null}}');

  expect(await store.read(cwd)).toMatchObject({ phase: 'locked' });
});

it('loads the previous evidence shape locked while preserving gate and proven tests', async ({
  onTestFinished,
}) => {
  queueReports(fail());

  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const recorded = await store.run(cwd, behavior, 'focused');
  const entry = recorded.evidence.reds[0]!;
  const record = {
    before: entry.testHashes,
    after: entry.testHashes,
    report: entry.report,
    greened: true,
    renewed: entry.testHashes,
  };
  const gateOff = { since: '2026-09-08T00:00:00.000Z' };
  const proven = [{ file: 'behavior.test.ts', fullname: 'required' }];

  await writeFile(
    join(cwd, '.tau/state.json'),
    JSON.stringify({
      tdd: {
        active: behavior,
        reds: [{ behavior, record }],
        red: record,
        focusedPass: record,
        fullPass: record,
        latestRun: record,
        verified: true,
        gateOff,
        proven,
      },
    }),
  );

  const reloaded = createEvidenceStore();

  expect(await reloaded.read(cwd)).toMatchObject({
    phase: 'locked',
    evidence: { phase: 'locked', gateOff, proven },
    notice: `TDD gate off since ${gateOff.since}`,
  });

  await reloaded.setGate(cwd, 'on');

  expect(await reloaded.read(cwd)).toMatchObject({
    phase: 'locked',
    implementationAllowed: false,
  });
});

it('leaves the recorded evidence untouched when a run is aborted', async ({ onTestFinished }) => {
  queueReports(fail(), { kind: 'cancelled' });

  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const red = await store.run(cwd, behavior, 'focused');

  const signal = AbortSignal.abort();
  const aborted = await store.run(cwd, behavior, 'full', signal);

  expect(runTests).toHaveBeenLastCalledWith({ cwd, scope: 'all', signal });
  expect(aborted).toMatchObject({ kind: 'cancelled', phase: 'red' });
  expect(await store.read(cwd)).toMatchObject({
    phase: 'red',
    evidence: { reds: red.evidence.reds },
  });
});

it('requires RED and a final full pass to verify', async ({ onTestFinished }) => {
  queueReports(
    pass(),
    fail(),
    pass(),
    fail(result('passed'), result('failed', 'other', 'other.test.ts')),
    pass(result('passed'), result('passed', 'other', 'other.test.ts')),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, behavior, 'full')).toMatchObject({
    phase: 'locked',
    fullPassValid: false,
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    phase: 'red',
    fullPassValid: false,
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    phase: 'green',
    fullPassValid: false,
  });

  await writeFile(
    join(cwd, 'other.test.ts'),
    "import { it, expect } from 'vitest'; it('other', () => expect(1).toBe(2));",
  );

  expect(await store.run(cwd, behavior, 'full')).toMatchObject({
    phase: 'green',
    fullPassValid: false,
  });

  await writeFile(
    join(cwd, 'other.test.ts'),
    "import { it } from 'vitest'; it('other', () => {});",
  );

  expect(await store.run(cwd, behavior, 'full')).toMatchObject({
    phase: 'verified',
    fullPassValid: true,
  });
});

it('keeps GREEN after production changes invalidate verification', async ({ onTestFinished }) => {
  queueReports(fail(), pass(), pass(), pass(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.read(cwd)).toMatchObject({ phase: 'red', implementationAllowed: true });

  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');

  expect(await store.read(cwd)).toMatchObject({ phase: 'verified' });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');

  expect(await store.read(cwd)).toMatchObject({
    phase: 'green',
    focusedPassValid: false,
    fullPassValid: false,
    implementationAllowed: true,
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');

  await writeFile(join(cwd, 'src/added.ts'), 'export const added = 1;');

  expect(await store.read(cwd)).toMatchObject({
    phase: 'green',
    fullPassValid: false,
    focusedPassValid: false,
  });

  await rm(join(cwd, 'src/added.ts'));
  await rm(join(cwd, 'src/value.ts'));

  expect(await store.read(cwd)).toMatchObject({
    phase: 'green',
    fullPassValid: false,
    focusedPassValid: false,
  });
});

it('renews RED for a test amended after GREEN and remembers the edit', async ({
  onTestFinished,
}) => {
  queueReports(fail(), pass(), pass(), pass(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  const test = join(cwd, 'behavior.test.ts');

  const originalTest = await readFile(test, 'utf8');
  const amendedTest = originalTest.replace('toBe(1)', 'toBeGreaterThan(0)');

  await writeFile(test, amendedTest);

  expect(await store.read(cwd)).toMatchObject({
    phase: 'green',
    implementationAllowed: true,
    focusedPassValid: false,
  });

  const renewed = await store.run(cwd, behavior, 'focused');

  expect(renewed).toMatchObject({ kind: 'pass', phase: 'green' });
  expect(renewed.evidence.reds[0]?.edited).toBe(true);
  expect(await createEvidenceStore().read(cwd)).toMatchObject({ phase: 'green' });
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({ phase: 'verified' });

  // Protected inputs affect verification, but do not discard the behavior's RED.
  await writeFile(join(cwd, 'vite.config.ts'), 'export default { test: {} };');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    kind: 'pass',
    phase: 'green',
  });
});

it('renews a test amended after the fix but before GREEN and records the edit', async ({
  onTestFinished,
}) => {
  queueReports(fail(), pass(), fail(), pass(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  const test = join(cwd, 'behavior.test.ts');

  const originalTest = await readFile(test, 'utf8');
  const amendedTest = originalTest.replace('toBe(1)', 'toBeGreaterThan(0)');

  await writeFile(test, amendedTest);

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    kind: 'pass',
    phase: 'green',
    implementationAllowed: true,
    evidence: { reds: [{ edited: true }] },
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 0;');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    kind: 'fail',
    phase: 'red',
    implementationAllowed: true,
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ phase: 'green' });
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({ phase: 'verified' });
});

it.each(['skip', 'delete', 'amend'])(
  'requires earlier RED to remain intact after %s',
  async (change) => {
    const earlier = change === 'delete' ? [] : [result(change === 'skip' ? 'skipped' : 'passed')];

    queueReports(
      fail(),
      pass(),
      fail(result('failed', 'second', 'second.test.ts')),
      pass(result('passed', 'second', 'second.test.ts')),
      pass(...earlier, result('passed', 'second', 'second.test.ts')),
    );

    const { cwd, store, behavior } = await createHarness(registerCleanup);

    await writeFile(
      join(cwd, 'second.test.ts'),
      "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBeGreaterThanOrEqual(2));",
    );

    await store.run(cwd, behavior, 'focused');

    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

    await store.run(cwd, behavior, 'focused');

    const second = { behavior: 'second', testFullName: 'second', files: ['second.test.ts'] };

    await store.run(cwd, second, 'focused');

    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');

    await store.run(cwd, second, 'focused');

    const path = join(cwd, 'behavior.test.ts');

    if (change === 'delete') {
      await rm(path);
    } else {
      const originalTest = await readFile(path, 'utf8');
      const amendedTest = originalTest.replace(
        change === 'skip' ? "it('required'" : 'toBe(1)',
        change === 'skip' ? "it.skip('required'" : 'toBe(2)',
      );

      await writeFile(path, amendedTest);
    }

    expect(await store.run(cwd, second, 'full')).toMatchObject({
      kind: 'pass',
      fullPassValid: false,
    });
  },
);

it('drops earlier REDs once a verified full pass closes the task', async ({ onTestFinished }) => {
  const { cwd, store } = await createHarness(onTestFinished);

  const cycle = async (index: number) => {
    const behavior = {
      behavior: `behavior ${index}`,
      testFullName: `behavior ${index}`,
      files: [`behavior${index}.test.ts`],
    };

    await writeFile(
      join(cwd, behavior.files[0]!),
      `import { it, expect } from 'vitest'; import { value } from './src/value'; it('behavior ${index}', () => expect(value).toBeGreaterThanOrEqual(${index}));`,
    );

    const fullname = `behavior ${index}`;
    const file = behavior.files[0]!;
    const passed = Array.from({ length: index }, (_, offset) =>
      result(
        'passed',
        offset === 0 && index === 4 ? 'renamed' : `behavior ${offset + 1}`,
        `behavior${offset + 1}.test.ts`,
      ),
    );

    queueReports(
      fail(result('failed', fullname, file)),
      pass(result('passed', fullname, file)),
      pass(...passed),
    );

    expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ phase: 'red' });

    await writeFile(join(cwd, 'src/value.ts'), `export const value = ${index};`);

    await store.run(cwd, behavior, 'focused');

    return store.run(cwd, behavior, 'full');
  };

  await rm(join(cwd, 'behavior.test.ts'));

  for (const index of [1, 2, 3]) {
    expect(await cycle(index)).toMatchObject({ phase: 'verified' });
  }

  const path = join(cwd, 'behavior1.test.ts');

  const originalTest = await readFile(path, 'utf8');
  const renamedTest = originalTest.replaceAll('behavior 1', 'renamed');

  await writeFile(path, renamedTest);

  expect(await cycle(4)).toMatchObject({ phase: 'verified', fullPassValid: true });
});

it('rejects a skipped earlier RED even when its test hash is unchanged', async ({
  onTestFinished,
}) => {
  queueReports(
    fail(),
    pass(),
    fail(result('failed', 'second', 'second.test.ts')),
    pass(result('passed', 'second', 'second.test.ts')),
    pass(result('skipped'), result('passed', 'second', 'second.test.ts')),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it.skipIf(value === 2)('required', () => expect(value).toBeGreaterThanOrEqual(1));",
  );
  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBe(2));",
  );

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  const second = { behavior: 'second', testFullName: 'second', files: ['second.test.ts'] };

  await store.run(cwd, second, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');

  await store.run(cwd, second, 'focused');

  expect(await store.run(cwd, second, 'full')).toMatchObject({
    kind: 'pass',
    phase: 'green',
    fullPassValid: false,
  });
});

it('renews a shared test file only for the RED that failed inside it', async ({
  onTestFinished,
}) => {
  queueReports(
    fail(),
    pass(),
    fail(result('failed', 'second', 'second.test.ts')),
    pass(result('passed', 'second', 'second.test.ts')),
    pass(result('passed'), result('passed', 'second', 'second.test.ts')),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  const path = join(cwd, 'behavior.test.ts');

  const originalTest = await readFile(path, 'utf8');
  const amendedTest = originalTest.replace('toBe(1)', 'toBeGreaterThan(0)');

  await writeFile(path, amendedTest);
  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBe(2));",
  );

  const second = {
    behavior: 'second',
    testFullName: 'second',
    files: ['second.test.ts', 'behavior.test.ts'],
  };

  expect(await store.run(cwd, second, 'focused')).toMatchObject({ phase: 'red' });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');

  await store.run(cwd, second, 'focused');

  expect(await store.run(cwd, second, 'full')).toMatchObject({
    kind: 'pass',
    fullPassValid: false,
  });
});

it('treats the same behavior with reordered files as unchanged', async ({ onTestFinished }) => {
  queueReports(fail(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it } from 'vitest'; it('second', () => {});",
  );

  const files = ['behavior.test.ts', 'second.test.ts'];

  expect(await store.run(cwd, { ...behavior, files }, 'focused')).toMatchObject({ phase: 'red' });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, { ...behavior, files: files.toReversed() }, 'focused')).toMatchObject(
    { phase: 'green' },
  );
});

it('never accepts a missing required test file as evidence', async ({ onTestFinished }) => {
  queueReports(fail(), pass(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const selection = { ...behavior, files: [...behavior.files, 'deleted.test.ts'] };

  expect(await store.run(cwd, selection, 'focused')).toMatchObject({
    phase: 'locked',
    implementationAllowed: false,
    evidence: { reds: [] },
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, selection, 'focused')).toMatchObject({ focusedPassValid: false });
  expect(await store.run(cwd, selection, 'full')).toMatchObject({
    phase: 'locked',
    fullPassValid: false,
  });
});

it('invalidates verification when the rest of the suite changes', async ({ onTestFinished }) => {
  queueReports(
    fail(),
    pass(),
    pass(),
    pass(result('passed'), result('passed', 'other', 'other.test.ts')),
    pass(result('passed'), result('passed', 'changed', 'other.test.ts')),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, behavior, 'full');

  const path = join(cwd, 'other.test.ts');

  await writeFile(path, "import { it } from 'vitest'; it('other', () => {});");

  expect(await store.read(cwd)).toMatchObject({ phase: 'green', fullPassValid: false });

  await store.run(cwd, behavior, 'full');

  await writeFile(path, "import { it } from 'vitest'; it('changed', () => {});");

  expect(await store.read(cwd)).toMatchObject({ phase: 'green', fullPassValid: false });

  await store.run(cwd, behavior, 'full');

  await rm(path);

  expect(await store.read(cwd)).toMatchObject({ phase: 'green', fullPassValid: false });
});

it.each(['skip', 'todo', 'delete'])(
  'rejects a required test changed to %s at both steps',
  async (change) => {
    const tests = change === 'delete' ? [] : [result(change === 'skip' ? 'skipped' : 'todo')];

    queueReports(
      fail(),
      pass(),
      { kind: 'no-tests-collected', tests },
      { kind: 'no-tests-collected', tests },
    );

    const { cwd, store, behavior } = await createHarness(registerCleanup);

    await store.run(cwd, behavior, 'focused');

    await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

    await store.run(cwd, behavior, 'focused');

    const path = join(cwd, 'behavior.test.ts');

    if (change === 'delete') {
      await rm(path);
    } else {
      const originalTest = await readFile(path, 'utf8');
      const amendedTest = originalTest.replace("it('required'", `it.${change}('required'`);

      await writeFile(path, amendedTest);
    }

    expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
      phase: 'green',
      focusedPassValid: false,
      implementationAllowed: true,
    });
    expect(await store.run(cwd, behavior, 'full')).toMatchObject({
      phase: 'green',
      fullPassValid: false,
    });
  },
);

it('records nothing when one file holds two tests with the same full name', async ({
  onTestFinished,
}) => {
  queueReports(fail(result('failed'), result('passed')), fail(result('passed'), result('failed')));

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value';" +
      " it('required', () => expect(value).toBe(1)); it('required', () => expect(value).toBe(0));",
  );

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    kind: 'fail',
    phase: 'locked',
    implementationAllowed: false,
    evidence: { reds: [] },
  });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({
    phase: 'locked',
    focusedPassValid: false,
  });
});

it('requires the same failing test file when full names collide', async ({ onTestFinished }) => {
  queueReports(
    fail(result('failed'), result('passed', 'required', 'other.test.ts')),
    pass(result('skipped'), result('passed', 'required', 'other.test.ts')),
    pass(result('skipped'), result('passed', 'required', 'other.test.ts')),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it.skipIf(value === 1)('required', () => expect(value).toBe(1));",
  );
  await writeFile(
    join(cwd, 'other.test.ts'),
    "import { it } from 'vitest'; it('required', () => {});",
  );

  const selection = { ...behavior, files: [...behavior.files, 'other.test.ts'] };

  await store.run(cwd, selection, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, selection, 'focused')).toMatchObject({
    phase: 'red',
    focusedPassValid: false,
  });
  expect(await store.run(cwd, selection, 'full')).toMatchObject({
    phase: 'red',
    fullPassValid: false,
  });
});

it('turns the gate off through the switch and back on', async ({ onTestFinished }) => {
  queueReports(fail());

  const { cwd, store, behavior } = await createHarness(onTestFinished);
  const write: ToolCallEvent = {
    type: 'tool_call',
    toolCallId: 'call-1',
    toolName: 'write',
    input: { path: 'src/value.ts' },
  };

  expect((await guardToolCall(write, cwd, store))?.block).toBe(true);

  await store.setGate(cwd, 'off');

  const off = await store.read(cwd);

  expect(off.phase).toBe('locked');
  expect(off.notice).toMatch(/^TDD gate off since \d{4}-/);
  expect(await guardToolCall(write, cwd, store)).toBeUndefined();
  expect(await tddGateStatus(cwd)).toBe(off.notice);
  expect((await createEvidenceStore().read(cwd)).notice).toBe(off.notice);

  await store.run(cwd, behavior, 'focused');

  await store.setGate(cwd, 'on');

  const on = await store.read(cwd);

  expect(on.notice).toBeUndefined();
  expect(on.phase).toBe('red');
  expect(on.evidence.reds[0]?.report.kind).toBe('fail');
  expect(await tddGateStatus(cwd)).toBeUndefined();
});

it('reports an unreadable evidence file instead of a gate that is on', async ({
  onTestFinished,
}) => {
  const { cwd } = await createHarness(onTestFinished);

  expect(await tddGateStatus(cwd)).toBeUndefined();

  await mkdir(join(cwd, '.tau'), { recursive: true });
  await writeFile(join(cwd, '.tau/state.json'), '{"tdd":{"active"');

  await expect(tddGateStatus(cwd)).rejects.toThrow('Unreadable test evidence');
  expect(unknownGateStatus(cwd)).toBe(
    `TDD gate status unknown: unreadable evidence at ${join(cwd, '.tau/state.json')}`,
  );
});

it('keeps evidence when the same behavior arrives with reordered fields', async ({
  onTestFinished,
}) => {
  queueReports(fail(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(
    cwd,
    { files: behavior.files, testFullName: behavior.testFullName, behavior: behavior.behavior },
    'focused',
  );

  expect((await store.read(cwd)).phase).toBe('green');
});

it('keeps RED when a vitest configuration appears', async ({ onTestFinished }) => {
  queueReports(fail());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  expect((await store.read(cwd)).implementationAllowed).toBe(true);

  await writeFile(join(cwd, 'vitest.config.ts'), 'export default { test: { exclude: ["**"] } };');

  expect((await store.read(cwd)).implementationAllowed).toBe(true);
});

it('keeps a proven RED when the agent returns to an earlier behavior', async ({
  onTestFinished,
}) => {
  queueReports(
    fail(),
    pass(),
    fail(result('failed', 'second', 'second.test.ts')),
    pass(result('passed', 'second', 'second.test.ts')),
    pass(),
    pass(result('passed', 'second', 'second.test.ts')),
    fail(),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBeGreaterThanOrEqual(2));",
  );

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');

  const second = { behavior: 'second', testFullName: 'second', files: ['second.test.ts'] };

  await store.run(cwd, second, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');

  expect(await store.run(cwd, second, 'focused')).toMatchObject({ phase: 'green' });

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('required', () => expect(value).toBe(2));",
  );

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ kind: 'pass', phase: 'green' });

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('required', () => expect(value).toBe(1));",
  );

  expect(await store.run(cwd, second, 'focused')).toMatchObject({ phase: 'green' });
  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ kind: 'fail', phase: 'red' });
});

it('treats a relabeled behavior as the same behavior', async ({ onTestFinished }) => {
  queueReports(fail(), pass());

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await store.run(cwd, behavior, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  const relabeled = await store.run(cwd, { ...behavior, behavior: 'renamed' }, 'focused');

  expect(relabeled).toMatchObject({
    phase: 'green',
    evidence: { active: { behavior: 'renamed' } },
  });
});

it('proves one behavior with several named tests together', async ({ onTestFinished }) => {
  queueReports(
    fail(result('failed', 'is one'), result('failed', 'is positive')),
    fail(result('failed', 'is one'), result('passed', 'is positive')),
    pass(result('passed', 'is one'), result('passed', 'is positive')),
    pass(result('passed', 'is one'), result('passed', 'is positive'), result('passed', 'other')),
    pass(result('passed', 'is one')),
    pass(result('passed', 'is one')),
  );

  const { cwd, store } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'behavior.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('is one', () => expect(value).toBe(1)); it('is positive', () => expect(value).toBeGreaterThan(0)); it('other', () => {});",
  );

  const behavior = {
    behavior: 'pair',
    testFullName: ['is positive', 'is one'],
    files: ['behavior.test.ts'],
  };
  const red = await store.run(cwd, behavior, 'focused');

  expect(red).toMatchObject({ kind: 'fail', phase: 'red' });
  expect(red.evidence.active?.testFullName).toEqual(['is one', 'is positive']);
  expect(red.evidence.proven.map((entry) => entry.fullname)).toEqual(['is one', 'is positive']);

  // Both tests must pass before the behavior can reach GREEN.
  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 2;');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ kind: 'fail', phase: 'red' });

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  expect(await store.run(cwd, behavior, 'focused')).toMatchObject({ kind: 'pass', phase: 'green' });
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({ phase: 'verified' });

  // A single name in an array is the same behavior as the plain string.
  const single = { behavior: 'one', testFullName: ['is one'], files: ['behavior.test.ts'] };
  const plain = { ...single, testFullName: 'is one' };

  await store.run(cwd, single, 'focused');

  expect((await store.run(cwd, plain, 'focused')).evidence.active?.testFullName).toBe('is one');
});

it('keeps recorded REDs when returning to a behavior after a verified full pass', async ({
  onTestFinished,
}) => {
  queueReports(
    fail(),
    fail(result('failed', 'second', 'second.test.ts')),
    pass(),
    pass(result('passed', 'second', 'second.test.ts')),
    pass(result('passed'), result('passed', 'second', 'second.test.ts')),
    pass(),
    pass(result('passed'), result('passed', 'second', 'second.test.ts')),
    fail(result('failed', 'third', 'third.test.ts')),
  );

  const { cwd, store, behavior } = await createHarness(onTestFinished);

  await writeFile(
    join(cwd, 'second.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('second', () => expect(value).toBe(1));",
  );

  const second = { behavior: 'second', testFullName: 'second', files: ['second.test.ts'] };

  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, second, 'focused');

  await writeFile(join(cwd, 'src/value.ts'), 'export const value = 1;');

  await store.run(cwd, behavior, 'focused');
  await store.run(cwd, second, 'focused');

  expect(await store.run(cwd, second, 'full')).toMatchObject({ phase: 'verified' });

  const test = join(cwd, 'behavior.test.ts');

  const originalTest = await readFile(test, 'utf8');

  await writeFile(test, `${originalTest}\n`);

  const revisited = await store.run(cwd, behavior, 'focused');

  expect(revisited).toMatchObject({ kind: 'pass', phase: 'green' });
  expect(revisited.evidence.reds).toHaveLength(2);
  expect(await store.run(cwd, behavior, 'full')).toMatchObject({ phase: 'verified' });

  // A new behavior after verification starts the next task without the previous task's REDs.
  await writeFile(
    join(cwd, 'third.test.ts'),
    "import { it, expect } from 'vitest'; import { value } from './src/value'; it('third', () => expect(value).toBe(3));",
  );

  const third = await store.run(
    cwd,
    { behavior: 'third', testFullName: 'third', files: ['third.test.ts'] },
    'focused',
  );

  expect(third).toMatchObject({ kind: 'fail', phase: 'red' });
  expect(third.evidence.reds.map((entry) => entry.behavior.behavior)).toEqual(['third']);
});
