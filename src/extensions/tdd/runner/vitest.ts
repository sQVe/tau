import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
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
  MAX_ASSERTION_BYTES,
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

export const extractBinPath = (pkg: unknown): string | null => {
  if (pkg == null || typeof pkg !== 'object') {
    return null;
  }
  const bin: unknown = (pkg as { bin?: unknown }).bin;
  if (typeof bin === 'string') {
    return bin;
  }
  if (bin == null || typeof bin !== 'object') {
    return null;
  }
  const entry: unknown = (bin as { vitest?: unknown }).vitest;
  return typeof entry === 'string' ? entry : null;
};

export const defaultResolveVitest: ResolveVitestFn = (cwd) => {
  try {
    const pkgPath = nodeRequire.resolve('vitest/package.json', { paths: [cwd] });
    const pkg: unknown = nodeRequire(pkgPath);
    const binRel = extractBinPath(pkg);
    if (binRel == null) {
      return null;
    }
    return join(dirname(pkgPath), binRel);
  } catch {
    return null;
  }
};

// Deliberately not defaultResolveVitest: require.resolve also honours NODE_PATH, which a parent
// test runner sets to its own installation, so it answers about this process, not the worktree.
export const runnerAvailable = (cwd: string): boolean => {
  for (let directory = resolvePath(cwd); ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'node_modules', 'vitest', 'package.json'))) return true;
    if (dirname(directory) === directory) return false;
  }
};

export const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    // detached lets the timeout path signal the whole process group on POSIX.
    // Windows has no equivalent; we fall back to child.kill there.
    const useProcessGroup = process.platform !== 'win32';
    const child = nodeSpawn(process.execPath, [cmd, ...args], {
      cwd: opts.cwd,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutOverflow = false;
    let bytes = 0;
    let stdoutBytes = 0;

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const cap = (chunk: Buffer, decoder: StringDecoder, current: string): string => {
      const remaining = MAX_TOTAL_BYTES - bytes;
      if (remaining <= 0) {
        return current;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      bytes += slice.length;
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

    child.stdout.on('data', (chunk: Buffer) => {
      // The JSON report must remain complete; bound failure messages after parsing.
      // Past the cap the report can no longer be trusted, so stop instead of parsing it.
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
      stderr = cap(chunk, stderrDecoder, stderr);
    });

    // Settle here rather than waiting for `close`: on Windows only the direct child dies,
    // and a descendant holding the piped stdio would keep `close` pending forever.
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      settle(null);
    }, opts.timeoutMs);
    timer.unref();

    child.on('close', settle);
    child.on('error', () => {
      settle(null);
    });

    const abort = () => {
      kill();
      settle(null);
    };
    if (opts.signal?.aborted === true) {
      abort();
    } else {
      opts.signal?.addEventListener('abort', abort, { once: true });
    }
  });

// Vitest reports always include at least one of these top-level keys.
const isVitestReport = (value: unknown): value is VitestReport => {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const keys = ['numTotalTests', 'numFailedTests', 'testResults', 'numTotalTestSuites'];
  return keys.some((k) => k in value);
};

// The report is read from the reporter's own output file: stdout carries test-controlled
// text, so a report scraped from it could be forged by the code under test.
const readReport = async (path: string): Promise<VitestReport | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isVitestReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const truncate = (text: string, max: number): string => {
  if (Buffer.byteLength(text, 'utf8') <= max) {
    return text;
  }
  const decoder = new StringDecoder('utf8');
  return decoder.write(Buffer.from(text, 'utf8').subarray(0, max)) + '…';
};

const assertionFullName = (assertion: VitestAssertionResult) =>
  assertion.fullName ??
  [...(assertion.ancestorTitles ?? []), assertion.title ?? ''].filter(Boolean).join(' ');

