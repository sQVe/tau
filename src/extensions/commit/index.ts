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
  pi.registerFlag('auto-approve-commits', {
    description:
      'Skip commit confirmation for this process. Checks and comment review still apply.',
    type: 'boolean',
    default: false,
  });

  pi.on('tool_call', guardToolCall);
  pi.registerTool(
    createCommitTool(pi, undefined, () => pi.getFlag('auto-approve-commits') === true),
  );
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
