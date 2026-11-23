import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import type { HandoverSender } from '../../handoverSender.js';
import { lookupSender } from '../../handoverSender.js';
import { connect } from '../../hc/connect.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { setAcceptCheck } from '../../inbox/inbox.js';
import { currentRole } from '../../role/role.js';
import { handoverQuestionCheck } from './acceptCheck.js';
import { handoverAnswerCheck } from './answer/answerCheck.js';
import { askSender, questionParameters, questionToolDescription } from './question/question.js';
import { handoverMessageText, senderMessages } from './senderMessages.js';

const senderFrom = (messages: string[]): HandoverSender | undefined =>
  lookupSender({
    // oxlint-disable-next-line node/no-process-env -- The sender environment is set for the active process.
    environment: process.env,
    messages,
  });

const senderOf = (context: ExtensionContext): HandoverSender | undefined =>
  senderFrom(senderMessages(context.sessionManager.getBranch()));

const senderAtStart = (
  context: ExtensionContext,
  event: BeforeAgentStartEvent,
): HandoverSender | undefined => {
  const eventText = event.messageType === 'custom' ? handoverMessageText(event.message) : undefined;
  const messages = senderMessages(context.sessionManager.getBranch());
  const withEventText = eventText === undefined ? messages : [...messages, eventText];

  return senderFrom(withEventText);
};

const registerQuestionTool = (pi: ExtensionAPI, hc: HcRuntime): void => {
  pi.registerTool({
    name: 'handover_question',
    exposure: 'model-only',
    label: 'Ask handover sender',
    description: questionToolDescription,
    promptSnippet: 'Ask the lead that sent this handover; the answer arrives as a new message.',
    parameters: questionParameters,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const sender = senderOf(context);

      if (sender === undefined) {
        throw new Error('This session has no handover sender to ask.');
      }

      const askerTerminal = currentTerminalAddress();

      if (askerTerminal === undefined) {
        throw new Error('This session has no terminal address to ask from.');
      }

      const askerSession = context.sessionManager.getSessionId();

      if (askerSession === '') {
        throw new Error('This session has no saved Pi session ID to ask from.');
      }

      return askSender(
        { hc: { ...hc, signal }, cwd: context.cwd, askerTerminal, askerSession, sender },
        parameters,
      );
    },
  });
};

export default function handoverQuestionExtension(pi: ExtensionAPI): void {
  let sessionDirectory: string | undefined;

  setAcceptCheck('handover-question', handoverQuestionCheck);

  setAcceptCheck(
    'handover-answer',
    handoverAnswerCheck(() => sessionDirectory),
  );

  pi.on('session_start', (_event, context) => {
    sessionDirectory = context.cwd;
  });

  const hc: HcRuntime = { exec: piExec(pi), connect, cwd: process.cwd() };
  let registered = false;

  pi.on('before_agent_start', (event, context) => {
    const sender = senderAtStart(context, event);

    if (registered || currentRole() !== 'lead' || sender === undefined) {
      return;
    }

    registered = true;
    registerQuestionTool(pi, hc);
  });
}
