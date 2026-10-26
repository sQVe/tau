export interface PathEntry {
  name: string;
  isFile: boolean;
  executable: boolean;
  identity: string;
}

const resolvesCommand = (entry: PathEntry) => entry.isFile && entry.executable;

// Each directory lists its entries in PATH order. A name keeps the first executable file that has it.
export const pathCommands = (directories: readonly (readonly PathEntry[])[]): string => {
  const winners = new Map<string, string>();

  for (const entries of directories) {
    for (const entry of entries) {
      if (resolvesCommand(entry) && !winners.has(entry.name)) {
        winners.set(entry.name, entry.identity);
      }
    }
  }

  // Names are unique map keys, so a comparison never returns zero.
  return [...winners]
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, identity]) => `${name} ${identity}\n`)
    .join('');
};
