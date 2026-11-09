import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultDeps, nextestRunner, runTests } from './nextest.js';
import type { RunnerResult, RunTestsInput, SpawnCommand, SpawnResult } from './types.js';

type Stage = 'list' | 'metadata' | 'run';

interface StageReply extends Partial<SpawnResult> {
  report?: string;
  during?: () => void;
}

interface SpawnCall {
  command: string;
  argumentsList: string[];
  timeoutMs: number;
}

const fileWrites = vi.hoisted(() => ({
  written: (_path: string): void => undefined,
  read: (_path: string): void => undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    writeFile: async (...writeArguments: Parameters<typeof actual.writeFile>) => {
      const [path] = writeArguments;

      await actual.writeFile(...writeArguments);
      fileWrites.written(typeof path === 'string' ? path : '');
    },
    readFile: (async (...readArguments: Parameters<typeof actual.readFile>) => {
      const [path] = readArguments;
      const content = await actual.readFile(...readArguments);

      fileWrites.read(typeof path === 'string' ? path : '');

      return content;
    }) as typeof actual.readFile,
  };
});

const emptyReport = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="nextest-run"/>\n';

const defaultList = JSON.stringify({
  'rust-suites': {
    demo: {
      'binary-id': 'demo',
      'binary-name': 'demo',
      kind: 'lib',
      'binary-path': '/repo/target/debug/deps/demo',
      'package-id': 'path+file:///repo#0.1.0',
      cwd: '/repo',
      testcases: {},
    },
  },
});

const defaultMetadata = JSON.stringify({ workspace_root: '/repo', packages: [] });

const defaultReplies: Partial<Record<Stage, StageReply>> = {
  list: { stdout: defaultList },
  metadata: { stdout: defaultMetadata },
};

const fixture = (name: string) => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

const toolConfigPathFrom = (argumentsList: string[]): string => {
  const flag = argumentsList[argumentsList.indexOf('--tool-config-file') + 1] ?? '';

  return flag.slice('tau:'.length);
};

const junitPathFrom = async (argumentsList: string[]): Promise<string> => {
  const toml = await readFile(toolConfigPathFrom(argumentsList), 'utf8');
  const quoted = /^path = (".*")$/m.exec(toml)?.[1] ?? '""';

  return JSON.parse(quoted) as string;
};

const stageOf = (argumentsList: string[]): Stage => {
  if (argumentsList[0] === 'metadata') {
    return 'metadata';
  }

  return argumentsList[1] === 'list' ? 'list' : 'run';
};

const fakeNextest = (
  replies: Partial<Record<Stage, StageReply>>,
  config: { writeCapture?: boolean } = {},
) => {
  const calls: SpawnCall[] = [];

  const spawn: SpawnCommand = async (command, argumentsList, options) => {
    calls.push({ command, argumentsList, timeoutMs: options.timeoutMs });

    const stage = stageOf(argumentsList);
    const { report, during, ...result } = { ...defaultReplies[stage], ...replies[stage] };

    during?.();

    if (options.stdoutFile !== undefined && config.writeCapture !== false) {
      await writeFile(options.stdoutFile, result.stdout ?? '');
    }

    if (report !== undefined) {
      await writeFile(await junitPathFrom(argumentsList), report);
    }

    return {
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      command: [command, ...argumentsList],
      started: true,
      stdoutTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      ...result,
    };
  };

  return { spawn, calls, stages: () => calls.map((call) => stageOf(call.argumentsList)) };
};

let searchPath = '';
let sharedAgentDirectory = '';

