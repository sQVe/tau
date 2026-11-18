import type { RoleKind } from '../../role/role.js';
import type { Loadout } from './types.js';

export const roleLaunchRefusal = (
  launchingRole: RoleKind,
  loadout: Pick<Loadout, 'profile' | 'role'>,
): string | undefined => {
  if (launchingRole !== 'architect' || loadout.role !== 'editing') {
    return undefined;
  }

  return `An architect session launches only investigation workers, and profile ${loadout.profile} is an editing profile. Put the change in a ticket for the lead to delegate.`;
};
