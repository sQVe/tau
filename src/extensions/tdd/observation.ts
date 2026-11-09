import { access, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { errorMessage } from '../../errors.js';
import { classifyPath, defaultTddConfig } from './config.js';
import type { TddConfig } from './config.js';
import { fingerprintInputs } from './inputFingerprint.js';
import {
  checkpoint,
  checkpointNeedsInputHash,
  compareInputs,
  completeRun,
  startRun,
  testNames,
} from './observationTransition.js';
import type { CheckpointInput, CycleState, HintDecision } from './observationTransition.js';
import { classificationPath, projectDirectoryFromSession } from './projectPath.js';
import { finishDiagnostics } from './runner/retention.js';
import { lookupRunner } from './runner/runners.js';
import type { RunDiagnostics, RunnerResult, TestRunner } from './runner/types.js';
import type { Behavior, ObservationResult, TestObservation, TestScope } from './types.js';

interface ObservationState {
  cwd: string;
  repositoryRoot: string;
  config: TddConfig;
  cycle: CycleState;
  pending: Promise<unknown>;
}

interface InputHash {
  hash: string | null;
  error: string | undefined;
}

interface RunRequest {
  requested: Behavior;
  scope: TestScope;
  signal?: AbortSignal | undefined;
  onStart?: ((behavior: Behavior) => void) | undefined;
}

interface TestFileRules {
  config: TddConfig;
  projectDirectory: string | undefined;
  testFilesCanBeProduction: boolean;
}

const normalizeTestFile = async (
  cwd: string,
  rules: TestFileRules,
  file: string,
): Promise<string> => {
  const path = relative(cwd, resolve(cwd, file));

  const classified = isAbsolute(path)
    ? null
    : classificationPath(cwd, path, rules.projectDirectory);

  if (classified === null) {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  // Only a file in a chosen project outside the session may be named by an absolute path.
  if (isAbsolute(file) && classified === path) {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  if (/[*?{}\\\0]/.test(file) || file.startsWith('@')) {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  // Vitest matches file filters as literal substrings, so brackets are safe in an existing path,
  // such as a Next.js route. A missing one is more likely a glob.
  const exists = () =>
    access(resolve(cwd, file)).then(
      () => true,
      () => false,
    );

  if (!classifyPath(rules.config, classified, rules.testFilesCanBeProduction).test) {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  if (/[[\]]/.test(file) && !(await exists())) {
    throw new Error(`Expected a test file inside the worktree: ${file}`);
  }

  return path;
};

const normalizeBehavior = async (
  cwd: string,
  rules: TestFileRules,
  behavior: Behavior,
): Promise<Behavior> => {
  const normalized = await Promise.all(
    behavior.files.map((file) => normalizeTestFile(cwd, rules, file)),
  );

  const files = [...new Set(normalized)].toSorted();

  return { ...behavior, files, testFullName: [...new Set(testNames(behavior))].toSorted() };
};

const hashInputs = async (state: ObservationState, files: string[]): Promise<InputHash> => {
  try {
    return {
      hash: await fingerprintInputs(state.cwd, state.config, files, state.repositoryRoot),
      error: undefined,
    };
  } catch (error) {
    // A reminder must not discard a test report or turn a successful edit into an error.
    return { hash: null, error: errorMessage(error) };
  }
};

const reportedInputs = (before: InputHash, after: InputHash): ObservationResult['inputs'] => {
  const error = before.error ?? after.error;

  return { before: before.hash, after: after.hash, ...(error === undefined ? {} : { error }) };
};

const selectedFailed = (cwd: string, behavior: Behavior, report: RunnerResult) =>
  report.kind === 'fail' &&
  testNames(behavior).every((name) => {
    const matches = report.tests.filter(
      (test) =>
        test.fullname === name &&
        test.attribution === undefined &&
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
      failure.attribution === undefined &&
      testNames(behavior).includes(failure.fullname) &&
      behavior.files.some((file) => resolve(cwd, failure.file) === resolve(cwd, file)),
  );

  return selectedFailures.map((failure) => thrownErrorType(failure.message)).find(Boolean) ?? null;
};

const hints = {
  red: 'No RED observed for this behavior; start the next behavior with a failing focused test.',
  stale: 'Test results are stale; rerun run_tests on the current inputs.',
  unknown: 'Test freshness is unknown; rerun run_tests when inputs can be read.',
  thrown:
    'RED came from a thrown {errorType}, not a failed assertion; make the test fail on the expected behavior before implementing.',
};

const enqueue = <Result>(state: ObservationState, work: () => Promise<Result>): Promise<Result> => {
  const result = state.pending.then(work);

  state.pending = result.catch(() => undefined);

  return result;
};

const hintText = (decision: HintDecision | undefined): string | undefined =>
  decision === undefined
    ? undefined
    : `Hint: ${hints[decision.kind].replace('{errorType}', decision.errorType ?? 'error')}`;

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
  const latest = state.cycle.latest;
  let input: CheckpointInput = { kind: 'skipped' };

  if (latest !== null && checkpointNeedsInputHash(state.cycle)) {
    const inputs = await hashInputs(state, latest.behavior.files);

    input = inputs.hash === null ? { kind: 'unavailable' } : { kind: 'value', hash: inputs.hash };
  }

  const transition = checkpoint(state.cycle, input, productionEdit);

  state.cycle = transition.state;

  return hintText(transition.hint);
};

const checkpointObservation = (state: ObservationState, productionEdit: boolean) =>
  enqueue(state, () => checkpointWork(state, productionEdit));

const manifestPath = ({ config, repositoryRoot }: ObservationState): string | undefined =>
  config.cargoManifestPath === undefined
    ? undefined
    : resolve(repositoryRoot, config.cargoManifestPath);

const runTestsFor = (
  state: ObservationState,
  runner: TestRunner,
  behavior: Behavior,
  request: RunRequest,
): Promise<RunnerResult> => {
  const input = {
    cwd: state.cwd,
    verificationArgv: state.config.verificationArgv,
    cargoManifestPath: manifestPath(state),
    cargoLocked: state.config.cargoLocked,
    signal: request.signal,
  };

  if (request.scope === 'full') {
    return runner.run({ ...input, scope: 'full' });
  }

  return runner.run({
    ...input,
    scope: 'focused',
    files: behavior.files,
    testNames: testNames(behavior),
  });
};

const performRun = async (
  state: ObservationState,
  request: RunRequest,
): Promise<ObservationResult> => {
  const runner = lookupRunner(state.config.runner);

  const rules = {
    config: state.config,
    projectDirectory: projectDirectoryFromSession(
      state.cwd,
      state.repositoryRoot,
      state.config.cargoManifestPath,
    ),
    testFilesCanBeProduction: runner.testFilesCanBeProduction,
  };

  const behavior = await normalizeBehavior(state.cwd, rules, request.requested);

  state.cycle = startRun(state.cycle, behavior);

  const before = await hashInputs(state, behavior.files);

  request.onStart?.(behavior);

  const report = await runTestsFor(state, runner, behavior, request);
  const after = await hashInputs(state, behavior.files);
  const freshness = compareInputs(before.hash, after.hash);

  const transition = completeRun(state.cycle, {
    behavior,
    scope: request.scope,
    kind: report.kind,
    fingerprint: after.hash,
    freshness,
    selectionFailed: selectedFailed(state.cwd, behavior, report),
    thrownErrorType: selectedThrownErrorType(state.cwd, behavior, report),
  });

  state.cycle = transition.state;

  const inputs = reportedInputs(before, after);

  const runPath = await saveRunRecord(report.diagnostics, {
    cwd: state.cwd,
    ...behavior,
    scope: request.scope,
    kind: report.kind,
    freshness,
    inputs: { before: inputs.before, after: inputs.after },
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
    hint: hintText(transition.hint),
  };
};

const runObservation = (state: ObservationState, request: RunRequest) =>
  enqueue(state, () => performRun(state, request));

export const createTestObservation = (
  cwd: string,
  config: TddConfig = defaultTddConfig,
  repositoryRoot = cwd,
): TestObservation => {
  const state: ObservationState = {
    cwd,
    repositoryRoot,
    config,
    cycle: {
      active: null,
      observedRed: false,
      latest: null,
      shownHints: new Set(),
      staleHintInput: null,
    },
    pending: Promise.resolve(),
  };

  return {
    run: (
      requested: Behavior,
      scope: TestScope,
      signal?: AbortSignal,
      onStart?: (behavior: Behavior) => void,
    ) => runObservation(state, { requested, scope, signal, onStart }),
    checkpoint: (productionEdit: boolean) => checkpointObservation(state, productionEdit),
  };
};

export const observationDirectory = async (directory: string): Promise<string> =>
  realpath(directory).catch(() => resolve(directory));
