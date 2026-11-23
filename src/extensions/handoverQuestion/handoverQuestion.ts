import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';

import { piExec } from '../../command.js';
import { lookupSender } from '../../handoverSender.js';
import { connect } from '../../hc/connect.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { setAcceptCheck } from '../../inbox/inbox.js';
import { currentRole } from '../../role/role.js';
import { handoverQuestionCheck } from './acceptCheck.js';
import { askSender, questionParameters, questionToolDescription } from './question/question.js';
import { senderMessages } from './senderMessages.js';

const branchOf = (
  sessionManager: ExtensionContext['sessionManager'] | undefined,
): readonly SessionEntry[] => (sessionManager === undefined ? [] : sessionManager.getBranch());

const senderOf = (context: ExtensionContext) =>
  lookupSender({
    // oxlint-disable-next-line node/no-process-env -- The sender environment is set for the active process.
    environment: process.env,
    messages: senderMessages(branchOf(context.sessionManager)),
  });

const registerQuestionTool = (pi: ExtensionAPI, hc: HcRuntime): void => {
  pi.registerTool({
    name: 'handover_question',
    exposure: 'model-only',
    label: 'Ask handover sender',
    description: questionToolDescription,
    promptSnippet: 'Ask the lead that sent this handover; the answer arrives as a new message.',
    parameters: questionParameters,
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
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

      return askSender({ hc, cwd: context.cwd, askerTerminal, askerSession, sender }, parameters);
    },
  });
};

export default function handoverQuestionExtension(pi: ExtensionAPI): void {
  setAcceptCheck('handover-question', handoverQuestionCheck);

  const hc: HcRuntime = { exec: piExec(pi), connect, cwd: process.cwd() };
  let registered = false;

  pi.on('before_agent_start', (_event, context) => {
    if (registered || currentRole() !== 'lead' || senderOf(context) === undefined) {
      return;
    }

    registered = true;
    registerQuestionTool(pi, hc);
  });
}
