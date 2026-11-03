import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { forgetReportedWarnings } from '../../config/config.js';
import { handleToolResult } from './editCheckpoint.js';
import { createObservationTracker } from './observationTracker.js';
import { registerRunTestsTool } from './runTestsTool.js';

export default function tddExtension(pi: ExtensionAPI): void {
  const tracker = createObservationTracker();

  pi.on('session_start', (_event, context) => {
    forgetReportedWarnings(context.ui);
    tracker.startSession();
  });

  pi.on('session_shutdown', () => {
    tracker.shutdownSession();
  });

  pi.on('tool_result', (event, context) => handleToolResult(tracker, event, context));

  registerRunTestsTool(pi, tracker);
}
