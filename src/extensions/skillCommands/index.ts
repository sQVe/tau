import { fileURLToPath } from 'node:url';

import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const skillsDirectory = fileURLToPath(new URL('../../../skills/', import.meta.url));

const buildSkillMessage = (skillName: string, argumentsText: string) => {
  const prefix = `/skill:${skillName}`;
  const trimmedArguments = argumentsText.trim();

  return trimmedArguments ? `${prefix} ${trimmedArguments}` : prefix;
};

// Registers `/<name>` for each Tau skill, so skills stay reachable when Pi's `/skill:<name>`
// commands are disabled.
export default function skillCommandsExtension(pi: ExtensionAPI) {
  const { skills } = loadSkillsFromDir({ dir: skillsDirectory, source: 'tau' });

  for (const skill of skills) {
    pi.registerCommand(skill.name, {
      description: `Run the ${skill.name} skill.`,
      handler: (argumentsText, context) => {
        pi.sendUserMessage(buildSkillMessage(skill.name, argumentsText), {
          deliverAs: context.isIdle() ? 'followUp' : 'steer',
          expandPromptTemplates: true,
        });

        return Promise.resolve();
      },
    });
  }
}
