import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import type { RunnerResult, TestResult } from '../src/extensions/tdd/runner/types.js';
import { initializeRepository } from './gitRepository.js';
import {
  cargoPackage,
  createCrate,
  createNextestTool,
  libraryWith,
  nextestConfig,
  prebuildCrate,
  removeDepInfoFiles,
  useSharedCargoEnvironment,
} from './nextestHarness.js';
import type { NextestPatch, NextestRequest, NextestToolResult } from './nextestHarness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

useSharedCargoEnvironment('nextest-attribution');

const staleHint = 'Hint: Test results are stale; rerun run_tests on the current inputs.';

const redHint =
  'Hint: No RED observed for this behavior; start the next behavior with a failing focused test.';

const testsOf = (result: NextestToolResult): TestResult[] => {
  const report: RunnerResult = result.details.report;

  return 'tests' in report ? report.tests : [];
};

const hintOf = (patch: NextestPatch | undefined): string | undefined => patch?.content.at(-1)?.text;

const workspaceFiles = (): Record<string, string> => ({
  'Cargo.toml': [
    '[workspace]',
    'resolver = "2"',
    'members = ["pkg_a", "pkg_b"]',
    'default-members = ["pkg_a"]',
    '',
  ].join('\n'),
  'pkg_a/Cargo.toml': cargoPackage('probe_ws_a'),
  'pkg_a/src/lib.rs': 'pub fn a() -> i32 { 1 }\n',
  'pkg_b/Cargo.toml': cargoPackage('probe_ws_b'),
  'pkg_b/src/lib.rs': libraryWith('    #[test]\n    fn b_passes() {}'),
  '.pi/tau.json': nextestConfig,
});

const tool = createNextestTool();

const run = (cwd: string, request: NextestRequest) => tool.run(cwd, request);

const expectNoRedObservation = async (cwd: string, path: string): Promise<void> => {
  const first = await tool.edit(cwd, path, '\npub fn first_change() {}\n');

  expect(hintOf(first)).toBe(staleHint);

  const second = await tool.edit(cwd, path, '\npub fn second_change() {}\n');

  expect(hintOf(second)).toBe(redHint);
};

const expectUnknownNoRed = async (result: NextestToolResult, fullname: string): Promise<void> => {
  expect(result.details.kind).toBe('fail');

  const test = testsOf(result)[0];

  expect(test).toMatchObject({ file: '', fullname, status: 'failed' });
  expect(test?.attribution).toMatchObject({ kind: 'unknown' });
};

it('records RED when a focused failing unit test is attributed to src/sub.rs', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'sub-red', {
    'Cargo.toml': cargoPackage('probe_sub_red'),
    'src/lib.rs': 'pub mod sub;\n',
    'src/sub.rs': libraryWith('    #[test]\n    fn inner_fails() { assert_eq!(1, 2); }'),
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(crate, {
    files: ['src/sub.rs'],
    testFullName: 'sub::tests::inner_fails',
  });

  expect(result.details.report).toMatchObject({
    kind: 'fail',
    tests: [{ file: 'src/sub.rs', fullname: 'sub::tests::inner_fails', status: 'failed' }],
  });

  expect(testsOf(result)[0]?.attribution).toBeUndefined();

  expect(
    hintOf(await tool.edit(crate, 'src/sub.rs', '\npub fn implemented() {}\n')),
  ).toBeUndefined();
});

it('records RED for a tests/api.rs test that panics inside a src/sub.rs helper', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'api-helper-red', {
    'Cargo.toml': cargoPackage('probe_api_helper_red'),
    'src/lib.rs': 'pub mod sub;\n',
    'src/sub.rs': 'pub fn fails() { panic!("HELPER FAILURE"); }\n',
    'tests/api.rs': '#[test]\nfn api_fails() { probe_api_helper_red::sub::fails(); }\n',
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(crate, { files: ['tests/api.rs'], testFullName: 'api_fails' });

  expect(result.details.report).toMatchObject({
    kind: 'fail',
    tests: [{ file: 'tests/api.rs', fullname: 'api_fails', status: 'failed' }],
  });

  expect(testsOf(result)[0]?.attribution).toBeUndefined();

  expect(
    hintOf(await tool.edit(crate, 'src/sub.rs', '\npub fn implemented() {}\n')),
  ).toBeUndefined();
});

