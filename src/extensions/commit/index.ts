import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { guardToolCall } from './guard.js';
import { createCommitTool } from './tool.js';

const commitSkillCommandPrefix = '/skill:commit';

const buildCommitSkillMessage = (argumentsText: string) => {
  const trimmedArguments = argumentsText.trim();

  return trimmedArguments
    ? `${commitSkillCommandPrefix} ${trimmedArguments}`
    : commitSkillCommandPrefix;
};

export default function commitExtension(pi: ExtensionAPI) {
  pi.on('tool_call', guardToolCall);
  pi.registerTool(createCommitTool(pi));
  pi.registerCommand('commit', {
    description: 'Run the commit skill.',
    handler: (argumentsText, context) => {
      pi.sendUserMessage(buildCommitSkillMessage(argumentsText), {
        deliverAs: context.isIdle() ? 'followUp' : 'steer',
      });

      return Promise.resolve();
    },
  });
}
