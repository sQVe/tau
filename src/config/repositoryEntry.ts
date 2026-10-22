const sameRepository = (key: string, repository: string): boolean =>
  key.toLowerCase() === repository.toLowerCase();

const rejectDuplicateKeys = (
  source: string,
  field: string,
  keys: string[],
  repository: string,
): void => {
  const seenKeys: string[] = [];

  // Every key naming the repository counts, parsed or not, so the error does not depend on entry order.
  for (const key of keys.filter((candidate) => sameRepository(candidate, repository))) {
    const duplicate = seenKeys.find((earlier) => earlier.toLowerCase() === key.toLowerCase());

    // GitHub names ignore case, so two keys that differ only in case would name one repository.
    if (duplicate !== undefined) {
      throw new Error(
        `Invalid Tau config ${source}: ${field} has both ${JSON.stringify(duplicate)} and ${JSON.stringify(key)}, which name the same repository. Keep one.`,
      );
    }

    seenKeys.push(key);
  }
};

// Finds the `[key, value]` entry that names `repository`, ignoring case. Entries for other
// repositories are never read. `field` names the map in errors, such as `fullCheck.repositories`.
export const findRepositoryEntry = (
  source: string,
  field: string,
  repositories: Record<string, unknown>,
  repository: string,
): [string, unknown] | undefined => {
  rejectDuplicateKeys(source, field, Object.keys(repositories), repository);

  return Object.entries(repositories).find(([key]) => sameRepository(key, repository));
};
