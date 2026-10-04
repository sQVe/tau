import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isToolCallEventType,
  loadSkillsFromDir,
  parseFrontmatter,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ResourceDiagnostic, Skill } from '@earendil-works/pi-coding-agent';

import { resolveReadPath } from '../../readPath.js';
import { appendSystemPrompt } from '../../systemPrompt.js';
import { isWorkerProcess } from '../../workerProcess.js';
import { requiredActions } from './requiredFor.js';

type SkillTools = Readonly<Record<string, readonly string[]>>;

const buildSkillMessage = (skillName: string, argumentsText: string) => {
  const prefix = `/skill:${skillName}`;
  const trimmedArguments = argumentsText.trim();

  return trimmedArguments ? `${prefix} ${trimmedArguments}` : prefix;
};

// Pi reads the active tools again before each model request, so a tool turned on here is
// callable on the next request, even in the middle of a run.
const activateTools = (pi: ExtensionAPI, toolNames: readonly string[]) => {
  const active = pi.getActiveTools();
  const missing = toolNames.filter((name) => !active.includes(name));

  if (missing.length === 0) {
    return;
  }

  pi.setActiveTools([...active, ...missing]);
};

// Registers `/<name>` for each Tau skill, so skills stay reachable when Pi's `/skill:<name>`
// commands are disabled.
const registerSkillCommands = (
  pi: ExtensionAPI,
  skills: readonly Skill[],
  skillTools: SkillTools,
) => {
  for (const skill of skills) {
    pi.registerCommand(skill.name, {
      description: `Run the ${skill.name} skill.`,
      handler: (argumentsText, context) => {
        const toolNames = skillTools[skill.name];

        if (toolNames !== undefined) {
          activateTools(pi, toolNames);
        }

        pi.sendUserMessage(buildSkillMessage(skill.name, argumentsText), {
          deliverAs: context.isIdle() ? 'followUp' : 'steer',
          expandPromptTemplates: true,
        });

        return Promise.resolve();
      },
    });
  }
};

// A path that cannot resolve, such as a file URL with a host, names no skill. The read tool reports
// the error itself.
const resolveSkillFile = (cwd: string, path: string) => {
  try {
    return resolveReadPath(cwd, path);
  } catch {
    return undefined;
  }
};

// The model runs a skill listed in the system prompt by reading its SKILL.md.
const registerSkillReadActivation = (
  pi: ExtensionAPI,
  skills: readonly Skill[],
  skillTools: SkillTools,
) => {
  const toolsBySkillFile = new Map(
    skills.flatMap((skill) => {
      const toolNames = skillTools[skill.name];

      return toolNames === undefined ? [] : [[resolve(skill.filePath), toolNames] as const];
    }),
  );

  if (toolsBySkillFile.size === 0) {
    return;
  }

  pi.on('tool_call', (event, context) => {
    if (!isToolCallEventType('read', event)) {
      return;
    }

    const skillFile = resolveSkillFile(context.cwd, event.input.path);
    const toolNames = skillFile === undefined ? undefined : toolsBySkillFile.get(skillFile);

    if (toolNames !== undefined) {
      activateTools(pi, toolNames);
    }
  });
};

const rejectUnknownSkillTools = (skills: readonly Skill[], skillTools: SkillTools) => {
  const skillNames = new Set(skills.map((skill) => skill.name));

  for (const skillName of Object.keys(skillTools)) {
    if (!skillNames.has(skillName)) {
      throw new Error(`Tau skill tools name an unknown skill: ${skillName}`);
    }
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

// A tool tied to a skill should register with `defaultActive: false`, so it stays out of the
// prompt until the skill runs.
export default function tauSkillsExtension(
  pi: ExtensionAPI,
  skillsDirectory: string,
  skillTools: SkillTools = {},
): void {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: skillsDirectory, source: 'tau' });

  rejectSkillProblems(skillsDirectory, diagnostics);
  rejectUnknownSkillTools(skills, skillTools);

  const lines = readRequiredForLines(skills);

  registerSkillCommands(pi, skills, skillTools);
  registerSkillReadActivation(pi, skills, skillTools);

  // Workers load only the skills their profile names, so the lines could name a missing skill.
  if (isWorkerProcess() || lines.length === 0) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, lines.join('\n'));
  });
}
