import type { Loadout } from './types.js';

const workersTabSuffix = '-workers';

const isPresent = (value: string | undefined): value is string =>
  value !== undefined && value !== '';

export const placementLabels = (
  role: Loadout['role'],
  managerLabels: Readonly<Record<string, string>>,
): Record<string, string> => {
  const space = managerLabels['herdr.space'];
  const managerTab = managerLabels['herdr.tab'];

  if (!isPresent(space) || !isPresent(managerTab)) {
    return {};
  }

  const tab = role === 'editing' ? managerTab : `${managerTab}${workersTabSuffix}`;

  return { 'herdr.space': space, 'herdr.tab': tab };
};
