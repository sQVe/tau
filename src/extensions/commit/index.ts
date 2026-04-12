import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { guardToolCall } from './guard.js';
import { createCommitTool } from './tool.js';

export default function commitExtension(pi: ExtensionAPI) {
  pi.on('tool_call', guardToolCall);
  pi.registerTool(createCommitTool(pi));
}
