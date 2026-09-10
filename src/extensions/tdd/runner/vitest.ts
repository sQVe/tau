import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { tddConfig } from '../config.js';
import type {
  ResolveVitestFn,
  RunTestsInput,
  RunnerDeps,
  RunnerResult,
  SpawnFn,
  SpawnResult,
  TestFailure,
  TestResult,
} from './types.js';
import {
  DEFAULT_TIMEOUT_MS,
  FULL_TIMEOUT_MS,
  MAX_FAILURES,
  MAX_MESSAGE_CHARS,
  MAX_STDOUT_BYTES,
  MAX_TOTAL_BYTES,
} from './types.js';

interface VitestAssertionResult {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status: TestResult['status'] | 'pending' | 'disabled';
  failureMessages?: string[];
}

interface VitestTestFile {
  name?: string;
  status?: string;
  assertionResults?: VitestAssertionResult[];
  message?: string;
}

interface VitestReport {
  numTotalTests?: number;
  numFailedTests?: number;
  numPassedTests?: number;
  numTotalTestSuites?: number;
  startTime?: number;
  success?: boolean;
  testResults?: VitestTestFile[];
}

const nodeRequire = createRequire(import.meta.url);

export const extractBinPath = (manifest: unknown): string | null => {
  if (manifest == null || typeof manifest !== 'object') {
    return null;
  }

  const binary: unknown = (manifest as { bin?: unknown }).bin;

  if (typeof binary === 'string') {
    return binary;
  }

  if (binary == null || typeof binary !== 'object') {
    return null;
  }

  const entry: unknown = (binary as { vitest?: unknown }).vitest;

  return typeof entry === 'string' ? entry : null;
};

export const defaultResolveVitest: ResolveVitestFn = (cwd) => {
  try {
    const manifestPath = nodeRequire.resolve('vitest/package.json', { paths: [cwd] });
    const manifest: unknown = nodeRequire(manifestPath);
    const binaryPath = extractBinPath(manifest);

    if (binaryPath == null) {
      return null;
    }

    return join(dirname(manifestPath), binaryPath);
  } catch {
    return null;
  }
};

// Do not use defaultResolveVitest here. require.resolve also searches NODE_PATH, which a parent
// test runner can set to its own installation rather than the worktree's.
export const runnerAvailable = (cwd: string): boolean => {
  for (let directory = resolvePath(cwd); ; directory = dirname(directory)) {
    try {
      statSync(join(directory, 'node_modules', 'vitest', 'package.json'));

      return true;
    } catch (error) {
      // Only a missing file proves absence; a transient EACCES or EMFILE must not turn the gate off.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        return true;
      }
    }

    if (dirname(directory) === directory) {
      return false;
    }
  }
};

// Debian-family systems name the runtime `nodejs`, so both spellings count as a Node command.
const nodeNames = process.platform === 'win32' ? ['node.exe'] : ['node', 'nodejs'];

const nodeOnPath = (path = process.env.PATH ?? '') =>
  path
    .split(delimiter)
    .flatMap((directory) => nodeNames.map((name) => join(directory, name)))
    .find((executable) => {
      try {
        accessSync(executable, constants.X_OK);

        return statSync(executable).isFile();
      } catch {
        return false;
      }
    });

// In compiled Pi, process.execPath is the agent and cannot run Vitest. Prefer Node from PATH.
// Keep the fallback for Node executables with other names, such as `nodejs`.
export const nodeExecutable = (executablePath = process.execPath) =>
  /^node(\.exe)?$/i.test(basename(executablePath.replaceAll('\\', '/')))
    ? executablePath
    : (nodeOnPath() ?? executablePath);

