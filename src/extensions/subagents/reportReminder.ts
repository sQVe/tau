import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  CustomMessageEntryDraft,
} from '@earendil-works/pi-coding-agent';

import { publish, taskEnded } from './records.js';
import { isTaskActive, remainingWork } from './workerExtensionState.js';
import type { WorkerExtensionState } from './workerExtensionState.js';

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
  state: WorkerExtensionState,
  event: AgentBeforeSettleEvent,
): AgentBeforeSettleEventResult | undefined => {
  // A reminder after an errored or aborted run repeats the same error; the error explains the stop.
  if (!isTaskActive(state) || state.pendingQuestion || state.runError !== undefined) {
    return undefined;
  }

  const task = state.task;

  if (remainingWork(state, task) <= 0 || taskEnded(state.directory, task)) {
    return undefined;
  }

  const requested = existsSync(join(state.directory, 'reportRequest.json'));
  // A refused report earns one more reminder; otherwise the worker could settle with no report.
  const alreadyReminded = requested && !state.remindAfterRefusal;

  if (alreadyReminded) {
    return undefined;
  }

  state.remindAfterRefusal = false;

  if (!requested) {
    publish(state.directory, 'reportRequest.json', { taskId: task.taskId, at: Date.now() });
  }

  return { entries: [...event.entries, reportReminder], continue: true };
};
