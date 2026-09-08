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
import { createEvidenceStore } from './state.js';
import type { Behavior, Phase } from './types.js';

vi.mock('./runner/index.js', () => ({
  runTests: vi.fn<typeof runTests>(),
  runnerAvailable: vi.fn<typeof runnerAvailable>(() => true),
}));

// AI-155 contract: phase belongs to the evidence, independently of read()'s byte checks.
// No fallback to the reported phase: that would let the old derived model pass this suite.
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
  implementationAllowed: false,
};
const verified: Expected = { ...green, storedPhase: 'verified', phase: 'verified' };

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
    testEdit: { ...green, phase: 'locked', implementationAllowed: false },
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
    testEdit: { ...verified, phase: 'green' },
    focusedRenew: green,
    productionEditThroughBash: { ...verified, phase: 'green' },
    otherTestEdit: { ...verified, phase: 'green' },
    protectedEdit: { ...verified, phase: 'green' },
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
  }))
    await writeFile(join(cwd, file), content);
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
const reach: Record<Phase, (h: Harness) => Promise<unknown>> = {
  locked: (h) => h.run({ kind: 'timeout' }),
  red: (h) => h.run(fail()),
  green: async (h) => {
    await reach.red(h);
    await h.run(pass());
  },
  verified: async (h) => {
    await reach.green(h);
    await h.run(pass(), 'full');
  },
};

const digest = async (cwd: string, file: string) =>
  createHash('sha256')
    .update(await readFile(join(cwd, file)))
    .digest('hex');
