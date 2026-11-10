import { defineTool } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { Exec } from '../../command.js';
import { createBranch } from './branch.js';
import type { BranchResult } from './branch.js';

const positionalArgument = Type.String({ pattern: '^[^-]' });

const parameters = Type.Object({
  parent: positionalArgument,
  branch: positionalArgument,
  trunk: positionalArgument,
  remote: positionalArgument,
});

const description = 'Puts branch on parent with local writes.';

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
