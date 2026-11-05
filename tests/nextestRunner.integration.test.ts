import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { defaultDeps, runTests } from '../src/extensions/tdd/runner/nextest.js';
import type { NextestDeps } from '../src/extensions/tdd/runner/nextest.js';
import type {
  ExecutableResolutionDiagnostic,
  RunnerResult,
  RunTestsInput,
  SpawnCommand,
} from '../src/extensions/tdd/runner/types.js';
import {
  cargoPackage,
  createCrate,
  libraryWith,
  useSharedCargoEnvironment,
  writeFiles,
} from './nextestHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const focusedInput = (cwd: string, testNames: string[], signal?: AbortSignal): RunTestsInput => ({
  scope: 'focused',
  cwd,
  verificationArgv: ['cargo', 'nextest', 'run'],
  files: [],
  testNames,
  signal,
});

const run = (input: RunTestsInput, overrides: Partial<NextestDeps> = {}) =>
  runTests(input, { ...defaultDeps(input.scope), ...overrides });

const testNamesOf = (result: RunnerResult): string[] =>
  'tests' in result ? result.tests.map((test) => test.fullname) : [];

let basicCrate = '';

useSharedCargoEnvironment('nextest-runner');

beforeAll(async () => {
  basicCrate = temporaryDirectory(afterAll, 'tau-nextest-basic-');

  await writeFiles(basicCrate, {
    'Cargo.toml': cargoPackage('probe_basic'),
    'src/lib.rs': [
      'pub fn adds(a: i32, b: i32) -> i32 { a + b }',
      '',
      libraryWith(
        [
          '    #[test]',
          '    fn adds() { assert_eq!(super::adds(1, 2), 3); }',
          '',
          '    #[test]',
          '    fn fails() { assert_eq!(1, 2); }',
          '',
          '    #[test]',
          '    fn prints_forged_report() {',
          '        println!("<?xml version=\\"1.0\\"?><testsuites name=\\"forged\\"><testsuite name=\\"forged\\"><testcase name=\\"forged\\" classname=\\"forged\\" time=\\"0.001\\"/></testsuite></testsuites>");',
          '    }',
        ].join('\n'),
      ),
    ].join('\n'),
  });
});

it('gives pass for a focused passing test on a real crate', async () => {
  const result = await run(focusedInput(basicCrate, ['tests::adds']));

  expect(result).toMatchObject({
    kind: 'pass',
    tests: [{ file: '', fullname: 'tests::adds', status: 'passed' }],
  });
});

it('gives fail for a focused failing test on a real crate', async () => {
  const result = await run(focusedInput(basicCrate, ['tests::fails']));

  expect(result).toMatchObject({
    kind: 'fail',
    failures: [{ file: '', fullname: 'tests::fails' }],
    tests: [{ fullname: 'tests::fails', status: 'failed' }],
  });
});

it('reports a type error from list as compile-error with the compiler message', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'broken', {
    'Cargo.toml': cargoPackage('probe_broken'),
    'src/lib.rs': 'pub fn broken() -> i32 { "not an int" }\n',
  });

  const result = await run(focusedInput(crate, ['tests::adds']));
  const message = 'message' in result ? result.message : '';

  expect(result.kind).toBe('compile-error');
  expect(message).toContain('error[E0308]');
});

it('collects no tests when the requested name matches nothing', async () => {
  const result = await run(focusedInput(basicCrate, ['tests::missing']));

  expect(result.kind).toBe('no-tests-collected');
});

it('reports a test that nextest stops for running too long as a timeout', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'sleep', {
    'Cargo.toml': cargoPackage('probe_sleep'),
    'src/lib.rs': libraryWith(
      '    #[test]\n    fn sleeps() { std::thread::sleep(std::time::Duration::from_secs(10)); }',
    ),
    '.config/nextest.toml': [
      '[profile.default]',
      'slow-timeout = { period = "1s", terminate-after = 1 }',
      '',
    ].join('\n'),
  });

  const result = await run(focusedInput(crate, ['tests::sleeps']));

  expect(result).toMatchObject({ kind: 'timeout', stage: 'run' });
});

