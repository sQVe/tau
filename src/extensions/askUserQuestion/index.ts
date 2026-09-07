import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

export default function askUserQuestionExtension(pi: ExtensionAPI) {
  pi.on('session_start', () => {
    if (!pi.getActiveTools().includes(ASK_USER_QUESTION_TOOL)) {
      throw new Error(
        `Tool "${ASK_USER_QUESTION_TOOL}" is not registered. The bundled package @juicesharp/rpiv-ask-user-question failed to load; reinstall Tau.`,
      );
    }
  });
}
