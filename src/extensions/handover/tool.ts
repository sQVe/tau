import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { HcRuntime } from '../../hc/hc.js';
import { ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';
import { sendHandover } from './send.js';
import type { SendHandoverRequest, SendHandoverResult } from './send.js';

interface PrepareDetails {
  directory: string;
}

type HandoverDetails = PrepareDetails | SendHandoverResult;

const parameters = Type.Object({
  action: Type.Union([Type.Literal('prepare'), Type.Literal('send')]),
  terminal: Type.Optional(
    Type.String({
      description: 'send: the hc terminal address or name that receives the handover.',
    }),
  ),
  file: Type.Optional(
    Type.String({
      description:
        'send: the handover file inside the directory that prepare returned. A relative path resolves against the working directory.',
    }),
  ),
});

type HandoverInput = Static<typeof parameters>;

const prepare = async (cwd: string): Promise<PrepareDetails> => {
  const root = await findTauRoot(cwd, 'handover');

  return { directory: await ensureTauDirectory(root, 'handovers') };
};

const sendRequest = (cwd: string, input: HandoverInput): SendHandoverRequest => {
  if (input.terminal === undefined) {
    throw new Error('send needs a terminal.');
  }

  if (input.file === undefined) {
    throw new Error('send needs a file.');
  }

  return { cwd, terminal: input.terminal, file: input.file };
};

const runAction = (hc: HcRuntime, cwd: string, input: HandoverInput): Promise<HandoverDetails> => {
  if (input.action === 'prepare') {
    return prepare(cwd);
  }

  return sendHandover(hc, sendRequest(cwd, input));
};

export const createHandoverTool = (
  hc: HcRuntime,
): ToolDefinition<typeof parameters, HandoverDetails> =>
  defineTool({
    name: 'handover',
    label: 'Handover',
    description: `Prepare a directory for a handover message, or send a prepared handover file.
- action prepare: creates .tau/handovers in the current checkout or bare repository root and ensures .tau/.gitignore ends with *. Returns {directory}, an absolute path. Reuses an existing directory.
- For a bare repository, uses the parent with a matching .git file, or the Git directory itself. Nested calls resolve to the same root.
- Errors: no Git repository, an unresolved bare Git directory, a symlink in the directory path or at .tau/.gitignore, a hard-linked .tau/.gitignore, a tracked destination or ignore file in a worktree, or an ignore exception after the last * in a bare root. In a worktree, prepare appends * after existing exceptions.
- action send: sends the text of the file to the terminal with hc send, which never forces or waits for the receiver's turn. Needs terminal (an hc address or name) and file (a file inside .tau/handovers from prepare). Returns {status, terminal, turn}. Status started means the receiver began its turn, notStarted means it did not, and blocked means hc refused because the terminal was busy; blocked returns no turn.
- Errors: a file outside .tau/handovers, a missing or empty file, the caller's own terminal by address or name, or any other hc error.`,
    promptSnippet:
      'Prepare the local directory for a handover message, or send a prepared handover file.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, _signal, _onUpdate, context) {
      const details = await runAction(hc, context.cwd, input);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