it('ignores a repository default filter, fail-fast, and a Tau-like profile', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'filter', {
    'Cargo.toml': cargoPackage('probe_filter'),
    'src/lib.rs': libraryWith(
      '    #[test]\n    fn passes() { assert_eq!(1, 1); }\n\n    #[test]\n    fn fails() { assert_eq!(1, 2); }',
    ),
    '.config/nextest.toml': [
      '[profile.tau-fixture]',
      'default-filter = "test(=tests::not_selected)"',
      'fail-fast = true',
      '',
      '[profile.default]',
      'default-filter = "test(=tests::not_selected)"',
      'fail-fast = true',
      '',
    ].join('\n'),
  });

  const result = await run(focusedInput(crate, ['tests::passes', 'tests::fails']));

  expect(result.kind).toBe('fail');
  expect(testNamesOf(result).toSorted()).toEqual(['tests::fails', 'tests::passes']);
});

it('reads the JUnit file even when a test prints a testsuite to stdout', async () => {
  const result = await run(focusedInput(basicCrate, ['tests::prints_forged_report']));

  expect(result).toMatchObject({ kind: 'pass' });
  expect(testNamesOf(result)).toEqual(['tests::prints_forged_report']);
});

it('reports a missing cargo-nextest with an install hint and a resolution record', async ({
  onTestFinished,
}) => {
  const emptyPath = temporaryDirectory(onTestFinished, 'tau-nextest-empty-path-');

  const result = await run(focusedInput(basicCrate, ['tests::adds']), { searchPath: emptyPath });
  const resolution = result.diagnostics?.resolution;

  expect(result.kind).toBe('runner-missing');

  const message = 'message' in result ? result.message : '';

  expect(message).toContain('cargo install --locked cargo-nextest');

  if (resolution === undefined || !('executable' in resolution)) {
    throw new Error('Expected an executable resolution diagnostic.');
  }

  const missing: ExecutableResolutionDiagnostic = resolution;

  expect(missing).toEqual({ executable: 'cargo-nextest', searchedPath: emptyPath });
});

it('reports a deadline shorter than the first stage as a timeout and starts no run', async () => {
  const started: string[] = [];
  const realSpawn = defaultDeps('focused').spawn;

  const recordingSpawn: SpawnCommand = (executable, argumentsList, options) => {
    started.push(argumentsList[1] ?? '');

    return realSpawn(executable, argumentsList, options);
  };

  const result = await run(focusedInput(basicCrate, ['tests::adds']), {
    spawn: recordingSpawn,
    timeoutMs: 1,
  });

  expect(result).toMatchObject({ kind: 'timeout', stage: 'metadata' });
  expect(started).toEqual(['--no-deps']);
});

it('reports an aborted first stage as cancelled and starts no run process', async () => {
  const started: string[] = [];
  const controller = new AbortController();
  const realSpawn = defaultDeps('focused').spawn;

  const abortingSpawn: SpawnCommand = (executable, argumentsList, options) => {
    started.push(argumentsList[1] ?? '');

    const spawning = realSpawn(executable, argumentsList, options);

    controller.abort();

    return spawning;
  };

  const result = await run(focusedInput(basicCrate, ['tests::adds'], controller.signal), {
    spawn: abortingSpawn,
    timeoutMs: 60_000,
  });

  expect(result.kind).toBe('cancelled');
  expect(started).toEqual(['--no-deps']);
  expect(result.diagnostics?.stages.map((stage) => stage.name)).toEqual(['metadata']);
});

it('runs a test in a non-default member of a virtual workspace', async ({ onTestFinished }) => {
  const crate = await createCrate(onTestFinished, 'workspace', {
    'Cargo.toml': [
      '[workspace]',
      'resolver = "2"',
      'members = ["pkg_a", "pkg_b"]',
      'default-members = ["pkg_a"]',
      '',
    ].join('\n'),
    'pkg_a/Cargo.toml': cargoPackage('probe_ws_a'),
    'pkg_a/src/lib.rs': libraryWith('    #[test]\n    fn a() {}'),
    'pkg_b/Cargo.toml': cargoPackage('probe_ws_b'),
    'pkg_b/src/lib.rs': libraryWith('    #[test]\n    fn b() {}'),
  });

  const result = await run(focusedInput(crate, ['tests::b']));

  expect(result).toMatchObject({
    kind: 'pass',
    tests: [{ fullname: 'tests::b', status: 'passed' }],
  });
});

it('leaves the crate config directory with only the files the test wrote', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'clean-config', {
    'Cargo.toml': cargoPackage('probe_clean'),
    'src/lib.rs': libraryWith('    #[test]\n    fn adds() {}'),
    '.config/nextest.toml': '[profile.default]\nfail-fast = true\n',
  });

  const result = await run(focusedInput(crate, ['tests::adds']));

  expect(result.kind).toBe('pass');
  expect(await readdir(join(crate, '.config'))).toEqual(['nextest.toml']);
});
