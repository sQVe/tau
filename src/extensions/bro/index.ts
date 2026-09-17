import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const broSkillCommandPrefix = '/skill:bro';

const buildBroSkillMessage = (argumentsText: string) => {
  const trimmedArguments = argumentsText.trim();

  return trimmedArguments ? `${broSkillCommandPrefix} ${trimmedArguments}` : broSkillCommandPrefix;
};

export default function broExtension(pi: ExtensionAPI) {
  pi.registerCommand('bro', {
    description: 'Run the bro skill.',
    handler: (argumentsText, context) => {
      pi.sendUserMessage(buildBroSkillMessage(argumentsText), {
        deliverAs: context.isIdle() ? 'followUp' : 'steer',
        expandPromptTemplates: true,
      });

      return Promise.resolve();
    },
  });
}
