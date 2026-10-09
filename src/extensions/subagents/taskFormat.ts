export const taskFormat = (
  version: unknown,
  currentVersion: number,
  oldestReadableVersion: number,
): 'current' | 'retired' | 'newer' | 'invalid' => {
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return 'invalid';
  }

  if (version < 1) {
    return 'invalid';
  }

  if (version < oldestReadableVersion) {
    return 'retired';
  }

  if (version > currentVersion) {
    return 'newer';
  }

  return 'current';
};
