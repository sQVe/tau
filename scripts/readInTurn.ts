// Reads started together would open more files than the process may hold.
export const readInTurn = async <Item, Result>(
  items: Item[],
  read: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
  const results: Result[] = [];

  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- One open file at a time.
    results.push(await read(item));
  }

  return results;
};
