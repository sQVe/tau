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
        'send: the handover file in the prepared directory. A relative path resolves against the working directory.',
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
    description: `Prepare and send handover messages.
- action prepare: creates .tau/handovers in the current checkout or bare repository root and ensures .tau/.gitignore ends with *. Returns {directory}, an absolute path. Reuses an existing directory.
- For a bare repository, uses the parent with a matching .git file, or the Git directory itself. Nested calls resolve to the same root.
- Errors: no Git repository, an unresolved bare Git directory, a symlink in the directory path or at .tau/.gitignore, a hard-linked .tau/.gitignore, a tracked destination or ignore file in a worktree, or an ignore exception after the last * in a bare root. In a worktree, prepare appends * after existing exceptions.
- action send: sends the file's text to terminal with hc send, never forced or waiting. Needs terminal (hc address or name) and file (from prepare). Returns {status, terminal, turn}: started, notStarted, or blocked (the receiver waits on its user; no turn).
- Send errors: a file outside .tau/handovers, a missing or empty file, your own terminal, or another hc error.`,
    promptSnippet: 'Prepare and send handover messages.',
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
