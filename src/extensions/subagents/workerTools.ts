import type { Loadout } from './types.js';

export const workerTools = (
  loadout: Pick<Loadout, 'tools' | 'skills'>,
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
    'subagent_progress',
    'subagent_report',
    'subagent_question',
    ...loadedSkillTools,
  ]);

  // Only the manager's PR step runs the full check, even when a worker loads the pr skill.
  tools.delete('full_check');

  return [...tools];
};

const parseToolList = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isToolName = (value: unknown): value is string => typeof value === 'string';

const isToolList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isToolName);

export const parseWorkerTools = (text: string | undefined): string[] => {
  if (text === undefined || text === '') {
    throw new Error('Worker tool list is missing.');
  }

  const value = parseToolList(text);

  if (!isToolList(value)) {
    throw new Error('Worker tool list is malformed.');
  }

  return value;
};
