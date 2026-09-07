import { createHash } from 'node:crypto';
import { glob, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { classifyPath, tddConfig } from './config.js';
import { runTests } from './runner/index.js';
import type { Behavior, EvidenceRecord, EvidenceState, InputHashes, Phase } from './types.js';

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
          ...[...files, ...sources].map((file) => resolve(cwd, file)),
          resolve(cwd, 'vite.config.ts'),
          resolve(cwd, 'package.json'),
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

const redPassed = (
  cwd: string,
  behavior: Behavior | null,
  red: EvidenceRecord | null,
  pass: EvidenceRecord | null,
) => {
  if (behavior === null || red?.report.kind !== 'fail' || pass?.report.kind !== 'pass')
    return false;
  const required = red.report.tests.filter(
    (test) =>
      test.status === 'failed' &&
      test.fullname === behavior.testFullName &&
      behavior.files.some((file) => resolve(cwd, file) === resolve(cwd, test.file)),
  );
  const passed = pass.report.tests;
  return (
    required.length > 0 &&
    required.every((test) =>
      passed.some(
        (result) =>
          result.fullname === test.fullname &&
          resolve(cwd, result.file) === resolve(cwd, test.file) &&
          result.status === 'passed',
      ),
    )
  );
};

const failedIn = (cwd: string, { behavior, record }: EvidenceState['reds'][number], file: string) =>
  record.report.kind === 'fail' &&
  record.report.tests.some(
    (test) =>
      test.status === 'failed' &&
      test.fullname === behavior.testFullName &&
      resolve(cwd, test.file) === file,
  );

const statePath = (cwd: string) => resolve(cwd, '.tau/state.json');

const emptyState = (): EvidenceState => ({
  active: null,
  reds: [],
  red: null,
  focusedPass: null,
  fullPass: null,
  latestRun: null,
});

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
    return parsed.tdd;
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
    const state = states.get(key) ?? loadState(key);
    states.set(key, state);
    return state;
  };
  const read = async (cwd: string) => {
    const state = await stateFor(cwd);
    const evidence = structuredClone(state);
    const hashes = await hashInputs(cwd, evidence.active?.files ?? []);
    const productionHashes = await hashInputs(cwd, evidence.active?.files ?? [], 'focused');
    const redValid =
      evidence.red !== null &&
      Object.entries(hashes).every(([file, hash]) => evidence.red?.after[file] === hash);
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
            // Only a RED that failed inside this file may renew its snapshot, so appending
            // a behavior to a shared file keeps working while an unrelated RED cannot
            // launder edits to an earlier required test.
            const latest = evidence.reds.findLast((entry) => failedIn(cwd, entry, file));
            return (latest?.record ?? record).after[file] === hash;
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
    };
  };
  const run = async (cwd: string, behavior: Behavior, scope: 'focused' | 'full') => {
    for (const file of behavior.files) {
      const path = relative(cwd, resolve(cwd, file));
      if (isAbsolute(file) || path.startsWith('../') || classifyPath(path) !== 'test') {
        throw new Error(`Expected a test file inside the worktree: ${file}`);
      }
    }
    const before = await hashInputs(cwd, behavior.files, scope);
    const report = await runTests(
      scope === 'full'
        ? { cwd, scope: 'all' }
        : {
            cwd,
            scope: 'changed',
            files: behavior.files,
            filter: `^${behavior.testFullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          },
    );
    const after = await hashInputs(cwd, behavior.files, scope);
    if (!sameHashes(before, after))
      return { kind: 'inputs-changed' as const, ...(await read(cwd)) };
    const state = await stateFor(cwd);
    if (JSON.stringify(state.active) !== JSON.stringify(behavior)) {
      Object.assign(state, {
        active: structuredClone(behavior),
        red: null,
        focusedPass: null,
        fullPass: null,
        latestRun: null,
      });
    }
    const record = { before, after, report };
    const filesExist = behavior.files.every((file) => after[resolve(cwd, file)] != null);
    state.latestRun = record;
    if (scope === 'full') state.fullPass = null;
    else state.focusedPass = null;
    if (
      filesExist &&
      scope === 'focused' &&
      report.kind === 'fail' &&
      report.tests.some(
        (test) =>
          test.fullname === behavior.testFullName &&
          behavior.files.some((file) => resolve(cwd, file) === resolve(cwd, test.file)) &&
          test.status === 'failed',
      )
    ) {
      state.red = record;
      state.reds = state.reds.filter(
        (entry) =>
          entry.behavior.testFullName !== behavior.testFullName ||
          JSON.stringify(entry.behavior.files) !== JSON.stringify(behavior.files),
      );
      state.reds.push({ behavior: structuredClone(behavior), record });
      state.focusedPass = null;
      state.fullPass = null;
    }
    if (
      filesExist &&
      report.kind === 'pass' &&
      report.tests.some(
        (test) =>
          test.fullname === behavior.testFullName &&
          behavior.files.some((file) => resolve(cwd, file) === resolve(cwd, test.file)) &&
          test.status === 'passed',
      )
    ) {
      if (scope === 'full') state.fullPass = record;
      else state.focusedPass = record;
    }
    await saveState(cwd, state);
    return { kind: report.kind, ...(await read(cwd)) };
  };
  return {
    read,
    run: (cwd: string, behavior: Behavior, scope: 'focused' | 'full') => {
      const result = pendingRun.then(() => run(cwd, behavior, scope));
      pendingRun = result.catch(() => undefined);
      return result;
    },
  };
};
