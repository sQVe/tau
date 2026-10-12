import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';

const parameters = Type.Object({ action: Type.Literal('prepare'), id: Type.String() });

const idPattern = /^[a-z0-9][a-z0-9-]*$/;

const prepare = async (cwd: string, id: unknown) => {
  if (typeof id !== 'string' || !idPattern.test(id)) {
    throw new Error(
      `Invalid id ${JSON.stringify(id)}: use lower-case letters, digits, and hyphens.`,
    );
  }

  const root = await findTauRoot(cwd, 'tracker_draft');

  return { directory: await ensureTauDirectory(root, `tickets/${id}`) };
};

export const createTrackerDraftTool = (): ToolDefinition<
  typeof parameters,
  { directory: string }
> =>
  defineTool({
    name: 'tracker_draft',
    label: 'Tracker draft',
    description: `Prepare a directory that holds a ticket draft.
- action prepare with id: creates .tau/tickets/<id> in the current checkout or bare repository root and ensures .tau/.gitignore ends with *. Returns {directory}, an absolute path. Reuses an existing directory and keeps its files.
- id matches ^[a-z0-9][a-z0-9-]*$, such as a lower-case ticket identifier (me-600) or a slug of the title. Nested calls resolve to the same root.
- Errors: a missing or invalid id (nothing is created), no Git repository, an unresolved bare Git directory, a symlink in the directory path, a hard-linked .tau/.gitignore, or a tracked destination or ignore file in a worktree.
- Writes nothing to the tracker.`,
    promptSnippet: 'Prepare the local directory for a ticket draft.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, toolParameters, _signal, _onUpdate, context) {
      const details = await prepare(context.cwd, toolParameters.id);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
