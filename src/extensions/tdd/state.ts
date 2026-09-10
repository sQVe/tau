import { createHash } from 'node:crypto';
import {
  glob,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { classifyPath, protectedPaths, tddConfig } from './config.js';
import { runTests, runnerAvailable } from './runner/index.js';
import type { RunnerResult, TestResult } from './runner/types.js';
import type { Behavior, EvidenceState, InputHashes, Phase, RedRecord } from './types.js';

// ponytail: one process-wide chain; split by worktree if independent runs need concurrency.
let pendingRun: Promise<unknown> = Promise.resolve();

const configPath = resolve(import.meta.dirname, 'config.ts');

const hashInputs = async (cwd: string, files: string[]): Promise<InputHashes> => {
  const paths = [...files, ...protectedPaths].map((file) => resolve(cwd, file));
  const uniquePaths = [...new Set([...paths, configPath])].toSorted();

  const entries = await Promise.all(
    uniquePaths.map(async (file): Promise<[string, string | null]> => {
      try {
        const content = await readFile(file);
        const digest = createHash('sha256').update(content).digest('hex');

        return [file, digest];
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }

        return [file, null];
      }
    }),
  );

  return Object.fromEntries(entries);
};

const treeDigest = async (cwd: string, files: string[]) => {
  const sources = [...files];

  for await (const file of glob([...tddConfig.productionGlobs, ...tddConfig.testGlobs], {
    cwd,
    exclude: ['**/node_modules/**', '**/.git/**'],
  })) {
    sources.push(file);
  }

  const hashes = await hashInputs(cwd, sources);

  return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
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

// Vitest permits duplicate full names in one file. A (file, fullname) pair proves a test's
// status only when it identifies exactly one result.
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
  if (behavior === null || red?.report.kind !== 'fail' || pass.kind !== 'pass') {
    return false;
  }

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

const failedIn = (cwd: string, { behavior, report }: RedRecord, file: string) =>
  report.kind === 'fail' &&
  testNames(behavior).some((name) => uniqueStatus(cwd, report.tests, name, file) === 'failed');

const staleVerificationFiles = async (cwd: string, records: RedRecord[]): Promise<string[]> => {
  const files = records.flatMap((record) => record.behavior.files);
  const hashes = await hashInputs(cwd, files);

  const protectedKeys = [...protectedPaths.map((path) => resolve(cwd, path)), configPath];

  const staleFiles = records.flatMap((record) => {
    // A later RED in the same file can accept an amendment; a RED in another file cannot.
    const staleTests = record.behavior.files.filter((file) => {
      const key = resolve(cwd, file);
      const latest = records.findLast((candidate) => failedIn(cwd, candidate, file));

      return (latest ?? record).testHashes[key] !== hashes[key];
    });

    // Configuration can change what runs, so every RED must accept the current configuration.
    const staleConfiguration = protectedKeys
      .filter((key) => record.testHashes[key] !== hashes[key])
      .map((key) => relative(cwd, key));

    return [...staleTests, ...staleConfiguration];
  });

  return [...new Set(staleFiles)];
};

const runnerChecks = new Map<string, { packageHash: string | null; available: boolean }>();

// Without a runner, no test can prove RED. Allow production edits until a runner is installed.
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

const recordSchema = Type.Record(Type.String(), Type.Unknown());

const behaviorSchema = Type.Object({
  behavior: Type.String({ minLength: 1 }),
  testFullName: Type.Union([
    Type.String({ minLength: 1 }),
    Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  ]),
  files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

const digestSchema = Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]);

const evidenceSchema = Type.Object({
  active: Type.Union([behaviorSchema, Type.Null()]),
  phase: Type.Union(
    (['locked', 'red', 'green', 'verified'] as const).map((phase) => Type.Literal(phase)),
  ),
  reds: Type.Array(
    Type.Object({
      behavior: behaviorSchema,
      report: Type.Object({
        kind: Type.Literal('fail'),
        tests: Type.Array(
          Type.Object({
            file: Type.String(),
            fullname: Type.String(),
            status: Type.Union(
              (['passed', 'failed', 'skipped', 'todo'] as const).map((status) =>
                Type.Literal(status),
              ),
            ),
          }),
        ),
        failures: Type.Array(
          Type.Object({
            file: Type.String(),
            fullname: Type.String(),
            message: Type.String(),
          }),
        ),
        truncated: Type.Boolean(),
      }),
      testHashes: Type.Record(Type.String(), digestSchema),
      greenTree: digestSchema,
      edited: Type.Boolean(),
      phase: Type.Union((['locked', 'red', 'green'] as const).map((phase) => Type.Literal(phase))),
    }),
  ),
  verifiedTree: digestSchema,
  proven: Type.Array(Type.Object({ file: Type.String(), fullname: Type.String() })),
  gateOff: Type.Union([Type.Object({ since: Type.String({ minLength: 1 }) }), Type.Null()]),
});

const isStoredState = (
  value: unknown,
): value is { tdd: Record<string, unknown> & { reds: unknown[] } } =>
  value !== null &&
  typeof value === 'object' &&
  'tdd' in value &&
  value.tdd !== null &&
  typeof value.tdd === 'object' &&
  'reds' in value.tdd &&
  Array.isArray(value.tdd.reds);

const rejectStateSymlinks = async (cwd: string) => {
  for (const path of [dirname(statePath(cwd)), statePath(cwd)]) {
    const entry = await lstat(path).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }

      return null;
    });

    if (entry?.isSymbolicLink()) {
      throw new Error(`Cannot use a symlink for TDD state: ${path}`);
    }
  }
};

