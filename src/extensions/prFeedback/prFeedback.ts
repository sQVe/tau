import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createPrFeedbackTool } from './tool.js';

export default function prFeedbackExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    createPrFeedbackTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );
}
