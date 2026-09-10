import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { requireRegisteredTools } from '../../bundledTools/index.js';

export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

export default function askUserQuestionExtension(extensionApi: ExtensionAPI) {
  requireRegisteredTools(extensionApi, '@juicesharp/rpiv-ask-user-question', [
    ASK_USER_QUESTION_TOOL,
  ]);
}
