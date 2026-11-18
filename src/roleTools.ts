import type { RoleKind } from './role.js';

const roleGatedTools: Readonly<Record<string, readonly RoleKind[]>> = {
  architect: ['lead'],
};

export const roleRegistersTool = (role: RoleKind, tool: string): boolean =>
  roleGatedTools[tool]?.includes(role) ?? true;
