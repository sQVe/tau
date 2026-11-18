import { roleRegistersTool } from '../../role/roleTools.js';
import type { Loadout } from './types.js';

export const workerTools = (
  loadout: Pick<Loadout, 'tools' | 'skills' | 'role'>,
  skillTools: Readonly<Record<string, readonly string[]>>,
): string[] => {
  const loadedSkillTools = loadout.skills.flatMap((path) => {
    const segments = path.split('/').filter(Boolean);

    segments.pop();
    const skillName = segments.at(-1) ?? '.';

    // A skill named like an Object property, such as constructor, must not read the prototype.
    return Object.hasOwn(skillTools, skillName) ? (skillTools[skillName] ?? []) : [];
  });

  const tools = new Set([
    ...loadout.tools,
    'subagent_report',
    'subagent_question',
    ...loadedSkillTools,
  ]);

  if (loadout.role === 'editing') {
    tools.add('full_check');
  } else {
    tools.delete('full_check');
  }

  return [...tools].filter((tool) => roleRegistersTool('worker', tool));
};
