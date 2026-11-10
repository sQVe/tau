export const supportsFocusedVitest = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10));

  if (major !== 2) {
    return major > 2;
  }

  if (minor !== 1) {
    return minor > 1;
  }

  const [release = ''] = version.split('+');

  return patch > 0 || !release.includes('-');
};
