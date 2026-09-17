import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

import { tddConfig } from '../config.js';
import { saveDiagnostics } from './diagnostics.js';
import { createDiagnosticsDirectory } from './retention.js';
import type {
  ResolveVitestFn,
  RunTestsInput,
  RunnerDeps,
  RunnerResult,
  SpawnFn,
  SpawnResult,
  TestFailure,
  TestResult,
  VitestResolutionDiagnostic,
  VitestResolutionFailure,
} from './types.js';
import {
  defaultTimeoutMilliseconds,
  fullTimeoutMilliseconds,
  maximumFailures,
  maximumMessageCharacters,
  maximumStdoutBytes,
  maximumTotalBytes,
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

const resolutionMessages: Record<string, string> = {
  MODULE_NOT_FOUND: 'The vitest/package.json request was not found from the lookup directory.',
  ERR_PACKAGE_PATH_NOT_EXPORTED: 'Package exports do not expose vitest/package.json.',
  ERR_INVALID_PACKAGE_CONFIG: 'Node could not parse a package manifest during Vitest resolution.',
  ERR_INVALID_PACKAGE_TARGET: 'A package export target is invalid.',
  EACCES: 'Permission denied while resolving the Vitest runner.',
  EPERM: 'The filesystem denied access while resolving the Vitest runner.',
  ENOENT: 'A resolved manifest or binary file is missing.',
  ENOTDIR: 'A resolution path contains a component that is not a directory.',
  EISDIR: 'A manifest path is a directory, not a file.',
  ELOOP: 'A resolution path contains a symbolic-link loop.',
  INVALID_BIN: 'Vitest manifest has no usable local bin entry or the binary is not a file.',
  INVALID_VERSION: 'Vitest manifest has no valid version for test-name decoding.',
};

const diagnosticPath = (path: string) => {
  const printable = stripVTControlCharacters(path).replace(/\p{Cc}/gu, ' ');

  return printable.length > 400 ? `${printable.slice(0, 394)} [cut]` : printable;
};

const resolutionErrorDetails = (error: unknown) => {
  const code =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const errorCode =
    typeof code === 'string' && Object.hasOwn(resolutionMessages, code) ? code : undefined;
  let errorType = 'UnknownError';

  // Never copy error.message, stack, or custom names: JSON parse errors can quote credentials.
  if (error instanceof Error) {
    errorType = ['SyntaxError', 'TypeError', 'RangeError'].includes(error.name)
      ? error.name
      : 'Error';
  }

  return { errorType, ...(errorCode === undefined ? {} : { errorCode }) };
};

const validVersion = (version: unknown): version is string =>
  typeof version === 'string' &&
  version.length <= 128 &&
  /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version);

const resolutionExplanation = (
  stage: VitestResolutionDiagnostic['stage'],
  errorType: string,
  errorCode: string | undefined,
  missing: boolean,
): string => {
  if (errorCode === 'MODULE_NOT_FOUND' && !missing) {
    return 'A dependency lookup failed inside the resolver; this does not establish that Vitest is absent.';
  }

  if (errorCode !== undefined) {
    return resolutionMessages[errorCode] ?? 'Vitest runner resolution failed.';
  }

  if (errorType === 'SyntaxError' && stage === 'manifest') {
    return 'Vitest manifest is not valid JSON.';
  }

  return 'Vitest runner resolution failed.';
};

const resolutionFailure = (
  cwd: string,
  stage: VitestResolutionDiagnostic['stage'],
  error: unknown,
  paths: { manifestPath?: string; binaryPath?: string } = {},
): VitestResolutionFailure => {
  const { errorCode, errorType } = resolutionErrorDetails(error);
  const resolution: VitestResolutionDiagnostic = {
    cwd: diagnosticPath(cwd),
    request: 'vitest/package.json',
    stage,
    errorType,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(paths.manifestPath === undefined
      ? {}
      : { manifestPath: diagnosticPath(paths.manifestPath) }),
    ...(paths.binaryPath === undefined ? {} : { binaryPath: diagnosticPath(paths.binaryPath) }),
  };
  // MODULE_NOT_FOUND can also refer to a broken export target inside an installed package.
  const missing =
    stage === 'lookup' &&
    errorCode === 'MODULE_NOT_FOUND' &&
    error instanceof Error &&
    error.message.startsWith("Cannot find module 'vitest/package.json'");
  const explanation = resolutionExplanation(stage, errorType, errorCode, missing);

  const message = [
    `${explanation} Stage: ${stage}; ${errorType}${errorCode === undefined ? '' : ` (${errorCode})`}.`,
    'Inspect this once, then fix resolution or use the repository runner. Bash tests do not update Tau observations.',
    `Lookup directory: ${resolution.cwd}; request: ${resolution.request}`,
    ...(resolution.manifestPath === undefined ? [] : [`Manifest: ${resolution.manifestPath}`]),
    ...(resolution.binaryPath === undefined ? [] : [`Binary: ${resolution.binaryPath}`]),
  ].join('\n');

  return { kind: missing ? 'runner-missing' : 'runner-resolution-error', message, resolution };
};

