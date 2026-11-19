const workersTabSuffix = '-workers';

const isPresent = (value: string | undefined): value is string =>
  value !== undefined && value !== '';

export const placementLabels = (
  managerLabels: Readonly<Record<string, string>>,
): Record<string, string> => {
  const space = managerLabels['herdr.space'];
  const managerTab = managerLabels['herdr.tab'];

  if (!isPresent(space) || !isPresent(managerTab)) {
    return {};
  }

  return { 'herdr.space': space, 'herdr.tab': `${managerTab}${workersTabSuffix}` };
};
