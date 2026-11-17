import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { readConfigLocation } from '../../config/config.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { findTauRoot } from '../../tauDirectory.js';
import { askArchitect } from './ask.js';
import type { AskResult } from './ask.js';
import { runGate } from './gate.js';
import type { GateResult } from './gate.js';
import { openArchitect } from './open.js';
import type { OpenResult } from './open.js';

type ArchitectDetails =
  | ({ action: 'open' } & OpenResult)
  | ({ action: 'ask' } & AskResult)
  | ({ action: 'gate' } & GateResult);

const parameters = Type.Object({
  action: Type.Union([Type.Literal('open'), Type.Literal('ask'), Type.Literal('gate')]),
  question: Type.Optional(Type.String({ description: 'ask: the question for the architect.' })),
  request: Type.Optional(
    Type.String({ description: 'gate: the user request, in the user words.' }),
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

const leadTerminal = (): string => {
  const address = currentTerminalAddress();

  if (address === undefined) {
    throw new Error('The architect tool requires HC_TERMINAL_ID. Start Tau inside an hc terminal.');
  }

  return address;
};

const runAction = async (
  hc: HcRuntime,
  context: ExtensionToolContext,
  input: ArchitectInput,
  signal: AbortSignal | undefined,
): Promise<ArchitectDetails> => {
  const root = await findTauRoot(context.cwd, 'architect');
  const location = readConfigLocation(root, {}, context);
  const runtime = { exec: hc.exec, cwd: hc.cwd, signal };

  if (input.action === 'open') {
    rejectUnexpected(input, ['question', 'request', 'restatement']);

    return {
      action: 'open',
      ...(await openArchitect({
        root,
        leadTerminal: leadTerminal(),
        location,
        ui: context.ui,
        runtime,
      })),
    };
  }

  if (input.action === 'ask') {
    rejectUnexpected(input, ['request', 'restatement']);

    return {
      action: 'ask',
      ...(await askArchitect({
        root,
        question: requireText('question', input.question),
        leadTerminal: leadTerminal(),
        location,
        ui: context.ui,
        hc: { ...hc, signal },
      })),
    };
  }

  rejectUnexpected(input, ['question']);

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
- action open: starts the architect in a herdr-app tab, or resumes its recorded session. Refuses while a live architect runs. Returns {status, sessionFile}.
- action ask: resumes the architect in a hidden terminal with question. The answer reaches your inbox. Refuses while an architect runs or another ask is live. A deadline returns {status: "needsOpen"}; call open instead.
- action gate: classifies request and restatement with typesafe/jev-latest. Returns {decision, label, confidence, recordPath}. Follow specified only when confidence is at least 0.7; every other outcome is open, so ask the user whether to brief a worker or open the architect.
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
