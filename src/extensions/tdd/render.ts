import { isAbsolute, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { LoadedTddConfig, TddConfig } from './config.js';
import { tddConfigFields } from './configLayers.js';
import { maximumFailures, reportLabels } from './runner/constants.js';
import { maximumRetainedRuns } from './runner/retention.js';
import type { DiagnosticFile, RunnerResult, RunStage, TestAttribution } from './runner/types.js';
import type { Behavior, ObservationResult } from './types.js';

type Observation = Omit<ObservationResult, 'hint'>;

interface DurationList {
  header: string | null;
  entries: string[];
  limit: number;
}

const maximumSummaryCharacters = 2000;

const printable = (text: string) =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, (character) =>
    character === '\n' || character === '\t' ? character : ' ',
  );

const cutMarker = ' [cut]';
const maximumFilesLength = 500;
const maximumNamesLength = 700;
const maximumTestNameLength = 200;
const maximumErrorLength = 400;
const maximumResultLength = 4000;
const maximumConfigLength = 1500;
// Room kept for the lines after the failures.
const trailingLinesRoom = 60;

const cap = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - cutMarker.length)}${cutMarker}` : text;

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
    `Files (${files.length}): ${cap(printable(files.join(', ')), maximumFilesLength)}`,
    `Exact names (${names.length}): ${cap(printable(names.join('\n  ')), maximumNamesLength)}`,
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

const focusedDurations = (report: RunnerResult): DurationList => {
  const timed = 'tests' in report ? report.tests.filter((test) => test.durationMs != null) : [];

  return {
    header: null,
    entries: timed.map(
      (test) => `  ${cap(printable(test.fullname), maximumTestNameLength)}: ${test.durationMs} ms`,
    ),
    limit: maximumFocusedDurations,
  };
};

// Integration files start real processes, so they would fill this list on every run.
const slowTests = (cwd: string, report: RunnerResult): DurationList => {
  const slow = ('tests' in report ? report.tests : [])
    .filter(
      (test) =>
        (test.durationMs ?? 0) > slowTestMilliseconds && !test.file.includes('.integration.'),
    )
    .toSorted((first, second) => (second.durationMs ?? 0) - (first.durationMs ?? 0));

  return {
    header: `Slow tests (over ${slowTestMilliseconds} ms):`,
    entries: slow.map((test) => {
      const file = isAbsolute(test.file) ? relative(cwd, test.file) : test.file;

      return `  ${cap(printable(`${file} › ${test.fullname}`), maximumTestNameLength)}: ${test.durationMs} ms`;
    }),
    limit: maximumSlowTests,
  };
};

const pushDurations = (lines: string[], { header, entries, limit }: DurationList) => {
  for (let shown = Math.min(entries.length, limit); shown > 0; shown -= 1) {
    const block: string[] = [];

    if (header != null) {
      block.push(header);
    }

    block.push(...entries.slice(0, shown), ...moreLine(entries.length - shown));

    if ([...lines, ...block].join('\n').length <= maximumSummaryCharacters) {
      lines.push(...block);

      return;
    }
  }
};

const messageLines = (report: RunnerResult): string[] =>
  'message' in report ? [report.message] : [];

const timeoutStageLines = (report: RunnerResult): string[] =>
  report.kind === 'timeout' && report.stage !== undefined
    ? [`Timed out during ${report.stage}.`]
    : [];

const fileFailureLines = (report: RunnerResult): string[] => {
  if (!('failures' in report)) {
    return [];
  }

  const fileFailures = report.failures.filter((failure) => failure.fullname === '<file>').length;

  if (fileFailures === 0) {
    return [];
  }

  const qualifier = 'truncated' in report && report.truncated ? 'At least ' : '';

  return [`${qualifier}${fileFailures} file/setup failures (separate from failed tests).`];
};

const attributionSuffix = (attribution: TestAttribution | undefined): string => {
  if (attribution === undefined) {
    return '';
  }

  if (attribution.kind === 'unknown') {
    return ` [attribution unknown: ${attribution.reason}]`;
  }

  return ` [ambiguous: ${(attribution.files ?? attribution.binaryIds).join(', ')}]`;
};

export const summarize = (cwd: string, observation: Observation): string => {
  const { report, scope, freshness } = observation;
  const scopeLabel = scope === 'full' ? 'full suite' : 'focused';

  const lines = [
    `${report.kind} · ${scopeLabel} · ${freshness}`,
    ...messageLines(report),
    ...timeoutStageLines(report),
    ...testSummary(report),
    ...fileFailureLines(report),
  ];

  const failures = 'failures' in report ? report.failures : [];
  let shown = 0;

  for (const failure of failures.slice(0, maximumFailures)) {
    const file = isAbsolute(failure.file) ? relative(cwd, failure.file) : failure.file;
    const entry = `✗ ${file} › ${failure.fullname}${attributionSuffix(failure.attribution)}\n    ${failure.message}`;

    if ([...lines, entry].join('\n').length > maximumSummaryCharacters - trailingLinesRoom) {
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

  pushDurations(lines, scope === 'full' ? slowTests(cwd, report) : focusedDurations(report));

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

  const truncation = file.truncated ? ', truncated' : '';

  return `${label}: ${file.path} (${size}${truncation})`;
};

const stageLabel = (label: string, stage: RunStage, labelStages: boolean): string =>
  labelStages ? `${label} (${stage.name})` : label;

const stageExecutionLine = (stage: RunStage): string =>
  `${stage.name}: elapsed ${stage.durationMs} ms; exit: ${stage.exitCode ?? 'unavailable'}.`;

const executionLines = (diagnostics: NonNullable<RunnerResult['diagnostics']>): string[] => {
  const startedStages = diagnostics.stages.filter((stage) => stage.started);

  if (startedStages.length === 0) {
    return ['Execution did not start.'];
  }

  if (diagnostics.stages.length > 1) {
    return [
      `Elapsed: ${diagnostics.durationMs} ms; timeout: ${diagnostics.timeoutMs} ms for the run.`,
      ...diagnostics.stages.map(stageExecutionLine),
    ];
  }

  return startedStages.map(
    (stage) =>
      `Elapsed: ${diagnostics.durationMs} ms; timeout: ${diagnostics.timeoutMs} ms; exit: ${stage.exitCode ?? 'unavailable'}.`,
  );
};

// The Vitest package diagnostic is already explained in the result message.
const resolutionLines = (diagnostics: NonNullable<RunnerResult['diagnostics']>): string[] => {
  const resolution = diagnostics.resolution;

  if (resolution === undefined || !('executable' in resolution)) {
    return [];
  }

  const searched = cap(printable(resolution.searchedPath), maximumFilesLength);

  return [`Searched PATH for ${resolution.executable}: ${searched}`];
};

const savedFileLines = (diagnostics: NonNullable<RunnerResult['diagnostics']>): string[] => {
  const lines: string[] = [];
  const labelStages = diagnostics.stages.length > 1;

  for (const stage of diagnostics.stages) {
    for (const [label, file] of [
      ['stdout', stage.stdout],
      ['stderr', stage.stderr],
    ] as const) {
      if (file !== undefined) {
        lines.push(diagnosticFileLine(stageLabel(label, stage, labelStages), file));
      }
    }
  }

  const reportLabel = reportLabels[diagnostics.report.format];

  if (diagnostics.report.file === undefined) {
    lines.push(`No ${reportLabel} was saved.`);
  } else {
    lines.push(diagnosticFileLine(reportLabel, diagnostics.report.file));
  }

  if (diagnostics.error !== undefined) {
    lines.push(cap(printable(diagnostics.error), maximumErrorLength));
  }

  return lines;
};

const excerptLines = (
  report: RunnerResult,
  diagnostics: NonNullable<RunnerResult['diagnostics']>,
): string[] => {
  if (report.kind === 'pass') {
    return [];
  }

  const labelStages = diagnostics.stages.length > 1;

  return diagnostics.stages.flatMap((stage) => {
    if (stage.excerpt == null || stage.excerpt === '') {
      return [];
    }

    const label = labelStages ? ` (${stage.name})` : '';

    return [`Runner output excerpt${label} (not a test verdict):\n${printable(stage.excerpt)}`];
  });
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

  lines.push(...executionLines(diagnostics), ...resolutionLines(diagnostics));

  if (runPath !== undefined) {
    lines.push(`Run record (command, selection, input fingerprints): ${runPath}`);
  }

  lines.push(...savedFileLines(diagnostics));

  lines.push(
    `Saved diagnostics are not reusable verification. Cleanup keeps up to ${maximumRetainedRuns} completed runs for seven days.`,
  );

  lines.push(...excerptLines(report, diagnostics));

  return cap(lines.join('\n'), maximumResultLength);
};

const configLabels: Record<keyof TddConfig, string> = {
  runner: 'Runner',
  productionGlobs: 'Production',
  testGlobs: 'Tests',
  testSupportGlobs: 'Test support',
  excludedGlobs: 'Excluded',
  verificationArgv: 'Command',
};

const configValueText = (value: string | readonly string[], separator: string): string =>
  typeof value === 'string' ? value : value.join(separator);

export const configSummary = ({ config, sources, ignored }: LoadedTddConfig): string => {
  const lines = [
    'TDD config (repository .pi/tau.json overrides user tau.json):',
    ...tddConfigFields.map((field) => {
      const separator = field === 'verificationArgv' ? ' ' : ', ';

      return `${configLabels[field]} (${sources[field]}): ${configValueText(config[field], separator)}`;
    }),
  ];

  if (ignored !== undefined) {
    lines.push(`Ignored ${ignored}: the project is not trusted.`);
  }

  return cap(printable(lines.join('\n')), maximumConfigLength);
};
