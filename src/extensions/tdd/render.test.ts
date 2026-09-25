import { expect, it } from 'vitest';

import { runContext, selectionSummary, summarize } from './render.js';
import type { RunnerResult } from './runner/types.js';

const behavior = { behavior: 'value', files: ['value.test.ts'], testFullName: 'value works' };

const observation = (
  report: RunnerResult,
  overrides: Partial<Parameters<typeof summarize>[1]> = {},
): Parameters<typeof summarize>[1] => ({
  kind: report.kind,
  scope: 'focused',
  freshness: 'fresh',
  inputs: { before: 'before', after: 'after' },
  runPath: undefined,
  report,
  ...overrides,
});

it('shows bounded selection context and distinguishes full-suite scope', () => {
  expect(selectionSummary(behavior, 'focused')).toContain('value.test.ts');
  expect(selectionSummary(behavior, 'focused')).toContain('value works');

  expect(selectionSummary(behavior, 'full')).toBe(
    'Scope: full suite (no file or test-name filter)',
  );

  expect(selectionSummary(behavior, 'full')).not.toContain('value works');
  expect(selectionSummary({})).toBe('Waiting for test selection');

  const large = selectionSummary(
    { ...behavior, testFullName: '\u001b[31m' + 'x'.repeat(5000) },
    'focused',
  );

  expect(large.length).toBeLessThan(1300);
  expect(large).toContain('[cut]');
  expect(large).not.toContain('\u001b');
});

it('separates file failures and unexecuted selections from test failures', () => {
  const failure = observation({
    kind: 'fail',
    tests: [],
    failures: [{ file: 'value.test.ts', fullname: '<file>', message: 'setup failed' }],
    truncated: false,
  });

  const skipped = observation({
    kind: 'no-tests-collected',
    tests: [{ file: 'value.test.ts', fullname: 'value works', status: 'skipped' }],
  });

  const missing = observation({ kind: 'no-tests-collected', tests: [] });

  expect(summarize('/repo', failure)).toContain(
    '1 file/setup failures (separate from failed tests)',
  );

  expect(summarize('/repo', skipped)).toContain('1 skipped');
  expect(summarize('/repo', skipped)).toContain('No tests ran successfully');
  expect(summarize('/repo', missing)).toContain('No matching tests in the report');
});

it('keeps run scope outcome and input freshness distinct', () => {
  const passed = { kind: 'pass' as const, tests: [] };
  const stale = runContext(behavior, observation(passed, { scope: 'full', freshness: 'stale' }));
  const unknown = runContext(behavior, observation(passed, { freshness: 'unknown' }));
  const failed = runContext(behavior, observation({ kind: 'timeout' }, { scope: 'full' }));

  expect(stale).toContain(
    'Full suite passed; inputs changed during this run; rerun on current inputs',
  );

  expect(unknown).toContain('input freshness could not be checked');
  expect(failed).toContain('Full suite did not pass');
  expect(failed).not.toContain('Full suite passed');
});

it('distinguishes an execution that did not start from a completed run', () => {
  const report: RunnerResult = {
    kind: 'runner-missing',
    message: 'vitest not found',
    resolution: {
      cwd: '/repo',
      request: 'vitest/package.json',
      stage: 'lookup',
      errorType: 'Error',
      errorCode: 'MODULE_NOT_FOUND',
    },
    diagnostics: { directory: '/tmp/run', durationMs: 0, timeoutMs: 30_000, exitCode: null },
  };

  const text = runContext(behavior, observation(report));

  expect(text).toContain('Execution did not start');
  expect(text).not.toContain('Elapsed:');
  expect(text).not.toContain('exit:');
});

it('shows bounded process diagnostics and readable artifact paths', () => {
  const report: RunnerResult = {
    kind: 'timeout',
    diagnostics: {
      directory: '/tmp/run',
      durationMs: 120_000,
      timeoutMs: 120_000,
      exitCode: null,
      stderr: { path: '/tmp/run/stderr.txt', bytes: 40_000, savedBytes: 32_768, truncated: true },
      excerpt: '\u001b[31mSetup failed\u001b[0m\u0007',
    },
  };

  const text = runContext(
    behavior,
    observation(report, { scope: 'full', runPath: '/tmp/run/run.json' }),
  );

  expect(text).toContain('Elapsed: 120000 ms; timeout: 120000 ms; exit: unavailable');
  expect(text).toContain('/tmp/run/run.json');
  expect(text).toContain('/tmp/run/stderr.txt (32768/40000 bytes, truncated)');
  expect(text).toContain('No JSON report was saved');
  expect(text).toContain('Setup failed');
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\u0007');
  expect(text.length).toBeLessThanOrEqual(4000);
});