const edit = async (h: Harness, file: string) => {
  const before = await digest(h.cwd, file);
  await writeFile(join(h.cwd, file), '// changed bytes');
  expect(await digest(h.cwd, file)).not.toBe(before);
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
const reloadLegacy = async (h: Harness, minimal: boolean) => {
  const evidence = (await h.store.read(h.cwd)).evidence;
  const legacy = minimal ? { reds: [], gateOff, proven } : { ...evidence, gateOff, proven };
  // JSON removal works both before and after AI-155 introduces phase into EvidenceState.
  await writeFile(
    join(h.cwd, '.tau/state.json'),
    JSON.stringify({ tdd: legacy }, (key, value: unknown) => (key === 'phase' ? undefined : value)),
  );
  return createEvidenceStore().read(h.cwd);
};

const actions: Record<Event, (h: Harness) => Promise<unknown>> = {
  read: (h) => h.store.read(h.cwd),
  focusedFail: (h) => h.run(fail()),
  focusedPass: (h) => h.run(pass()),
  focusedLoadError: (h) => h.run(loadError),
  focusedTimeout: (h) => h.run({ kind: 'timeout' }),
  focusedNoTests: (h) => h.run({ kind: 'no-tests-collected', tests: [] }),
  focusedCancelled: (h) => h.run({ kind: 'cancelled' }),
  focusedAmbiguousFail: (h) => h.run({ ...fail(), tests: ambiguous('failed') } as RunnerResult),
  focusedAmbiguousPass: (h) => h.run(pass(ambiguous('passed'))),
  fullPass: (h) => h.run(pass(), 'full'),
  fullFail: (h) => h.run(fail(), 'full'),
  fullLoadError: (h) => h.run(loadError, 'full'),
  fullTimeout: (h) => h.run({ kind: 'timeout' }, 'full'),
  fullNoTests: (h) => h.run({ kind: 'no-tests-collected', tests: [] }, 'full'),
  fullCancelled: (h) => h.run({ kind: 'cancelled' }, 'full'),
  fullSkipped: (h) =>
    h.run(pass([...results(current, 'passed'), ...results(previous, 'skipped')]), 'full'),
  fullMissing: (h) => h.run(pass(results(current, 'passed')), 'full'),
  fullAmbiguous: (h) =>
    h.run(
      pass([
        ...results(current, 'passed'),
        ...results(previous, 'passed'),
        ...results(previous, 'passed'),
      ]),
      'full',
    ),
  testEdit: (h) => edit(h, 'behavior.test.ts'),
  focusedRenew: async (h) => {
    await edit(h, 'behavior.test.ts');
    await h.run(pass());
  },
  productionEditThroughBash: async (h) => {
    expect(
      await guardToolCall(
        {
          type: 'tool_call',
          toolCallId: 'bash',
          toolName: 'bash',
          input: { command: "printf '// changed bytes' > src/value.ts" },
        },
        h.cwd,
        h.store,
      ),
    ).toBeUndefined();
    // Apply the bytes a bash tool writes, bypassing the write/edit guard as real bash does.
    await edit(h, 'src/value.ts');
  },
  otherTestEdit: (h) => edit(h, 'other.test.ts'),
  protectedEdit: (h) => edit(h, 'vite.config.ts'),
  // A non-evidentiary run isolates switching from a new RED/GREEN result.
  switchKnown: (h) => h.run({ kind: 'timeout' }, 'focused', previous),
  switchNew: (h) => h.run({ kind: 'timeout' }, 'focused', fresh),
  legacyReload: (h) => reloadLegacy(h, false),
  noPhaseReload: (h) => reloadLegacy(h, true),
};

it.each(Object.keys(reach) as Phase[])('reaches %s using the mocked runner', async (phase) => {
  const h = await createHarness(onTestFinished);
  await reach[phase](h);
  expect(await h.store.read(h.cwd)).toMatchObject({ phase, notice: undefined });
  expect(runnerAvailable).toHaveBeenCalledWith(h.cwd);
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
  const h = await createHarness(onTestFinished);
  await reach[from](h);
  const before = await h.store.read(h.cwd);
  await actions[event](h);
  const reloading = event === 'legacyReload' || event === 'noPhaseReload';
  const store = reloading ? createEvidenceStore() : h.store;
  const actual = await store.read(h.cwd);

  expect.soft(actual.phase).toBe(expected.phase);
  expect.soft(actual.implementationAllowed).toBe(expected.implementationAllowed);
  expect
    .soft(actual.evidence.reds.map(({ behavior }) => behavior.behavior).toSorted())
    .toEqual(expected.reds);
  expect.soft(actual.evidence).toHaveProperty('phase', expected.storedPhase);
  if (!reloading) expect(actual.notice).toBeUndefined();
  else expect(actual.evidence).toMatchObject({ gateOff, proven });

  if (event === 'testEdit' && (from === 'red' || from === 'green')) {
    expect(actual.staleSinceRed).toContain('behavior.test.ts');
    expect(actual.evidence.reds).toEqual(before.evidence.reds);
  }
  if (event === 'fullPass' && from !== 'locked') {
    // AI-155's new persisted digest field; its spelling is local to this target contract.
    expect(actual.evidence).toHaveProperty('verifiedTree', expect.stringMatching(/^[a-f0-9]{64}$/));
  }
  if (
    ['testEdit', 'productionEditThroughBash', 'otherTestEdit', 'protectedEdit'].includes(event) &&
    from === 'verified'
  ) {
    expect(actual.evidence).toEqual(before.evidence);
  }
  if (event === 'focusedFail') {
    expect(
      actual.evidence.reds.find(({ behavior }) => behavior.behavior === 'current')?.report,
    ).toEqual(fail());
    expect(
      actual.evidence.reds.find(({ behavior }) => behavior.behavior === 'current')?.testHashes[
        join(h.cwd, 'behavior.test.ts')
      ],
    ).toBe(await digest(h.cwd, 'behavior.test.ts'));
  }
  if (event === 'focusedRenew' && from !== 'locked') {
    expect(
      actual.evidence.reds.find(({ behavior }) => behavior.behavior === 'current'),
    ).toHaveProperty('edited', true);
    expect(
      actual.evidence.reds.find(({ behavior }) => behavior.behavior === 'current')?.testHashes[
        join(h.cwd, 'behavior.test.ts')
      ],
    ).toBe(await digest(h.cwd, 'behavior.test.ts'));
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
  if (event === 'switchKnown') expect(actual.evidence.active).toMatchObject(previous);
  if (event === 'switchNew') expect(actual.evidence.active).toMatchObject(fresh);
  // Protected paths remain blocked even for RED and migrated gate-off evidence.
  for (const path of protectedPaths) {
    expect(
      await guardToolCall(
        { type: 'tool_call', toolCallId: path, toolName: 'write', input: { path, content: '' } },
        h.cwd,
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
      h.cwd,
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
    const h = await createHarness(onTestFinished);
    await reach[phase](h);
    const before = await h.store.read(h.cwd);
    const stored = await readFile(join(h.cwd, '.tau/state.json'), 'utf8');

    const result = await h.run({ kind: 'cancelled' }, scope, behavior);

    expect(result).toMatchObject({ kind: 'cancelled', ...before });
    expect(await h.store.read(h.cwd)).toEqual(before);
    expect(await readFile(join(h.cwd, '.tau/state.json'), 'utf8')).toBe(stored);
    expect(await createEvidenceStore().read(h.cwd)).toEqual(before);
  },
);