it('attributes a focused passing integration test to tests/api.rs', async ({ onTestFinished }) => {
  const crate = await createCrate(onTestFinished, 'api-pass', {
    'Cargo.toml': cargoPackage('probe_api_pass'),
    'src/lib.rs': 'pub fn value() -> i32 { 1 }\n',
    'tests/api.rs': '#[test]\nfn api_passes() { assert_eq!(1, 1); }\n',
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(crate, { files: ['tests/api.rs'], testFullName: 'api_passes' });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ file: 'tests/api.rs', fullname: 'api_passes', status: 'passed' }],
  });

  expect(testsOf(result)[0]?.attribution).toBeUndefined();
});

it('reports a test name in two binaries with different files as ambiguous and records no RED', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'duplicate-different-files', {
    'Cargo.toml': cargoPackage('probe_duplicate'),
    'src/lib.rs': '#[test]\nfn shared_fails() { assert_eq!(1, 2); }\n',
    'src/main.rs': 'fn main() {}\n#[test]\nfn shared_fails() { assert_eq!(1, 2); }\n',
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(crate, { files: ['src/lib.rs'], testFullName: 'shared_fails' });

  expect(result.details.kind).toBe('fail');

  const test = testsOf(result)[0];

  expect(test).toMatchObject({ file: '', fullname: 'shared_fails', status: 'failed' });

  expect(test?.attribution).toMatchObject({
    kind: 'ambiguous',
    binaryIds: ['probe_duplicate', 'probe_duplicate::bin/probe_duplicate'],
  });

  await expectNoRedObservation(crate, 'src/lib.rs');
});

it('runs the matched binary when another requested file matches none and records RED', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'partial-focus', {
    'Cargo.toml': cargoPackage('probe_partial'),
    'src/lib.rs': '#[test]\nfn lib_fails() { assert_eq!(1, 2); }\n',
    'src/platform.rs': '// platform-gated, not part of the dep-info\n',
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(crate, {
    files: ['src/lib.rs', 'src/platform.rs'],
    testFullName: 'lib_fails',
  });

  expect(result.details.report).toMatchObject({
    kind: 'fail',
    tests: [{ file: 'src/lib.rs', fullname: 'lib_fails', status: 'failed' }],
  });

  expect(testsOf(result)[0]?.attribution).toBeUndefined();

  expect(
    hintOf(await tool.edit(crate, 'src/lib.rs', '\npub fn implemented() {}\n')),
  ).toBeUndefined();
});

it('gives unknown attribution when the binary lists no requested file and records no RED', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'no-requested-file', {
    'Cargo.toml': ['[workspace]', 'resolver = "2"', 'members = ["pkg_a", "pkg_b"]', ''].join('\n'),
    'pkg_a/Cargo.toml': cargoPackage('probe_no_req_a'),
    'pkg_a/src/lib.rs': 'pub fn a() -> i32 { 1 }\n',
    'pkg_b/Cargo.toml': cargoPackage('probe_no_req_b'),
    'pkg_b/src/lib.rs': libraryWith('    #[test]\n    fn b_fails() { assert_eq!(1, 2); }'),
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);
  await removeDepInfoFiles('probe_no_req_a');

  const result = await run(crate, {
    files: ['pkg_a/src/lib.rs'],
    testFullName: 'tests::b_fails',
  });

  expect(result.details.kind).toBe('fail');
  await expectUnknownNoRed(result, 'tests::b_fails');
  await expectNoRedObservation(crate, 'pkg_a/src/lib.rs');
});

it('reports a test compiled into the lib and the bin as ambiguous and records no RED', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'dual-binary', {
    'Cargo.toml': cargoPackage('probe_dual'),
    'src/lib.rs': 'pub mod shared;\n',
    'src/main.rs': 'mod shared;\nfn main() {}\n',
    'src/shared.rs': '#[test]\nfn shared_fails() { assert_eq!(1, 2); }\n',
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(crate, {
    files: ['src/shared.rs'],
    testFullName: 'shared::shared_fails',
  });

  expect(result.details.kind).toBe('fail');

  const tests = testsOf(result);
  const binaryIds = ['probe_dual', 'probe_dual::bin/probe_dual'].toSorted();

  expect(tests).toHaveLength(2);

  for (const test of tests) {
    expect(test).toMatchObject({ file: '', fullname: 'shared::shared_fails', status: 'failed' });

    const attribution = test.attribution;

    expect(attribution?.kind).toBe('ambiguous');

    if (attribution?.kind !== 'ambiguous') {
      throw new Error('Expected an ambiguous attribution.');
    }

    expect(attribution.binaryIds.toSorted()).toEqual(binaryIds);
  }

  await expectNoRedObservation(crate, 'src/shared.rs');
});

