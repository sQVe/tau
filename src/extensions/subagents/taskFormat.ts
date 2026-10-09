export const taskFormat = (
  version: unknown,
  currentVersion: number,
): 'current' | 'retired' | 'newer' | 'invalid' => {
  if (typeof version !== 'number') {
    return 'invalid';
  }

  if (version < currentVersion) {
    return 'retired';
  }

  if (version > currentVersion) {
    return 'newer';
  }

  return version === currentVersion ? 'current' : 'invalid';
};
