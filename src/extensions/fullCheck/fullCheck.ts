import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createFullCheckTool } from './tool.js';

export default function fullCheckExtension(pi: ExtensionAPI): void {
  pi.registerTool(createFullCheckTool());
}
