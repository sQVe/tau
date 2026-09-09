import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TestContext } from 'vitest';
import { expect, it, onTestFinished, vi } from 'vitest';

import { protectedPaths } from './config.js';
import { guardToolCall } from './guard.js';
import { runTests, runnerAvailable } from './runner/index.js';
import type { RunnerResult, TestResult } from './runner/types.js';
import { createEvidenceStore, tddGateStatus } from './state.js';
import type { Behavior, Phase } from './types.js';

vi.mock('./runner/index.js', () => ({
  runTests: vi.fn<typeof runTests>(),
  runnerAvailable: vi.fn<typeof runnerAvailable>(() => true),
}));

// Check the stored phase separately from the phase reported after hashing files.
type Event =
  | 'read'
  | 'focusedFail'
  | 'focusedPass'
  | 'focusedLoadError'
  | 'focusedTimeout'
  | 'focusedNoTests'
  | 'focusedCancelled'
  | 'focusedAmbiguousFail'
  | 'focusedAmbiguousPass'
  | 'fullPass'
  | 'fullFail'
  | 'fullLoadError'
  | 'fullTimeout'
  | 'fullNoTests'
  | 'fullCancelled'
  | 'fullSkipped'
  | 'fullMissing'
  | 'fullAmbiguous'
  | 'testEdit'
  | 'focusedRenew'
  | 'productionEditThroughBash'
  | 'otherTestEdit'
  | 'protectedEdit'
  | 'switchKnown'
  | 'switchNew'
  | 'legacyReload'
  | 'noPhaseReload';

interface Expected {
  storedPhase: Phase;
  phase: Phase;
  implementationAllowed: boolean;
  reds: string[];
}

const locked: Expected = {
  storedPhase: 'locked',
  phase: 'locked',
  implementationAllowed: false,
  reds: ['previous'],
};

const red: Expected = {
  storedPhase: 'red',
  phase: 'red',
  implementationAllowed: true,
  reds: ['current', 'previous'],
};

const green: Expected = {
  ...red,
  storedPhase: 'green',
  phase: 'green',
  implementationAllowed: true,
};

const verified: Expected = {
  ...green,
  storedPhase: 'verified',
  phase: 'verified',
  implementationAllowed: false,
};