export const defaultSpawn: SpawnFn = (command, arguments_, options) =>
  new Promise<SpawnResult>((resolve) => {
    // detached lets the timeout path signal the whole process group on POSIX.
    // Windows has no equivalent; we fall back to child.kill there.
    const useProcessGroup = process.platform !== 'win32';
    const child = nodeSpawn(nodeExecutable(), [command, ...arguments_], {
      cwd: options.cwd,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutOverflow = false;
    let diagnosticBytes = 0;
    let stdoutBytes = 0;

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const appendDiagnosticChunk = (
      chunk: Buffer,
      decoder: StringDecoder,
      current: string,
    ): string => {
      const remaining = MAX_TOTAL_BYTES - diagnosticBytes;

      if (remaining <= 0) {
        return current;
      }

      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;

      diagnosticBytes += slice.length;

      return current + decoder.write(slice);
    };

    let settled = false;

    const settle = (code: number | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();

      resolve({ stdout, stderr, code, timedOut, stdoutOverflow });
    };

    const kill = () => {
      try {
        if (useProcessGroup && child.pid != null) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    };

    const abort = () => {
      kill();
      settle(null);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      // Stop on stdout overflow rather than accepting a result from a run that exceeded its limit.
      stdoutBytes += chunk.length;

      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stdoutOverflow = true;
        kill();
        settle(null);

        return;
      }

      stdout += stdoutDecoder.write(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendDiagnosticChunk(chunk, stderrDecoder, stderr);
    });

    // Settle here rather than waiting for `close`: on Windows only the direct child dies,
    // and a descendant holding the piped stdio would keep `close` pending forever.
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      settle(null);
    }, options.timeoutMs);

    timer.unref();

    child.on('close', settle);
    child.on('error', () => {
      settle(null);
    });

    if (options.signal?.aborted === true) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }
  });

// Vitest reports always include at least one of these top-level keys.
const isVitestReport = (value: unknown): value is VitestReport => {
  if (value == null || typeof value !== 'object') {
    return false;
  }

  const keys = ['numTotalTests', 'numFailedTests', 'testResults', 'numTotalTestSuites'];

  return keys.some((key) => key in value);
};

