import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { createCommitTool } from './tool.js';

export default function commitExtension(pi: ExtensionAPI) {
  pi.registerTool(createCommitTool(pi));
}
