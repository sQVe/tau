const minor = (version: string) => /^(\d+\.\d+)\.\d+/.exec(version.trim())?.[1];

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

// `pnpm run` puts the package bin directories first, and they hold the dependency's own `pi`.
export const installedPiPath = (path: string, delimiter: string): string =>
  path
    .split(delimiter)
    .filter((directory) => !/node_modules[/\\]\.bin[/\\]?$/.test(directory))
    .join(delimiter);
