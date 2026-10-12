import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createTrackerDraftTool } from './draftTool.js';
import { createTrackerEvidenceTool } from './tool.js';

export default function trackerExtension(pi: ExtensionAPI): void {
  pi.registerTool(createTrackerDraftTool());

  pi.registerTool(
    createTrackerEvidenceTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );
}
