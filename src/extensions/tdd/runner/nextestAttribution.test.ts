import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { runTests } from './nextest.js';
import type { RunnerResult, RunTestsInput, SpawnCommand } from './types.js';

interface NextestBinaryFixture {
  binaryId: string;
  binaryName: string;
  kind: 'lib' | 'bin' | 'test';
  binaryPath: string;
  packageId: string;
  cwd: string;
  testNames: string[];
}

interface CargoTargetFixture {
  packageId: string;
  name: string;
  kind: 'lib' | 'bin' | 'test';
  srcPath: string;
}

const testCaseEntry = { kind: 'test', ignored: false, 'filter-match': { status: 'matches' } };

const listDocument = (binaries: NextestBinaryFixture[]): string =>
  JSON.stringify({
    'rust-suites': Object.fromEntries(
      binaries.map((binary) => [
        binary.binaryId,
        {
          'binary-id': binary.binaryId,
          'binary-name': binary.binaryName,
          kind: binary.kind,
          'binary-path': binary.binaryPath,
          'package-id': binary.packageId,
          cwd: binary.cwd,
          testcases: Object.fromEntries(binary.testNames.map((name) => [name, testCaseEntry])),
        },
      ]),
    ),
  });

const metadataDocument = (
  workspaceRoot: string,
  packageId: string,
  targets: CargoTargetFixture[],
) =>
  JSON.stringify({
    workspace_root: workspaceRoot,
    packages: [
      {
        id: packageId,
        targets: targets.map((target) => ({
          name: target.name,
          kind: [target.kind],
          src_path: target.srcPath,
        })),
      },
    ],
  });

const failingReport = (binaryId: string, name: string): string =>
  `<testsuites><testsuite name="${binaryId}"><testcase name="${name}" classname="${binaryId}" time="0.001"><failure>boom</failure></testcase></testsuite></testsuites>`;

const writeDepInfo = async (
  directory: string,
  baseName: string,
  sources: string[],
): Promise<string> => {
  await mkdir(directory, { recursive: true });

  const binaryPath = join(directory, baseName);

  await writeFile(`${binaryPath}.d`, `${binaryPath}.d: ${sources.join(' ')}\n`, 'utf8');

  return binaryPath;
};

const junitPathFrom = async (argumentsList: string[]): Promise<string> => {
  const flag = argumentsList[argumentsList.indexOf('--tool-config-file') + 1] ?? '';
  const toml = await readFile(flag.slice('tau:'.length), 'utf8');
  const quoted = /^path = (".*")$/m.exec(toml)?.[1] ?? '""';

  return JSON.parse(quoted) as string;
};

const stageOf = (argumentsList: string[]): 'list' | 'metadata' | 'run' => {
  if (argumentsList[0] === 'metadata') {
    return 'metadata';
  }

  return argumentsList[1] === 'list' ? 'list' : 'run';
};

const fakeNextest = (list: string, metadata: string, report: string, runCode = 100) => {
  const stages: string[] = [];
  const runExpressions: string[] = [];

  const spawn: SpawnCommand = async (command, argumentsList) => {
    const stage = stageOf(argumentsList);

    stages.push(stage);

    let stdout = '';

    if (stage === 'list') {
      stdout = list;
    } else if (stage === 'metadata') {
      stdout = metadata;
    }

    if (stage === 'run') {
      runExpressions.push(argumentsList[argumentsList.indexOf('-E') + 1] ?? '');
      await writeFile(await junitPathFrom(argumentsList), report);
    }

    return {
      stdout,
      stderr: '',
      code: stage === 'run' ? runCode : 0,
      timedOut: false,
      command: [command, ...argumentsList],
      started: true,
      stdoutTruncated: false,
      stdoutBytes: stdout.length,
      stderrBytes: 0,
    };
  };

  return { spawn, stages, runExpressions };
};

let searchPath = '';

beforeAll(async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(afterAll, 'tau-nextest-attribution-agent-'));
  searchPath = temporaryDirectory(afterAll, 'tau-nextest-attribution-path-');

  const executable = join(searchPath, 'cargo-nextest');

  await writeFile(executable, '');
  await chmod(executable, 0o755);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const focused = (cwd: string, files: string[], testNames: string[]): RunTestsInput => ({
  scope: 'focused',
  cwd,
  verificationArgv: ['cargo', 'nextest', 'run'],
  files,
  testNames,
});

