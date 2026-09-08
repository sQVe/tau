import { createHash } from 'node:crypto';
import { glob, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { classifyPath, protectedPaths, tddConfig } from './config.js';
import { runTests, runnerAvailable } from './runner/index.js';
import type { RunnerResult, TestResult } from './runner/types.js';
import type { Behavior, EvidenceState, InputHashes, Phase, RedRecord } from './types.js';

// ponytail: one process-wide chain; split by worktree if independent runs need concurrency.
let pendingRun: Promise<unknown> = Promise.resolve();

const configPath = resolve(import.meta.dirname, 'config.ts');

const hashInputs = async (cwd: string, files: string[]): Promise<InputHashes> => {
  return Object.fromEntries(
    await Promise.all(
      [...new Set([...[...files, ...protectedPaths].map((file) => resolve(cwd, file)), configPath])]
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

const treeDigest = async (cwd: string, files: string[]) => {
  const sources = [...files];
  for await (const file of glob([...tddConfig.productionGlobs, ...tddConfig.testGlobs], {
    cwd,
    exclude: ['**/node_modules/**', '**/.git/**'],
  }))
    sources.push(file);
  return createHash('sha256')
    .update(JSON.stringify(await hashInputs(cwd, sources)))
    .digest('hex');
};

export const testNames = (behavior: Pick<Behavior, 'testFullName'>): string[] =>
  Array.isArray(behavior.testFullName) ? behavior.testFullName : [behavior.testFullName];

// The label is free text for the summary; the test names and files identify a behavior.
const sameBehavior = (left: Behavior, right: Behavior) =>
  JSON.stringify(testNames(left)) === JSON.stringify(testNames(right)) &&
  JSON.stringify(left.files) === JSON.stringify(right.files);

const activeRed = (state: EvidenceState) =>
  state.reds.find((entry) => state.active !== null && sameBehavior(entry.behavior, state.active));

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
  red: RedRecord | undefined,
  pass: RunnerResult,
) => {
  if (behavior === null || red?.report.kind !== 'fail' || pass.kind !== 'pass') return false;
  const redTests = red.report.tests;
  const passedTests = pass.tests;
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

const failedIn = (cwd: string, { behavior, report }: RedRecord, file: string) => {
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
  phase: 'locked',
  verifiedTree: null,
  proven: [],
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
    const stored = parsed.tdd;
    const legacy = !['locked', 'red', 'green', 'verified'].includes(stored.phase);
    return {
      active: stored.active ?? null,
      phase: legacy ? 'locked' : stored.phase,
      reds: stored.reds.map((entry) => {
        // Old snapshots kept the report and hashes inside record. Discard their derived flags.
        const old = entry as RedRecord & { record?: { report: RunnerResult; after: InputHashes } };
        return {
          behavior: entry.behavior,
          report: old.record?.report ?? entry.report,
          testHashes: old.record?.after ?? entry.testHashes,
          edited: entry.edited ?? false,
          phase: legacy ? 'locked' : entry.phase,
        };
      }),
      verifiedTree: legacy ? null : stored.verifiedTree,
      proven: stored.proven ?? [],
      gateOff: stored.gateOff ?? null,
    };
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
    const red = activeRed(evidence);
    const staleSinceRed =
      red === undefined
        ? []
        : red.behavior.files.filter(
            (file) => red.testHashes[resolve(cwd, file)] !== hashes[resolve(cwd, file)],
          );
    let phase: Phase = evidence.phase;
    if ((phase === 'red' || phase === 'green') && staleSinceRed.length > 0) phase = 'locked';
    if (
      phase === 'verified' &&
      evidence.verifiedTree !== (await treeDigest(cwd, evidence.active?.files ?? []))
    )
      phase = 'green';
    return {
      evidence,
      phase,
      implementationAllowed: phase === 'red',
      focusedPassValid: phase === 'green' || phase === 'verified',
      fullPassValid: phase === 'verified',
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
    const before =
      scope === 'full'
        ? await treeDigest(cwd, behavior.files)
        : await hashInputs(cwd, behavior.files);
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
    const after = await hashInputs(cwd, behavior.files);
    const fullTree = scope === 'full' ? await treeDigest(cwd, behavior.files) : null;
    const current = fullTree ?? after;
    if (JSON.stringify(before) !== JSON.stringify(current))
      return { kind: 'inputs-changed' as const, report: null, ...(await read(cwd)) };
    const state = await stateFor(cwd);
    const entry = state.reds.find((candidate) => sameBehavior(candidate.behavior, behavior));
    let arrival: 'unseen' | 'known' | 'same' = entry === undefined ? 'unseen' : 'known';
    if (state.active !== null && sameBehavior(state.active, behavior)) arrival = 'same';
    // Cancellation cannot switch behaviors. A full run on the active behavior still clears verification.
    if (report.kind === 'cancelled' && arrival !== 'same')
      return { kind: 'cancelled' as const, report, ...(await read(cwd)) };
    const filesExist = behavior.files.every((file) => after[resolve(cwd, file)] != null);
    let outcome: 'other' | 'fail' | 'pass' = 'other';
    if (filesExist && report.kind === 'fail' && uniquelyIs(cwd, report.tests, behavior, 'failed'))
      outcome = 'fail';
    else if (filesExist && report.kind === 'pass' && redPassed(cwd, behavior, entry, report))
      outcome = 'pass';
    if (arrival !== 'same') {
      if (arrival === 'unseen' && state.phase === 'verified') state.reds = [];
      state.phase = entry?.phase ?? 'locked';
      state.verifiedTree = null;
    }
    state.active = structuredClone(behavior);
    if (scope === 'full') {
      state.verifiedTree = null;
      if (state.phase === 'verified') state.phase = 'green';
      // Earlier tests may share a file extended by a later RED, but a RED in a different file
      // cannot authorize an amendment. Only the latest RED proven inside that file renews it.
      const hashes = await hashInputs(
        cwd,
        state.reds.flatMap((red) => red.behavior.files),
      );
      const intact = state.reds.every((red) =>
        red.behavior.files.every((file) => {
          const key = resolve(cwd, file);
          const latest = state.reds.findLast((candidate) => failedIn(cwd, candidate, file));
          return (latest ?? red).testHashes[key] === hashes[key];
        }),
      );
      if (
        outcome === 'pass' &&
        intact &&
        state.reds.every((red) => redPassed(cwd, red.behavior, red, report))
      ) {
        state.phase = 'verified';
        state.verifiedTree = fullTree;
      }
    } else {
      const transition = `${arrival}:${outcome}` as const;
      switch (transition) {
        case 'same:fail':
        case 'known:fail':
        case 'unseen:fail': {
          const red: RedRecord = {
            behavior: structuredClone(behavior),
            report,
            testHashes: after,
            edited: false,
            phase: 'red',
          };
          state.reds = state.reds.filter(
            (candidate) => !sameBehavior(candidate.behavior, behavior),
          );
          state.reds.push(red);
          state.phase = 'red';
          state.verifiedTree = null;
          for (const file of behavior.files)
            for (const fullname of testNames(behavior)) {
              if (
                'tests' in report &&
                uniqueStatus(cwd, report.tests, fullname, file) === 'failed' &&
                !state.proven.some((known) => known.file === file && known.fullname === fullname)
              )
                state.proven.push({ file, fullname });
            }
          break;
        }
        case 'same:pass':
        case 'known:pass':
          if (entry !== undefined) {
            entry.edited ||= behavior.files.some(
              (file) => entry.testHashes[resolve(cwd, file)] !== after[resolve(cwd, file)],
            );
            entry.testHashes = after;
            entry.phase = 'green';
            state.phase = 'green';
            state.verifiedTree = null;
          }
          break;
        case 'same:other':
        case 'known:other':
        case 'unseen:other':
        case 'unseen:pass':
          break;
        default:
          throw new Error('Unexpected TDD transition', { cause: transition satisfies never });
      }
    }
    await saveState(cwd, state);
    return { kind: report.kind, report, ...(await read(cwd)) };
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