// Every event is explicit in every phase. Do not fill missing cells with defaults or a spread.
const transitions: Record<Phase, Record<Event, Expected>> = {
  locked: {
    read: locked,
    focusedFail: red,
    focusedPass: locked,
    focusedLoadError: locked,
    focusedTimeout: locked,
    focusedNoTests: locked,
    focusedCancelled: locked,
    focusedAmbiguousFail: locked,
    focusedAmbiguousPass: locked,
    fullPass: locked,
    fullFail: locked,
    fullLoadError: locked,
    fullTimeout: locked,
    fullNoTests: locked,
    fullCancelled: locked,
    fullSkipped: locked,
    fullMissing: locked,
    fullAmbiguous: locked,
    testEdit: locked,
    focusedRenew: locked,
    productionEditThroughBash: locked,
    otherTestEdit: locked,
    protectedEdit: locked,
    switchKnown: { ...green, reds: ['previous'] },
    switchNew: { ...locked, reds: locked.reds },
    legacyReload: { ...locked, reds: locked.reds },
    noPhaseReload: { ...locked, reds: [] },
  },
  red: {
    read: red,
    focusedFail: red,
    focusedPass: green,
    focusedLoadError: red,
    focusedTimeout: red,
    focusedNoTests: red,
    focusedCancelled: red,
    focusedAmbiguousFail: red,
    focusedAmbiguousPass: red,
    fullPass: verified,
    fullFail: red,
    fullLoadError: red,
    fullTimeout: red,
    fullNoTests: red,
    fullCancelled: red,
    fullSkipped: red,
    fullMissing: red,
    fullAmbiguous: red,
    testEdit: { ...red, phase: 'locked', implementationAllowed: false },
    focusedRenew: green,
    productionEditThroughBash: red,
    otherTestEdit: red,
    protectedEdit: red,
    switchKnown: green,
    switchNew: { ...locked, reds: red.reds },
    legacyReload: { ...locked, reds: red.reds },
    noPhaseReload: { ...locked, reds: [] },
  },
  green: {
    read: green,
    focusedFail: red,
    focusedPass: green,
    focusedLoadError: green,
    focusedTimeout: green,
    focusedNoTests: green,
    focusedCancelled: green,
    focusedAmbiguousFail: green,
    focusedAmbiguousPass: green,
    fullPass: verified,
    fullFail: green,
    fullLoadError: green,
    fullTimeout: green,
    fullNoTests: green,
    fullCancelled: green,
    fullSkipped: green,
    fullMissing: green,
    fullAmbiguous: green,
    testEdit: green,
    focusedRenew: green,
    productionEditThroughBash: green,
    otherTestEdit: green,
    protectedEdit: green,
    switchKnown: green,
    switchNew: { ...locked, reds: green.reds },
    legacyReload: { ...locked, reds: green.reds },
    noPhaseReload: { ...locked, reds: [] },
  },
  verified: {
    read: verified,
    focusedFail: red,
    focusedPass: green,
    focusedLoadError: verified,
    focusedTimeout: verified,
    focusedNoTests: verified,
    focusedCancelled: verified,
    focusedAmbiguousFail: verified,
    focusedAmbiguousPass: verified,
    fullPass: verified,
    fullFail: green,
    fullLoadError: green,
    fullTimeout: green,
    fullNoTests: green,
    fullCancelled: green,
    fullSkipped: green,
    fullMissing: green,
    fullAmbiguous: green,
    testEdit: { ...verified, phase: 'green', implementationAllowed: true },
    focusedRenew: green,
    productionEditThroughBash: { ...verified, phase: 'green', implementationAllowed: true },
    otherTestEdit: { ...verified, phase: 'green', implementationAllowed: true },
    protectedEdit: { ...verified, phase: 'green', implementationAllowed: true },
    switchKnown: green,
    switchNew: { ...locked, reds: [] },
    legacyReload: { ...locked, reds: verified.reds },
    noPhaseReload: { ...locked, reds: [] },
  },
};

const current: Behavior = {
  behavior: 'current',
  testFullName: ['required', 'also required'],
  files: ['behavior.test.ts'],
};

const previous: Behavior = {
  behavior: 'previous',
  testFullName: 'earlier',
  files: ['previous.test.ts'],
};

const fresh: Behavior = { behavior: 'new', testFullName: 'new', files: ['other.test.ts'] };

const results = (behavior: Behavior, status: TestResult['status']): TestResult[] =>
  [behavior.testFullName]
    .flat()
    .map((fullname) => ({ file: behavior.files[0]!, fullname, status }));

const pass = (
  tests = [...results(current, 'passed'), ...results(previous, 'passed')],
): RunnerResult => ({ kind: 'pass', tests });

const fail = (behavior = current): RunnerResult => ({
  kind: 'fail',
  tests: results(behavior, 'failed'),
  failures: [],
  truncated: false,
});

// Reuse state.test.ts's createHarness layout locally: importing that test would register its
// real-runner suite. No node_modules symlink is needed because both runner exports are mocked.
const createHarness = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = await mkdtemp(join(tmpdir(), 'tau-transitions-'));
  cleanup(() => rm(cwd, { recursive: true, force: true }));

  await mkdir(join(cwd, 'src'));

  for (const [file, content] of Object.entries({
    'package.json': '{"type":"module"}',
    'vite.config.ts': 'export default {};',
    'src/value.ts': 'export const value = 0;',
    'behavior.test.ts': '// current behavior',
    'previous.test.ts': '// previous behavior',
    'other.test.ts': '// unrelated behavior',
  })) {
    await writeFile(join(cwd, file), content);
  }

  const store = createEvidenceStore();

  const run = (report: RunnerResult, scope: 'focused' | 'full' = 'focused', behavior = current) => {
    vi.mocked(runTests).mockResolvedValueOnce(report);

    return store.run(cwd, behavior, scope);
  };

  // A second entry catches accidental clearing and full runs that check only the active RED.
  await run(fail(previous), 'focused', previous);
  await run(pass(results(previous, 'passed')), 'focused', previous);

  return { cwd, store, run };
};