const run = async (
  input: RunTestsInput,
  spawn: SpawnCommand,
  onTestFinished: TestContext['onTestFinished'],
): Promise<RunnerResult> => {
  const result = await runTests(input, { spawn, searchPath, timeoutMs: 30_000 });
  const directory = result.diagnostics?.directory;

  if (directory !== undefined) {
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
  }

  return result;
};

it('attributes a failing unit test in the requested src/sub.rs', async ({ onTestFinished }) => {
  const workspace = temporaryDirectory(onTestFinished, 'tau-nextest-attr-');

  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src/lib.rs'), 'pub mod sub;\n', 'utf8');
  await writeFile(join(workspace, 'src/sub.rs'), '#[cfg(test)]\nmod tests {\n}\n', 'utf8');

  const binaryPath = await writeDepInfo(workspace, 'demo-abc', ['src/lib.rs', 'src/sub.rs']);

  const list = listDocument([
    {
      binaryId: 'demo',
      binaryName: 'demo',
      kind: 'lib',
      binaryPath,
      packageId: 'package',
      cwd: workspace,
      testNames: ['sub::tests::fails'],
    },
  ]);

  const metadata = metadataDocument(workspace, 'package', [
    { packageId: 'package', name: 'demo', kind: 'lib', srcPath: join(workspace, 'src/lib.rs') },
  ]);

  const nextest = fakeNextest(list, metadata, failingReport('demo', 'sub::tests::fails'));

  const result = await run(
    focused(workspace, ['src/sub.rs'], ['sub::tests::fails']),
    nextest.spawn,
    onTestFinished,
  );

  expect(result).toMatchObject({
    kind: 'fail',
    tests: [{ file: 'src/sub.rs', fullname: 'sub::tests::fails', status: 'failed' }],
    failures: [{ file: 'src/sub.rs', fullname: 'sub::tests::fails' }],
  });

  expect(nextest.runExpressions[0]).toBe('binary_id(demo) & test(=sub::tests::fails)');

  const tests = 'tests' in result ? result.tests : [];

  expect(tests[0]?.attribution).toBeUndefined();
});

it('gives unknown attribution when a dep-info file is missing, not no-tests-collected', async ({
  onTestFinished,
}) => {
  const workspace = temporaryDirectory(onTestFinished, 'tau-nextest-attr-');

  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src/sub.rs'), '#[cfg(test)]\nmod tests {\n}\n', 'utf8');

  const list = listDocument([
    {
      binaryId: 'demo',
      binaryName: 'demo',
      kind: 'lib',
      binaryPath: join(workspace, 'demo-missing'),
      packageId: 'package',
      cwd: workspace,
      testNames: ['sub::tests::fails'],
    },
  ]);

  const metadata = metadataDocument(workspace, 'package', [
    { packageId: 'package', name: 'demo', kind: 'lib', srcPath: join(workspace, 'src/lib.rs') },
  ]);

  const nextest = fakeNextest(list, metadata, failingReport('demo', 'sub::tests::fails'));

  const result = await run(
    focused(workspace, ['src/sub.rs'], ['sub::tests::fails']),
    nextest.spawn,
    onTestFinished,
  );

  expect(result.kind).toBe('fail');
  expect(nextest.stages).toEqual(['metadata', 'list', 'run']);

  const failures = 'failures' in result ? result.failures : [];

  expect(failures[0]?.attribution).toEqual({
    kind: 'unknown',
    reason: 'no dep-info for binary demo',
  });
});

