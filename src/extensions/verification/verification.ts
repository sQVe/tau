import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isWorkerProcess } from '../../worker.js';
import { createVerificationTool } from './tool.js';

export default function verificationExtension(pi: ExtensionAPI): void {
  if (isWorkerProcess()) {
    return;
  }

  pi.registerTool(createVerificationTool());
}
