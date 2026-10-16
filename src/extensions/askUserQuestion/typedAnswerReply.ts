import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { branchFacts } from './branchFacts.js';
import { decideTypedAnswerReply } from './typedAnswerGuard.js';

export const refuseUnrepliedTypedAnswer = (
  sessionManager: ExtensionContext['sessionManager'],
): void => {
  const decision = decideTypedAnswerReply(branchFacts(sessionManager.getBranch()));

  if (decision.kind === 'refuse') {
    throw new Error(
      "The user's last answer was typed text, and you have not replied to it in visible text. Write the reply to the typed answer as visible text, then end your turn. Do not call ask_user_question in the same message.",
    );
  }
};
