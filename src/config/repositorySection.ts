import { anyKey, isRecord } from '../schema.js';
import type { KnownKeys } from '../schema.js';
import { readUserOnlyKey, warnUnknownKeys } from './config.js';
import type { ConfigLocation, ConfigWarnings } from './config.js';
import { findRepositoryEntry } from './repositoryEntry.js';

export interface RepositorySectionReader<Entry> {
  // The user-only config key that holds the section, such as `qa`.
  key: string;
  // Known keys beside `repositories` in the section, such as `agentTeam`.
  knownSectionKeys?: KnownKeys;
  knownEntryKeys: KnownKeys;
  // An example section body for the "must be an object" error.
  example: string;
  repository: string | undefined;
  // Reads the matched entry. `field` names it in errors, such as `qa.repositories.sQVe/tau`.
  readEntry: (source: string, field: string, value: unknown) => Entry;
}

const repositoryKeyPattern = /^[^\s/]+\/[^\s/]+$/u;

// Reads the entry for `repository` from a section of the user file keyed by owner/name. Entries for
// other repositories are never read. Resolves undefined when the section has no such entry.
export const readRepositorySection = <Entry>(
  location: ConfigLocation,
  ui: ConfigWarnings,
  {
    key,
    knownSectionKeys = {},
    knownEntryKeys,
    example,
    repository,
    readEntry,
  }: RepositorySectionReader<Entry>,
): Entry | undefined => {
  const user = readUserOnlyKey(location, key);

  if (user === undefined) {
    return undefined;
  }

  const { source, value: section } = user;

  if (!isRecord(section)) {
    throw new Error(`Invalid Tau config ${source}: ${key} must be an object such as ${example}.`);
  }

  warnUnknownKeys(
    ui,
    source,
    section,
    { ...knownSectionKeys, repositories: { [anyKey]: knownEntryKeys } },
    key,
  );

  const { repositories } = section;

  if (repositories === undefined) {
    return undefined;
  }

  if (!isRecord(repositories)) {
    throw new Error(
      `Invalid Tau config ${source}: ${key}.repositories must be an object keyed by owner/name.`,
    );
  }

  if (repository === undefined) {
    return undefined;
  }

  const match = findRepositoryEntry(source, `${key}.repositories`, repositories, repository);

  if (match === undefined) {
    return undefined;
  }

  const [entryKey, entry] = match;

  if (!repositoryKeyPattern.test(entryKey)) {
    throw new Error(
      `Invalid Tau config ${source}: ${JSON.stringify(entryKey)} in ${key}.repositories must be an owner/name such as "sQVe/tau".`,
    );
  }

  return readEntry(source, `${key}.repositories.${entryKey}`, entry);
};
