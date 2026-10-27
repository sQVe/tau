import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { forgetReportedWarnings } from '../../config/config.js';
import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isWorkerProcess } from '../../worker.js';
import { createTrackerDraftTool } from './draftTool.js';
import { readSessionPromptLines } from './sessionPrompt.js';
import { createTrackerEvidenceTool } from './tool.js';

export default function trackerExtension(pi: ExtensionAPI): void {
  pi.registerTool(createTrackerDraftTool());

  pi.registerTool(
    createTrackerEvidenceTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );

  if (isWorkerProcess()) {
    return;
  }

  let promptLines: string[] = [];

  pi.on('session_start', async (_event, context) => {
    forgetReportedWarnings(context.ui);
    promptLines = await readSessionPromptLines(pi, context);
  });

  pi.on('before_agent_start', (event) => {
    if (promptLines.length > 0) {
      appendSystemPrompt(event, promptLines.map((line) => `- ${line}`).join('\n'));
    }
  });
}
