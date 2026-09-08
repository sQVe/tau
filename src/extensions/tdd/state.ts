import { createHash } from 'node:crypto';
import { glob, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { classifyPath, protectedPaths, tddConfig } from './config.js';
import { runTests, runnerAvailable } from './runner/index.js';
import type { RunnerResult, TestResult } from './runner/types.js';
import type {
  Behavior,
  EvidenceRecord,
  EvidenceState,
  InputHashes,
  Phase,
  RedRecord,
} from './types.js';

// ponytail: one process-wide chain; split by worktree if independent runs need concurrency.
let pendingRun: Promise<unknown> = Promise.resolve();

const configPath = resolve(import.meta.dirname, 'config.ts');

const hashInputs = async (
  cwd: string,
  files: string[],
  scope: 'red' | 'focused' | 'full' = 'red',
): Promise<InputHashes> => {
  const sources: string[] = [];
  if (scope !== 'red') {
    for await (const file of glob(
      [...tddConfig.productionGlobs, ...(scope === 'full' ? tddConfig.testGlobs : [])],
      { cwd, exclude: ['**/node_modules/**', '**/.git/**'] },
    )) {
      if (scope === 'full' || classifyPath(file) === 'production') sources.push(file);
    }
  }
  return Object.fromEntries(
    await Promise.all(
      [
        ...new Set([
          ...[...files, ...sources, ...protectedPaths].map((file) => resolve(cwd, file)),
          configPath,
        ]),
      ]
        .toSorted()
        .map(async (file): Promise<[string, string | null]> => {
          try {
            return [
              file,
              createHash('sha256')
                .update(await readFile(file))
                .digest('hex'),
            ];
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
              throw error;
            return [file, null];
          }
        }),
    ),
  );
};

const sameHashes = (left: InputHashes, right: InputHashes) =>
  JSON.stringify(left) === JSON.stringify(right);

export const testNames = (behavior: Pick<Behavior, 'testFullName'>): string[] =>
  Array.isArray(behavior.testFullName) ? behavior.testFullName : [behavior.testFullName];

// The label is free text for the summary; the test names and files identify a behavior.
const sameBehavior = (left: Behavior, right: Behavior) =>
  JSON.stringify(testNames(left)) === JSON.stringify(testNames(right)) &&
  JSON.stringify(left.files) === JSON.stringify(right.files);

const redHash = (record: RedRecord, file: string) => record.renewed?.[file] ?? record.after[file];

// The active RED and its list entry are one object until a reload splits them.
const activeRedRecords = (state: EvidenceState): RedRecord[] => {
  const active = state.active;
  const entry =
    active === null
      ? undefined
      : state.reds.find((candidate) => sameBehavior(candidate.behavior, active));
  return [...new Set([state.red, entry?.record].filter((record) => record != null))];
};

const identityMatches = (cwd: string, fullname: string, file: string, test: TestResult) =>
  test.fullname === fullname && resolve(cwd, test.file) === resolve(cwd, file);

// Vitest permits duplicate full names in one file, so (file, fullname) only identifies a test
// when exactly one result carries it. Anything else is ambiguous and proves nothing.
const uniqueStatus = (
  cwd: string,
  tests: TestResult[],
  fullname: string,
  file: string,
): TestResult['status'] | null => {
  const matched = tests.filter((test) => identityMatches(cwd, fullname, file, test));
  return matched.length === 1 ? (matched[0]?.status ?? null) : null;
};

// Ambiguity is per file: another required file can still identify the behavior on its own.
export const ambiguousFiles = (cwd: string, behavior: Behavior, report: RunnerResult) =>
  'tests' in report
    ? behavior.files.filter((file) =>
        testNames(behavior).some(
          (name) =>
            report.tests.filter((test) => identityMatches(cwd, name, file, test)).length > 1,
        ),
      )
    : [];

// Every named test has to reach the status in some required file.
const uniquelyIs = (
  cwd: string,
  tests: TestResult[],
  behavior: Behavior,
  status: TestResult['status'],
) =>
  testNames(behavior).every((name) =>
    behavior.files.some((file) => uniqueStatus(cwd, tests, name, file) === status),
  );

const redPassed = (
  cwd: string,
  behavior: Behavior | null,
  red: EvidenceRecord | null,
  pass: EvidenceRecord | null,
) => {
  if (behavior === null || red?.report.kind !== 'fail' || pass?.report.kind !== 'pass')
    return false;
  const redTests = red.report.tests;
  const passedTests = pass.report.tests;
  return testNames(behavior).every((name) => {
    const required = behavior.files.filter(
      (file) => uniqueStatus(cwd, redTests, name, file) === 'failed',
    );
    return (
      required.length > 0 &&
      required.every((file) => uniqueStatus(cwd, passedTests, name, file) === 'passed')
    );
  });
};

const failedIn = (
  cwd: string,
  { behavior, record }: EvidenceState['reds'][number],
  file: string,
) => {
  const report = record.report;
  return (
    report.kind === 'fail' &&
    testNames(behavior).some((name) => uniqueStatus(cwd, report.tests, name, file) === 'failed')
  );
};

const runnerChecks = new Map<string, { packageHash: string | null; available: boolean }>();

// Nothing can be proven without a runner, so production edits stop being gated until the agent
// installs one through the exempt bash tool.
const runnerNotice = (cwd: string, hashes: InputHashes) => {
  const key = resolve(cwd);
  const packageHash = hashes[resolve(cwd, 'package.json')] ?? null;
  const cached = runnerChecks.get(key);
  // An installed runner is cached until package.json changes; an absent one is re-checked every
  // read, because installing it leaves package.json untouched.
  const available =
    cached?.available === true && cached.packageHash === packageHash ? true : runnerAvailable(key);
  runnerChecks.set(key, { packageHash, available });
  return available ? undefined : 'no test runner resolves from this worktree';
};

const statePath = (cwd: string) => resolve(cwd, '.tau/state.json');

const emptyState = (): EvidenceState => ({
  active: null,
  reds: [],
  red: null,
  focusedPass: null,
  fullPass: null,
  latestRun: null,
  proven: [],
  verified: false,
  gateOff: null,
});

const gateOffNotice = (state: EvidenceState) =>
  state.gateOff == null ? undefined : `TDD gate off since ${state.gateOff.since}`;

// The commit tool reports the switch without importing the store the tdd extension owns. Commit is
// exempt from the guard, so an unreadable file has to be said out loud rather than read as on.
export const tddGateStatus = async (cwd: string) => {
  try {
    return gateOffNotice(await loadState(resolve(cwd)));
  } catch {
    return `TDD gate status unknown: unreadable evidence at ${statePath(resolve(cwd))}`;
  }
};

const isStoredState = (value: unknown): value is { tdd: EvidenceState } =>
  value !== null &&
  typeof value === 'object' &&
  'tdd' in value &&
  value.tdd !== null &&
  typeof value.tdd === 'object' &&
  'reds' in value.tdd &&
  Array.isArray(value.tdd.reds);

const loadState = async (cwd: string): Promise<EvidenceState> => {
  const path = statePath(cwd);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return emptyState();
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isStoredState(parsed)) throw new Error('missing tdd evidence');
    // Evidence written by an earlier version may lack fields added since.
    return { ...emptyState(), ...parsed.tdd };
  } catch (error) {
    throw new Error(`Unreadable test evidence in ${path}`, { cause: error });
  }
};

