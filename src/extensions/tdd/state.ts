import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { classifyPath } from './config.js';
import { runTests } from './runner/index.js';
import type { Behavior, EvidenceRecord, EvidenceState, InputHashes } from './types.js';

// ponytail: one process-wide chain; split by worktree if independent runs need concurrency.
let pendingRun: Promise<unknown> = Promise.resolve();

const configPath = resolve(import.meta.dirname, 'config.ts');

const hashInputs = async (cwd: string, files: string[]): Promise<InputHashes> =>
  Object.fromEntries(
    await Promise.all(
      [
        ...new Set([
          ...files.map((file) => resolve(cwd, file)),
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

const sameHashes = (left: InputHashes, right: InputHashes) =>
  JSON.stringify(left) === JSON.stringify(right);

export const createEvidenceStore = () => {
  let state: EvidenceState = {
    active: null,
    red: null,
    focusedPass: null,
    fullPass: null,
    latestRun: null,
  };
  const read = async (cwd: string) => {
    const evidence = structuredClone(state);
    const hashes = await hashInputs(cwd, evidence.active?.files ?? []);
    const valid = (record: EvidenceRecord | null) =>
      record !== null && sameHashes(record.after, hashes);
    return {
      evidence,
      implementationAllowed: valid(evidence.red),
      focusedPassValid: valid(evidence.focusedPass),
      fullPassValid: valid(evidence.fullPass),
    };
  };
  const run = async (cwd: string, behavior: Behavior, scope: 'focused' | 'full') => {
    for (const file of behavior.files) {
      const path = relative(cwd, resolve(cwd, file));
      if (isAbsolute(file) || path.startsWith('../') || classifyPath(path) !== 'test') {
        throw new Error(`Expected a test file inside the worktree: ${file}`);
      }
    }
    const before = await hashInputs(cwd, behavior.files);
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
    const after = await hashInputs(cwd, behavior.files);
    if (!sameHashes(before, after))
      return { kind: 'inputs-changed' as const, ...(await read(cwd)) };
    if (JSON.stringify(state.active) !== JSON.stringify(behavior)) {
      state = { active: behavior, red: null, focusedPass: null, fullPass: null, latestRun: null };
    }
    const record = { before, after, report };
    state.latestRun = record;
    if (
      scope === 'focused' &&
      report.kind === 'fail' &&
      report.tests.some(
        (test) =>
          test.fullname === behavior.testFullName &&
          behavior.files.some((file) => resolve(cwd, file) === resolve(cwd, test.file)) &&
          test.status === 'failed',
      )
    )
      state.red = record;
    if (
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