export const defaultResolveVitest: ResolveVitestFn = (cwd) => {
  let stage: VitestResolutionDiagnostic['stage'] = 'lookup';
  const paths: { manifestPath?: string; binaryPath?: string } = {};

  try {
    paths.manifestPath = nodeRequire.resolve('vitest/package.json', { paths: [cwd] });
    stage = 'manifest';
    const manifest: unknown = JSON.parse(readFileSync(paths.manifestPath, 'utf8'));
    const version =
      manifest !== null && typeof manifest === 'object' && 'version' in manifest
        ? manifest.version
        : undefined;

    if (!validVersion(version)) {
      return resolutionFailure(
        cwd,
        stage,
        Object.assign(new TypeError('Invalid Vitest manifest version'), {
          code: 'INVALID_VERSION',
        }),
        paths,
      );
    }

    stage = 'binary';
    const binary = extractBinPath(manifest);

    if (
      binary === null ||
      binary.trim().length === 0 ||
      isAbsolute(binary) ||
      /[\p{Cc}:?#]/u.test(binary)
    ) {
      return resolutionFailure(
        cwd,
        stage,
        Object.assign(new TypeError('Invalid Vitest bin entry'), { code: 'INVALID_BIN' }),
        paths,
      );
    }

    const directory = dirname(paths.manifestPath);
    const binaryPath = resolvePath(directory, binary);
    const localPath = relative(directory, binaryPath);

    if (localPath === '..' || localPath.startsWith(`..${sep}`)) {
      return resolutionFailure(
        cwd,
        stage,
        Object.assign(new TypeError('Vitest bin leaves its package'), { code: 'INVALID_BIN' }),
        paths,
      );
    }

    paths.binaryPath = binaryPath;

    if (!statSync(binaryPath).isFile()) {
      return resolutionFailure(
        cwd,
        stage,
        Object.assign(new TypeError('Vitest bin is not a file'), { code: 'INVALID_BIN' }),
        paths,
      );
    }

    return { path: binaryPath, version };
  } catch (error) {
    return resolutionFailure(cwd, stage, error, paths);
  }
};

// Debian-family systems name the runtime `nodejs`, so both spellings count as a Node command.
const nodeNames = process.platform === 'win32' ? ['node.exe'] : ['node', 'nodejs'];

// oxlint-disable-next-line node/no-process-env -- Compiled Pi needs a real Node executable from the caller's PATH.
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

const appendChunk = (
  chunk: Buffer,
  decoder: StringDecoder,
  current: string,
  remaining: number,
): string => {
  if (remaining <= 0) {
    return current;
  }

  return current + decoder.write(chunk.subarray(0, remaining));
};

export const defaultSpawn: SpawnFn = (command, arguments_, options) =>
  new Promise<SpawnResult>((resolve) => {
    // detached lets the timeout path signal the whole process group on POSIX.
    // Windows has no equivalent; we fall back to child.kill there.
    const useProcessGroup = process.platform !== 'win32';
    const executable = nodeExecutable();
    const child = nodeSpawn(executable, [command, ...arguments_], {
      cwd: options.cwd,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    let settled = false;

    const settle = (code: number | null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();

      resolve({
        stdout,
        stderr,
        code,
        timedOut,
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdoutBytes > maximumStdoutBytes,
        command: [executable, command, ...arguments_],
        started: child.pid !== undefined,
      });
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
      // Continue draining after the capture limit; console noise cannot decide the test verdict.
      stdout = appendChunk(chunk, stdoutDecoder, stdout, maximumStdoutBytes - stdoutBytes);
      stdoutBytes += chunk.length;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendChunk(chunk, stderrDecoder, stderr, maximumTotalBytes - stderrBytes);
      stderrBytes += chunk.length;
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
    child.on('error', (error) => {
      const message = Buffer.from(error.message);

      stderr = appendChunk(message, stderrDecoder, stderr, maximumTotalBytes - stderrBytes);
      stderrBytes += message.length;
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

const nameSeparator = (version: string) => (Number.parseInt(version, 10) >= 5 ? ' > ' : ' ');

const assertionFullName = (assertion: VitestAssertionResult, version: string): string => {
  // Vitest 5 filters with " > " but its Jest-compatible JSON fullName still uses spaces.
  // Rebuild from title parts; replacing spaces would change literal names and merge identities.
  if (
    nameSeparator(version) === ' > ' &&
    assertion.ancestorTitles !== undefined &&
    assertion.title !== undefined
  ) {
    return [...assertion.ancestorTitles, assertion.title].join(' > ');
  }

  return (
    assertion.fullName ??
    [...(assertion.ancestorTitles ?? []), assertion.title ?? ''].filter(Boolean).join(' ')
  );
};

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
  version: string,
): TestResult[] =>
  (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((assertion) => selected(assertionFullName(assertion, version)))
      .map((assertion) => ({
        file: file.name ?? '<unknown>',
        fullname: assertionFullName(assertion, version),
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
  text.length > maximumMessageCharacters ? `${text.slice(0, maximumMessageCharacters)}…` : text;

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

// oxlint-disable-next-line eslint/complexity -- File errors and assertion failures share one truncation budget.
const collectFailures = (
  report: VitestReport,
  cwd: string,
  version: string,
): { failures: TestFailure[]; truncated: boolean } => {
  const failures: TestFailure[] = [];
  let truncated = false;

  for (const file of report.testResults ?? []) {
    // Hook and load errors live only on the file entry, never on an assertion.
    const hasFailedAssertion =
      file.assertionResults?.some((assertion) => assertion.status === 'failed') === true;

    if (file.status === 'failed' && ((file.message ?? '').length > 0 || !hasFailedAssertion)) {
      if (failures.length >= maximumFailures) {
        return { failures, truncated: true };
      }

      failures.push({
        file: file.name ?? '<unknown>',
        fullname: '<file>',
        message:
          assertionMessage([file.message ?? ''], cwd) ||
          'File setup or load failed; inspect the saved runner diagnostics.',
      });
    }

    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed') {
        continue;
      }

      if (failures.length >= maximumFailures) {
        truncated = true;

        return { failures, truncated };
      }

      failures.push({
        file: file.name ?? '<unknown>',
        fullname: assertionFullName(assertion, version),
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
  timeoutMs: scope === 'all' ? fullTimeoutMilliseconds : defaultTimeoutMilliseconds,
});

// oxlint-disable-next-line eslint/complexity -- Process failures and report validity must be classified before accepting test evidence.
const classifyResult = async (
  input: RunTestsInput,
  result: SpawnResult,
  outputFile: string,
  version: string,
): Promise<RunnerResult> => {
  if (input.signal?.aborted === true) {
    return { kind: 'cancelled' };
  }

  if (result.timedOut) {
    return { kind: 'timeout' };
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

  const tests = collectTests(report, selects(input.filter), version);
  const total = report.numTotalTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const files = report.testResults ?? [];

  if (failed > 0 || files.some((file) => file.status === 'failed')) {
    const { failures, truncated } = collectFailures(report, input.cwd, version);

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

  if (input.filter !== undefined && tests.length === 0) {
    const candidates = collectTests(report, () => true, version)
      .slice(0, 5)
      .map((test) => `${relative(input.cwd, test.file)}: ${capMessage(test.fullname)}`);
    const message = [
      `No tests matched the exact name filter. Vitest ${version} joins nested names with ${JSON.stringify(nameSeparator(version))}.`,
      'Use the complete describe and test names. Do not restructure tests or broaden the filter.',
      candidates.length > 0
        ? `Collected names (up to 5):\n${candidates.join('\n')}`
        : 'No names were reported; check the selected files and runner diagnostics.',
    ].join('\n');

    return { kind: 'no-tests-collected', tests, message };
  }

  if (total === 0 || report.numPassedTests === 0) {
    return { kind: 'no-tests-collected', tests };
  }

  return { kind: 'pass', tests };
};

const runInDirectory = async (
  input: RunTestsInput,
  dependencies: RunnerDeps,
  outputFile: string,
): Promise<{ report: RunnerResult; result?: SpawnResult }> => {
  const runnerArguments = buildArguments(input, outputFile);

  if (runnerArguments == null) {
    return { report: { kind: 'no-tests-collected', tests: [] } };
  }

  let runner: ReturnType<ResolveVitestFn>;

  try {
    runner = dependencies.resolveVitest(input.cwd);
  } catch (error) {
    return { report: resolutionFailure(input.cwd, 'resolver', error) };
  }

  if ('kind' in runner) {
    return { report: runner };
  }

  const result = await dependencies.spawn(runner.path, runnerArguments, {
    cwd: input.cwd,
    timeoutMs: dependencies.timeoutMs,
    signal: input.signal,
  });

  return { report: await classifyResult(input, result, outputFile, runner.version), result };
};

export const runVitest = async (
  input: RunTestsInput,
  dependencies: RunnerDeps,
): Promise<RunnerResult> => {
  const directory = await createDiagnosticsDirectory();
  const started = performance.now();

  try {
    const { report, result } = await runInDirectory(
      input,
      dependencies,
      join(directory, 'report.json'),
    );
    const diagnostics = await saveDiagnostics(
      {
        directory,
        durationMs: Math.round(performance.now() - started),
        timeoutMs: dependencies.timeoutMs,
        command: result?.command,
        started: result?.started ?? result !== undefined,
        exitCode: result?.code ?? null,
        ...('resolution' in report ? { resolution: report.resolution } : {}),
      },
      result,
    );

    return { ...report, diagnostics };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });

    throw error;
  }
};