beforeAll(async () => {
  sharedAgentDirectory = temporaryDirectory(afterAll, 'tau-nextest-agent-');
  vi.stubEnv('PI_CODING_AGENT_DIR', sharedAgentDirectory);
  searchPath = temporaryDirectory(afterAll, 'tau-nextest-path-');

  const executable = join(searchPath, 'cargo-nextest');

  await writeFile(executable, '');
  await chmod(executable, 0o755);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const focused = (testNames: string[], signal?: AbortSignal): RunTestsInput => ({
  scope: 'focused',
  cwd: '/repo',
  verificationArgv: ['cargo', 'nextest', 'run'],
  files: [],
  testNames,
  signal,
});

const focusedIn = (
  cwd: string,
  files: string[],
  testNames: string[],
  signal?: AbortSignal,
): RunTestsInput => ({
  scope: 'focused',
  cwd,
  verificationArgv: ['cargo', 'nextest', 'run'],
  files,
  testNames,
  signal,
});

const listWithSources = (binaryPath: string, cwd: string, testNames: string[]): string =>
  JSON.stringify({
    'rust-suites': {
      demo: {
        'binary-id': 'demo',
        'binary-name': 'demo',
        kind: 'lib',
        'binary-path': binaryPath,
        'package-id': 'package',
        cwd,
        testcases: Object.fromEntries(
          testNames.map((name) => [
            name,
            { kind: 'test', ignored: false, 'filter-match': { status: 'matches' } },
          ]),
        ),
      },
    },
  });

const metadataWithRoot = (workspaceRoot: string, srcPath: string): string =>
  JSON.stringify({
    workspace_root: workspaceRoot,
    packages: [{ id: 'package', targets: [{ name: 'demo', kind: ['lib'], src_path: srcPath }] }],
  });

const run = async (
  input: RunTestsInput,
  spawn: SpawnCommand,
  overrides: { searchPath?: string; timeoutMs?: number } = {},
): Promise<RunnerResult> => {
  const result = await runTests(input, {
    spawn,
    searchPath: overrides.searchPath ?? searchPath,
    timeoutMs: overrides.timeoutMs ?? 30_000,
  });

  const directory = result.diagnostics?.directory;

  if (directory !== undefined) {
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
  }

  return result;
};

it('reports a build failure during list with the compiler output and starts no run', async () => {
  const nextest = fakeNextest({
    list: {
      code: 101,
      stderr: '   Compiling error-chain v0.12.4\nerror[E0425]: cannot find value `x`\n',
    },
  });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({
    kind: 'compile-error',
    message: 'cargo nextest list could not build the tests:\nerror[E0425]: cannot find value `x`',
  });

  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('names the exit code when list fails without a build error', async () => {
  const nextest = fakeNextest({ list: { code: 2 } });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({
    kind: 'compile-error',
    message: 'cargo nextest list exited with code 2.',
  });

  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('reports unreadable list JSON as a compile error instead of an empty binary list', async () => {
  const nextest = fakeNextest({ list: { stdout: '{"rust-suites":' } });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({ kind: 'compile-error' });
  expect('message' in result && result.message).toContain('nextest list');
  expect('message' in result && result.message).toContain('{"rust-suites":');
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('reports unreadable metadata JSON as a compile error and starts no list', async () => {
  const nextest = fakeNextest({ metadata: { stdout: '{"workspace_root":' } });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({ kind: 'compile-error' });
  expect('message' in result && result.message).toContain('metadata');
  expect(nextest.stages()).toEqual(['metadata']);
});

it('reports a missing list capture with truncated stdout as a compile error and starts no run', async () => {
  const nextest = fakeNextest(
    { list: { stdout: defaultList, stdoutTruncated: true } },
    { writeCapture: false },
  );

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({ kind: 'compile-error' });
  expect('message' in result && result.message).toContain('nextest list');
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('reports a missing metadata capture with truncated stdout as a compile error and starts no list', async () => {
  const nextest = fakeNextest(
    { metadata: { stdout: defaultMetadata, stdoutTruncated: true } },
    { writeCapture: false },
  );

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({ kind: 'compile-error' });
  expect('message' in result && result.message).toContain('metadata');
  expect(nextest.stages()).toEqual(['metadata']);
});

it('parses complete discovery output when the capture file is missing', async () => {
  const nextest = fakeNextest(
    { run: { report: await fixture('two-binaries.xml') } },
    { writeCapture: false },
  );

  const result = await run(focused(['tests::same']), nextest.spawn);

  expect(result.kind).toBe('pass');
  expect(nextest.stages()).toEqual(['metadata', 'list', 'run']);
});

it('reports a failed discovery capture as a compile error and starts no later stage', async () => {
  const nextest = fakeNextest({
    metadata: { code: null, stderr: 'ENOSPC: no space left on device, write' },
  });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({ kind: 'compile-error' });
  expect('message' in result && result.message).toContain('ENOSPC');
  expect(nextest.stages()).toEqual(['metadata']);
});

it.for([
  { name: 'exit 0 with passing tests', code: 0, report: 'two-binaries.xml', kind: 'pass' },
  { name: 'exit 100 with a failed test', code: 100, report: 'pass-and-fail.xml', kind: 'fail' },
  { name: 'exit 4 with an empty report', code: 4, report: undefined, kind: 'no-tests-collected' },
])('maps a run with $name to $kind', async ({ code, report, kind }) => {
  const xml = report === undefined ? emptyReport : await fixture(report);
  const nextest = fakeNextest({ run: { code, report: xml } });

  const result = await run(focused(['tests::same', 'tests::fails']), nextest.spawn);

  expect(result.kind).toBe(kind);
  expect(nextest.stages()).toEqual(['metadata', 'list', 'run']);
});

it('reads test results and failures from the JUnit report', async () => {
  const nextest = fakeNextest({ run: { code: 100, report: await fixture('pass-and-fail.xml') } });

  const result = await run(focused(['tests::fails', 'tests::passes']), nextest.spawn);

  expect(result).toMatchObject({
    kind: 'fail',
    truncated: false,
    tests: [
      { file: '', fullname: 'tests::fails', status: 'failed', durationMs: 7 },
      { file: '', fullname: 'tests::passes', status: 'passed', durationMs: 8 },
    ],
  });

  const failures = 'failures' in result ? result.failures : [];

  expect(failures).toHaveLength(1);
  expect(failures[0]?.fullname).toBe('tests::fails');
  expect(failures[0]?.message).toContain('boom at fixture');
});

it('reports a run without a JUnit report as an error that names the report path', async () => {
  const nextest = fakeNextest({ run: { code: 0 } });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result.kind).toBe('compile-error');
  expect('message' in result && result.message).toContain(result.diagnostics?.report.path);
});

it('names the exit code when run fails without a test failure', async () => {
  const nextest = fakeNextest({ run: { code: 3, report: await fixture('two-binaries.xml') } });

  const result = await run(focused(['tests::same']), nextest.spawn);

  expect(result).toMatchObject({
    kind: 'compile-error',
    message: 'cargo nextest run exited with code 3.',
  });
});

it('does not pass a run whose report has no passed test', async () => {
  const nextest = fakeNextest({ run: { code: 0, report: emptyReport } });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result.kind).toBe('no-tests-collected');
});

it('reports a test that nextest stopped for running too long as a run timeout', async () => {
  const nextest = fakeNextest({ run: { code: 100, report: await fixture('timeout.xml') } });

  const result = await run(focused(['tests::sleeps']), nextest.spawn);

  expect(result).toMatchObject({ kind: 'timeout', stage: 'run' });
});

it('reports a run that reaches the deadline as a run timeout', async () => {
  const nextest = fakeNextest({ run: { code: null, timedOut: true } });

  const result = await run(focused(['tests::adds']), nextest.spawn);

  expect(result).toMatchObject({ kind: 'timeout', stage: 'run' });
});

it('gives the run only the time that list left of the deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const nextest = fakeNextest({
    list: { during: () => vi.advanceTimersByTime(400) },
    run: { report: await fixture('two-binaries.xml') },
  });

  const result = await run(focused(['tests::same']), nextest.spawn, { timeoutMs: 1000 });

  expect(result.kind).toBe('pass');
  expect(nextest.calls.map((call) => call.timeoutMs)).toEqual([1000, 1000, 600]);
});

it.for([
  { name: 'uses up the deadline', reply: { during: () => vi.advanceTimersByTime(1000) } },
  { name: 'times out', reply: { code: null, timedOut: true } },
])('reports a list that $name as a list timeout and starts no run', async ({ reply }) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
  });

  const nextest = fakeNextest({ list: reply });

  const result = await run(focused(['tests::adds']), nextest.spawn, { timeoutMs: 1000 });

  expect(result).toMatchObject({ kind: 'timeout', stage: 'list' });
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('reports an abort during list as cancelled and starts no run', async () => {
  const controller = new AbortController();

  const nextest = fakeNextest({
    list: {
      code: null,
      during: () => {
        controller.abort();
      },
    },
  });

  const result = await run(focused(['tests::adds'], controller.signal), nextest.spawn);

  expect(result.kind).toBe('cancelled');
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('reports an abort during the tool-config write as cancelled and starts no run', async () => {
  const controller = new AbortController();
  const nextest = fakeNextest({});

  fileWrites.written = (path) => {
    if (path.endsWith('tool-config.toml')) {
      controller.abort();
    }
  };

  onTestFinished(() => {
    fileWrites.written = () => undefined;
  });

  const result = await run(focused(['tests::adds'], controller.signal), nextest.spawn);

  expect(result.kind).toBe('cancelled');
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

const useFakeClock = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  onTestFinished(() => {
    vi.useRealTimers();
    fileWrites.written = () => undefined;
  });
};

it('reports a deadline that expires during the tool-config write as a timeout and starts no run', async () => {
  useFakeClock();

  fileWrites.written = (path) => {
    if (path.endsWith('tool-config.toml')) {
      vi.advanceTimersByTime(1000);
    }
  };

  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  const result = await run(focused(['tests::same']), nextest.spawn, { timeoutMs: 1000 });

  expect(result).toMatchObject({ kind: 'timeout', stage: 'list' });
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('reports an abort during metadata as cancelled and starts no run', async () => {
  const controller = new AbortController();

  const nextest = fakeNextest({
    metadata: {
      during: () => {
        controller.abort();
      },
    },
  });

  const result = await run(focused(['tests::adds'], controller.signal), nextest.spawn);

  expect(result.kind).toBe('cancelled');
  expect(nextest.stages()).toEqual(['metadata']);
});

it('reports a metadata stage that uses up the deadline as a timeout and starts no run', async () => {
  useFakeClock();

  const nextest = fakeNextest({ metadata: { during: () => vi.advanceTimersByTime(1000) } });

  const result = await run(focused(['tests::adds']), nextest.spawn, { timeoutMs: 1000 });

  expect(result).toMatchObject({ kind: 'timeout', stage: 'metadata' });
  expect(nextest.stages()).toEqual(['metadata']);
});

it('starts no list stage when the deadline expires after metadata parsing', async () => {
  let calls = 0;

  const now = vi.spyOn(performance, 'now').mockImplementation(() => {
    calls += 1;

    return calls <= 5 ? 0 : 1000;
  });

  onTestFinished(() => {
    now.mockRestore();
  });

  const nextest = fakeNextest({
    metadata: { stdout: metadataWithRoot('/repo', '/repo/src/lib.rs') },
  });

  const result = await run(focused(['tests::adds']), nextest.spawn, { timeoutMs: 1000 });

  expect(result).toMatchObject({ kind: 'timeout', stage: 'metadata' });
  expect(nextest.stages()).toEqual(['metadata']);
});

const writeReadableCrate = async (
  workspace: string,
): Promise<{ binaryPath: string; readDepInfo: string }> => {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src/lib.rs'), 'pub mod sub;\n', 'utf8');
  await writeFile(join(workspace, 'src/sub.rs'), 'mod tests {}\n', 'utf8');

  const binaryPath = join(workspace, 'demo-abc');

  await writeFile(`${binaryPath}.d`, `${binaryPath}.d: src/lib.rs src/sub.rs\n`, 'utf8');

  return { binaryPath, readDepInfo: `${binaryPath}.d` };
};

it('reports an abort during the dep-info reads as cancelled, not no-tests-collected', async ({
  onTestFinished: cleanup,
}) => {
  const workspace = temporaryDirectory(cleanup, 'tau-nextest-read-abort-');
  const { binaryPath, readDepInfo } = await writeReadableCrate(workspace);
  const controller = new AbortController();

  const nextest = fakeNextest({
    list: { stdout: listWithSources(binaryPath, workspace, ['sub::tests::fails']) },
    metadata: { stdout: metadataWithRoot(workspace, join(workspace, 'src/lib.rs')) },
  });

  fileWrites.read = (path) => {
    if (path === readDepInfo) {
      controller.abort();
    }
  };

  cleanup(() => {
    fileWrites.read = () => undefined;
  });

  const result = await run(
    focusedIn(workspace, ['src/other.rs'], ['sub::tests::fails'], controller.signal),
    nextest.spawn,
  );

  expect(result.kind).toBe('cancelled');
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it('reports an expired deadline during the dep-info reads as a timeout, not no-tests-collected', async ({
  onTestFinished: cleanup,
}) => {
  useFakeClock();

  const workspace = temporaryDirectory(cleanup, 'tau-nextest-read-deadline-');
  const { binaryPath, readDepInfo } = await writeReadableCrate(workspace);

  const nextest = fakeNextest({
    list: { stdout: listWithSources(binaryPath, workspace, ['sub::tests::fails']) },
    metadata: { stdout: metadataWithRoot(workspace, join(workspace, 'src/lib.rs')) },
  });

  fileWrites.read = (path) => {
    if (path === readDepInfo) {
      vi.advanceTimersByTime(1000);
    }
  };

  cleanup(() => {
    fileWrites.read = () => undefined;
  });

  const result = await run(
    focusedIn(workspace, ['src/other.rs'], ['sub::tests::fails']),
    nextest.spawn,
    { timeoutMs: 1000 },
  );

  expect(result).toMatchObject({ kind: 'timeout', stage: 'list' });
  expect(nextest.stages()).toEqual(['metadata', 'list']);
});

it.for<{ stage: Stage; code: number }>([
  { stage: 'list', code: 2 },
  { stage: 'run', code: 0 },
])('reports a $stage stage that exits after the deadline as a timeout', async ({ stage, code }) => {
  useFakeClock();

  const nextest = fakeNextest({
    [stage]: { code, during: () => vi.advanceTimersByTime(1000) },
    run: {
      report: await fixture('two-binaries.xml'),
      ...(stage === 'run' ? { during: () => vi.advanceTimersByTime(1000) } : {}),
    },
  });

  const result = await run(focused(['tests::same']), nextest.spawn, { timeoutMs: 1000 });

  expect(result).toMatchObject({ kind: 'timeout', stage });
});

it('reports an abort during the JUnit read as cancelled', async () => {
  const controller = new AbortController();
  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  fileWrites.read = (path) => {
    if (path.endsWith('report.xml')) {
      controller.abort();
    }
  };

  onTestFinished(() => {
    fileWrites.read = () => undefined;
  });

  const result = await run(focused(['tests::same'], controller.signal), nextest.spawn);

  expect(result.kind).toBe('cancelled');
});

it('gives a full run the longer default deadline', () => {
  expect(defaultDeps('focused').timeoutMs).toBe(nextestRunner.focusedTimeoutMs);
  expect(defaultDeps('full').timeoutMs).toBe(nextestRunner.fullTimeoutMs);
  expect(nextestRunner.fullTimeoutMs).toBeGreaterThan(nextestRunner.focusedTimeoutMs);
});

it('writes absolute tool-config and JUnit paths under a relative agent directory', async ({
  onTestFinished: cleanup,
}) => {
  const agentDirectory = temporaryDirectory(cleanup, 'tau-nextest-relative-agent-');

  vi.stubEnv('PI_CODING_AGENT_DIR', relative(process.cwd(), agentDirectory));

  cleanup(() => {
    vi.stubEnv('PI_CODING_AGENT_DIR', sharedAgentDirectory);
  });

  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  await run(focused(['tests::same']), nextest.spawn);

  const runArgumentsList = nextest.calls.at(-1)?.argumentsList ?? [];

  expect(isAbsolute(toolConfigPathFrom(runArgumentsList))).toBe(true);
  expect(isAbsolute(await junitPathFrom(runArgumentsList))).toBe(true);
});

it('keeps the binary ID of each test result and failure', async () => {
  const nextest = fakeNextest({ run: { code: 100, report: await fixture('pass-and-fail.xml') } });
  const twoBinaries = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  const failed = await run(focused(['tests::fails']), nextest.spawn);
  const passed = await run(focused(['tests::same']), twoBinaries.spawn);

  expect('failures' in failed && failed.failures[0]?.binaryId).toBe('demo');

  expect('tests' in passed && passed.tests.map((test) => test.binaryId)).toEqual([
    'demo::bin/demo',
    'demo',
  ]);
});

it('reports a missing cargo-nextest with an install hint and starts nothing', async ({
  onTestFinished: cleanup,
}) => {
  const emptyPath = temporaryDirectory(cleanup, 'tau-nextest-empty-path-');
  const nextest = fakeNextest({});

  const result = await run(focused(['tests::adds']), nextest.spawn, { searchPath: emptyPath });

  expect(result.kind).toBe('runner-missing');
  expect('message' in result && result.message).toContain('cargo install --locked cargo-nextest');

  expect(result.diagnostics?.resolution).toEqual({
    executable: 'cargo-nextest',
    searchedPath: emptyPath,
  });

  expect(nextest.calls).toEqual([]);
});

it('collects no tests for a focused run without names and starts nothing', async () => {
  const nextest = fakeNextest({});

  const result = await run(focused([]), nextest.spawn);

  expect(result.kind).toBe('no-tests-collected');
  expect(nextest.calls).toEqual([]);
});

it('keeps the tool config and the JUnit report in the diagnostics directory', async () => {
  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  const result = await run(focused(['tests::same']), nextest.spawn);
  const directory = result.diagnostics?.directory;
  const list = nextest.calls[1];
  const runCall = nextest.calls.at(-1);
  const toolConfigPath = toolConfigPathFrom(runCall?.argumentsList ?? []);
  const junitPath = await junitPathFrom(runCall?.argumentsList ?? []);

  expect(dirname(toolConfigPath)).toBe(directory);
  expect(dirname(junitPath)).toBe(directory);
  expect(result.diagnostics?.report).toMatchObject({ path: junitPath, format: 'junit' });
  expect(list?.argumentsList.join(' ')).not.toContain(directory);
  expect(list?.argumentsList).not.toContain('--tool-config-file');
});

it('saves a diagnostics record for each stage and spawns cargo for all three', async () => {
  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  const result = await run(focused(['tests::same']), nextest.spawn);

  expect(result.diagnostics?.stages.map((stage) => stage.name)).toEqual([
    'metadata',
    'list',
    'run',
  ]);

  expect(nextest.calls.map((call) => call.command)).toEqual(['cargo', 'cargo', 'cargo']);
});

it.for([
  { name: 'no Cargo options', options: {}, manifest: [] },
  {
    name: 'a manifest path and --locked',
    options: { cargoManifestPath: '/repo/backend/Cargo.toml', cargoLocked: true },
    manifest: ['--manifest-path', '/repo/backend/Cargo.toml', '--locked'],
  },
])('passes $name to every cargo stage', async ({ options, manifest }) => {
  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });
  const targets = ['--workspace', '--bins', '--tests'];

  await run({ ...focused(['tests::same']), ...options }, nextest.spawn);

  const [metadata, list, runCall] = nextest.calls.map((call) => call.argumentsList);

  expect(metadata).toEqual(['metadata', '--no-deps', '--format-version', '1', ...manifest]);

  expect(list).toEqual(['nextest', 'list', ...targets, ...manifest, '--message-format', 'json']);

  expect(runCall?.slice(0, 5 + manifest.length)).toEqual([
    'nextest',
    'run',
    ...targets,
    ...manifest,
  ]);
});

it('passes the focused names to run as a filter', async () => {
  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  await run(focused(['tests::same']), nextest.spawn);

  expect(nextest.calls.at(-1)?.argumentsList.slice(-2)).toEqual(['-E', 'test(=tests::same)']);
});

it('runs every test in a full run', async () => {
  const nextest = fakeNextest({ run: { report: await fixture('two-binaries.xml') } });

  const result = await run(
    { scope: 'full', cwd: '/repo', verificationArgv: ['cargo', 'nextest', 'run'] },
    nextest.spawn,
  );

  expect(result.kind).toBe('pass');
  expect(nextest.calls.at(-1)?.argumentsList).not.toContain('-E');
});

it('keeps the first failures and marks the rest as not collected', async () => {
  const failedCases = Array.from(
    { length: 11 },
    (_, index) =>
      `<testcase name="tests::fails_${index}" classname="demo" time="0.001"><failure>boom ${index}</failure></testcase>`,
  ).join('');

  const report = `<testsuites><testsuite name="demo">${failedCases}</testsuite></testsuites>`;
  const nextest = fakeNextest({ run: { code: 100, report } });

  const result = await run(focused(['tests::fails_0']), nextest.spawn);
  const failures = 'failures' in result ? result.failures : [];

  expect(failures.map((failure) => failure.message)).toEqual(
    Array.from({ length: 10 }, (_, index) => `boom ${index}`),
  );

  expect('truncated' in result && result.truncated).toBe(true);
});

it.for([
  { argv: ['cargo', 'nextest', 'run'], accepted: true },
  { argv: ['cargo', 'nextest', 'run', '--release'], accepted: false },
  { argv: ['cargo', 'test'], accepted: false },
])('accepts $argv as the verification command: $accepted', ({ argv, accepted }) => {
  const error = nextestRunner.verificationArgvError(argv);

  expect(error === null).toBe(accepted);
});