const loadState = async (cwd: string): Promise<EvidenceState> => {
  await rejectStateSymlinks(cwd);

  const path = statePath(cwd);
  let content: string;

  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }

    return emptyState();
  }

  try {
    const parsed: unknown = JSON.parse(content);

    if (!isStoredState(parsed)) {
      throw new Error('missing tdd evidence');
    }

    const stored = parsed.tdd;
    const legacy = stored.phase === undefined;

    const state = {
      active: stored.active ?? null,
      phase: legacy ? 'locked' : stored.phase,
      reds: stored.reds.map((entry) => {
        if (!Value.Check(recordSchema, entry)) {
          throw new Error('invalid RED evidence');
        }

        // Old snapshots kept the report and hashes inside record. Discard their derived flags.
        const record = entry.record;
        const legacyRecord = Value.Check(recordSchema, record) ? record : undefined;

        return {
          behavior: entry.behavior,
          report: legacyRecord?.report ?? entry.report,
          testHashes: legacyRecord?.after ?? entry.testHashes,
          greenTree: entry.greenTree ?? null,
          edited: entry.edited ?? false,
          phase: legacy ? 'locked' : entry.phase,
        };
      }),
      verifiedTree: legacy ? null : stored.verifiedTree,
      proven: stored.proven ?? [],
      gateOff: stored.gateOff ?? null,
    };

    if (!Value.Check(evidenceSchema, state)) {
      throw new Error('invalid evidence fields');
    }

    const hasInvalidRed = state.reds.some(
      ({ behavior, report }) => !uniquelyIs(cwd, report.tests, behavior, 'failed'),
    );

    if (hasInvalidRed) {
      throw new Error('stored RED report does not prove its named tests');
    }

    const evidence: EvidenceState = state;

    if (evidence.phase !== 'locked' && activeRed(evidence) === undefined) {
      throw new Error('active phase has no RED evidence');
    }

    return evidence;
  } catch (error) {
    throw new Error(`Unreadable test evidence in ${path}`, { cause: error });
  }
};

const effectiveNotice = (cwd: string, state: EvidenceState, hashes: InputHashes) =>
  gateOffNotice(state) ?? runnerNotice(cwd, hashes);

// Commit is exempt from the guard, so it must report unreadable evidence rather than assume gate on.
export const tddGateStatus = async (cwd: string) => {
  try {
    const directory = await realpath(cwd);
    const state = await loadState(directory);

    return effectiveNotice(directory, state, await hashInputs(directory, []));
  } catch {
    return `TDD gate status unknown: unreadable evidence at ${statePath(resolve(cwd))}`;
  }
};

