import type { RoleKind } from './role.js';

const roleGatedTools = new Map<string, readonly RoleKind[]>([
  ['architect', ['lead']],
  ['plan', ['lead']],
]);

export const roleRegistersTool = (role: RoleKind, tool: string): boolean =>
  roleGatedTools.get(tool)?.includes(role) ?? true;
