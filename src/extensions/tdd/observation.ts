import { createHash } from 'node:crypto';
import { glob, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { classifyPath, configurationGlobs, tddConfig } from './config.js';
import { runTests } from './runner/index.js';
import { finishDiagnostics } from './runner/retention.js';
import type { RunDiagnostics, RunnerResult } from './runner/types.js';
import type { Behavior } from './types.js';

export type Freshness = 'fresh' | 'stale' | 'unknown';

const testNames = (behavior: Behavior) =>
  Array.isArray(behavior.testFullName) ? behavior.testFullName : [behavior.testFullName];

const normalizeTestFile = (cwd: string, file: string): string => {
  const literalPath = file.replaceAll(sep, '/');
  const path = relative(cwd, resolve(cwd, file)).replaceAll(sep, '/');

  if (isAbsolute(file) || isAbsolute(path)) {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  if (/[*?[\]{}\\\0]/.test(literalPath) || file.startsWith('@')) {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  if (path.startsWith('../') || classifyPath(path) !== 'test') {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  return path;
};

const normalizeBehavior = (cwd: string, behavior: Behavior): Behavior => {
  const files = [...new Set(behavior.files.map((file) => normalizeTestFile(cwd, file)))].toSorted();

  return { ...behavior, files, testFullName: [...new Set(testNames(behavior))].toSorted() };
};

const identity = (behavior: Behavior) => JSON.stringify([behavior.files, testNames(behavior)]);

const compareInputs = (before: string | null, after: string | null): Freshness => {
  if (before === null || after === null) {
    return 'unknown';
  }

  return before === after ? 'fresh' : 'stale';
};

// Content is checked at bounded checkpoints, not as an atomic snapshot.
const fingerprint = async (cwd: string, files: string[]): Promise<string | null> => {
  try {
    const paths = [...files];

    for await (const file of glob(
      [
        ...tddConfig.productionGlobs,
        ...tddConfig.testGlobs,
        ...tddConfig.testSupportGlobs,
        ...configurationGlobs,
      ],
      { cwd, exclude: [...tddConfig.excludedGlobs] },
    )) {
      paths.push(file);
    }

    const digest = createHash('sha256');

    const entries = await Promise.all(
      [...new Set(paths.map((path) => resolve(cwd, path)))].toSorted().map(async (file) => {
        try {
          const content = await readFile(file);

          return [file, createHash('sha256').update(content).digest('hex')];
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
          }

          return [file, null];
        }
      }),
    );

    digest.update(JSON.stringify(entries));

    return digest.digest('hex');
  } catch {
    // A reminder must not discard a test report or turn a successful edit into an error.
    return null;
  }
};

const selectedFailed = (cwd: string, behavior: Behavior, report: RunnerResult) =>
  report.kind === 'fail' &&
  testNames(behavior).every((name) => {
    const matches = report.tests.filter(
      (test) =>
        test.fullname === name &&
        behavior.files.some((file) => resolve(cwd, test.file) === resolve(cwd, file)),
    );

    return matches.length === 1 && matches[0]?.status === 'failed';
  });

const missingSymbolTypes = new Set(['TypeError', 'ReferenceError', 'SyntaxError']);

// A plain Error stays unclassified: production code may throw one as the expected behavior.
export const thrownErrorType = (message: string): string | null => {
  const errorType = /^([A-Za-z]*Error)\b/.exec(message)?.[1];

  if (errorType == null || errorType === 'AssertionError') {
    return null;
  }

  const missingModule = /Cannot find (?:module|package)|does not provide an export/.test(message);

  return missingSymbolTypes.has(errorType) || missingModule ? errorType : null;
};

const selectedThrownErrorType = (cwd: string, behavior: Behavior, report: RunnerResult) => {
  if (report.kind !== 'fail') {
    return null;
  }

  const selectedFailures = report.failures.filter(
    (failure) =>
      testNames(behavior).includes(failure.fullname) &&
      behavior.files.some((file) => resolve(cwd, failure.file) === resolve(cwd, file)),
  );

  return selectedFailures.map((failure) => thrownErrorType(failure.message)).find(Boolean) ?? null;
};

interface LatestRun {
  behavior: Behavior;
  scope: 'focused' | 'full';
  kind: RunnerResult['kind'];
  fingerprint: string | null;
  freshness: Freshness;
}

const hints = {
  red: 'No RED observed for this behavior; start the next behavior with a failing focused test.',
  full: 'Focused tests passed; run_tests with scope "full" to verify the suite.',
  stale: 'Test results are stale; rerun run_tests on the current inputs.',
  unknown: 'Test freshness is unknown; rerun run_tests when inputs can be read.',
  thrown:
    'RED came from a thrown {errorType}, not a failed assertion; make the test fail on the expected behavior before implementing.',
};

interface ObservationState {
  cwd: string;
  active: string | null;
  observedRed: boolean;
  latest: LatestRun | null;
  shownHints: Set<keyof typeof hints>;
  staleHintInput: string | null;
  pending: Promise<unknown>;
}

interface RunRequest {
  requested: Behavior;
  scope: 'focused' | 'full';
  signal?: AbortSignal | undefined;
  onStart?: ((behavior: Behavior) => void) | undefined;
}

const enqueue = <Result>(state: ObservationState, work: () => Promise<Result>): Promise<Result> => {
  const result = state.pending.then(work);

  state.pending = result.catch(() => undefined);

  return result;
};

const hint = (
  state: ObservationState,
  condition: keyof typeof hints | undefined,
  input: string | null = null,
  errorType = 'error',
): string | undefined => {
  if (condition === undefined || state.shownHints.has(condition)) {
    return undefined;
  }

  state.shownHints.add(condition);

  if (condition === 'stale' || condition === 'unknown') {
    state.staleHintInput = input;
  }

  return `Hint: ${hints[condition].replace('{errorType}', errorType)}`;
};

const sameAsLatest = (state: ObservationState, key: string): boolean =>
  state.active === null && state.latest !== null && identity(state.latest.behavior) === key;

const isExpectedImplementationEdit = (state: ObservationState, latest: LatestRun): boolean =>
  state.observedRed && latest.scope === 'focused' && latest.freshness === 'stale';

const suggestsMissingRed = (
  state: ObservationState,
  freshness: 'stale' | 'unknown',
  current: string | null,
): boolean => {
  if (state.observedRed || !state.shownHints.has(freshness)) {
    return false;
  }

  return current !== null && current !== state.staleHintInput;
};

const editHint = (state: ObservationState, current: string | null): string | undefined => {
  const latest = state.latest;

  if (latest !== null && latest.freshness !== 'fresh') {
    const freshness = latest.freshness;

    // Changing production is expected while implementing an observed focused failure.
    if (isExpectedImplementationEdit(state, latest)) {
      return undefined;
    }

    // Keep stale-first after verification. Only a later input change can suggest missing RED.
    if (suggestsMissingRed(state, freshness, current)) {
      return hint(state, 'red');
    }

    return hint(state, freshness, current);
  }

  if (latest?.scope === 'full' && latest.kind === 'pass') {
    return undefined;
  }

  return hint(state, state.observedRed ? undefined : 'red');
};

const runHint = (
  state: ObservationState,
  scope: 'focused' | 'full',
  report: RunnerResult,
  freshness: Freshness,
): 'stale' | 'unknown' | 'full' | undefined => {
  if (freshness !== 'fresh') {
    return freshness;
  }

  if (scope === 'full' && report.kind === 'pass') {
    state.active = null;
    state.observedRed = false;
    state.shownHints.clear();
  } else if (scope === 'focused' && report.kind === 'pass') {
    return 'full';
  }

  return undefined;
};

const saveRunRecord = async (diagnostics: RunDiagnostics | undefined, record: unknown) => {
  if (diagnostics === undefined) {
    return undefined;
  }

  const path = join(diagnostics.directory, 'run.json');

  try {
    await writeFile(path, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' });

    return path;
  } catch (error) {
    diagnostics.error = [diagnostics.error, `Could not save run.json: ${String(error)}`]
      .filter(Boolean)
      .join('\n');

    return undefined;
  }
};

const checkpointWork = async (
  state: ObservationState,
  productionEdit: boolean,
): Promise<string | undefined> => {
  const latest = state.latest;
  const canSuggestRed = !state.observedRed && !state.shownHints.has('red');
  let current: string | null = null;

  if (latest !== null && latest.fingerprint !== null) {
    if (latest.freshness !== 'stale' || canSuggestRed) {
      current = await fingerprint(state.cwd, latest.behavior.files);

      if (current === null) {
        latest.freshness = 'unknown';
      } else if (current !== latest.fingerprint) {
        latest.freshness = 'stale';
      } else if (latest.freshness === 'unknown') {
        latest.freshness = 'fresh';
      }
    }
  }

  if (!productionEdit) {
    return undefined;
  }

  return editHint(state, current);
};

const checkpoint = (state: ObservationState, productionEdit: boolean) =>
  enqueue(state, () => checkpointWork(state, productionEdit));

const runTestsFor = (
  state: ObservationState,
  behavior: Behavior,
  request: RunRequest,
): ReturnType<typeof runTests> =>
  runTests(
    request.scope === 'full'
      ? { cwd: state.cwd, scope: 'all', signal: request.signal }
      : {
          cwd: state.cwd,
          scope: 'changed',
          files: behavior.files,
          filter: `^(?:${testNames(behavior)
            .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|')})$`,
          signal: request.signal,
        },
  );

const performRun = async (state: ObservationState, request: RunRequest) => {
  const behavior = normalizeBehavior(state.cwd, request.requested);
  const key = identity(behavior);

  if (state.active !== key && !sameAsLatest(state, key)) {
    state.observedRed = false;
    state.shownHints.clear();
  }

  state.active = key;

  const before = await fingerprint(state.cwd, behavior.files);

  request.onStart?.(behavior);

  const report = await runTestsFor(state, behavior, request);
  const after = await fingerprint(state.cwd, behavior.files);
  const freshness = compareInputs(before, after);
  const previous = state.latest;

  state.latest = {
    behavior,
    scope: request.scope,
    kind: report.kind,
    fingerprint: after,
    freshness,
  };

  let thrownType: string | null = null;

  if (
    freshness === 'fresh' &&
    request.scope === 'focused' &&
    selectedFailed(state.cwd, behavior, report)
  ) {
    if (!state.observedRed) {
      state.shownHints.clear();
    }

    state.observedRed = true;
    thrownType = selectedThrownErrorType(state.cwd, behavior, report);
  }

  if (previous?.freshness !== freshness && freshness === 'fresh') {
    state.shownHints.clear();
  }

  const inputs = { before, after };
  const runPath = await saveRunRecord(report.diagnostics, {
    cwd: state.cwd,
    ...behavior,
    scope: request.scope,
    kind: report.kind,
    freshness,
    inputs,
    diagnostics: report.diagnostics,
  });

  await finishDiagnostics(report.diagnostics);

  return {
    kind: report.kind,
    scope: request.scope,
    freshness,
    inputs,
    runPath,
    report,
    hint:
      thrownType === null
        ? hint(state, runHint(state, request.scope, report, freshness), after)
        : hint(state, 'thrown', after, thrownType),
  };
};

const runObservation = (state: ObservationState, request: RunRequest) =>
  enqueue(state, () => performRun(state, request));

export const createTestObservation = (cwd: string) => {
  const state: ObservationState = {
    cwd,
    active: null,
    observedRed: false,
    latest: null,
    shownHints: new Set(),
    staleHintInput: null,
    pending: Promise.resolve(),
  };

  return {
    run: (
      requested: Behavior,
      scope: 'focused' | 'full',
      signal?: AbortSignal,
      onStart?: (behavior: Behavior) => void,
    ) => runObservation(state, { requested, scope, signal, onStart }),
    checkpoint: (productionEdit: boolean) => checkpoint(state, productionEdit),
  };
};

export const observationDirectory = async (directory: string) =>
  realpath(directory).catch(() => resolve(directory));
