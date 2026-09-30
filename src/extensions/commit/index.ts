import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { appendToolGuidelines } from '../../systemPrompt/index.js';
import { guardToolCall } from './guard.js';
import { commitToolGuidelines, createCommitTool } from './tool.js';

export default function commitExtension(pi: ExtensionAPI) {
  pi.on('tool_call', guardToolCall);
  pi.registerTool(createCommitTool(pi));
  appendToolGuidelines(pi, 'commit', commitToolGuidelines);
}
