import { expect, it } from 'vitest';

import { runContext, summarize } from './render.js';
import type { RunDiagnostics, RunnerResult, RunStage } from './runner/types.js';

const behavior = { behavior: 'value', files: ['src/lib.rs'], testFullName: 'tests::adds' };

const observation = (report: RunnerResult): Parameters<typeof summarize>[1] => ({
  kind: report.kind,
  scope: 'focused',
  freshness: 'fresh',
  inputs: { before: 'before', after: 'after' },
  runPath: undefined,
  report,
});

const stage = (name: string): RunStage => ({
  name,
  command: ['cargo', 'nextest', name],
  started: true,
  exitCode: null,
  durationMs: 100,
});

const diagnostics = (stages: RunStage[]): RunDiagnostics => ({
  directory: '/tmp/run',
  durationMs: 200,
  timeoutMs: 1000,
  report: { path: '/tmp/run/report.xml', format: 'junit' },
  stages,
});

it('names the stage that timed out', () => {
  const text = summarize('/repo', observation({ kind: 'timeout', stage: 'list' }));

  expect(text).toContain('Timed out during list.');
});

it('names no stage for a timeout without one', () => {
  const text = summarize('/repo', observation({ kind: 'timeout' }));

  expect(text).not.toContain('Timed out during');
});

it('shows one timeout for a run with several stages', () => {
  const report: RunnerResult = {
    kind: 'timeout',
    stage: 'run',
    diagnostics: diagnostics([stage('list'), stage('run')]),
  };

  const text = runContext(behavior, observation(report));

  expect(text).toContain('Elapsed: 200 ms; timeout: 1000 ms for the run.');
});

it('shows the searched PATH when the runner executable is missing', () => {
  const report: RunnerResult = {
    kind: 'runner-missing',
    message: 'cargo-nextest was not found on PATH.',
    resolution: { executable: 'cargo-nextest', searchedPath: '/usr/bin:/bin' },
    diagnostics: {
      ...diagnostics([]),
      resolution: { executable: 'cargo-nextest', searchedPath: '/usr/bin:/bin' },
    },
  };

  const text = runContext(behavior, observation(report));

  expect(text).toContain('Searched PATH for cargo-nextest: /usr/bin:/bin');
});