// The report is read from the reporter's own output file: stdout carries test-controlled
// text, so a report scraped from it could be forged by the code under test.
const readReport = async (path: string): Promise<VitestReport | null> => {
  try {
    const content = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(content);

    return isVitestReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const assertionFullName = (assertion: VitestAssertionResult) =>
  assertion.fullName ??
  [...(assertion.ancestorTitles ?? []), assertion.title ?? ''].filter(Boolean).join(' ');

// A focused run reports every unselected test as skipped, which says nothing about it.
const selects = (filter: string | undefined) => {
  if (filter == null) {
    return () => true;
  }

  let pattern: RegExp;

  try {
    pattern = new RegExp(filter);
  } catch {
    return () => true;
  }

  return (fullname: string) => pattern.test(fullname);
};

const collectTests = (
  report: VitestReport,
  selected: (fullname: string) => boolean,
): TestResult[] =>
  (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((assertion) => selected(assertionFullName(assertion)))
      .map((assertion) => ({
        file: file.name ?? '<unknown>',
        fullname: assertionFullName(assertion),
        status:
          assertion.status === 'pending' || assertion.status === 'disabled'
            ? 'skipped'
            : assertion.status,
      })),
  );

const frameLocation = (line: string, cwd: string): string | null => {
  const trimmed = line.trim();

  if (!trimmed.startsWith('at ')) {
    return null;
  }

  const match = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(trimmed);
  const path = match?.[1]?.replace(/^file:\/\//, '');

  if (path == null || path.includes('node_modules') || !isAbsolute(path)) {
    return null;
  }

  const location = relative(cwd, path);

  if (location.length === 0 || location.startsWith('..') || isAbsolute(location)) {
    return null;
  }

  return `${location}:${match?.[2]}`;
};

const capMessage = (text: string) =>
  text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;

// Keep the assertion and its worktree location. Omit the rest of the stack to limit output.
const assertionMessage = (messages: string[], cwd: string): string => {
  const raw = messages[0] ?? '';
  const frame = raw
    .split('\n')
    .map((line) => frameLocation(line, cwd))
    .find((location) => location != null);
  const headline = raw.split('\n')[0]?.trim() ?? '';

  if (headline.length === 0 || headline.includes('STACK_TRACE_ERROR')) {
    return capMessage(frame ?? '');
  }

  return capMessage(frame == null ? headline : `${headline} (${frame})`);
};

const collectFailures = (
  report: VitestReport,
  cwd: string,
): { failures: TestFailure[]; truncated: boolean } => {
  const failures: TestFailure[] = [];
  let truncated = false;

  for (const file of report.testResults ?? []) {
    // Hook and load errors live only on the file entry, never on an assertion.
    const hasFailedAssertion =
      file.assertionResults?.some((assertion) => assertion.status === 'failed') === true;

    if (file.status === 'failed' && ((file.message ?? '').length > 0 || !hasFailedAssertion)) {
      if (failures.length >= MAX_FAILURES) {
        return { failures, truncated: true };
      }

      failures.push({
        file: file.name ?? '<unknown>',
        fullname: '<file>',
        message: assertionMessage([file.message ?? 'load error'], cwd),
      });
    }

    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed') {
        continue;
      }

      if (failures.length >= MAX_FAILURES) {
        truncated = true;

        return { failures, truncated };
      }

      failures.push({
        file: file.name ?? '<unknown>',
        fullname: assertionFullName(assertion),
        message: assertionMessage(assertion.failureMessages ?? [], cwd),
      });
    }
  }

  return { failures, truncated };
};

// Vitest's CLI parses dash-leading positionals as options and treats an empty
// filter as "match every file", so neither may reach it as a scoped path.
const toFilterArgument = (path: string) => (path.startsWith('-') ? `./${path}` : path);

const scopedPaths = (input: RunTestsInput): string[] => {
  const paths = input.scope === 'file' ? [input.path ?? ''] : (input.files ?? []);

  return paths.filter((path) => path.trim().length > 0);
};

const buildArguments = (input: RunTestsInput, outputFile: string): string[] | null => {
  const runnerArguments: string[] = [
    ...tddConfig.verificationArgv.slice(1),
    `--outputFile=${outputFile}`,
  ];

  if (input.scope !== 'all') {
    const paths = scopedPaths(input);

    if (paths.length === 0) {
      return null;
    }

    runnerArguments.push(...paths.map(toFilterArgument));
  }

  if (input.filter != null) {
    runnerArguments.push('-t', input.filter);
  }

  return runnerArguments;
};

export const defaultDeps = (scope: RunTestsInput['scope'] = 'changed'): RunnerDeps => ({
  resolveVitest: defaultResolveVitest,
  spawn: defaultSpawn,
  timeoutMs: scope === 'all' ? FULL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
});

const runInDirectory = async (
  input: RunTestsInput,
  dependencies: RunnerDeps,
  outputFile: string,
): Promise<RunnerResult> => {
  const runnerArguments = buildArguments(input, outputFile);

  if (runnerArguments == null) {
    return { kind: 'no-tests-collected', tests: [] };
  }

  const binary = dependencies.resolveVitest(input.cwd);

  if (binary == null) {
    return {
      kind: 'runner-missing',
      message: 'vitest not resolvable from this worktree',
    };
  }

  const result = await dependencies.spawn(binary, runnerArguments, {
    cwd: input.cwd,
    timeoutMs: dependencies.timeoutMs,
    signal: input.signal,
  });

  if (input.signal?.aborted === true) {
    return { kind: 'cancelled' };
  }

  if (result.timedOut) {
    return { kind: 'timeout' };
  }

  if (result.stdoutOverflow === true) {
    return {
      kind: 'output-limit',
      message: `vitest stdout exceeded ${MAX_STDOUT_BYTES} bytes; the run was killed without parsing a truncated report`,
    };
  }

  const report = await readReport(outputFile);

  if (report == null) {
    if (result.code === 0) {
      return {
        kind: 'fail',
        failures: [
          {
            file: '<runner>',
            fullname: '<parse>',
            message: assertionMessage(
              [
                `unparseable vitest output: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
              ],
              input.cwd,
            ),
          },
        ],
        tests: [],
        truncated: false,
      };
    }

    return {
      kind: 'compile-error',
      message: 'no parseable report from vitest',
      tests: [],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const tests = collectTests(report, selects(input.filter));
  const total = report.numTotalTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const files = report.testResults ?? [];

  if (failed > 0 || files.some((file) => file.status === 'failed')) {
    const { failures, truncated } = collectFailures(report, input.cwd);

    return {
      kind: 'fail',
      failures,
      tests,
      truncated,
    };
  }

  if (result.code !== 0) {
    return {
      kind: 'compile-error',
      message: 'vitest did not complete successfully',
      tests,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  if (total === 0 || report.numPassedTests === 0) {
    return { kind: 'no-tests-collected', tests };
  }

  return { kind: 'pass', tests };
};

export const runVitest = async (
  input: RunTestsInput,
  dependencies: RunnerDeps,
): Promise<RunnerResult> => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-vitest-'));

  try {
    return await runInDirectory(input, dependencies, join(directory, 'report.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
