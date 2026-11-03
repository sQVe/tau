import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isWorkerProcess } from '../../worker.js';
import { buildSkillMessage, loadSkillCatalog } from './skillCatalog.js';

export default function tauSkillsExtension(pi: ExtensionAPI, skillsDirectory: string): void {
  const { commands, requiredForLines } = loadSkillCatalog(skillsDirectory);

  for (const command of commands) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: (argumentsText, context) => {
        pi.sendUserMessage(buildSkillMessage(command.name, argumentsText), {
          deliverAs: context.isIdle() ? 'followUp' : 'steer',
          expandPromptTemplates: true,
        });

        return Promise.resolve();
      },
    });
  }

  // Workers load only the skills their profile names, so the lines could name a missing skill.
  if (isWorkerProcess() || requiredForLines.length === 0) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, requiredForLines.join('\n'));
  });
}
