import { isRecord } from '../../isRecord.js';
import { findRepositoryEntry } from '../../repositoryEntry.js';
import { readUserOnlyKey, warnUnknownKeys } from '../../tauConfig.js';
import type { ConfigLocation, ConfigWarnings } from '../../tauConfig.js';
import { anyKey } from '../../unknownKeys.js';
import type { KnownKeys } from '../../unknownKeys.js';

const repositoryKeyPattern = /^[^\s/]+\/[^\s/]+$/u;

const knownFullCheckKeys: KnownKeys = {
  repositories: { [anyKey]: { argv: true } },
};

export const readArgv = (source: string, field: string, value: unknown): string[] => {
  const expected = `${field} must be a non-empty array of non-empty strings, such as ["pnpm", "check"].`;

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid Tau config ${source}: ${expected}`);
  }

  const items = value.filter((item): item is string => typeof item === 'string' && item !== '');

  if (items.length !== value.length) {
    throw new Error(`Invalid Tau config ${source}: ${expected}`);
  }

  return items;
};

const readEntry = (source: string, key: string, value: unknown): string[] => {
  const field = `fullCheck.repositories.${key}`;

  if (!repositoryKeyPattern.test(key)) {
    throw new Error(
      `Invalid Tau config ${source}: ${JSON.stringify(key)} in fullCheck.repositories must be an owner/name such as "sQVe/tau".`,
    );
  }

  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"argv": ["pnpm", "check"]}.`,
    );
  }

  return readArgv(source, `${field}.argv`, value.argv);
};

// Reads the command of the entry for `repository`. A bad entry for another repository is ignored.
// Resolves undefined when the repository has no entry.
export const readFullCheckArgv = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): string[] | undefined => {
  // Only the user file may name a command, since the check runs in every checkout of the user.
  const user = readUserOnlyKey(location, 'fullCheck');

  if (user === undefined) {
    return undefined;
  }

  const { source, value: fullCheck } = user;

  if (!isRecord(fullCheck)) {
    throw new Error(
      `Invalid Tau config ${source}: fullCheck must be an object such as {"repositories": {"sQVe/tau": {"argv": ["pnpm", "check"]}}}.`,
    );
  }

  warnUnknownKeys(ui, source, fullCheck, knownFullCheckKeys, 'fullCheck');

  const { repositories } = fullCheck;

  if (repositories === undefined) {
    return undefined;
  }

  if (!isRecord(repositories)) {
    throw new Error(
      `Invalid Tau config ${source}: fullCheck.repositories must be an object keyed by owner/name.`,
    );
  }

  if (repository === undefined) {
    return undefined;
  }

  const match = findRepositoryEntry(source, 'fullCheck.repositories', repositories, repository);

  return match === undefined ? undefined : readEntry(source, match[0], match[1]);
};
