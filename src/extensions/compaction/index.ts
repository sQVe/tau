import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isWorkerProcess } from '../../workerProcess/index.js';
import { decideReminder } from './reminder.js';

const thresholdTokens = 200_000;

const reminderText = `The context has passed ${thresholdTokens.toLocaleString('en-US')} tokens. Run /compact at a good stopping point.`;

// Suggests /compact in a manager session. Pi and the user own compaction, so Tau never starts one
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
    const contextTokens = context.getContextUsage()?.tokens ?? undefined;
    const step = decideReminder({ contextTokens, thresholdTokens, reminded });

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
