import { createHash } from 'node:crypto';
import { glob, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { classifyPath, configurationPaths, tddConfig } from './config.js';
import { runTests } from './runner/index.js';
import { finishDiagnostics } from './runner/retention.js';
import type { RunDiagnostics, RunnerResult } from './runner/types.js';
import type { Behavior } from './types.js';

export type Freshness = 'fresh' | 'stale' | 'unknown';

const testNames = (behavior: Behavior) =>
  Array.isArray(behavior.testFullName) ? behavior.testFullName : [behavior.testFullName];

const normalizeBehavior = (cwd: string, behavior: Behavior): Behavior => {
  const files = [
    ...new Set(
      behavior.files.map((file) => {
        const literalPath = file.replaceAll(sep, '/');
        const path = relative(cwd, resolve(cwd, file)).replaceAll(sep, '/');

        if (
          isAbsolute(file) ||
          isAbsolute(path) ||
          /[*?[\]{}\\\0]/.test(literalPath) ||
          file.startsWith('@') ||
          path.startsWith('../') ||
          classifyPath(path) !== 'test'
        ) {
          throw new Error(`Expected a test file inside the worktree: ${file}`);
        }

        return path;
      }),
    ),
  ].toSorted();

  return { ...behavior, files, testFullName: [...new Set(testNames(behavior))].toSorted() };
};

const identity = (behavior: Behavior) => JSON.stringify([behavior.files, testNames(behavior)]);

const compareInputs = (before: string | null, after: string | null): Freshness => {
  if (before === null || after === null) {
    return 'unknown';
  }

  return before === after ? 'fresh' : 'stale';
};

// Keep the existing source, test, and configuration coverage. This is a checkpoint, not an atomic snapshot.
const fingerprint = async (cwd: string, files: string[]): Promise<string | null> => {
  try {
    const paths = [...files, ...configurationPaths];

    for await (const file of glob([...tddConfig.productionGlobs, ...tddConfig.testGlobs], {
      cwd,
      exclude: ['**/node_modules/**', '**/.git/**'],
    })) {
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

export const createTestObservation = (cwd: string) => {
  let active: string | null = null;
  let observedRed = false;
  let latest: LatestRun | null = null;
  const shownHints = new Set<keyof typeof hints>();
  let staleHintInput: string | null = null;
  let pending: Promise<unknown> = Promise.resolve();

  const enqueue = <Result>(work: () => Promise<Result>): Promise<Result> => {
    const result = pending.then(work);

    pending = result.catch(() => undefined);

    return result;
  };

  const hint = (condition: keyof typeof hints | undefined, input: string | null = null) => {
    if (condition === undefined || shownHints.has(condition)) {
      return undefined;
    }

    shownHints.add(condition);

    if (condition === 'stale' || condition === 'unknown') {
      staleHintInput = input;
    }

    return `Hint: ${hints[condition]}`;
  };

  const editHint = (current: string | null) => {
    if (latest !== null && latest.freshness !== 'fresh') {
      // Changing production is expected while implementing an observed focused failure.
      if (observedRed && latest.scope === 'focused' && latest.freshness === 'stale') {
        return undefined;
      }

      // Keep stale-first after verification. Only a later input change can suggest missing RED.
      if (
        !observedRed &&
        shownHints.has(latest.freshness) &&
        current !== null &&
        current !== staleHintInput
      ) {
        return hint('red');
      }

      return hint(latest.freshness, current);
    }

    if (latest?.scope === 'full' && latest.kind === 'pass') {
      return undefined;
    }

    return hint(observedRed ? undefined : 'red');
  };

  const checkpoint = (productionEdit: boolean) =>
    enqueue(async () => {
      let current: string | null = null;
      const canSuggestRed = !observedRed && !shownHints.has('red');

      if (
        latest !== null &&
        latest.fingerprint !== null &&
        (latest.freshness !== 'stale' || canSuggestRed)
      ) {
        current = await fingerprint(cwd, latest.behavior.files);

        if (current === null) {
          latest.freshness = 'unknown';
        } else if (current !== latest.fingerprint) {
          latest.freshness = 'stale';
        } else if (latest.freshness === 'unknown') {
          latest.freshness = 'fresh';
        }
      }

      if (!productionEdit) {
        return undefined;
      }

      return editHint(current);
    });

  const runHint = (scope: 'focused' | 'full', report: RunnerResult, freshness: Freshness) => {
    if (freshness !== 'fresh') {
      return freshness;
    }

    if (scope === 'full' && report.kind === 'pass') {
      active = null;
      observedRed = false;
      shownHints.clear();
    } else if (scope === 'focused' && report.kind === 'pass') {
      return observedRed ? 'full' : 'red';
    }

    return undefined;
  };

  const run = (
    requested: Behavior,
    scope: 'focused' | 'full',
    signal?: AbortSignal,
    onStart?: (behavior: Behavior) => void,
  ) =>
    enqueue(async () => {
      const behavior = normalizeBehavior(cwd, requested);
      const key = identity(behavior);

      if (
        active !== key &&
        !(active === null && latest !== null && identity(latest.behavior) === key)
      ) {
        observedRed = false;
        shownHints.clear();
      }

      active = key;

      const before = await fingerprint(cwd, behavior.files);

      onStart?.(behavior);

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
      const after = await fingerprint(cwd, behavior.files);
      const freshness = compareInputs(before, after);
      const previous = latest;

      latest = { behavior, scope, kind: report.kind, fingerprint: after, freshness };

      if (freshness === 'fresh' && scope === 'focused' && selectedFailed(cwd, behavior, report)) {
        if (!observedRed) {
          shownHints.clear();
        }

        observedRed = true;
      }

      if (previous?.freshness !== freshness && freshness === 'fresh') {
        shownHints.clear();
      }

      const inputs = { before, after };
      const runPath = await saveRunRecord(report.diagnostics, {
        cwd,
        ...behavior,
        scope,
        kind: report.kind,
        freshness,
        inputs,
        diagnostics: report.diagnostics,
      });

      await finishDiagnostics(report.diagnostics);

      return {
        kind: report.kind,
        scope,
        freshness,
        inputs,
        runPath,
        report,
        hint: hint(runHint(scope, report, freshness), after),
      };
    });

  return { run, checkpoint };
};

export const observationDirectory = async (directory: string) =>
  realpath(directory).catch(() => resolve(directory));
