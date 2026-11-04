import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { errorMessage } from '../../errors.js';
import { label } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { stringEnum } from '../../schema.js';
import { saveReport } from './assignment.js';
import type { Assignment, SavedReport } from './assignment.js';
import { blockerKinds, decideIncompleteReport } from './incompleteReport.js';
import { decideSummaryLength, summaryLengthLimit } from './summaryLength.js';

export interface ReportRefusalState {
  incompleteRefused: boolean;
  reminderSent: boolean;
  remindAfterRefusal: boolean;
}

export interface ReportTarget {
  hc: HcRuntime;
  terminal: string;
  assignmentPath: string;
  assignment: Assignment;
  refusal: ReportRefusalState;
}

const millisecondsPerSecond = 1000;
const millisecondsPerMinute = 60_000;

export const handoverSectionNames = ['Changes', 'Evidence', 'Decisions', 'Concerns'] as const;

const summaryHasHeading = (summary: string, name: string): boolean =>
  new RegExp(`^[\\s#*>-]*${name}\\**\\s*(?::|\\(|$)`, 'im').test(summary);

const summaryLengthLimitText = summaryLengthLimit.toLocaleString('en-US');

const summaryHeadings = handoverSectionNames.map((name) => `## ${name}`).join(', ');

export const reportParameters = Type.Object({
  outcome: stringEnum(['success', 'failure', 'incomplete']),
  summary: Type.String({
    minLength: 1,
    maxLength: 32_000,
    description: `A short lead, then exactly these headings: ${summaryHeadings}. Write None under an empty one. A report without them is refused. At most ${summaryLengthLimitText} characters; save longer details to a file and name it in evidence.`,
  }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 32_000 }), { maxItems: 100 }),
  blocker: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 4000,
      description: 'Required for incomplete: what stops you.',
    }),
  ),
  blockerKind: Type.Optional(
    stringEnum(blockerKinds, {
      description:
        'Required for incomplete. time: the deadline is nearly reached; dependency: an external dependency; decision: a parent decision; limit: another exhausted limit.',
    }),
  ),
  onlyParentCanClear: Type.Optional(
    Type.Boolean({
      description:
        'For incomplete: true when only the parent or user can clear the blocker, such as a server you may not restart or an expired login. Such a report is accepted on the first call.',
    }),
  ),
});

export type ReportInput = Static<typeof reportParameters>;

const refuseEarlyIncomplete = (
  target: ReportTarget,
  {
    blocker,
    blockerKind,
    onlyParentCanClear = false,
  }: Pick<ReportInput, 'blocker' | 'blockerKind' | 'onlyParentCanClear'>,
) => {
  if (blocker === undefined || blocker.trim() === '' || blockerKind === undefined) {
    throw new Error(
      'An incomplete report needs a blocker and blockerKind: the external dependency, exhausted limit, or parent decision that stops you. Without one, finish the work or report failure.',
    );
  }

  const { assignment } = target;
  const remaining = assignment.deadline - Date.now();

  const step = decideIncompleteReport({
    blockerKind,
    remaining,
    window: assignment.deadline - assignment.createdAt,
    refusedBefore: target.refusal.incompleteRefused,
    onlyParentCanClear,
  });

  if (step === 'accept') {
    return;
  }

  if (step === 'refuseTime') {
    throw new Error(
      `Report refused: ${Math.floor(remaining / millisecondsPerSecond)} seconds remain. Continue the remaining assigned work now. Do not sleep, poll, or retry the report only to wait out the time. Report incomplete only when a concrete blocker stops you.`,
    );
  }

  target.refusal.incompleteRefused = true;

  throw new Error(
    `Report refused: ${Math.floor(remaining / millisecondsPerMinute)} minutes remain. Finish the remaining assigned work. Report incomplete only when a concrete blocker stops you. Set onlyParentCanClear when only the parent or user can clear it.`,
  );
};

const refuseMissingSections = (summary: string) => {
  const missing = handoverSectionNames.filter((name) => !summaryHasHeading(summary, name));

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `Report refused: summary is missing the ${missing.join(', ')} section headings. Resend a compact summary with all four sections, writing None under any that is empty.`,
  );
};

const refuseLongSummary = (summary: string) => {
  if (decideSummaryLength({ length: summary.length }) === 'accept') {
    return;
  }

  const length = summary.length.toLocaleString('en-US');

  throw new Error(
    `Report refused: the summary has ${length} characters, over the limit of ${summaryLengthLimitText} characters. Save the details to a file, name it in evidence, and resend a shorter summary.`,
  );
};

const reportOutcome = (value: string): SavedReport['outcome'] => {
  if (value === 'success' || value === 'failure' || value === 'incomplete') {
    return value;
  }

  throw new Error(`Unknown report outcome: ${value}.`);
};

const withBlocker = (summary: string, blocker: string | undefined): string =>
  blocker === undefined ? summary : `Blocker: ${blocker}\n\n${summary}`;

export const stepFailure = (step: string, error: unknown): string =>
  `${step} failed: ${errorMessage(error)}`;

const resultText = (failures: readonly string[]): string =>
  failures.length === 0
    ? 'Handover durably accepted. Report label set. Stop working.'
    : `Handover durably accepted. ${failures.join(' ')} Stop working.`;

export const reportToParent = async (
  target: ReportTarget,
  parameters: ReportInput,
): Promise<AgentToolResult<SavedReport>> => {
  const { assignment } = target;

  if (assignment.report !== null) {
    throw new Error('This worker already reported.');
  }

  const {
    blocker,
    blockerKind: _blockerKind,
    onlyParentCanClear: _onlyParentCanClear,
    ...handover
  } = parameters;

  const summary = withBlocker(
    handover.summary,
    handover.outcome === 'incomplete' ? blocker : undefined,
  );

  try {
    refuseLongSummary(handover.summary);
    refuseMissingSections(summary);

    if (handover.outcome === 'incomplete') {
      refuseEarlyIncomplete(target, parameters);
    }
  } catch (error) {
    target.refusal.remindAfterRefusal = true;
    throw error;
  }

  const report: SavedReport = {
    outcome: reportOutcome(handover.outcome),
    summary,
    evidence: handover.evidence,
  };

  await saveReport(target.assignmentPath, report);
  assignment.report = report;

  const failures: string[] = [];

  try {
    await label(target.hc, target.terminal, { 'tau.report': target.assignmentPath });
  } catch (error) {
    failures.push(stepFailure('Report label', error));
  }

  return {
    content: [{ type: 'text' as const, text: resultText(failures) }],
    details: report,
    terminate: true,
  };
};
