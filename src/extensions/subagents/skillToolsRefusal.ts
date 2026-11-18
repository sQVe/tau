import type { RoleKind } from '../../role.js';
import { roleRegistersTool } from '../../roleTools.js';
import type { SkillTools } from '../../skillTools.js';

const reloadInstruction = 'Run /reload, then launch again.';

const listedToolNames = (skillTools: SkillTools): string[] => {
  const skillToolNames = Object.values(skillTools).flat();

  return [...new Set(skillToolNames)];
};

export const skillToolsRefusal = (
  current: SkillTools | undefined,
  registeredToolNames: ReadonlySet<string>,
  role: RoleKind,
): string | undefined => {
  if (current === undefined) {
    return 'Tau could not read src/skillTools.json. The file must be fixed before a launch.';
  }

  const missing = listedToolNames(current).filter(
    (tool) => roleRegistersTool(role, tool) && !registeredToolNames.has(tool),
  );

  if (missing.length === 0) {
    return undefined;
  }

  return `Tau's skill tools changed on disk and need tools this Pi session did not register: ${missing.join(', ')}. ${reloadInstruction}`;
};
