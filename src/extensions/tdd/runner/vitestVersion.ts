const focusedEntryRelease = '2.1.0';
const configReporterOptionsRelease = '4.0.3';

const releaseParts = (version: string): number[] =>
  version.split('.').map((part) => Number.parseInt(part, 10));

// A prerelease of the minimum release comes before it.
const isAtLeast = (version: string, minimum: string): boolean => {
  const parts = releaseParts(version);

  for (const [index, required] of releaseParts(minimum).entries()) {
    const part = parts[index] ?? 0;

    if (part !== required) {
      return part > required;
    }
  }

  const [release = ''] = version.split('+');

  return !release.includes('-');
};

export const supportsFocusedVitest = (version: string): boolean =>
  isAtLeast(version, focusedEntryRelease);

export const givesConfigReporterOptionsToCliReporters = (version: string): boolean =>
  isAtLeast(version, configReporterOptionsRelease);