const saveState = async (cwd: string, state: EvidenceState) => {
  const path = statePath(cwd);
  const temporary = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, JSON.stringify({ tdd: state }));
  await rename(temporary, path);
};

// A test edited after its behavior reached GREEN cannot fail again without removing the fix, and
// that ceremony proves little, so the amended file is accepted and the full run reports it.
// Protected inputs are never renewed: they decide how verification runs.
const renewRed = (cwd: string, state: EvidenceState, behavior: Behavior, pass: EvidenceRecord) => {
  const red = state.red;
  if (red?.greened !== true) return;
  const keys = behavior.files.map((file) => resolve(cwd, file));
  const staleTests = keys.filter((key) => redHash(red, key) !== pass.after[key]);
  const staleOthers = [...protectedPaths.map((file) => resolve(cwd, file)), configPath].filter(
    (key) => redHash(red, key) !== pass.after[key],
  );
  if (staleTests.length === 0 || staleOthers.length > 0) return;
  if (!redPassed(cwd, behavior, red, pass)) return;
  const renewed = Object.fromEntries(keys.map((key) => [key, pass.after[key] ?? null]));
  for (const record of activeRedRecords(state)) record.renewed = { ...record.renewed, ...renewed };
};

export const createEvidenceStore = () => {
  const states = new Map<string, Promise<EvidenceState>>();
  const stateFor = (cwd: string) => {
    const key = resolve(cwd);
    // A rejected load must not be cached: repairing the file has to take effect on the next read.
    const state =
      states.get(key) ??
      loadState(key).catch((error: unknown) => {
        states.delete(key);
        throw error;
      });
    states.set(key, state);
    return state;
  };
  const read = async (cwd: string) => {
    const state = await stateFor(cwd);
    const evidence = structuredClone(state);
    const hashes = await hashInputs(cwd, evidence.active?.files ?? []);
    const productionHashes = await hashInputs(cwd, evidence.active?.files ?? [], 'focused');
    const staleSinceRed =
      evidence.red === null
        ? []
        : Object.entries(hashes)
            .filter(([file, hash]) => evidence.red !== null && redHash(evidence.red, file) !== hash)
            .map(([file]) => relative(cwd, file));
    const redValid = evidence.red !== null && staleSinceRed.length === 0;
    const fullHashes = await hashInputs(cwd, evidence.active?.files ?? [], 'full');
    const valid = (record: EvidenceRecord | null, current: InputHashes) =>
      redValid && record !== null && sameHashes(record.after, current);
    const focusedPassValid =
      valid(evidence.focusedPass, productionHashes) &&
      redPassed(cwd, evidence.active, evidence.red, evidence.focusedPass);
    const earlierRedsValid = (
      await Promise.all(
        evidence.reds.map(async ({ behavior, record }) => {
          const requiredHashes = await hashInputs(cwd, behavior.files);
          return Object.entries(requiredHashes).every(([file, hash]) => {
            // A RED that failed inside this file renews its snapshot, so appending a behavior
            // to a shared file keeps working while a RED elsewhere cannot launder edits here.
            // An earlier test weakened in the same edit is still laundered: ABU-338.
            const latest = evidence.reds.findLast((entry) => failedIn(cwd, entry, file));
            return redHash(latest?.record ?? record, file) === hash;
          });
        }),
      )
    ).every(Boolean);
    const requiredTestsPassed = evidence.reds.every(({ behavior, record }) =>
      redPassed(cwd, behavior, record, evidence.fullPass),
    );
    const fullPassValid =
      valid(evidence.fullPass, fullHashes) && earlierRedsValid && requiredTestsPassed;
    let phase: Phase = 'locked';
    if (redValid) phase = 'red';
    if (focusedPassValid) phase = 'green';
    if (fullPassValid) phase = 'verified';
    return {
      evidence,
      phase,
      implementationAllowed: phase === 'red',
      focusedPassValid,
      fullPassValid,
      staleSinceRed,
      notice: gateOffNotice(evidence) ?? runnerNotice(cwd, hashes),
    };
  };
  const run = async (
    cwd: string,
    requested: Behavior,
    scope: 'focused' | 'full',
    signal?: AbortSignal,
  ) => {
    // Canonical field and file order so the same behavior submitted differently stays the same
    // behavior: identity is compared as serialized JSON, which key order would otherwise change.
    const names = [...new Set(testNames(requested))].toSorted();
    const behavior: Behavior = {
      behavior: requested.behavior,
      testFullName: names.length === 1 ? (names[0] ?? '') : names,
      files: [...new Set(requested.files)].toSorted(),
    };
    for (const file of behavior.files) {
      const path = relative(cwd, resolve(cwd, file)).replaceAll('\\', '/');
      if (isAbsolute(file) || path.startsWith('../') || classifyPath(path) !== 'test') {
        throw new Error(`Expected a test file inside the worktree: ${file}`);
      }
    }
    const before = await hashInputs(cwd, behavior.files, scope);
    const report = await runTests(
      scope === 'full'
        ? { cwd, scope: 'all', signal }
        : {
            cwd,
            scope: 'changed',
            files: behavior.files,
            filter: `^(?:${testNames(behavior)
              .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('|')})$`,
            signal,
          },
    );
    // A cancelled run proves nothing, so the stored evidence stays as it was.
    if (report.kind === 'cancelled') return { kind: 'cancelled' as const, ...(await read(cwd)) };
    const after = await hashInputs(cwd, behavior.files, scope);
    if (!sameHashes(before, after))
      return { kind: 'inputs-changed' as const, ...(await read(cwd)) };
    const state = await stateFor(cwd);
    if (state.active !== null && sameBehavior(state.active, behavior)) {
      state.active.behavior = behavior.behavior;
    } else {
      // A verified full pass is a task boundary: a new behavior starts without the spent REDs, so
      // renaming or dropping a shipped test cannot deadlock the gate. Returning to a recorded
      // behavior is a touch-up of the same task and keeps them.
      const known = state.reds.some((entry) => sameBehavior(entry.behavior, behavior));
      const reds = state.verified && !known ? [] : state.reds;
      Object.assign(state, {
        active: structuredClone(behavior),
        reds,
        // Returning to a behavior keeps its proven RED; read() still checks the hashes.
        red: reds.find((entry) => sameBehavior(entry.behavior, behavior))?.record ?? null,
        focusedPass: null,
        fullPass: null,
        latestRun: null,
        verified: false,
      });
    }
    const record: RedRecord = { before, after, report };
    const filesExist = behavior.files.every((file) => after[resolve(cwd, file)] != null);
    state.latestRun = record;
    if (scope === 'full') state.fullPass = null;
    else state.focusedPass = null;
    if (
      filesExist &&
      scope === 'focused' &&
      report.kind === 'fail' &&
      uniquelyIs(cwd, report.tests, behavior, 'failed')
    ) {
      state.red = record;
      state.reds = state.reds.filter((entry) => !sameBehavior(entry.behavior, behavior));
      state.reds.push({ behavior: structuredClone(behavior), record });
      for (const file of behavior.files)
        for (const fullname of testNames(behavior)) {
          if (
            uniqueStatus(cwd, report.tests, fullname, file) === 'failed' &&
            !state.proven.some((known) => known.file === file && known.fullname === fullname)
          )
            state.proven.push({ file, fullname });
        }
      state.focusedPass = null;
      state.fullPass = null;
    }
    if (filesExist && report.kind === 'pass' && uniquelyIs(cwd, report.tests, behavior, 'passed')) {
      if (scope === 'full') state.fullPass = record;
      else state.focusedPass = record;
      if (scope === 'focused') renewRed(cwd, state, behavior, record);
    }
    const result = await read(cwd);
    if (result.focusedPassValid) for (const red of activeRedRecords(state)) red.greened = true;
    state.verified = result.fullPassValid;
    await saveState(cwd, state);
    return { kind: report.kind, ...result };
  };
  const setGate = async (cwd: string, gate: 'on' | 'off') => {
    const state = await stateFor(cwd);
    state.gateOff = gate === 'off' ? { since: new Date().toISOString() } : null;
    await saveState(cwd, state);
    return read(cwd);
  };
  return {
    read,
    setGate,
    run: (cwd: string, behavior: Behavior, scope: 'focused' | 'full', signal?: AbortSignal) => {
      const result = pendingRun.then(() => run(cwd, behavior, scope, signal));
      pendingRun = result.catch(() => undefined);
      return result;
    },
  };
};
