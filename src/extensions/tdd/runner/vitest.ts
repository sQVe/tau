import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type {
  ResolveVitestFn,
  RunTestsInput,
  RunnerDeps,
  RunnerResult,
  SpawnFn,
  SpawnResult,
  TestFailure,
} from './types.js';
import { DEFAULT_TIMEOUT_MS, MAX_ASSERTION_BYTES, MAX_FAILURES, MAX_TOTAL_BYTES } from './types.js';

interface VitestAssertionResult {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status?: string;
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

const require_ = createRequire(import.meta.url);

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
    const pkgPath = require_.resolve('vitest/package.json', { paths: [cwd] });
    const pkg: unknown = require_(pkgPath);
    const binRel = extractBinPath(pkg);
    if (binRel == null) {
      return null;
    }
    return join(dirname(pkgPath), binRel);
  } catch {
    return null;
  }
};

export const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise<SpawnResult>((resolve) => {
    // Run the resolved vitest entry under the current Node runtime so the
    // timeout path can signal the whole process group (detached + -pid kill).
    const child = nodeSpawn(process.execPath, [cmd, ...args], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let bytes = 0;

    const cap = (chunk: Buffer, current: string): string => {
      const remaining = MAX_TOTAL_BYTES - bytes;
      if (remaining <= 0) {
        return current;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      bytes += slice.length;
      return current + slice.toString('utf8');
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = cap(chunk, stdout);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = cap(chunk, stderr);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid != null) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut });
    });
  });

const extractJsonPayload = (stdout: string): string | null => {
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line?.startsWith('{') ?? false) {
      return lines.slice(i).join('\n');
    }
  }
  return null;
};

const parseReport = (stdout: string): VitestReport | null => {
  const payload = extractJsonPayload(stdout);
  if (payload == null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed != null && typeof parsed === 'object') {
      return parsed as VitestReport;
    }
    return null;
  } catch {
    return null;
  }
};

const truncate = (text: string, max: number): string => {
  if (Buffer.byteLength(text, 'utf8') <= max) {
    return text;
  }
  return Buffer.from(text, 'utf8').subarray(0, max).toString('utf8') + '…';
};

const collectFailures = (report: VitestReport): { failures: TestFailure[]; truncated: boolean } => {
  const failures: TestFailure[] = [];
  let truncated = false;

  for (const file of report.testResults ?? []) {
    if (
      file.status === 'failed' &&
      (file.assertionResults == null || file.assertionResults.length === 0)
    ) {
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
      const fullname =
        a.fullName ?? [...(a.ancestorTitles ?? []), a.title ?? ''].filter(Boolean).join(' ');
      failures.push({
        file: file.name ?? '<unknown>',
        fullname,
        message: truncate((a.failureMessages ?? []).join('\n'), MAX_ASSERTION_BYTES),
      });
    }
  }

  return { failures, truncated };
};

const buildArgs = (input: RunTestsInput): string[] => {
  const args = ['run', '--reporter=json', '--no-color'];
  if (input.scope === 'file' && input.path != null) {
    args.push(input.path);
  } else if (input.scope === 'changed' && input.files != null) {
    args.push(...input.files);
  }
  if (input.filter != null) {
    args.push('-t', input.filter);
  }
  return args;
};

export const defaultDeps = (): RunnerDeps => ({
  resolveVitest: defaultResolveVitest,
  spawn: defaultSpawn,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

export const runVitest = async (input: RunTestsInput, deps: RunnerDeps): Promise<RunnerResult> => {
  const bin = deps.resolveVitest(input.cwd);
  if (bin == null) {
    return {
      kind: 'runner-missing',
      message: `vitest not resolvable from ${input.cwd}`,
    };
  }

  const result = await deps.spawn(bin, buildArgs(input), {
    cwd: input.cwd,
    timeoutMs: deps.timeoutMs,
  });

  if (result.timedOut) {
    return { kind: 'timeout' };
  }

  const report = parseReport(result.stdout);

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
        total: 0,
        failed: 1,
        truncated: false,
      };
    }
    return {
      kind: 'compile-error',
      message: 'no parseable report from vitest',
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const total = report.numTotalTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const files = report.testResults ?? [];

  if (failed > 0 || files.some((f) => f.status === 'failed')) {
    const { failures, truncated } = collectFailures(report);
    return {
      kind: 'fail',
      failures,
      total,
      failed: failed || failures.length,
      truncated,
    };
  }

  if (total === 0) {
    return { kind: 'no-tests-collected' };
  }

  return { kind: 'pass', total };
};
