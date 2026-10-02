import { readFileSync } from 'node:fs';

import { loadSkillsFromDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ResourceDiagnostic, Skill } from '@earendil-works/pi-coding-agent';

import { appendSystemPrompt } from '../../systemPrompt.js';
import { isWorkerProcess } from '../../workerProcess.js';
import { requiredActions } from './requiredFor.js';

const buildSkillMessage = (skillName: string, argumentsText: string) => {
  const prefix = `/skill:${skillName}`;
  const trimmedArguments = argumentsText.trim();

  return trimmedArguments ? `${prefix} ${trimmedArguments}` : prefix;
};

// Registers `/<name>` for each Tau skill, so skills stay reachable when Pi's `/skill:<name>`
// commands are disabled.
const registerSkillCommands = (pi: ExtensionAPI, skills: readonly Skill[]) => {
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
};

// Pi's `Skill` drops custom frontmatter fields, so read them from the skill file.
const readFrontmatter = (filePath: string) => {
  const content = readFileSync(filePath, 'utf8');

  return parseFrontmatter(content).frontmatter;
};

const readRequiredForLines = (skills: readonly Skill[]) => {
  const actions = requiredActions(
    skills.map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
      frontmatter: readFrontmatter(skill.filePath),
    })),
  );

  return actions.map(({ name, action }) => `Use the \`${name}\` skill whenever you are ${action}.`);
};

// Pi skips a skill it cannot parse and only warns, which would silently drop its rules.
const rejectSkillProblems = (
  skillsDirectory: string,
  diagnostics: readonly ResourceDiagnostic[],
) => {
  if (diagnostics.length === 0) {
    return;
  }

  const problems = diagnostics.map(
    (diagnostic) => `${diagnostic.path ?? skillsDirectory}: ${diagnostic.message}`,
  );

  throw new Error(`Tau skills failed to load:\n${problems.join('\n')}`);
};

export default function tauSkillsExtension(pi: ExtensionAPI, skillsDirectory: string) {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDirectory, source: 'tau' });

  rejectSkillProblems(skillsDirectory, diagnostics);

  const lines = readRequiredForLines(skills);

  registerSkillCommands(pi, skills);

  // Workers load only the skills their profile names, so the lines could name a missing skill.
  if (isWorkerProcess() || lines.length === 0) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, lines.join('\n'));
  });
}
