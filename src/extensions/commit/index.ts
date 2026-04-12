import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

import { guardToolCall } from './guard.js';
import { createCommitTool } from './tool.js';

const commitSkillCommandPrefix = '/skill:commit';

const buildCommitSkillMessage = (args: string) => {
  const trimmedArgs = args.trim();

  return trimmedArgs ? `${commitSkillCommandPrefix} ${trimmedArgs}` : commitSkillCommandPrefix;
};

export default function commitExtension(pi: ExtensionAPI) {
  pi.on('tool_call', guardToolCall);
  pi.registerTool(createCommitTool(pi));
  pi.registerCommand('commit', {
    description: 'Delegate to the commit skill.',
    handler: (args, ctx) => {
      pi.sendUserMessage(buildCommitSkillMessage(args), {
        deliverAs: ctx.isIdle() ? 'followUp' : 'steer',
      });

      return Promise.resolve();
    },
  });
}
