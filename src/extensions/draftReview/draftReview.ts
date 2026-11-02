import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { connect } from '../../hc/connect.js';
import { createDraftReviewTool } from './tool.js';

export default function draftReviewExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    createDraftReviewTool({
      exec: (command, commandArguments, options) => pi.exec(command, commandArguments, options),
      connect,
    }),
  );
}
