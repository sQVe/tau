import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { Exec } from '../../command.js';
import { createBranch } from './branch.js';
import type { BranchResult } from './branch.js';

const parameters = Type.Object({
  parent: Type.String(),
  branch: Type.String(),
  trunk: Type.String(),
  remote: Type.String(),
});

const description =
  'Puts branch on top of parent with local writes only. result: created, inPlace, or stop with reason.';

export const createStackBranchTool = (
  exec: Exec,
): ToolDefinition<typeof parameters, BranchResult> =>
  defineTool({
    name: 'stack_branch',
    label: 'Stack branch',
    description,
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, request, signal, _onUpdate, context) {
      const details = await createBranch({ exec, cwd: context.cwd, signal }, request);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