it('collects no tests and starts no run when no binary contains the requested file', async ({
  onTestFinished,
}) => {
  const workspace = temporaryDirectory(onTestFinished, 'tau-nextest-attr-');

  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src/lib.rs'), 'pub mod sub;\n', 'utf8');

  const binaryPath = await writeDepInfo(workspace, 'demo-abc', ['src/lib.rs']);

  const list = listDocument([
    {
      binaryId: 'demo',
      binaryName: 'demo',
      kind: 'lib',
      binaryPath,
      packageId: 'package',
      cwd: workspace,
      testNames: ['sub::tests::fails'],
    },
  ]);

  const metadata = metadataDocument(workspace, 'package', [
    { packageId: 'package', name: 'demo', kind: 'lib', srcPath: join(workspace, 'src/lib.rs') },
  ]);

  const nextest = fakeNextest(list, metadata, failingReport('demo', 'sub::tests::fails'));

  const result = await run(
    focused(workspace, ['src/other.rs'], ['sub::tests::fails']),
    nextest.spawn,
    onTestFinished,
  );

  expect(result.kind).toBe('no-tests-collected');
  expect(nextest.stages).toEqual(['metadata', 'list']);
});

it('resolves dep-info paths against the workspace root when the suite cwd is a member', async ({
  onTestFinished,
}) => {
  const workspaceRoot = temporaryDirectory(onTestFinished, 'tau-nextest-attr-');
  const member = join(workspaceRoot, 'member');

  await mkdir(join(member, 'src'), { recursive: true });
  await writeFile(join(member, 'src/lib.rs'), 'pub mod sub;\n', 'utf8');
  await writeFile(join(member, 'src/sub.rs'), '#[cfg(test)]\nmod tests {\n}\n', 'utf8');

  const binaryPath = await writeDepInfo(join(workspaceRoot, 'deps'), 'demo-abc', [
    'member/src/lib.rs',
    'member/src/sub.rs',
  ]);

  const list = listDocument([
    {
      binaryId: 'demo',
      binaryName: 'demo',
      kind: 'lib',
      binaryPath,
      packageId: 'package',
      cwd: member,
      testNames: ['sub::tests::fails'],
    },
  ]);

  const metadata = metadataDocument(workspaceRoot, 'package', [
    { packageId: 'package', name: 'demo', kind: 'lib', srcPath: join(member, 'src/lib.rs') },
  ]);

  const nextest = fakeNextest(list, metadata, failingReport('demo', 'sub::tests::fails'));

  const result = await run(
    focused(member, ['src/sub.rs'], ['sub::tests::fails']),
    nextest.spawn,
    onTestFinished,
  );

  expect(result).toMatchObject({
    kind: 'fail',
    tests: [{ file: 'src/sub.rs', fullname: 'sub::tests::fails', status: 'failed' }],
  });
});

it('keeps the unscoped name filter when one binary has no dep-info', async ({ onTestFinished }) => {
  const workspace = temporaryDirectory(onTestFinished, 'tau-nextest-attr-');

  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src/lib.rs'), 'pub mod sub;\n', 'utf8');
  await writeFile(join(workspace, 'src/sub.rs'), '#[cfg(test)]\nmod tests {\n}\n', 'utf8');

  const binaryPath = await writeDepInfo(workspace, 'demo-abc', ['src/lib.rs', 'src/sub.rs']);

  const list = listDocument([
    {
      binaryId: 'demo',
      binaryName: 'demo',
      kind: 'lib',
      binaryPath,
      packageId: 'package',
      cwd: workspace,
      testNames: ['sub::tests::fails'],
    },
    {
      binaryId: 'other',
      binaryName: 'other',
      kind: 'lib',
      binaryPath: join(workspace, 'other-missing'),
      packageId: 'package',
      cwd: workspace,
      testNames: ['other::tests::fails'],
    },
  ]);

  const metadata = metadataDocument(workspace, 'package', [
    { packageId: 'package', name: 'demo', kind: 'lib', srcPath: join(workspace, 'src/lib.rs') },
    { packageId: 'package', name: 'other', kind: 'lib', srcPath: join(workspace, 'src/other.rs') },
  ]);

  const nextest = fakeNextest(list, metadata, failingReport('demo', 'sub::tests::fails'));

  const result = await run(
    focused(workspace, ['src/sub.rs'], ['sub::tests::fails']),
    nextest.spawn,
    onTestFinished,
  );

  expect(result.kind).toBe('fail');
  expect(nextest.runExpressions[0]).toBe('test(=sub::tests::fails)');
});
