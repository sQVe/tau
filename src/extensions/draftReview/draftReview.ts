/* oxlint-disable node/no-process-env -- The herdr pane comes from the active Pi process. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isProcessRunning } from './processRunning.js';
import { createDraftReviewTool } from './tool.js';

export default function draftReviewExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    createDraftReviewTool({
      exec: (command, commandArguments, options) => pi.exec(command, commandArguments, options),
      isProcessRunning,
      herdrPaneId: () => {
        const paneId = process.env.HERDR_PANE_ID;

        return paneId === undefined || paneId === '' ? undefined : paneId;
      },
    }),
  );
}
