import { isAbsolute } from 'node:path';

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { HcRuntime } from '../../hc/hc.js';
import { ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';
import { sendHandover } from './send.js';
import type { SendHandoverRequest, SendHandoverResult } from './send.js';
import { startHandover } from './start.js';
import type { StartHandoverRequest, StartHandoverResult, StartHandoverTarget } from './start.js';

interface PrepareDetails {
  directory: string;
}

type HandoverDetails = PrepareDetails | SendHandoverResult | StartHandoverResult;

const parameters = Type.Object({
  action: Type.Union([Type.Literal('prepare'), Type.Literal('send'), Type.Literal('start')]),
  terminal: Type.Optional(
    Type.String({
      description: 'send: the hc terminal address or name that receives the handover.',
    }),
  ),
  file: Type.Optional(
    Type.String({
      description:
        'send, start: the handover file in the prepared directory. A relative path resolves against the working directory.',
    }),
  ),
  folder: Type.Optional(
    Type.String({
      description: 'start: absolute path of the checkout the new Pi runs in.',
    }),
  ),
  space: Type.Optional(
    Type.String({
      description: 'start: herdr-app space ID that gets the new Pi tab. Omit it to use name.',
    }),
  ),
  name: Type.Optional(Type.String({ description: 'start without space: name of the new space.' })),
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

const startTarget = (input: HandoverInput): StartHandoverTarget => {
  if (input.space !== undefined) {
    return { space: input.space };
  }

  if (input.name === undefined) {
    throw new Error('start needs a name when it has no space.');
  }

  return { name: input.name };
};

const startRequest = (cwd: string, input: HandoverInput): StartHandoverRequest => {
  if (input.file === undefined) {
    throw new Error('start needs a file.');
  }

  if (input.folder === undefined) {
    throw new Error('start needs a folder.');
  }

  if (!isAbsolute(input.folder)) {
    throw new Error(`start needs an absolute folder: ${JSON.stringify(input.folder)}.`);
  }

  return {
    cwd,
    file: input.file,
    folder: input.folder,
    target: startTarget(input),
  };
};

const runAction = (hc: HcRuntime, cwd: string, input: HandoverInput): Promise<HandoverDetails> => {
  if (input.action === 'prepare') {
    return prepare(cwd);
  }

  if (input.action === 'start') {
    return startHandover(hc, startRequest(cwd, input));
  }

  return sendHandover(hc, sendRequest(cwd, input));
};

export const createHandoverTool = (
  hc: HcRuntime,
): ToolDefinition<typeof parameters, HandoverDetails> =>
  defineTool({
    name: 'handover',
    label: 'Handover',
    description: `Prepare, send, and start handover messages.
- action prepare: creates .tau/handovers in the checkout or bare repository root. Returns {directory}, an absolute path. Reuses an existing directory.
- action send: queues a copy of the file's current text in the inbox of the Pi session at terminal. Needs terminal (hc address or name) and file (from prepare). Returns {status: queued, terminal, messageId}. Queued means the message waits in the receiver's inbox; it is not a delivery receipt. Throws when the receiver is not listening; nothing is queued then.
- action start: opens a Pi tab with the file's text as its task. Needs file and folder, plus space or name. Returns {reply}, herdr-app's output.`,
    promptSnippet: 'Prepare, send, and start handover messages.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      signal?.throwIfAborted();

      const details = await runAction({ ...hc, signal }, context.cwd, input);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
