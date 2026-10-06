import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { findCheckoutRoot, readGitOutput } from '../../gitOutput.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

const parameters = Type.Object({ action: Type.Literal('prepare') });

const prepare = async (cwd: string) => {
  const bare = await readGitOutput(cwd, ['rev-parse', '--is-bare-repository']);
  const root = bare?.trim() === 'true' ? cwd : await findCheckoutRoot(cwd, 'handover');

  return { directory: await ensureTauDirectory(root, 'handovers') };
};

export const createHandoverTool = (): ToolDefinition<typeof parameters, { directory: string }> =>
  defineTool({
    name: 'handover',
    label: 'Handover',
    description: `Prepare a directory for a handover message.
- action prepare: creates .tau/handovers in the current checkout or bare repository root and ensures .tau/.gitignore ends with *. Returns {directory}, an absolute path. Reuses an existing directory.
- Errors: no Git repository, a symlink in the directory path or at .tau/.gitignore, a hard-linked .tau/.gitignore, a tracked destination or ignore file in a worktree, or an ignore exception after the last * in a bare root. In a worktree, prepare appends * after existing exceptions.`,
    promptSnippet: 'Prepare the local directory for a handover message.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, _parameters, _signal, _onUpdate, context) {
      const details = await prepare(context.cwd);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
