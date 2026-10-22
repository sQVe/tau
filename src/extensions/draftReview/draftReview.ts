import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { herdrPaneId } from '../../herdr.js';
import { isProcessRunning } from './processRunning.js';
import { createDraftReviewTool } from './tool.js';

export default function draftReviewExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    createDraftReviewTool({
      exec: (command, commandArguments, options) => pi.exec(command, commandArguments, options),
      isProcessRunning,
      herdrPaneId,
    }),
  );
}
