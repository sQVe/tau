import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  CustomMessageEntryDraft,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import { currentRole } from '../../role/role.js';
import { decideHandBack } from './handBackDecision.js';

type ContextMessage = AgentBeforeSettleEvent['context']['contextMessages'][number];
type AssistantMessage = Extract<ContextMessage, { role: 'assistant' }>;

const reminder: CustomMessageEntryDraft = {
  type: 'custom_message',
  customType: 'tau-lead-hand-back-reminder',
  content: [
    'Your turn ended asking the user to approve or do a step.',
    'If your finished work settled that step and you can do it, do it now.',
    'If it needs a real decision or approval for an outward action, ask with ask_user_question.',
    'Otherwise end the turn.',
  ].join(' '),
  display: true,
};

const messageText = (message: AssistantMessage): string => {
  const texts = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));

  return texts.join('\n');
};

const finalAssistantText = (event: AgentBeforeSettleEvent): string => {
  const message = event.context.contextMessages.findLast(
    (entry): entry is AssistantMessage => entry.role === 'assistant',
  );

  return message === undefined ? '' : messageText(message);
};

export const registerHandBackReminder = (pi: ExtensionAPI): void => {
  let reminded = false;

  pi.on('message_start', (event) => {
    if (event.message.role === 'user') {
      reminded = false;
    }
  });

  pi.on('agent_before_settle', (event): AgentBeforeSettleEventResult | undefined => {
    const decision = decideHandBack({
      role: currentRole(),
      finalText: finalAssistantText(event),
      outcome: event.outcome,
      reminded,
    });

    if (decision.kind === 'settle') {
      return undefined;
    }

    reminded = true;

    return { entries: [...event.entries, reminder], continue: true };
  });
};
