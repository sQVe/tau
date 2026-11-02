import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  CustomMessageEntryDraft,
} from '@earendil-works/pi-coding-agent';

import type { ReportTarget } from './report.js';

export interface ReminderState {
  target: ReportTarget;
  runError: string | undefined;
  questionAsked: boolean;
}

const reportReminder: CustomMessageEntryDraft = {
  type: 'custom_message',
  customType: 'tau-worker-report-request',
  content: [
    'Your turn ended without subagent_report. Finish the assigned work, then call subagent_report.',
    'Report incomplete only with a concrete blocker. Do not expand the original scope; the deadline is unchanged.',
  ].join(' '),
  display: true,
};

export const remindToReport = (
  state: ReminderState,
  event: AgentBeforeSettleEvent,
): AgentBeforeSettleEventResult | undefined => {
  // A reminder after an errored or aborted run repeats the same error; the error explains the stop.
  if (state.target.assignment.report !== null || state.runError !== undefined) {
    return undefined;
  }

  // A worker that asked a question waits for the parent's reply; it is not done yet.
  if (state.questionAsked) {
    return undefined;
  }

  // Nothing enforces the deadline yet, so a worker past it can still report and must be asked to.
  const { refusal } = state.target;
  // A refused report earns one more reminder; otherwise the worker could settle with no report.
  const alreadyReminded = refusal.reminderSent && !refusal.remindAfterRefusal;

  if (alreadyReminded) {
    return undefined;
  }

  refusal.reminderSent = true;
  refusal.remindAfterRefusal = false;

  return { entries: [...event.entries, reportReminder], continue: true };
};
