import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type SkillTools = Readonly<Record<string, readonly string[]>>;

export const skillToolsPath = fileURLToPath(new URL('./skillTools.json', import.meta.url));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isToolList = (value: unknown): value is unknown[] => Array.isArray(value);

const isToolName = (value: unknown): value is string => typeof value === 'string';

export const parseSkillTools = (text: string): SkillTools | undefined => {
  const value = parseJson(text);

  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries: [string, string[]][] = [];

  for (const [skill, tools] of Object.entries(value)) {
    if (!isToolList(tools)) {
      return undefined;
    }

    if (!tools.every(isToolName)) {
      return undefined;
    }

    entries.push([skill, tools]);
  }

  return Object.fromEntries(entries);
};

// Re-reads the table, so a launch sees edits made after this module loaded. An unreadable or
// malformed file returns undefined, which the launch refuses.
export const readSkillTools = (): SkillTools | undefined => {
  try {
    return parseSkillTools(readFileSync(skillToolsPath, 'utf8'));
  } catch {
    return undefined;
  }
};

const loadSkillTools = (): SkillTools => {
  const parsed = readSkillTools();

  if (parsed === undefined) {
    throw new Error(`${skillToolsPath} must map each skill name to a list of tool names.`);
  }

  return parsed;
};

export const skillTools: SkillTools = loadSkillTools();