type Harness = Awaited<ReturnType<typeof createHarness>>;

// One script per starting phase; setup uses run(), never an invented stored-state fixture.
const reach: Record<Phase, (harness: Harness) => Promise<unknown>> = {
  locked: (harness) => harness.run({ kind: 'timeout' }),
  red: (harness) => harness.run(fail()),
  green: async (harness) => {
    await reach.red(harness);

    await harness.run(pass());
  },
  verified: async (harness) => {
    await reach.green(harness);

    await harness.run(pass(), 'full');
  },
};

const digest = async (cwd: string, file: string) => {
  const content = await readFile(join(cwd, file));

  return createHash('sha256').update(content).digest('hex');
};

const edit = async (harness: Harness, file: string) => {
  const before = await digest(harness.cwd, file);

  await writeFile(join(harness.cwd, file), '// changed bytes');

  expect(await digest(harness.cwd, file)).not.toBe(before);
};

const loadError: RunnerResult = {
  kind: 'compile-error',
  message: 'load error',
  stdout: '',
  stderr: 'load error',
  tests: [],
};

const ambiguous = (status: 'passed' | 'failed') => {
  const tests = results(current, status);

  return [...tests, tests[0]!];
};

const gateOff = { since: '2026-09-08T00:00:00.000Z' };

const proven = [{ file: 'old.test.ts', fullname: 'survives migration' }];

const reloadLegacy = async (harness: Harness, minimal: boolean) => {
  const { evidence } = await harness.store.read(harness.cwd);
  const legacy = minimal ? { reds: [], gateOff, proven } : { ...evidence, gateOff, proven };

  await writeFile(
    join(harness.cwd, '.tau/state.json'),
    JSON.stringify({ tdd: legacy }, (key, value: unknown) => (key === 'phase' ? undefined : value)),
  );

  return createEvidenceStore().read(harness.cwd);
};

const actions: Record<Event, (harness: Harness) => Promise<unknown>> = {
  read: (harness) => harness.store.read(harness.cwd),
  focusedFail: (harness) => harness.run(fail()),
  focusedPass: (harness) => harness.run(pass()),
  focusedLoadError: (harness) => harness.run(loadError),
  focusedTimeout: (harness) => harness.run({ kind: 'timeout' }),
  focusedNoTests: (harness) => harness.run({ kind: 'no-tests-collected', tests: [] }),
  focusedCancelled: (harness) => harness.run({ kind: 'cancelled' }),
  focusedAmbiguousFail: (harness) =>
    harness.run({ ...fail(), tests: ambiguous('failed') } as RunnerResult),
  focusedAmbiguousPass: (harness) => harness.run(pass(ambiguous('passed'))),

  fullPass: (harness) => harness.run(pass(), 'full'),
  fullFail: (harness) => harness.run(fail(), 'full'),
  fullLoadError: (harness) => harness.run(loadError, 'full'),
  fullTimeout: (harness) => harness.run({ kind: 'timeout' }, 'full'),
  fullNoTests: (harness) => harness.run({ kind: 'no-tests-collected', tests: [] }, 'full'),
  fullCancelled: (harness) => harness.run({ kind: 'cancelled' }, 'full'),
  fullSkipped: (harness) =>
    harness.run(pass([...results(current, 'passed'), ...results(previous, 'skipped')]), 'full'),
  fullMissing: (harness) => harness.run(pass(results(current, 'passed')), 'full'),
  fullAmbiguous: (harness) =>
    harness.run(
      pass([
        ...results(current, 'passed'),
        ...results(previous, 'passed'),
        ...results(previous, 'passed'),
      ]),
      'full',
    ),

  testEdit: (harness) => edit(harness, 'behavior.test.ts'),
  focusedRenew: async (harness) => {
    await edit(harness, 'behavior.test.ts');

    await harness.run(pass());
  },
  productionEditThroughBash: async (harness) => {
    const decision = await guardToolCall(
      {
        type: 'tool_call',
        toolCallId: 'bash',
        toolName: 'bash',
        input: { command: "printf '// changed bytes' > src/value.ts" },
      },
      harness.cwd,
      harness.store,
    );

    expect(decision).toBeUndefined();

    // Apply the bytes a bash tool writes, bypassing the write/edit guard as real bash does.
    await edit(harness, 'src/value.ts');
  },
  otherTestEdit: (harness) => edit(harness, 'other.test.ts'),
  protectedEdit: (harness) => edit(harness, 'vite.config.ts'),

  // A non-evidentiary run isolates switching from a new RED/GREEN result.
  switchKnown: (harness) => harness.run({ kind: 'timeout' }, 'focused', previous),
  switchNew: (harness) => harness.run({ kind: 'timeout' }, 'focused', fresh),
  legacyReload: (harness) => reloadLegacy(harness, false),
  noPhaseReload: (harness) => reloadLegacy(harness, true),
};

