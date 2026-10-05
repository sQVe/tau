import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createCodeReviewTool } from './tool.js';

export default function codeReviewExtension(pi: ExtensionAPI): void {
  pi.registerTool(createCodeReviewTool());
}
