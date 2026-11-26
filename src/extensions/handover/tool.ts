import { isAbsolute } from 'node:path';

import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { resolveAllowedModel } from '../../config/models.js';
import { isBareRootWithoutGitEntry } from '../../git.js';
import { senderOf } from '../../handoverSender.js';
import type { HandoverSender } from '../../handoverSender.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { currentRole } from '../../role/role.js';
import { ensureTauDirectory, findTauRoot } from '../../tauDirectory.js';
import type { SpaceChoice } from './placement.js';
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
      description: 'start: space ID to reuse. Opens a tab there and leaves its panes alone.',
    }),
  ),
  newSpace: Type.Optional(
    Type.Boolean({
      description:
        'start: true creates another space even when the folder has one. Not with space.',
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        'start: short title of the work, about 40 characters. Names the tab as lead: <name> and any space it creates.',
    }),
  ),
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

const currentSender = (context: ExtensionToolContext): HandoverSender | undefined =>
  senderOf({
    role: currentRole(),
    terminal: currentTerminalAddress(),
    sessionId: sessionIdOf(context.sessionManager),
  });

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

  const sender = currentSender(context);

  return {
    cwd: context.cwd,
    terminal: input.terminal,
    file: input.file,
    sender,
    messageId: input.messageId,
    sessionId: input.sessionId,
  };
};

const spaceChoiceOf = (input: HandoverInput): SpaceChoice => {
  if (input.space !== undefined) {
    return { kind: 'reuse', space: input.space };
  }

  if (input.newSpace === true) {
    return { kind: 'create' };
  }

  return { kind: 'decide' };
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

  const name = input.name;

  if (name === undefined || name.trim() === '') {
    throw new Error('start needs a name: a short title of the work.');
  }

  return {
    cwd: context.cwd,
    file: input.file,
    folder: input.folder,
    spaceChoice: spaceChoiceOf(input),
    title: name,
    model: input.model,
    sender: currentSender(context),
  };
};

const rejectMisplacedOptions = (input: HandoverInput): void => {
  if (input.action !== 'start' && input.model !== undefined) {
    throw new Error('model is only for action start.');
  }

  if (input.action !== 'send' && input.final !== undefined) {
    throw new Error('final is only for action send.');
  }

  if (input.action !== 'start' && input.newSpace !== undefined) {
    throw new Error('newSpace is only for action start.');
  }

  if (input.action !== 'start' && input.space !== undefined) {
    throw new Error('space is only for action start.');
  }
};

const rejectExclusiveSpaceOptions = (input: HandoverInput): void => {
  if (input.space !== undefined && input.newSpace === true) {
    throw new Error('space and newSpace cannot be used together: pass one of them.');
  }
};

const runAction = async (
  hc: HcRuntime,
  context: ExtensionToolContext,
  input: HandoverInput,
): Promise<HandoverDetails> => {
  rejectMisplacedOptions(input);
  rejectExclusiveSpaceOptions(input);

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
- action start: starts Pi with the file's text as its task. Needs file, folder, and name. Without space or newSpace: true, it lists herdr-app's spaces and refuses when the folder already has one on this computer, naming each. Pass model as provider/model-id to run the new Pi on another model. Returns {space, tab, terminal, model, spaceStatus, reply}, where spaceStatus is created or reused, model is read from the started process arguments as provider/model-id, default if absent, and reply is herdr-app's output.`,
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
