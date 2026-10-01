import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isWorkerProcess } from '../../workerProcess/index.js';
import { loadCompactionConfig } from './config.js';
import { decideReminder } from './reminder.js';

const reminderText = (thresholdTokens: number): string =>
  `The context has passed ${thresholdTokens.toLocaleString('en-US')} tokens. Run /compact at a good stopping point.`;

// Suggests /compact in a manager session. Pi and the user own compaction, so Tau never starts one
// and sends the model nothing.
export default function compactionExtension(pi: ExtensionAPI): void {
  if (isWorkerProcess()) {
    return;
  }

  let thresholdTokens: number | undefined;
  let reminded = false;

  pi.on('session_start', (_event, context) => {
    // An invalid config throws below and leaves the reminder off for this session.
    thresholdTokens = undefined;
    reminded = false;

    thresholdTokens = loadCompactionConfig({
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    }).reminderTokens;
  });

  pi.on('session_compact', () => {
    reminded = false;
  });

  pi.on('agent_settled', (_event, context) => {
    if (thresholdTokens === undefined) {
      return;
    }

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
      context.ui.notify(reminderText(thresholdTokens), 'warning');
    }
  });
}
