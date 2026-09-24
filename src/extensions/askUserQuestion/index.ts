import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { requireRegisteredTools } from '../../bundledTools/index.js';

const askUserQuestionTool = 'ask_user_question';

export default function askUserQuestionExtension(pi: ExtensionAPI) {
  requireRegisteredTools(pi, '@juicesharp/rpiv-ask-user-question', [askUserQuestionTool]);
}