const timed = (file: string, fullname: string, durationMs?: number) => ({
  file,
  fullname,
  status: 'passed' as const,
  ...(durationMs === undefined ? {} : { durationMs }),
});

it('shows the duration of each selected test in a focused run', () => {
  const summary = summarize(
    '/repo',
    observation({
      kind: 'pass',
      tests: [timed('/repo/value.test.ts', 'value works', 42), timed('/repo/value.test.ts', 'old')],
    }),
  );

  expect(summary).toContain('value works: 42 ms');
  expect(summary).not.toContain('old:');
});

it('stays quiet about durations in a full run when no test is slow', () => {
  const summary = summarize(
    '/repo',
    observation(
      {
        kind: 'pass',
        tests: [
          timed('/repo/value.test.ts', 'fast', 1000),
          timed('/repo/tests/flow.integration.test.ts', 'real process', 9000),
        ],
      },
      { scope: 'full' },
    ),
  );

  expect(summary).not.toMatch(/\d+ ms/);
});

it('lists only the slowest tests over one second in a full run', () => {
  const summary = summarize(
    '/repo',
    observation(
      {
        kind: 'pass',
        tests: [
          timed('/repo/a.test.ts', 'slow', 1001),
          timed('/repo/a.test.ts', 'slower', 1500),
          timed('/repo/b.test.ts', 'slowest', 3000),
          timed('/repo/b.test.ts', 'also slow', 1200),
          timed('/repo/b.test.ts', 'fast', 5),
        ],
      },
      { scope: 'full' },
    ),
  );

  const listed = [...summary.matchAll(/› (.+): \d+ ms/g)].map((match) => match[1]);

  expect(listed).toEqual(['slowest', 'slower', 'also slow']);
  expect(summary).toContain('+1 more');
});

it('counts the durations that do not fit as hidden', () => {
  const tests = Array.from({ length: 15 }, (_, index) =>
    timed('/repo/value.test.ts', `value works ${'x'.repeat(200)} ${index}`, index),
  );

  const summary = summarize('/repo', observation({ kind: 'pass', tests }));
  const shown = summary.match(/: \d+ ms$/gm)?.length ?? 0;

  expect(summary.length).toBeLessThanOrEqual(2000);
  expect(shown).toBeGreaterThan(0);
  expect(summary).toContain(`+${15 - shown} more`);
});

it('omits the slow test heading when none of its entries fit', () => {
  const failures = Array.from({ length: 10 }, (_, index) => ({
    file: '/repo/value.test.ts',
    fullname: `value fails ${index}`,
    message: 'x'.repeat(160),
  }));

  const tests = [
    ...failures.map((failure) => ({
      ...timed(failure.file, failure.fullname, 1),
      status: 'failed' as const,
    })),
    timed('/repo/value.test.ts', `slow ${'x'.repeat(200)}`, 3000),
  ];

  const summary = summarize(
    '/repo',
    observation({ kind: 'fail', tests, failures, truncated: false }, { scope: 'full' }),
  );

  expect(summary).not.toMatch(/\d+ ms/);
  expect(summary.trimEnd().endsWith(':')).toBe(false);
});

it('shows failure messages before durations when both do not fit', () => {
  const tests = Array.from({ length: 10 }, (_, index) => ({
    ...timed('/repo/value.test.ts', `value fails ${'x'.repeat(200)} ${index}`, index),
    status: 'failed' as const,
  }));

  const failures = tests.map((test, index) => ({
    file: test.file,
    fullname: test.fullname,
    message: `expected ${index} to be 1`,
  }));

  const summary = summarize(
    '/repo',
    observation({ kind: 'fail', tests, failures, truncated: false }),
  );

  expect(summary).toContain('expected 0 to be 1');
  expect(summary.length).toBeLessThanOrEqual(2000);
});