// A focused run reports every unselected test as skipped, which says nothing about it.
const selects = (filter: string | undefined) => {
  if (filter == null) return () => true;
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
  if (!trimmed.startsWith('at ')) return null;
  const match = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(trimmed);
  const path = match?.[1]?.replace(/^file:\/\//, '');
  if (path == null || path.includes('node_modules') || !path.startsWith(`${cwd}/`)) return null;
  return `${relative(cwd, path)}:${match?.[2]}`;
};

const capMessage = (text: string) =>
  text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;

// The stack is noise the model cannot act on; the assertion line and the frame in the worktree
// are the whole story.
const assertionMessage = (messages: string[], cwd: string): string => {
  const raw = messages[0] ?? '';
  const frame = raw
    .split('\n')
    .map((line) => frameLocation(line, cwd))
    .find((location) => location != null);
  const headline = raw.split('\n')[0]?.trim() ?? '';
  if (headline.length === 0 || headline.includes('STACK_TRACE_ERROR'))
    return capMessage(frame ?? '');
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
    const hasFailedAssertion = file.assertionResults?.some((a) => a.status === 'failed') === true;
    if (file.status === 'failed' && ((file.message ?? '').length > 0 || !hasFailedAssertion)) {
      if (failures.length >= MAX_FAILURES) {
        return { failures, truncated: true };
      }
      failures.push({
        file: file.name ?? '<unknown>',
        fullname: '<file>',
        message: truncate(file.message ?? 'load error', MAX_ASSERTION_BYTES),
      });
    }
    for (const a of file.assertionResults ?? []) {
      if (a.status !== 'failed') {
        continue;
      }
      if (failures.length >= MAX_FAILURES) {
        truncated = true;
        return { failures, truncated };
      }
      failures.push({
        file: file.name ?? '<unknown>',
        fullname: assertionFullName(a),
        message: assertionMessage(a.failureMessages ?? [], cwd),
      });
    }
  }

  return { failures, truncated };
};

// Vitest's CLI parses dash-leading positionals as options and treats an empty
// filter as "match every file", so neither may reach it as a scoped path.
const toFilterArg = (path: string) => (path.startsWith('-') ? `./${path}` : path);

const scopedPaths = (input: RunTestsInput): string[] => {
  const raw = input.scope === 'file' ? [input.path ?? ''] : (input.files ?? []);
  return raw.filter((path) => path.trim().length > 0);
};

const buildArgs = (input: RunTestsInput, outputFile: string): string[] | null => {
  const args: string[] = [...tddConfig.verificationArgv.slice(1), `--outputFile=${outputFile}`];
  if (input.scope !== 'all') {
    const paths = scopedPaths(input);
    if (paths.length === 0) {
      return null;
    }
    args.push(...paths.map(toFilterArg));
  }
  if (input.filter != null) {
    args.push('-t', input.filter);
  }
  return args;
};

export const defaultDeps = (scope: RunTestsInput['scope'] = 'changed'): RunnerDeps => ({
  resolveVitest: defaultResolveVitest,
  spawn: defaultSpawn,
  timeoutMs: scope === 'all' ? FULL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
});

export const runVitest = async (input: RunTestsInput, deps: RunnerDeps): Promise<RunnerResult> => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-vitest-'));
  try {
    return await runInDirectory(input, deps, join(directory, 'report.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const runInDirectory = async (
  input: RunTestsInput,
  deps: RunnerDeps,
  outputFile: string,
): Promise<RunnerResult> => {
  const args = buildArgs(input, outputFile);
  if (args == null) {
    return { kind: 'no-tests-collected', tests: [] };
  }

  const bin = deps.resolveVitest(input.cwd);
  if (bin == null) {
    return {
      kind: 'runner-missing',
      message: `vitest not resolvable from ${input.cwd}`,
    };
  }

  const result = await deps.spawn(bin, args, {
    cwd: input.cwd,
    timeoutMs: deps.timeoutMs,
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
            message: truncate(
              `unparseable vitest output: ${result.stderr.length > 0 ? result.stderr : result.stdout}`,
              MAX_ASSERTION_BYTES,
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

  if (failed > 0 || files.some((f) => f.status === 'failed')) {
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
