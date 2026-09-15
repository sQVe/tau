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
