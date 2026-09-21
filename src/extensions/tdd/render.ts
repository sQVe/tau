import { isAbsolute, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { createTestObservation } from './observation.js';
import { maximumRetainedRuns } from './runner/retention.js';
import { maximumFailures } from './runner/types.js';
import type { DiagnosticFile, RunnerResult } from './runner/types.js';
import type { Behavior } from './types.js';

type Observation = Omit<
  Awaited<ReturnType<ReturnType<typeof createTestObservation>['run']>>,
  'hint'
>;

const maximumSummaryCharacters = 2000;

const printable = (text: string) =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, (character) =>
    character === '\n' || character === '\t' ? character : ' ',
  );

const cap = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 6)} [cut]` : text;

export const selectionSummary = (behavior: Partial<Behavior>, scope?: string): string => {
  if (scope === 'full') {
    return 'Scope: full suite (no file or test-name filter)';
  }

  if (scope !== 'focused') {
    return 'Waiting for test selection';
  }

  const names = Array.isArray(behavior.testFullName)
    ? behavior.testFullName
    : [behavior.testFullName ?? ''];
  const files = behavior.files ?? [];

  return [
    'Scope: focused',
    `Files (${files.length}): ${cap(printable(files.join(', ')), 500)}`,
    `Exact names (${names.length}): ${cap(printable(names.join('\n  ')), 700)}`,
  ].join('\n');
};

const testSummary = (report: RunnerResult): string[] => {
  if (!('tests' in report)) {
    return [];
  }

  const count = (...statuses: string[]) =>
    report.tests.filter((test) => statuses.includes(test.status)).length;
  const lines = [
    `${count('passed')} passed, ${count('failed')} failed, ${count('skipped', 'todo')} skipped`,
  ];

  if (report.kind === 'no-tests-collected') {
    lines.push(
      report.tests.length === 0
        ? 'No matching tests in the report.'
        : 'No tests ran successfully; inspect the reported skipped/todo tests and runner output.',
    );
  }

  return lines;
};

// Measured on Tau's suite: the median test takes 3 ms and 90% finish within 210 ms.
const slowTestMilliseconds = 1000;
const maximumSlowTests = 3;
const maximumFocusedDurations = 10;

const moreLine = (hidden: number) => (hidden > 0 ? [`  +${hidden} more`] : []);

const focusedDurations = (report: RunnerResult): string[] => {
  const timed = 'tests' in report ? report.tests.filter((test) => test.durationMs != null) : [];
  const shown = timed.slice(0, maximumFocusedDurations);

  return [
    ...shown.map((test) => `  ${cap(printable(test.fullname), 200)}: ${test.durationMs} ms`),
    ...moreLine(timed.length - shown.length),
  ];
};

// Integration files start real processes, so they would fill this list on every run.
const slowTests = (cwd: string, report: RunnerResult): string[] => {
  const slow = ('tests' in report ? report.tests : [])
    .filter(
      (test) =>
        (test.durationMs ?? 0) > slowTestMilliseconds && !test.file.includes('.integration.'),
    )
    .toSorted((first, second) => (second.durationMs ?? 0) - (first.durationMs ?? 0));

  if (slow.length === 0) {
    return [];
  }

  const shown = slow.slice(0, maximumSlowTests);

  return [
    `Slow tests (over ${slowTestMilliseconds} ms):`,
    ...shown.map((test) => {
      const file = isAbsolute(test.file) ? relative(cwd, test.file) : test.file;

      return `  ${cap(printable(`${file} › ${test.fullname}`), 200)}: ${test.durationMs} ms`;
    }),
    ...moreLine(slow.length - shown.length),
  ];
};

export const summarize = (cwd: string, observation: Observation): string => {
  const { report, scope, freshness } = observation;
  const lines = [`${report.kind} · ${scope === 'full' ? 'full suite' : 'focused'} · ${freshness}`];

  if ('message' in report) {
    lines.push(report.message);
  }

  lines.push(...testSummary(report));
  lines.push(...(scope === 'full' ? slowTests(cwd, report) : focusedDurations(report)));

  const failures = 'failures' in report ? report.failures : [];
  const fileFailures = failures.filter((failure) => failure.fullname === '<file>').length;

  if (fileFailures > 0) {
    const qualifier = 'truncated' in report && report.truncated ? 'At least ' : '';

    lines.push(`${qualifier}${fileFailures} file/setup failures (separate from failed tests).`);
  }

  let shown = 0;

  for (const failure of failures.slice(0, maximumFailures)) {
    const file = isAbsolute(failure.file) ? relative(cwd, failure.file) : failure.file;
    const entry = `✗ ${file} › ${failure.fullname}\n    ${failure.message}`;

    if ([...lines, entry].join('\n').length > maximumSummaryCharacters - 60) {
      break;
    }

    lines.push(entry);
    shown += 1;
  }

  if (failures.length > shown) {
    lines.push(`+${failures.length - shown} more`);
  }

  if ('truncated' in report && report.truncated) {
    lines.push('further failures were not collected');
  }

  return cap(printable(lines.join('\n')), maximumSummaryCharacters);
};

const freshnessDescriptions = {
  fresh: 'inputs unchanged during this run',
  stale: 'inputs changed during this run; rerun on current inputs',
  unknown: 'input freshness could not be checked',
};

const diagnosticFileLine = (label: string, file: DiagnosticFile): string => {
  const size =
    file.decodedBytes === undefined
      ? `${file.savedBytes}/${file.bytes} bytes`
      : `${file.savedBytes}/${file.decodedBytes} decoded bytes; ${file.bytes} process bytes observed`;

  return `${label}: ${file.path} (${size}${file.truncated ? ', truncated' : ''})`;
};

export const runContext = (behavior: Behavior, observation: Observation): string => {
  const { scope, freshness, report, runPath } = observation;
  const lines = [selectionSummary(behavior, scope)];
  const coverage = scope === 'full' ? 'Full suite' : 'Focused selection';

  if (report.kind === 'pass') {
    lines.push(`${coverage} passed; ${freshnessDescriptions[freshness]}.`);
  } else {
    lines.push(`${coverage} did not pass; freshness describes inputs, not test success.`);
  }

  lines.push(
    'Freshness checks source, tests, and configuration at run boundaries, not an atomic repository snapshot.',
  );

  const diagnostics = report.diagnostics;

  if (diagnostics === undefined) {
    return lines.join('\n');
  }

  if (diagnostics.started === false || report.kind === 'runner-missing') {
    lines.push('Execution did not start.');
  } else {
    lines.push(
      `Elapsed: ${diagnostics.durationMs} ms; timeout: ${diagnostics.timeoutMs} ms; exit: ${diagnostics.exitCode ?? 'unavailable'}.`,
    );
  }

  if (runPath !== undefined) {
    lines.push(`Run record (command, selection, input fingerprints): ${runPath}`);
  }

  for (const [label, file] of [
    ['stdout', diagnostics.stdout],
    ['stderr', diagnostics.stderr],
    ['JSON report', diagnostics.report],
  ] as const) {
    if (file !== undefined) {
      lines.push(diagnosticFileLine(label, file));
    }
  }

  if (diagnostics.report === undefined) {
    lines.push('No JSON report was saved.');
  }

  if (diagnostics.error !== undefined) {
    lines.push(cap(printable(diagnostics.error), 400));
  }

  lines.push(
    `Saved diagnostics are not reusable verification. Cleanup keeps up to ${maximumRetainedRuns} completed runs for seven days.`,
  );

  if (report.kind !== 'pass' && diagnostics.excerpt) {
    lines.push(`Runner output excerpt (not a test verdict):\n${printable(diagnostics.excerpt)}`);
  }

  return cap(lines.join('\n'), 4000);
};
