import type { Loadout } from './types.js';

export const workerTools = (
  loadout: Pick<Loadout, 'tools' | 'skills'>,
  skillTools: Readonly<Record<string, readonly string[]>>,
): string[] => {
  const loadedSkillTools = loadout.skills.flatMap((path) => {
    const segments = path.split('/').filter(Boolean);

    segments.pop();
    const skillName = segments.at(-1) ?? '.';

    return skillTools[skillName] ?? [];
  });

  return [
    ...new Set([
      ...loadout.tools,
      'subagent_progress',
      'subagent_report',
      'subagent_question',
      ...loadedSkillTools,
    ]),
  ];
};
