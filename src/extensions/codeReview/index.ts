import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const codeReviewSkillCommandPrefix = '/skill:code-review';

const buildCodeReviewSkillMessage = (argumentsText: string) => {
  const trimmedArguments = argumentsText.trim();

  return trimmedArguments
    ? `${codeReviewSkillCommandPrefix} ${trimmedArguments}`
    : codeReviewSkillCommandPrefix;
};

export default function codeReviewExtension(pi: ExtensionAPI) {
  pi.registerCommand('code-review', {
    description: 'Run the code-review skill.',
    handler: (argumentsText, context) => {
      pi.sendUserMessage(buildCodeReviewSkillMessage(argumentsText), {
        deliverAs: context.isIdle() ? 'followUp' : 'steer',
        expandPromptTemplates: true,
      });

      return Promise.resolve();
    },
  });
}
