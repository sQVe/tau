export interface PathEntry {
  name: string;
  isFile: boolean;
  executable: boolean;
  identity: string;
}

const resolvesCommand = (entry: PathEntry) => entry.isFile && entry.executable;

const sortedLines = (lines: Iterable<string>) => [...lines].toSorted().join('');

// Shadowed executables count too: tests that strip package bins from PATH run the command behind
// them, such as the installed pi.
export const pathCommands = (directories: readonly (readonly PathEntry[])[]): string => {
  const winners = new Map<string, string>();
  const executables = new Set<string>();

  for (const entries of directories) {
    for (const entry of entries.filter(resolvesCommand)) {
      executables.add(`${entry.name} ${entry.identity}\n`);

      if (!winners.has(entry.name)) {
        winners.set(entry.name, `${entry.name} ${entry.identity}\n`);
      }
    }
  }

  return `${sortedLines(winners.values())}\n${sortedLines(executables)}`;
};
