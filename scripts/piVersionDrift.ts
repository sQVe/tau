const minor = (version: string) => /^(\d+\.\d+)\.\d+/.exec(version.trim())?.[1];

// Returns the fix when the installed Pi and Tau's Pi dependency differ in minor version.
export const piVersionDrift = (installed: string, dependency: string): string | undefined => {
  const installedMinor = minor(installed);

  if (installedMinor !== undefined && installedMinor === minor(dependency)) {
    return undefined;
  }

  return [
    `Installed pi ${installed.trim()} differs from Tau's @earendil-works/pi-coding-agent ${dependency} in minor version.`,
    'Upgrade @earendil-works/pi-coding-agent, pi-ai, and pi-tui to the installed minor, or update pi to match.',
  ].join('\n');
};
