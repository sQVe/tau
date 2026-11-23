import { isAbsolute } from 'node:path';

import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { resolveAllowedModel } from '../../config/models.js';
import { isBareRootWithoutGitEntry } from '../../git.js';
import { senderOf } from '../../handoverSender.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { PiStartTarget } from '../../piStart/piStart.js';
import { currentRole } from '../../role/role.js';
import { ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';
import { sendHandover } from './send.js';
import type { SendHandoverRequest, SendHandoverResult } from './send.js';
import { startHandover } from './start.js';
import type { StartHandoverRequest, StartHandoverResult } from './start.js';

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
      description: 'start: herdr-app space ID where the new Pi runs. Omit it to use name.',
    }),
  ),
  name: Type.Optional(Type.String({ description: 'start without space: name of the new space.' })),
  model: Type.Optional(
    Type.String({
      description: "start: the new Pi's model as provider/model-id. Omit it for the default model.",
    }),
  ),
  final: Type.Optional(
    Type.Boolean({
      description:
        "send: true for the architect's last handover to the lead. The architect session closes after it is queued.",
    }),
  ),
  messageId: Type.Optional(
    Type.String({
      description: 'send retry: messageId of an unknown result.',
    }),
  ),
  sessionId: Type.Optional(Type.String({ description: 'send retry: its sessionId.' })),
});

type HandoverInput = Static<typeof parameters>;

const prepare = async (cwd: string): Promise<PrepareDetails> => {
  const root = await findTauRoot(cwd, 'handover');

  return { directory: await ensureTauDirectory(root, 'handovers') };
};

const sessionIdOf = (
  sessionManager: ExtensionToolContext['sessionManager'],
): string | undefined => {
  try {
    const sessionId = sessionManager.getSessionId();

    return sessionId === '' ? undefined : sessionId;
  } catch {
    return undefined;
  }
};

const sendRequest = (context: ExtensionToolContext, input: HandoverInput): SendHandoverRequest => {
  if (input.terminal === undefined) {
    throw new Error('send needs a terminal.');
  }

  if (input.file === undefined) {
    throw new Error('send needs a file.');
  }

  if (input.messageId !== undefined && input.sessionId === undefined) {
    throw new Error('A send retry needs the sessionId of its unknown result.');
  }

  const sender = senderOf({
    role: currentRole(),
    terminal: currentTerminalAddress(),
    sessionId: sessionIdOf(context.sessionManager),
  });

  return {
    cwd: context.cwd,
    terminal: input.terminal,
    file: input.file,
    sender,
    messageId: input.messageId,
    sessionId: input.sessionId,
  };
};

const startTarget = (input: HandoverInput): PiStartTarget => {
  if (input.space !== undefined) {
    return { space: input.space };
  }

  if (input.name === undefined) {
    throw new Error('start needs a name when it has no space.');
  }

  return { name: input.name };
};

const startRequest = (
  context: ExtensionToolContext,
  input: HandoverInput,
): Omit<StartHandoverRequest, 'bareRoot'> => {
  if (input.model !== undefined) {
    resolveAllowedModel(context, input.model);
  }

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
    cwd: context.cwd,
    file: input.file,
    folder: input.folder,
    target: startTarget(input),
    model: input.model,
  };
};

const runAction = async (
  hc: HcRuntime,
  context: ExtensionToolContext,
  input: HandoverInput,
): Promise<HandoverDetails> => {
  if (input.action !== 'start' && input.model !== undefined) {
    throw new Error('model is only for action start.');
  }

  if (input.action !== 'send' && input.final !== undefined) {
    throw new Error('final is only for action send.');
  }

  if (input.action === 'prepare') {
    return prepare(context.cwd);
  }

  if (input.action === 'start') {
    const request = startRequest(context, input);

    return startHandover(hc, {
      ...request,
      bareRoot: await isBareRootWithoutGitEntry(request.folder),
    });
  }

  return sendHandover(hc, sendRequest(context, input));
};

export const createHandoverTool = (
  hc: HcRuntime,
): ToolDefinition<typeof parameters, HandoverDetails> =>
  defineTool({
    name: 'handover',
    label: 'Handover',
    description: `Prepare, send, and start handover messages.
- action prepare: creates .tau/handovers in the checkout or bare repository root. Returns {directory}, an absolute path. Reuses an existing directory.
- action send: sends the file's text to the inbox of the Pi session at terminal (hc address or name). Needs file (from prepare). final: true marks the architect's last handover; the architect closes after it is queued. Returns {status, terminal, sessionId, messageId}.
  - queued: saved and shown once. Never resend it.
  - unknown: it may be saved; see note. Retry with the same file, messageId, and sessionId.
  - An error ending "Nothing was queued." is a refusal.
- action start: starts Pi with the file's text as its task. Needs file and folder, plus space or name. Pass model as provider/model-id to run the new Pi on another model. Returns {reply}, herdr-app's output.`,
    promptSnippet: 'Prepare, send, and start handover messages.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      signal?.throwIfAborted();

      const details = await runAction({ ...hc, signal }, context, input);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
