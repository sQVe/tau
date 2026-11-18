import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { readConfigLocation } from '../../config/config.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { isUuid } from '../../inbox/inbox.js';
import { findTauRoot } from '../../tauDirectory.js';
import { answerLiveAsk } from './answer.js';
import type { AnswerResult } from './answer.js';
import { askArchitect } from './ask/ask.js';
import type { AskResult } from './ask/ask.js';
import { runGate } from './gate.js';
import type { GateResult } from './gate.js';
import { retryLiveAsk } from './liveAsk.js';
import { openArchitect } from './open/open.js';
import type { OpenResult } from './open/open.js';

type ArchitectDetails =
  | ({ action: 'open' } & OpenResult)
  | ({ action: 'ask' } & AskResult)
  | ({ action: 'gate' } & GateResult);

type AnswerDetails = { action: 'answer' } & AnswerResult;

const parameters = Type.Object({
  action: Type.Union([Type.Literal('open'), Type.Literal('ask'), Type.Literal('gate')]),
  question: Type.Optional(Type.String({ description: 'ask: the question for the architect.' })),
  askId: Type.Optional(Type.String({ description: 'ask: retry an unknown ask by askId.' })),
  request: Type.Optional(
    Type.String({ description: 'open, gate: the user request, in the user words.' }),
  ),
  restatement: Type.Optional(
    Type.String({ description: 'gate: what the lead understood the user to ask for.' }),
  ),
});

type ArchitectInput = Static<typeof parameters>;

const requireText = (name: string, value: string | undefined): string => {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const rejectUnexpected = (input: ArchitectInput, names: readonly (keyof ArchitectInput)[]) => {
  const present = names.filter((name) => input[name] !== undefined);

  if (present.length > 0) {
    throw new Error(`action ${input.action} does not take ${present.join(', ')}.`);
  }
};

const requireAskId = (value: string): string => {
  if (!isUuid(value)) {
    throw new Error(`askId is not a UUID: ${value}`);
  }

  return value;
};

const leadTerminal = (): string => {
  const address = currentTerminalAddress();

  if (address === undefined) {
    throw new Error('The architect tool requires HC_TERMINAL_ID. Start Tau inside an hc terminal.');
  }

  return address;
};

const runAsk = (
  hc: HcRuntime,
  context: ExtensionToolContext,
  input: ArchitectInput,
  root: string,
): Promise<AskResult> => {
  const leadSessionId = context.sessionManager.getSessionId();

  if (input.askId !== undefined) {
    if (input.question !== undefined) {
      throw new Error('action ask with askId does not take question.');
    }

    return retryLiveAsk({ root, askId: requireAskId(input.askId), leadSessionId, hc });
  }

  return askArchitect({
    root,
    question: requireText('question', input.question),
    leadTerminal: leadTerminal(),
    leadSessionId,
    location: readConfigLocation(root, {}, context),
    ui: context.ui,
    hc,
  });
};

const runAction = async (
  hc: HcRuntime,
  context: ExtensionToolContext,
  input: ArchitectInput,
  signal: AbortSignal | undefined,
): Promise<ArchitectDetails> => {
  const root = await findTauRoot(context.cwd, 'architect');
  const location = readConfigLocation(root, {}, context);

  if (input.action === 'open') {
    rejectUnexpected(input, ['question', 'askId', 'restatement']);

    return {
      action: 'open',
      ...(await openArchitect({
        root,
        leadTerminal: leadTerminal(),
        request: requireText('request', input.request),
        location,
        ui: context.ui,
        hc: { ...hc, signal },
      })),
    };
  }

  if (input.action === 'ask') {
    rejectUnexpected(input, ['request', 'restatement']);

    return { action: 'ask', ...(await runAsk({ ...hc, signal }, context, input, root)) };
  }

  rejectUnexpected(input, ['question', 'askId']);

  return {
    action: 'gate',
    ...(await runGate({
      root,
      request: requireText('request', input.request),
      restatement: requireText('restatement', input.restatement),
      location,
      context,
      signal,
    })),
  };
};

export const createArchitectTool = (
  hc: HcRuntime,
): ToolDefinition<typeof parameters, ArchitectDetails> =>
  defineTool({
    name: 'architect',
    label: 'Architect',
    description: `Open, ask, or gate the checkout's architect.
- action open: with request, starts the architect in a pane beside the lead, or resumes its recorded session. Returns {status, sessionFile}, or {status: "running", terminal} for a live architect; send it the request with handover. Refuses while another architect holds the lock.
- action ask: if the architect is live here, queues question in its inbox: {status: "queued", askId, note} or {status: "unknown", askId, note}; retry an unknown ask with askId. Follow the note. Refuses while a hidden ask runs, or when a live architect in another checkout holds the lock. Else resumes it hidden: {status, askId, answer} or {status: "needsOpen"}.
- action gate: classifies request and restatement with typesafe/jev-latest. Returns {decision, label, confidence, recordPath}. Follow specified; on open, call architect open; on uncertain, ask the user whether to brief a worker or open the architect.
Every gate call writes a record under .tau/lead/gate.`,
    promptSnippet: 'Open, ask, or gate the checkout architect.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      signal?.throwIfAborted();

      const details = await runAction(hc, context, input, signal);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });

const answerParameters = Type.Object({
  action: Type.Literal('answer'),
  askId: Type.String(),
  file: Type.String(),
});

export const createArchitectAnswerTool = (
  hc: HcRuntime,
): ToolDefinition<typeof answerParameters, AnswerDetails> =>
  defineTool({
    name: 'architect',
    label: 'Architect',
    description: `Answer a lead question "Ask <askId> from the lead".
- action answer: sends file to the lead session that asked. Returns {status: "queued" or "unknown", askId, note}. Follow the note. An error means nothing was queued: tell the user.`,
    promptSnippet: 'Answer a lead question with its askId.',
    parameters: answerParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      signal?.throwIfAborted();

      const root = await findTauRoot(context.cwd, 'architect');

      const result = await answerLiveAsk({
        root,
        cwd: context.cwd,
        askId: requireAskId(input.askId),
        file: input.file,
        architectSessionId: context.sessionManager.getSessionId(),
        hc: { ...hc, signal },
      });

      const details: AnswerDetails = { action: 'answer', ...result };

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
