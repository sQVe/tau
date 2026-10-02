import type {
  SessionStartEvent,
  sessionEntryToContextMessages,
} from '@earendil-works/pi-coding-agent';

type ContextMessage = ReturnType<typeof sessionEntryToContextMessages>[number];

/**
 * On resume, fork, and reload, Pi fills history into its default editor before
 * session_start, and a replacement editor does not copy it. On startup and
 * tree navigation Pi fills the installed editor itself.
 */
export const refillsHistory = (reason: SessionStartEvent['reason']) =>
  reason === 'resume' || reason === 'fork' || reason === 'reload';

const userText = (message: ContextMessage) => {
  if (message.role !== 'user') {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
};

/** The text of each user message, oldest first, as Pi's `renderInitialMessages` adds it to history. */
export const sentPromptTexts = (messages: readonly ContextMessage[]): string[] =>
  messages.map((message) => userText(message)).filter((text) => text !== '');
