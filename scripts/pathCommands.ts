export interface PathEntry {
  name: string;
  isFile: boolean;
  executable: boolean;
  identity: string;
}

const resolvesCommand = (entry: PathEntry) => entry.isFile && entry.executable;

export const pathCommands = (directories: readonly (readonly PathEntry[])[]): string => {
  const winners = new Map<string, string>();

  for (const entries of directories) {
    for (const entry of entries) {
      if (resolvesCommand(entry) && !winners.has(entry.name)) {
        winners.set(entry.name, entry.identity);
      }
    }
  }

  return [...winners]
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, identity]) => `${name} ${identity}\n`)
    .join('');
};