const saveState = async (cwd: string, state: EvidenceState) => {
  const path = statePath(cwd);
  await rejectStateSymlinks(cwd);

  const temporaryDirectory = await mkdtemp(`${path}.`);
  const temporary = resolve(temporaryDirectory, 'state.json');

  try {
    await writeFile(temporary, JSON.stringify({ tdd: state }), { flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

const withStateLock = async <Result>(
  cwd: string,
  update: () => Promise<Result>,
): Promise<Result> => {
  await rejectStateSymlinks(cwd);
  await mkdir(dirname(statePath(cwd)), { recursive: true });

  const lock = resolve(cwd, '.tau/state.lock');
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
        throw error;
      }

      // Never steal an old lock: its owner may only be paused, not dead.
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for TDD state lock at ${lock}. Stop other Tau sessions before removing an abandoned lock.`,
          { cause: error },
        );
      }

      await setTimeout(25);
    }
  }

  try {
    return await update();
  } finally {
    await rmdir(lock);
  }
};

export const createEvidenceStore = () => {
  const read = async (directory: string) => {
    const cwd = await realpath(directory);
    const evidence = await loadState(cwd);

    const hashes = await hashInputs(cwd, evidence.active?.files ?? []);
    const red = activeRed(evidence);
    const staleSinceRed =
      red === undefined
        ? []
        : red.behavior.files.filter(
            (file) => red.testHashes[resolve(cwd, file)] !== hashes[resolve(cwd, file)],
          );

    let phase: Phase = evidence.phase;

    if (phase === 'red' && staleSinceRed.length > 0) {
      phase = 'locked';
    }

    const currentTree =
      phase === 'green' || phase === 'verified'
        ? await treeDigest(cwd, evidence.active?.files ?? [])
        : null;

    if (phase === 'verified' && evidence.verifiedTree !== currentTree) {
      phase = 'green';
    }

    const notice = effectiveNotice(cwd, evidence, hashes);

    return {
      evidence,
      phase,
      implementationAllowed: notice !== undefined || phase === 'red' || phase === 'green',
      focusedPassValid:
        phase === 'verified' || (phase === 'green' && red?.greenTree === currentTree),
      fullPassValid: phase === 'verified',
      staleSinceRed,
      notice,
    };
  };

  const run = async (
    directory: string,
    requested: Behavior,
    scope: 'focused' | 'full',
    signal?: AbortSignal,
  ) => {
    const cwd = await realpath(directory);

    // Sort and deduplicate names and files because behavior identity compares serialized arrays.
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

    const before = await treeDigest(cwd, behavior.files);
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

    // Test execution stays outside the lock so a user can switch the gate during a long run.
    return withStateLock(cwd, async () => {
      const after = await hashInputs(cwd, behavior.files);
      const currentTree = await treeDigest(cwd, behavior.files);

      if (before !== currentTree) {
        return { kind: 'inputs-changed' as const, report: null, ...(await read(cwd)) };
      }

      const state = await loadState(cwd);

      const entry = state.reds.find((candidate) => sameBehavior(candidate.behavior, behavior));
      let arrival: 'unseen' | 'known' | 'same' = entry === undefined ? 'unseen' : 'known';

      if (state.active !== null && sameBehavior(state.active, behavior)) {
        arrival = 'same';
      }

      // Cancellation cannot switch behaviors. A full run on the active behavior still clears verification.
      if (report.kind === 'cancelled' && arrival !== 'same') {
        return { kind: 'cancelled' as const, report, ...(await read(cwd)) };
      }

      const filesExist = behavior.files.every((file) => after[resolve(cwd, file)] != null);
      let outcome: 'other' | 'fail' | 'pass' = 'other';

      if (
        filesExist &&
        report.kind === 'fail' &&
        uniquelyIs(cwd, report.tests, behavior, 'failed')
      ) {
        outcome = 'fail';
      } else if (filesExist && report.kind === 'pass' && redPassed(cwd, behavior, entry, report)) {
        outcome = 'pass';
      }

      if (arrival !== 'same') {
        if (arrival === 'unseen' && state.phase === 'verified') {
          state.reds = [];
        }

        state.phase = entry?.phase ?? 'locked';
        state.verifiedTree = null;
      }

      state.active = structuredClone(behavior);

      let staleForVerification: string[] = [];

      if (scope === 'full') {
        state.verifiedTree = null;

        if (state.phase === 'verified') {
          state.phase = 'green';
        }

        staleForVerification = await staleVerificationFiles(cwd, state.reds);

        if (
          outcome === 'pass' &&
          staleForVerification.length === 0 &&
          state.reds.every((red) => redPassed(cwd, red.behavior, red, report))
        ) {
          state.phase = 'verified';
          state.verifiedTree = currentTree;
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
              greenTree: null,
              edited: false,
              phase: 'red',
            };

            state.reds = state.reds.filter(
              (candidate) => !sameBehavior(candidate.behavior, behavior),
            );
            state.reds.push(red);
            state.phase = 'red';
            state.verifiedTree = null;

            for (const file of behavior.files) {
              for (const fullname of testNames(behavior)) {
                if (
                  'tests' in report &&
                  uniqueStatus(cwd, report.tests, fullname, file) === 'failed' &&
                  !state.proven.some((known) => known.file === file && known.fullname === fullname)
                ) {
                  state.proven.push({ file, fullname });
                }
              }
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
              entry.greenTree = currentTree;
              entry.phase = 'green';
              state.reds = state.reds.filter((candidate) => candidate !== entry);
              state.reds.push(entry);
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

      return { kind: report.kind, report, staleForVerification, ...(await read(cwd)) };
    });
  };

  const setGate = async (directory: string, gate: 'on' | 'off') => {
    const cwd = await realpath(directory);

    return withStateLock(cwd, async () => {
      const state = await loadState(cwd);

      state.gateOff = gate === 'off' ? { since: new Date().toISOString() } : null;

      await saveState(cwd, state);

      return read(cwd);
    });
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