it('attributes a non-default workspace member to its file from the workspace root', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'workspace', workspaceFiles());

  await prebuildCrate(crate);

  const result = await run(crate, {
    files: ['pkg_b/src/lib.rs'],
    testFullName: 'tests::b_passes',
  });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ file: 'pkg_b/src/lib.rs', fullname: 'tests::b_passes', status: 'passed' }],
  });
});

it('resolves workspace dep-info against the root when the suite runs from a member', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'workspace-member', {
    ...workspaceFiles(),
    'pkg_b/.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(`${crate}/pkg_b`, {
    files: ['src/lib.rs'],
    testFullName: 'tests::b_passes',
  });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ file: 'src/lib.rs', fullname: 'tests::b_passes', status: 'passed' }],
  });
});

it('attributes a test in backend/Cargo.toml to its file from the repository root', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'subdirectory', {
    'backend/Cargo.toml': cargoPackage('probe_backend'),
    'backend/src/lib.rs': libraryWith('    #[test]\n    fn backend_passes() {}'),
    '.pi/tau.json': JSON.stringify({
      tdd: { runner: 'nextest', cargoManifestPath: 'backend/Cargo.toml' },
    }),
  });

  await prebuildCrate(join(crate, 'backend'));

  const result = await run(crate, {
    files: ['backend/src/lib.rs'],
    testFullName: 'tests::backend_passes',
  });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ file: 'backend/src/lib.rs', fullname: 'tests::backend_passes', status: 'passed' }],
  });

  expect(testsOf(result)[0]?.attribution).toBeUndefined();
});

it('resolves the manifest path from the Git root when the session is the project directory', async ({
  onTestFinished,
}) => {
  const repository = await createCrate(onTestFinished, 'nested-session', {
    'backend/Cargo.toml': cargoPackage('probe_nested_session'),
    'backend/src/lib.rs': libraryWith('    #[test]\n    fn nested_passes() {}'),
    'backend/.pi/tau.json': JSON.stringify({
      tdd: { runner: 'nextest', cargoManifestPath: 'backend/Cargo.toml' },
    }),
  });

  await initializeRepository(repository);
  await prebuildCrate(join(repository, 'backend'));

  const result = await run(join(repository, 'backend'), {
    files: ['src/lib.rs'],
    testFullName: 'tests::nested_passes',
  });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ file: 'src/lib.rs', fullname: 'tests::nested_passes', status: 'passed' }],
  });
});

it('gives unknown attribution when a binary dep-info file is missing', async ({
  onTestFinished,
}) => {
  const crate = await createCrate(onTestFinished, 'missing-dep-info', {
    'Cargo.toml': cargoPackage('probe_missing_dep_info'),
    'src/lib.rs': 'pub mod sub;\n',
    'src/sub.rs': libraryWith('    #[test]\n    fn inner_fails() { assert_eq!(1, 2); }'),
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);
  await removeDepInfoFiles('probe_missing_dep_info');

  const result = await run(crate, {
    files: ['src/sub.rs'],
    testFullName: 'sub::tests::inner_fails',
  });

  expect(result.details.kind).toBe('fail');
  await expectUnknownNoRed(result, 'sub::tests::inner_fails');
  await expectNoRedObservation(crate, 'src/sub.rs');
});

it('runs a focused test in a bin-only crate', async ({ onTestFinished }) => {
  const crate = await createCrate(onTestFinished, 'bin-only', {
    'Cargo.toml': cargoPackage('probe_bin_only'),
    'src/main.rs': '#[test]\nfn bin_passes() { assert_eq!(1, 1); }\nfn main() {}\n',
    '.pi/tau.json': nextestConfig,
  });

  await prebuildCrate(crate);

  const result = await run(crate, { files: ['src/main.rs'], testFullName: 'bin_passes' });

  expect(result.details.report).toMatchObject({
    kind: 'pass',
    tests: [{ file: 'src/main.rs', fullname: 'bin_passes', status: 'passed' }],
  });
});
