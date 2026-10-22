import { readUserOnlyKey, warnUnknownKeys } from '../../config/config.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { findRepositoryEntry } from '../../config/repositoryEntry.js';
import { isRecord } from '../../isRecord.js';
import { anyKey } from '../../unknownKeys.js';
import type { KnownKeys } from '../../unknownKeys.js';

export interface QaSettings {
  urlCommand: string | undefined;
  testAccountCommand: string | undefined;
  dataWrites: boolean;
  // The config file the settings came from, named in refusals.
  source: string;
}

const knownQaKeys: KnownKeys = {
  repositories: {
    [anyKey]: { urlCommand: true, testAccountCommand: true, dataWrites: true },
  },
};

const readCommand = (source: string, field: string, value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new TypeError(`Invalid Tau config ${source}: ${field} must be a string.`);
  }

  if (!value.trim()) {
    throw new Error(`Invalid Tau config ${source}: ${field} is empty.`);
  }

  return value;
};

const readDataWrites = (source: string, field: string, value: unknown): boolean => {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== 'boolean') {
    throw new TypeError(`Invalid Tau config ${source}: ${field} must be true or false.`);
  }

  return value;
};

const readEntry = (source: string, key: string, value: unknown): QaSettings => {
  const field = `qa.repositories.${key}`;

  if (!isRecord(value)) {
    throw new Error(
      `Invalid Tau config ${source}: ${field} must be an object such as {"urlCommand": "./scripts/dev-url"}.`,
    );
  }

  return {
    urlCommand: readCommand(source, `${field}.urlCommand`, value.urlCommand),
    testAccountCommand: readCommand(
      source,
      `${field}.testAccountCommand`,
      value.testAccountCommand,
    ),
    dataWrites: readDataWrites(source, `${field}.dataWrites`, value.dataWrites),
    source,
  };
};

// Reads the QA settings of the entry for `repository`. A bad entry for another repository is
// ignored. Resolves undefined when the repository has no entry. Only the user file may set `qa`,
// since it names commands that run in every checkout of the user.
export const readQaSettings = (
  location: ConfigLocation,
  ui: ConfigWarnings,
  repository: string | undefined,
): QaSettings | undefined => {
  const user = readUserOnlyKey(location, 'qa');

  if (user === undefined) {
    return undefined;
  }

  const { source, value: qa } = user;

  if (!isRecord(qa)) {
    throw new Error(
      `Invalid Tau config ${source}: qa must be an object such as {"repositories": {"sQVe/cape": {"urlCommand": "./scripts/dev-url"}}}.`,
    );
  }

  warnUnknownKeys(ui, source, qa, knownQaKeys, 'qa');

  const { repositories } = qa;

  if (repositories === undefined) {
    return undefined;
  }

  if (!isRecord(repositories)) {
    throw new Error(
      `Invalid Tau config ${source}: qa.repositories must be an object keyed by owner/name.`,
    );
  }

  if (repository === undefined) {
    return undefined;
  }

  const match = findRepositoryEntry(source, 'qa.repositories', repositories, repository);

  return match === undefined ? undefined : readEntry(source, match[0], match[1]);
};
