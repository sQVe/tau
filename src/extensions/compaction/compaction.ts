import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isWorkerProcess } from '../../workerProcess.js';
import { decideReminder } from './reminder.js';

const thresholdPercent = 50;

const reminderText = `The context has passed ${thresholdPercent}% of the model's context window. Finish the current ticket, then start a new session.`;

// Suggests a new session in a manager session. Pi and the user own compaction, so Tau never starts one
// and sends the model nothing.
export default function compactionExtension(pi: ExtensionAPI): void {
  if (isWorkerProcess()) {
    return;
  }

  let reminded = false;

  pi.on('session_start', () => {
    reminded = false;
  });

  pi.on('session_compact', () => {
    reminded = false;
  });

  pi.on('agent_settled', (_event, context) => {
    const contextPercent = context.getContextUsage()?.percent ?? undefined;
    const step = decideReminder({ contextPercent, thresholdPercent, reminded });

    if (step === 'rearm') {
      reminded = false;

      return;
    }

    if (step === 'keep') {
      return;
    }

    reminded = true;

    if (context.hasUI) {
      context.ui.notify(reminderText, 'warning');
    }
  });
}
