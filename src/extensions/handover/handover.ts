import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createHandoverTool } from './tool.js';

export default function handoverExtension(pi: ExtensionAPI): void {
  pi.registerTool(createHandoverTool());
}