it('rejects malformed stored evidence before it can authorize writes', async () => {
  const harness = await createHarness(onTestFinished);

  await reach.green(harness);

  const { evidence } = await harness.store.read(harness.cwd);
  const entry = evidence.reds.at(-1)!;
  const invalidStates = [
    { ...evidence, active: null },
    { ...evidence, phase: 'unknown' },
    { ...evidence, gateOff: true },
    { ...evidence, proven: [null] },
    { ...evidence, reds: [] },
    { ...evidence, reds: [{ ...entry, behavior: {} }] },
    { ...evidence, reds: [{ ...entry, report: { kind: 'fail' } }] },
    { ...evidence, reds: [{ ...entry, report: { ...entry.report, tests: [] } }] },
    { ...evidence, reds: [{ ...entry, testHashes: [] }] },
    { ...evidence, reds: [{ ...entry, phase: 'verified' }] },
  ];

  for (const state of invalidStates) {
    await writeFile(join(harness.cwd, '.tau/state.json'), JSON.stringify({ tdd: state }));

    await expect(createEvidenceStore().read(harness.cwd)).rejects.toThrow(
      'Unreadable test evidence',
    );
    expect(await tddGateStatus(harness.cwd)).toContain('status unknown');
  }
});

it.each(Object.keys(reach) as Phase[])('reaches %s using the mocked runner', async (phase) => {
  const harness = await createHarness(onTestFinished);

  await reach[phase](harness);

  expect(await harness.store.read(harness.cwd)).toMatchObject({ phase, notice: undefined });
  expect(runnerAvailable).toHaveBeenCalledWith(harness.cwd);
});

const cells = (Object.keys(transitions) as Phase[]).flatMap((from) =>
  (Object.keys(transitions[from]) as Event[]).map((event) => ({
    from,
    event,
    expected: transitions[from][event],
  })),
);

