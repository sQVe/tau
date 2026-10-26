export interface PathEntry {
  name: string;
  isFile: boolean;
  executable: boolean;
  identity: string;
}

const resolvesCommand = (entry: PathEntry) => entry.isFile && entry.executable;

// Shadowed executables count in PATH order: tests that strip package bins from PATH run the next
// command behind them, such as the installed pi.
export const pathCommands = (directories: readonly (readonly PathEntry[])[]): string => {
  const chains = new Map<string, string[]>();

  for (const entries of directories) {
    for (const entry of entries.filter(resolvesCommand)) {
      const chain = chains.get(entry.name) ?? [];

      if (!chain.includes(entry.identity)) {
        chains.set(entry.name, [...chain, entry.identity]);
      }
    }
  }

  return [...chains]
    .map(([name, chain]) => `${name} ${chain.join(' ')}\n`)
    .toSorted()
    .join('');
};
