import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { readConfigLocation } from '../../config/config.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { currentInboxPath, isUuid } from '../../inbox/inbox.js';
import { findTauRoot } from '../../tauDirectory.js';
import { answerLiveAsk } from './answer.js';
import type { AnswerResult, AnswerTracker } from './answer.js';
import { askArchitect } from './ask/ask.js';
import type { AskResult } from './ask/ask.js';
import { decideAskIntake, decideGateIntake } from './ask/askIntakeDecision.js';
import { runGate } from './gate.js';
import type { GateResult } from './gate.js';
import { createLiveAskOperations } from './liveAsk.js';
import type { LiveAskOperations } from './liveAsk.js';
import { openArchitect } from './open/open.js';
import type { OpenResult } from './open/open.js';
import { readGateRecord } from './record.js';

type ArchitectDetails =
  | ({ action: 'open' } & OpenResult)
  | ({ action: 'ask' } & AskResult)
  | ({ action: 'gate' } & GateResult);

type AnswerDetails = { action: 'answer' } & AnswerResult;

const parameters = Type.Object({
  action: Type.Union([Type.Literal('open'), Type.Literal('ask'), Type.Literal('gate')]),
  question: Type.Optional(Type.String({ description: 'ask: the question for the architect.' })),
  gate: Type.Optional(
    Type.String({
      description: 'ask: an uncertain gate record path.',
    }),
  ),
  askId: Type.Optional(Type.String()),
  request: Type.Optional(
    Type.String({ description: 'open, gate: the user request, in the user words.' }),
  ),
  restatement: Type.Optional(
    Type.String({ description: 'gate: what the lead understood the user to ask for.' }),
  ),
});

type ArchitectInput = Static<typeof parameters>;

const unsetWhenBlank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

const requireText = (name: string, value: string | undefined): string => {
  const text = unsetWhenBlank(value);

  if (text === undefined) {
    throw new Error(`${name} is required.`);
  }

  return text;
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

const runAsk = async (
  hc: HcRuntime,
  context: ExtensionToolContext,
  input: ArchitectInput,
  root: string,
  liveAsk: LiveAskOperations,
): Promise<AskResult> => {
  const leadSessionId = context.sessionManager.getSessionId();

  const ask = (question: string, gateRecord: string | null): Promise<AskResult> =>
    askArchitect({
      root,
      question,
      gateRecord,
      leadTerminal: leadTerminal(),
      leadSessionId,
      listenerPath: currentInboxPath(),
      location: readConfigLocation(root, {}, context),
      ui: context.ui,
      hc,
      liveAsk: liveAsk.ask,
    });

  const intake = decideAskIntake({
    askId: input.askId,
    question: input.question,
    gate: input.gate,
  });

  if (intake.kind === 'refusal') {
    throw new Error(intake.message);
  }

  if (intake.kind === 'retry') {
    return liveAsk.retry({ root, askId: requireAskId(intake.askId), leadSessionId, hc });
  }

  if (intake.kind === 'ask') {
    return ask(intake.question, intake.gateRecord);
  }

  const gate = decideGateIntake(intake.gate, await readGateRecord(root, intake.gate));

  if (gate.kind === 'refusal') {
    throw new Error(gate.message);
  }

  return ask(gate.question, gate.gateRecord);
};

const runAction = async (
  hc: HcRuntime,
  context: ExtensionToolContext,
  input: ArchitectInput,
  signal: AbortSignal | undefined,
  liveAsk: LiveAskOperations,
): Promise<ArchitectDetails> => {
  const root = await findTauRoot(context.cwd, 'architect');
  const location = readConfigLocation(root, {}, context);

  if (input.action === 'open') {
    rejectUnexpected(input, ['question', 'askId', 'restatement', 'gate']);

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

    return { action: 'ask', ...(await runAsk({ ...hc, signal }, context, input, root, liveAsk)) };
  }

  rejectUnexpected(input, ['question', 'askId', 'gate']);

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
): ToolDefinition<typeof parameters, ArchitectDetails> => {
  const liveAsk = createLiveAskOperations();

  return defineTool({
    name: 'architect',
    label: 'Architect',
    description: `- open: with request, starts or resumes it beside the lead. Returns {status, sessionFile, model} or {status: "running", terminal}; model is the started provider/model-id, or "unknown" when no terminal was reported. Send a live one the request with handover.
- ask: with question or gate, a gate record path. Live: {queued|unknown, askId, note}; follow note, retry unknown by askId. Else hidden: {askId, answer} or needsOpen. Refuses if busy.
- gate: classifies request and restatement. Returns {decision, label, confidence, recordPath}. Gate only a new request; an acceptance reply follows your offer. Follow specified; on open, open it; on uncertain, ask with gate = recordPath.`,
    promptSnippet: 'Open, ask, or gate the checkout architect.',
    parameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      signal?.throwIfAborted();

      const details = await runAction(hc, context, input, signal, liveAsk);

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
};

const answerParameters = Type.Object({
  action: Type.Literal('answer'),
  askId: Type.String(),
  file: Type.Optional(
    Type.String({
      description: 'omit only to resend after unknown.',
    }),
  ),
});

export const createArchitectAnswerTool = (
  hc: HcRuntime,
  answers: AnswerTracker,
): ToolDefinition<typeof answerParameters, AnswerDetails> =>
  defineTool({
    name: 'architect',
    label: 'Architect',
    description: `Answer an "Ask <askId> from the lead".
- answer: sends file to lead: {status: queued|unknown, askId, note}; follow note. Retry after a file error; after unknown, retry with no file. Tell the user only after a refusal.`,
    promptSnippet: 'Answer a lead question.',
    parameters: answerParameters,
    executionMode: 'sequential',
    async execute(_toolCallId, input, signal, _onUpdate, context) {
      signal?.throwIfAborted();

      const root = await findTauRoot(context.cwd, 'architect');

      const result = await answers.run(() =>
        answerLiveAsk({
          root,
          cwd: context.cwd,
          askId: requireAskId(input.askId),
          file: input.file,
          architectSessionId: context.sessionManager.getSessionId(),
          hc: { ...hc, signal },
          uncertainText: answers.uncertainText,
          recordDelivered: answers.recordDelivered,
          recordUncertain: answers.recordUncertain,
        }),
      );

      const details: AnswerDetails = { action: 'answer', ...result };

      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  });