/* oxlint-disable vitest/no-conditional-expect -- Extra checks depend on the table event, not the observed result. */
it.each(cells)('$from + $event', async ({ from, event, expected }) => {
  const harness = await createHarness(onTestFinished);

  await reach[from](harness);

  const before = await harness.store.read(harness.cwd);

  await actions[event](harness);

  const reloading = event === 'legacyReload' || event === 'noPhaseReload';
  const store = reloading ? createEvidenceStore() : harness.store;
  const actual = await store.read(harness.cwd);

  expect.soft(actual.phase).toBe(expected.phase);
  expect.soft(actual.implementationAllowed).toBe(expected.implementationAllowed);
  expect
    .soft(actual.evidence.reds.map(({ behavior }) => behavior.behavior).toSorted())
    .toEqual(expected.reds);
  expect.soft(actual.evidence).toHaveProperty('phase', expected.storedPhase);

  if (!reloading) {
    expect(actual.notice).toBeUndefined();
  } else {
    expect(actual.evidence).toMatchObject({ gateOff, proven });
  }

  if (event === 'testEdit' && (from === 'red' || from === 'green')) {
    expect(actual.staleSinceRed).toContain('behavior.test.ts');
    expect(actual.evidence.reds).toEqual(before.evidence.reds);
  }

  if (event === 'fullPass' && from !== 'locked') {
    expect(actual.evidence).toHaveProperty('verifiedTree', expect.stringMatching(/^[a-f0-9]{64}$/));
  }

  if (
    ['testEdit', 'productionEditThroughBash', 'otherTestEdit', 'protectedEdit'].includes(event) &&
    from === 'verified'
  ) {
    expect(actual.evidence).toEqual(before.evidence);
  }

  if (event === 'focusedFail') {
    const currentRed = actual.evidence.reds.find(({ behavior }) => behavior.behavior === 'current');
    const testHash = currentRed?.testHashes[join(harness.cwd, 'behavior.test.ts')];

    expect(currentRed?.report).toEqual(fail());
    expect(testHash).toBe(await digest(harness.cwd, 'behavior.test.ts'));
  }

  if (event === 'focusedRenew' && from !== 'locked') {
    const currentRed = actual.evidence.reds.find(({ behavior }) => behavior.behavior === 'current');
    const testHash = currentRed?.testHashes[join(harness.cwd, 'behavior.test.ts')];

    expect(currentRed).toHaveProperty('edited', true);
    expect(testHash).toBe(await digest(harness.cwd, 'behavior.test.ts'));
  }

  if (
    ['fullFail', 'fullLoadError', 'fullTimeout', 'fullNoTests', 'fullCancelled'].includes(event)
  ) {
    expect(actual.evidence.reds).toEqual(before.evidence.reds);
    expect(actual.fullPassValid).toBe(false);
    expect(actual.evidence).toHaveProperty('verifiedTree', null);
  }

  if (
    [
      'focusedLoadError',
      'focusedTimeout',
      'focusedNoTests',
      'focusedCancelled',
      'focusedAmbiguousFail',
      'focusedAmbiguousPass',
    ].includes(event) ||
    (event === 'focusedPass' && from === 'locked')
  ) {
    expect(actual.evidence).toEqual(before.evidence);
  }

  if (event === 'switchKnown') {
    expect(actual.evidence.active).toMatchObject(previous);
  }

  if (event === 'switchNew') {
    expect(actual.evidence.active).toMatchObject(fresh);
  }

  // Protected paths remain blocked even for RED and migrated gate-off evidence.
  for (const path of protectedPaths) {
    expect(
      await guardToolCall(
        { type: 'tool_call', toolCallId: path, toolName: 'write', input: { path, content: '' } },
        harness.cwd,
        store,
      ),
    ).toMatchObject({ block: true });
  }

  if (!reloading) {
    const blocked = await guardToolCall(
      {
        type: 'tool_call',
        toolCallId: 'production',
        toolName: 'write',
        input: { path: 'src/value.ts', content: '' },
      },
      harness.cwd,
      store,
    );

    expect(blocked?.block ?? false).toBe(!expected.implementationAllowed);
  }
});

it.each(
  (Object.keys(reach) as Phase[]).flatMap((phase) =>
    (['focused', 'full'] as const).flatMap((scope) =>
      [previous, fresh].map((behavior) => ({ phase, scope, behavior })),
    ),
  ),
)(
  'keeps $phase evidence when a $scope run switching to $behavior.behavior is cancelled',
  async ({ phase, scope, behavior }) => {
    const harness = await createHarness(onTestFinished);

    await reach[phase](harness);

    const before = await harness.store.read(harness.cwd);
    const stored = await readFile(join(harness.cwd, '.tau/state.json'), 'utf8');

    const result = await harness.run({ kind: 'cancelled' }, scope, behavior);

    expect(result).toMatchObject({ kind: 'cancelled', ...before });
    expect(await harness.store.read(harness.cwd)).toEqual(before);
    expect(await readFile(join(harness.cwd, '.tau/state.json'), 'utf8')).toBe(stored);
    expect(await createEvidenceStore().read(harness.cwd)).toEqual(before);
  },
);
