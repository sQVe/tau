import { StringEnum } from '@earendil-works/pi-ai';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';

import { blockerKinds, decideIncompleteReport } from './incompleteReport.js';
import { handoverSectionNames, handoverSections } from './presentation.js';
import { acceptReport } from './records.js';
import { decideSummaryLength, summaryLengthLimit } from './summaryLength.js';
import type { Report, Task } from './types.js';
import { isTaskActive, remainingWork } from './workerExtensionState.js';
import type { WorkerExtensionState } from './workerExtensionState.js';

const millisecondsPerSecond = 1000;
const millisecondsPerMinute = 60_000;

const summaryLengthLimitText = summaryLengthLimit.toLocaleString('en-US');

const summaryHeadings = handoverSectionNames.map((name) => `## ${name}`).join(', ');

export const reportParameters = Type.Object({
  outcome: StringEnum(['success', 'failure', 'incomplete']),
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
    StringEnum(blockerKinds, {
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
  state: WorkerExtensionState,
  task: Task,
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

  const remaining = remainingWork(state, task);

  const step = decideIncompleteReport({
    blockerKind,
    remaining,
    window: task.deadline - task.createdAt,
    refusedBefore: state.incompleteRefused,
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

  state.incompleteRefused = true;
  throw new Error(
    `Report refused: ${Math.floor(remaining / millisecondsPerMinute)} minutes remain. Finish the remaining assigned work. Report incomplete only when a concrete blocker stops you. Set onlyParentCanClear when only the parent or user can clear it.`,
  );
};

const refuseMissingSections = (summary: string) => {
  const missing = handoverSections({ summary })?.missing ?? [];

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

const withBlocker = (summary: string, blocker: string | undefined): string =>
  blocker === undefined ? summary : `Blocker: ${blocker}\n\n${summary}`;

export const reportToParent = (
  state: WorkerExtensionState,
  parameters: ReportInput,
): Promise<AgentToolResult<Report>> => {
  if (!isTaskActive(state)) {
    throw new Error('This worker has no accepted active task.');
  }

  const task = state.task;

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
      refuseEarlyIncomplete(state, task, parameters);
    }
  } catch (error) {
    state.remindAfterRefusal = true;
    throw error;
  }

  const report = acceptReport(state.directory, task.taskId, {
    ...handover,
    summary,
    taskId: task.taskId,
  });

  state.reported = true;
  clearTimeout(state.deadlineWarning);

  return Promise.resolve({
    content: [{ type: 'text' as const, text: 'Handover durably accepted. Stop working.' }],
    details: report,
    terminate: true,
  });
};
